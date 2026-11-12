# 实现说明（0.3 现状）

这份文档回答"它现在到底是怎么跑起来的"：有哪些部件、状态存在哪、一次编辑走完哪些代码、以及每个关键选择背后的理由。协议字段级细节见[远程协议 v1](remote-protocol.md)，部署见[远程部署](deployment-remote.md)。

## 0. 一句话

一个 VS Code 扩展 + 一个 Node 服务端：**每台电脑上的项目目录就是真实文件**，扩展拿"每文件版本号（revision）+ 工作区事件序号（seq）"和服务器对齐，服务器只保存"路径 → 版本 + 字节"，不保存文档模型。没有中心化文档、没有 CRDT 文档树，任何工具（LaTeX Workshop、Python、git、记事本）动磁盘都能被同步。

## 1. 三个部件

| 部件 | 位置 | 入口 | 产物 / 启动 |
| --- | --- | --- | --- |
| VS Code 扩展 | `apps/vscode-extension` | `src/extension.ts` 的 `activate()` | esbuild 打成 `dist/extension.cjs`，`vsce` 打成 `.vsix` |
| 协作服务端 | `apps/collab-server` | `src/server.mjs`（`node src/server.mjs`，或 `npm start`） | 单进程 + 一个 SQLite 文件（+ `uploads/` 目录） |
| 验证与脚本 | `tests/`、`scripts/` | `npm test` / `npm run test:clients` / `npm run bench:remote` | 测试报告、基准数字 |

两者共享的契约只有一份：`docs/remote-protocol.md`。扩展不 import 服务端代码，服务端不 import 扩展代码——**跨包唯一的耦合是 HTTP/WS 报文**。

## 2. 代码地图

### 2.1 扩展（TypeScript，约 3.9k 行）

| 文件 | 行数 | 职责 | 关键点 |
| --- | --- | --- | --- |
| `src/extension.ts` | 735 | 激活、命令注册、**0.1 单文件模式**（Yjs/Hocuspocus）、URI handler | 0.1 与工作区模式并存，互不影响 |
| `src/project-sync.ts` | 1187 | **同步内核**：扫描、比对、上传/下载、三路合并、冲突副本、崩溃恢复、主循环 | 0.2 的正确性逻辑逐字保留，只换"多久发现变化" |
| `src/transport.ts` | 1156 | **线路层**：能力探测、WS 订阅、三级降级、心跳看门狗、退避、分片/Range/幂等键纯函数 | 不 import 其它本地模块，故可脱离 VS Code 单测 |
| `src/project-session.ts` | 459 | VS Code 事件桥（保存、脏状态、blocked）、状态栏、加入/离开、`Copy Join Link` | 唯一知道 `vscode` API 的同步相关文件 |
| `src/editor-model.ts` | 74 | UTF-16 偏移 → patch、CRLF 归一、编辑器模型 | 0.1 与合并共用 |
| `src/join-link.ts` | 80 | 一键加入链接的构造/解析/地址归一 | 纯函数，与 `/join` 页面格式互认（有测试锁） |
| `src/connection-form.ts` | 205 | 连接窗口 webview（地址 / 工作区 / 令牌） | 手填入口，仍然保留 |

### 2.2 服务端（ESM，约 2.1k 行）

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `src/server.mjs` | 709 | 路由总入口、鉴权、`/join` 闸门、优雅停机、TLS/反代、把各模块接起来 |
| `src/workspace-store.mjs` | 98 | `workspace_files`：路径 → revision + sha256 + 字节；路径冲突/容量校验 |
| `src/commit-api.mjs` | 91 | 新旧端点共用的提交服务：`If-Match`、10 分钟幂等表、在同一事务里调 `seq.append` |
| `src/seq-store.mjs` | 120 | `workspace_seq` + `workspace_events`：单调 seq、裁剪维护 floor、`since(workspace,since,limit)` |
| `src/realtime.mjs` | 312 | WebSocket hub（手写 RFC6455 帧）：`hello/changes/reset/ping`、`pong/ack/resync`、慢客户端处理 |
| `src/upload-store.mjs` | 221 | 分片会话：`uploads/<id>/<offset>.part`、`received[]`、TTL、finish 走 commit |
| `src/member-store.mjs` + `member-cli.mjs` | 68 + 77 | 成员令牌 `lsw1.<id>.<secret>`（只存 sha256）与角色；命令行增删查 |
| `src/workspace-http.mjs` | 113 | 0.2 兼容端点 `/workspace/manifest`、`/workspace/file`（含 Range 206、`X-LSW-Seq`） |
| `src/config.mjs` | 107 | 环境变量解析、公网开关、TLS 材料、大小上下限 |
| `src/join-page.mjs` | 128 | `GET /join` 的 HTML（令牌可见性由 `server.mjs` 把关） |
| `src/snapshot-store.mjs` | 85 | 0.1 单文件模式的 Yjs 快照表；**同时是数据库所有者**（`application_id`/`user_version` 迁移、`locking_mode=EXCLUSIVE`） |

