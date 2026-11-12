# Folder Relay 远程协作协议 v1

本文件是 0.3 远程协作的**唯一事实来源**。服务端（`apps/collab-server`）与扩展（`apps/vscode-extension`）分别按此实现，两边不得各自发明字段。

目标：把 0.2 的「650 ms 全量轮询清单」换成「服务端推送增量 + 单调序号续传 + 分片断点续传」，使跨城/跨网协作在 100 ms 级感知延迟、断网后无人工干预自愈。

## 0. 术语

| 术语 | 含义 |
| --- | --- |
| workspace | 一个共享工作区，字符串 UUID（沿用 0.2 的 `workspaceId` / `documentId`） |
| seq | **服务端单调递增序号**，每个 workspace 一条，每次成功 commit 递增 1。客户端用它做增量续传 |
| revision | **每个文件独立的版本号**，每次 commit 该文件 +1；0 表示"文件不存在"。用于乐观并发 |
| blob | 文件内容（原始字节），内容寻址：`sha256` |
| floor | 服务端事件日志当前保留的最小 seq。`since < floor` 时客户端必须全量重置 |

`seq` 与 `revision` 必须分开：seq 是**工作区级时间轴**（事件日志），revision 是**文件级版本**（并发控制）。这是 0.2 混淆两者的地方，也是远程场景下必须先修正的地方。

## 1. 传输与鉴权

- HTTP/1.1 或 HTTP/2，TLS 终止在反代（Caddy/Nginx）或服务端直连（`LSW_TLS_CERT`/`LSW_TLS_KEY`）。
- 鉴权：`Authorization: Bearer <token>`。
  - 旧共享令牌（`LSW_TOKEN`）：等价于 owner，兼容 0.2 客户端。
  - 成员令牌：`lsw1.<memberId>.<secret>`，服务端只存 `sha256(secret)`，可单独吊销。
  - 浏览器端无法设置头部时，WebSocket 可用子协议携带：`new WebSocket(url, ['lsw.v1', 'lsw.token.' + token])`。
- 角色：`viewer`（读清单/blob/订阅事件）、`editor`（+commit/upload）、`owner`（+成员管理）。
- 所有响应带 `Cache-Control: no-store`。

## 2. 能力协商

`GET /v1/config` → 200

```json
{
  "proto": 1,
  "workspace": null,
  "features": ["ws", "longpoll", "chunked-upload", "range", "idempotency", "member-tokens"],
  "heartbeatMs": 25000,
  "maxFileBytes": 16777216,
  "maxPaths": 4096,
  "chunkBytes": 524288,
  "maxChunkConcurrency": 3,
  "partRetry": 3,
  "cooldownAfterFailures": 5,
  "cooldownMs": 30000,
  "unhealthyAfterErrors": 5,
  "errorWindowMs": 60000,
  "pollFallbackMs": 3000
}
```

| 字段 | 默认行为 |
| --- | --- |
| `heartbeatMs` | 每 25 s 发送心跳，客户端在静默超过 62.5 s 后重连 |
| `chunkBytes` | 每块 512 KiB，16 MiB 文件分为 32 块 |
| `maxChunkConcurrency` / `partRetry` | 最多并发上传 3 块，每块最多重试 3 次 |
| `cooldownAfterFailures` / `cooldownMs` | 连续失败 5 次后冷却 30 s |
| `unhealthyAfterErrors` / `errorWindowMs` | 60 s 内出现至少 5 次网络或解析错误时重新连接 |


无鉴权也可读（不含任何工作区数据）。0.2 客户端拿到 404 就走旧路径。

## 3. 事件日志与增量

### 3.1 `GET /v1/workspace/changes?workspace=<id>&since=<seq>[&wait=<ms>]`

鉴权后返回自 `since` 之后的事件（`since` 语义：**已收到的最大 seq**，返回 `since+1..head`）。

```json
{
  "workspace": "uuid",
  "head": 42,
  "floor": 1,
  "from": 13,
  "reset": false,
  "changes": [
    { "seq": 13, "path": "main.tex", "revision": 7, "sha256": "…", "size": 812, "deleted": false, "at": "2026-…Z" }
  ]
}
```

- `reset: true` 表示请求的区间已不可用，具体判据是 **`since + 1 < floor`**（等价于"想要的最早一条已被裁剪"）。注意不要写成字面 `since < floor`：`floor` 从 1 起，首次连接 `since=0` 会被永远判成 reset。
  `changes` 可为空，客户端必须走全量 `manifest` 后从 `head` 续接。
- `wait=<ms>`：长轮询。无新事件时挂起，最多 `wait` 毫秒（上限 30000，默认 0=立即返回）。有新事件立即返回。
- 单次返回上限 512 条；`head - from + 1 > 512` 时截断，客户端继续拉。
- `changes` 帧/响应同时带 `floor`（实现额外加的字段，客户端可忽略），便于客户端区分"日志裁剪"与"就是没有事件"。

### 3.2 `GET /workspace/manifest?workspace=<id>`（沿用 0.2，语义不变）

返回全量 `{files:[{path,revision,sha256,size}]}`。v1 额外在响应头带 `X-LSW-Seq: <head>`，客户端全量对齐后把 `lastSeq` 设为它。

## 4. 提交（乐观并发 + 幂等）

### 4.1 `POST /v1/workspace/commit?workspace=<id>&path=<p>[&delete=1]`

| 头 | 说明 |
| --- | --- |
| `If-Match: "<revision>"` | 必填，客户端已知的该文件版本，`0` 表示新建（0.2 用 `"0"`，保持一致） |
| `Idempotency-Key: <uuid>` | 建议填。相同 key 在 10 分钟内重放返回**原结果**，不重复递增 revision/seq |
| `Content-Length` | PUT 内容长度，`delete=1` 时必须为 0 |

成功 200：

```json
{ "file": { "path": "main.tex", "revision": 8, "sha256": "…", "size": 812 }, "seq": 43 }
```

失败：

| 状态 | `error` | 客户端动作 |
| --- | --- | --- |
| 412 | `revision-changed` | 附带 `"file": {当前版本}`；客户端走 3-way 合并或产出冲突副本 |
| 409 | `path-collision` | 大小写/父子路径冲突，报错给用户 |
| 413 | `file-too-large` | 报错 |
| 507 | `workspace-capacity` | 报错 |
| 428 | `revision-precondition-required` | 客户端补 `If-Match` |

`GET /workspace/file`（0.2 接口）新增 `Range: bytes=a-b` 支持：返回 206 + `Content-Range`，`sha256` 校验仍按整文件做（客户端最后对齐整文件哈希）。这让 16 MiB 文件在丢包链路上可续传。

## 5. 分片断点续传（> 256 KiB 走这条）

1. `POST /v1/upload?workspace=<id>&path=<p>&size=<n>&sha256=<hex>&base=<revision>`
   → 201 `{ "upload": "<uuid>", "offset": 0, "chunkBytes": 524288, "received": [] }`
   若存在 `(workspace, path, size, sha256)` 完全相同的未完成会话 → 200 并返回已收分片：

   ```json
   { "upload": "<id>", "offset": 1048576, "chunkBytes": 524288,
     "received": [{ "offset": 0, "length": 524288 }, { "offset": 524288, "length": 524288 }] }
   ```

   `offset` 是**顺序续传点**（已收的连续前缀），`received` 是**已收块集合**。客户端优先用 `received` 找出需要补传的分块。
2. `PUT /v1/upload/<id>?offset=<n>`，body 为 ≤ `chunkBytes` 的原始字节
   → 200 `{ "upload": "<id>", "offset": <新偏移> }`
   → 409 `upload-offset-mismatch` + `{ "expected": <n> }`（客户端从 `expected` 重发）
   → 410 `upload-expired`（30 分钟无活动）
3. `POST /v1/upload/<id>/finish` → 与 4.1 相同的 `{file, seq}`；可带 `Idempotency-Key`（**必须幂等**，否则重试会重复递增 revision/seq）。
   - 校验 `sha256` 不符 → 422 `upload-hash-mismatch`（会话保留，允许重传坏块后重试 finish）；
   - 还有缺口没传完 → 409 `upload-incomplete` + `{ "expected": <缺口起始 offset> }`（会话保留）。
4. `DELETE /v1/upload/<id>` 取消。
5. `GET /v1/upload/<id>` → `{upload, size, sha256, base, offset, received:[{offset,length}…]}`，用于客户端崩溃后恢复。

分片落盘：`<LSW_DATA>/uploads/<id>/<offset>.part`，不进 SQLite（避免 WAL 膨胀）。合并成功后写 workspace 存储并删除目录。