## 3. 状态存在哪

### 3.1 服务端：一个 SQLite 文件

`LSW_DB_PATH`（默认 `data/collaboration.sqlite3`），WAL + `synchronous=FULL` + `locking_mode=EXCLUSIVE`（单进程独占，换来"提交返回即落盘"）。

| 表 | 主键 | 作用 | 写入方 |
| --- | --- | --- | --- |
| `workspace_files` | (workspace_id, path_key) | 路径 → revision、sha256、字节 | `workspace-store.commit` |
| `workspace_seq` | workspace_id | `head`（最新 seq）、`floor`（日志最旧可用） | `seq-store.append` |
| `workspace_events` | (workspace_id, seq) | 事件流：path/revision/sha256/size/deleted/at | 同上（与 revision 同一事务） |
| `members` | member_id | 名称、角色、`secret_sha256`、吊销时间 | `member-cli`（需停服） |
| `commit_idempotency` | (workspace_id, idem_key) | 10 分钟内的重放回执 | `commit-api` |
| `snapshots` | document_id | 0.1 单文件模式的 Yjs 二进制快照 | `snapshot-store` |

分片不落库：`LSW_DATA_DIR/uploads/<id>/<offset>.part` + `meta.json`（重启可续传）。

### 3.2 客户端：真实文件 + 一份旁路状态

```
你的项目目录/                     ← 唯一事实来源：普通文件，任何工具都能改
…
<VS Code globalStorage>/projects/<associationHash>/
├── checkout/
│   ├── <sha256(小写相对路径)>.json   ← 每文件：base(已确认版本) / intent(待投影) / conflict / resolution
│   ├── <uuid>.project               ← 待写盘的字节（崩溃后据此继续，不重下）
│   └── sequence.json                ← lastSeq：断线续传水位
└── conflicts/<uuid>/
    ├── local.tex  shared.tex  base.tex
    └── versions.json                ← 谁、哪个 revision、哪个 sha256
```

`checkout` 里没有文件内容（除了崩溃恢复用的临时载荷），所以不会出现"两份真相"。

## 4. 运行流程

### 4.1 起服务端

`node src/server.mjs` → 读环境变量 → 打开/迁移 SQLite → 起 HTTP（可选 TLS）→ 打印 `{"event":"listening",…}` 与 `/join` 地址。

### 4.2 加入

两条路，殊途同归（都落到 `joinProject({url, workspaceId, token})`）：

1. `/join` 页面里的一键链接 `vscode://lsw-local.latex-sync-workspace/join?…` → `window.registerUriHandler` → `parseJoinLink` → `joinProject`；
2. 命令 `LSW: Join Shared Project` → 连接窗口手填。

`joinProject` 会先 `GET /workspace/manifest` 验令牌，再存 `SecretStorage`（令牌）与 `workspaceState`（地址 + 工作区 ID），然后启动 `ProjectSync`。

### 4.3 一次保存的完整链路

```text
Ctrl+S
 └─ VS Code 原生写盘（project-session 320ms 防抖后调 doc.save()）
     └─ fs.watch 唤醒 ProjectSync.wake() → fullRequested = true
         └─ pump() → reconcile()：拉 manifest → 逐文件 inspect(sha256) 比对
             ├─ 本地更新 → upload / 分片上传（If-Match + Idempotency-Key）
             │     └─ 服务端：同一事务里 revision+1、seq+1、写事件 → 广播 WS → 返回 {file,seq}
             └─ 远端更新 → download（≥256KiB 走 Range）→ sha256 校验 → writeAtomic 写盘
对端：WS 收到 changes → pending 只放这几个 path → applyPending()
     └─ reconcileFile(key, path, row)：同一套比对/合并/冲突逻辑
```

要点：**推送通道只传"哪个文件变了"**，内容永远走 HTTP 且逐次校验 sha256，所以推送丢帧、乱序、重复都不会造成错误状态（最坏是多跑一轮）。

### 4.4 四种情形

| 情形 | 行为 |
| --- | --- |
| 断线 | 静默 62.5 s 或 60 s 内 5 次网络错 → 判死；抖动退避重连；连上带 `since=lastSeq` 续传 |
| 服务端重启 | 广播 `reset(reason=restart)` + close `1012`；客户端 1 s 起短退避回来，全量对齐一次 |
| 双方改同一文件 | 不同段落 → `mergeText()` 三方合并后上传；整份覆盖 → 落 `conflicts/`，命令里看 diff、提交解决稿 |
| 弱网大文件 | 512 KiB 分片、并发 3、按 `received[]` 乱序续传；下载 Range 续传；最后仍校验整文件哈希 |

## 5. 为什么是这样（关键决定）