## 6. 推送通道（WebSocket）

`GET /v1/events?workspace=<id>&since=<seq>`，`Upgrade: websocket`。

服务端帧（JSON text，均为对象）：

| `t` | 载荷 | 说明 |
| --- | --- | --- |
| `hello` | `{workspace, seq, floor, proto, heartbeatMs, resumeWindow}` | 连接建立后第一帧；`seq` 是当前 head，`floor` 是日志最旧可用 seq，`resumeWindow` 是日志保留条数 |
| `changes` | `{changes:[…], head, floor}` | 增量事件，字段同 3.1 |
| `reset` | `{head, reason}` | 日志不覆盖 `since`（或服务端重启），客户端全量重同步 |
| `ping` | `{seq}` | 每 `heartbeatMs` 一次，**无事件时也发** |

客户端帧：

| `t` | 载荷 | 说明 |
| --- | --- | --- |
| `pong` | `{seq}` | 收到 `ping` 后回。服务端 3×`heartbeatMs` 无 pong 则断开 |
| `ack` | `{seq}` | 已应用到的 seq，服务端用于裁剪日志（可选） |
| `resync` | `{since}` | 显式请求重放 |

**客户端稳定性契约（硬性）**：

1. **双路判死**，满足任一即视为连接死亡 → 主动 `close()` 并重连：
   - 静默判据：超过 `2.5 × heartbeatMs` 没收到任何帧（默认 25 s → 62.5 s）；
   - 错误计数判据：`errorWindowMs`（默认 60 s）窗口内累计 ≥ `unhealthyAfterErrors`（默认 5）次网络/解析失败。
2. 重连退避：`delay = min(30s, 500ms × 1.8^n)` 再乘 `0.5 + random()×0.5` 抖动；收到 `hello` 后 `n = 0`。
   连续失败 ≥ `cooldownAfterFailures`（默认 5）次后进入**冷却**：固定 `cooldownMs`（默认 30 s）且**不加抖动**，直到一次成功或用户手动重连。冷却防的是"网络整体不可用时客户端群体持续敲服务端"。
3. 重连 URL 带 `since=lastSeq`；`reset` 到达前 **不丢弃** 本地待同步状态。
4. WS 不可用（404/握手失败/`features` 无 `ws`）→ 降级长轮询 `changes?wait=25000`；长轮询也 404 → 定时间隔轮询（loopback 650 ms、远程 3000 ms）。
5. 降级与升级都只影响"多久发现变化"，**不得**跳过 reconciler 的逐文件校验（sha256 + revision 双校验必须保留）。
6. `lastSeq` 持久化在本地 checkout 状态里（与 `base.row.revision` 同目录），重启后从它续传。

## 7. 健康与运维

`GET /healthz` → `{ "status": "ok", "seq": 42, "sockets": 3, "clients": 3, "uptimeMs": 123456, "version": "0.3.0", "stopping": false }`

优雅停机（远程场景必须）：收到 SIGTERM 后

1. 对已连接 WS 广播 `{"t":"reset", "head":head, "reason":"restart"}` 并关闭码 `1012`（service restart）；
2. 拒绝新 commit（503 `stopping`）；
3. 等待在途 commit 落盘（最多 10 s）后退出。

客户端见 `1012` 视为"服务器重启"，用 1 s 起的短退避快速重连，而不是 30 s 长退避。

## 8. 多节点（v1 不实现，留接口）

`seq` 由单进程 SQLite 分配（`locking_mode=EXCLUSIVE`）。多节点前提：

- 序号分配迁到 Postgres `UPDATE workspace_seq SET seq = seq + 1 RETURNING seq` 或 Redis `INCR`；
- 事件日志进 Postgres/Redis Stream，WS 节点间用 Redis Pub/Sub 广播；
- blob 进对象存储（S3/MinIO），SQLite 只留元数据；
- 负载均衡需 sticky 或纯无状态（推荐后者）。

客户端协议不变——这是把 `seq` 设计成工作区级单调序号的直接收益。

## 9. 兼容矩阵

| 客户端 | 服务端 0.2 | 服务端 0.3 |
| --- | --- | --- |
| 0.2 | 轮询，可用 | 轮询仍可用（`/workspace/*` 保留），`/v1/*` 未使用 |
| 0.3 | `GET /v1/config` 404 → 降级轮询，可用 | 推送 + 分片，最佳 |