| 决定 | 理由 | 代价 |
| --- | --- | --- |
| 不做 CRDT/OT，只做"文件版本 + 三方合并" | 目标是按文件同步，不是协同编辑同一段文字；要支持二进制、支持任意外部工具写盘、支持离线任意时长 | 同一文件同一行的并发修改只能出冲突副本，不能自动收敛 |
| `revision`（文件级）与 `seq`（工作区级）分离 | 前者管并发（我要覆盖的是不是最新版），后者管续传（我漏了哪些事件）。混在一起就无法增量 | 多一张表、多一次事务内分配 |
| 推送只叫醒，不带内容 | 推送挂了不影响正确性，只是退化成轮询 | 每次变化多一次 HTTP 往返 |
| SQLite 单进程 `EXCLUSIVE` | 提交返回即已落盘，崩溃不会丢已确认的写；无需跨进程一致性设计 | 不能多进程/多节点，重启期间不可用 |
| 手写 WebSocket 帧 | 只为 `ws` 这一个用途引入完整 `ws` 服务端依赖不划算，且能精确控制 ping/close 语义 | 自己维护 RFC6455 细节（有测试覆盖） |
| `fast-diff` + patch 区间归并 | 判定"两个改动是否重叠"足够，不需要完整的 diff3 实现 | 相邻/交叉编辑按冲突处理（保守但安全） |
| 幂等键 | "提交成功但响应丢了"的重试不能变成"重复提交" | 多一张表、10 分钟窗口 |

## 6. 状态机（用户看到的状态栏）

| 状态 | 文案 | 含义 |
| --- | --- | --- |
| `Starting` | 正在打开工作区 | 首次全量对齐中（`primed=false`，增量让位） |
| `Syncing` | 同步中 | 有文件在处理，或本地未保存 |
| `Saved` | 工作区已同步 | 与服务器一致 |
| `Reconnecting` | 正在重新连接 | 推送通道断了但在重连（**不是**离线） |
| `Offline` | 离线 · 本地可编辑 | 服务器不可达，本地继续工作 |
| `Conflict` | 工作区有冲突 | 有冲突副本待处理 |
| `Error` | 工作区同步遇到问题 | 非瞬时错误（令牌、容量、路径等） |

## 7. 安全模型

- **身份**：共享令牌（= owner）或成员令牌 `lsw1.<id>.<secret>`（只存 sha256，可吊销）。角色 `viewer/editor/owner` 在服务端逐请求校验。
- **页面上限**：`/join` 含令牌明文，只对回环地址或已带对令牌的请求返回；经反代（`X-Forwarded-For`）一律要求令牌。
- **浏览器面**：默认拒绝带 `Origin` 的请求/升级，`LSW_ALLOW_ORIGINS` 白名单才放行。
- **路径**：NFC 归一、禁 `<>:"|?*` 与控制字符、禁 Windows 设备名、大小写冲突检测、父子路径互斥、禁符号链接。
- **传输**：远程必须 `wss://`；`ws://` 只允许回环。反代终止 TLS 时用 `LSW_TRUST_PROXY=1` 才认 `X-Forwarded-Proto`。

## 8. 已知边界

1. **一个进程 = 一个工作区**（`LSW_DOCUMENT_ID`）；多工作区需要多实例。
2. **单写者数据库**：不能滚动升级/多节点；重启窗口内不可用（客户端会自动恢复）。
3. **没有端到端加密**：服务器能看到文件明文（适合小组自建，不适合不可信服务商）。
4. **成员管理需停服**（`member-cli` 与服务端共用 EXCLUSIVE 数据库）。
5. **没有局域网自动发现**（mDNS 未做），加入靠链接/手填。
6. **同一行并发编辑不自动合并**：会产生冲突副本，需要人工选。
7. 上限为 4096 个路径和单文件 16 MiB。工作区总容量默认 128 MiB，可通过 `LSW_MAX_WORKSPACE_MIB` 调整，事件日志默认保留 4096 条/工作区。

## 9. 想改哪里

| 想做的事 | 动这些文件 |
| --- | --- |
| 加一个命令 / 改状态栏 | `src/extension.ts`（注册）、`src/project-session.ts`（状态与提示） |
| 改合并策略（比如引入 diff3） | `src/project-sync.ts` 的 `mergeText()` + `tests` 里的合并用例 |
| 改传输（换协议/加压缩） | `src/transport.ts` 纯函数层 + `server.mjs` 路由 |
| 换存储（Postgres/对象存储） | `workspace-store.mjs`、`seq-store.mjs`、`upload-store.mjs` 三个模块的接口，协议不动 |
| 上多节点 | 先换 `seq-store` 的序号分配（Postgres/Redis）+ `realtime.mjs` 加 Redis Pub/Sub 扇出 |
| 加局域网发现 | 新模块 + `project-session.ts` 的连接入口；协议不需要改 |
