# 一键部署：云主机 + Caddy + Folder Relay

目标：把协作服务放到一台 24 小时在线的公网小机器上，组员只填一个 `wss://` 地址。

全程只需要你在本地 Windows 上跑**一条命令**。买机器和改 DNS 需要你自己的账号，其余都由脚本完成。

## 阿里云 ECS 必读（其他厂商同理）

| 事项 | 说明 |
| --- | --- |
| **安全组** | 控制台 → 实例 → 安全组 → 入方向放行 **22（SSH）、80（证书签发）、443（同步）**。默认只开 22，这一步不做后面一定连不上 |
| **镜像** | Ubuntu 24.04 LTS 最省事；**Alibaba Cloud Linux 3 / Anolis 也支持**（脚本会自动走 dnf 路径，Node 与 Caddy 用官方静态二进制，不依赖发行版仓库） |
| **大陆地域 + 域名** | 未做 ICP 备案的域名访问 80/443 会被拦，Let's Encrypt 会签不出证书 → 用下面的 Cloudflare Tunnel 路线，或换香港/新加坡地域 |
| **只有内网 IP** | 需要绑定弹性公网 IP（EIP），否则外网不可达 |
| **配置** | 2 核 2 GB 对你完全够用（本服务内存占用几十 MB）；盘 20 GB 足够 |

### 两种入口怎么选

| 你的情况 | 用哪种 | 命令 |
| --- | --- | --- |
| 有已备案域名（或选香港/新加坡地域） | Caddy 直接签证书 | `.\deploy.ps1 -Server <IP> -Domain sync.example.com` |
| **没有域名**（不想买、不想注册任何账号） | **Quick Tunnel**：免费临时地址，5 分钟能用；缺点是**每次重启地址会变** | `.\deploy.ps1 -Server <IP> -QuickTunnel` |
| 没有域名但想地址稳定 | 有 Cloudflare 账号 + 任意域名（十几元/年）→ 命名隧道 | `.\deploy.ps1 -Server <IP> -TunnelToken <token>` |
| 没有域名，也不想装隧道 | Caddy + `<IP>.sslip.io` 免费解析（大陆地域可能被 80 端口拦截） | `.\deploy.ps1 -Server <IP>` |

Cloudflare Tunnel 的 token 获取：Cloudflare 面板 → Zero Trust → Networks → Tunnels → Create a tunnel（选 Cloudflared）→ 复制安装命令里 `--token` 后面那串；再在该隧道的 Public Hostname 里把域名指向 `http://127.0.0.1:1234`。


### 三种"没有域名"的做法，怎么选

| | 需要注册账号 | 地址稳定 | 组员要装东西 | 适合 |
| --- | --- | --- | --- | --- |
| `-QuickTunnel` | 不需要 | ❌ 重启会变 | 不需要 | 今天就要用、临时协作 |
| `-TunnelToken`（命名隧道） | Cloudflare（免费）+ 一个域名 | ✅ | 不需要 | 长期用，最推荐 |
| 无参数（sslip.io） | 不需要 | ✅（`IP.sslip.io` 固定） | 不需要 | 香港/新加坡地域；大陆地域要看 80 端口是否被备案拦截 |

Quick Tunnel 的当前地址随时可查：服务器上执行 `relay-url`。

## 0. 先买一台（约 5 分钟）

| 要求 | 值 | 说明 |
| --- | --- | --- |
| 配置 | 1 核 / 512 MB–1 GB / 20 GB 系统盘 | 够 10 人级文件同步；本服务只需几十 MB 内存 |
| 镜像 | **Ubuntu 24.04 LTS**（或 22.04） | 脚本按 apt 写；Debian 12 也可 |
| 带宽 | 1–3 Mbps 足够 | 只传变更文件，不是流量大户 |
| 安全组 | 放行 **22、80、443** | 80 用于证书签发，443 用于同步 |
| 登录方式 | root + 密码，或 Ubuntu 镜像的 `ubuntu` 用户 + 密钥 | 脚本两种都支持 |

> 便宜档常见是"轻量应用服务器 / 共享型 / 学生机"。价格随活动浮动，按官网现价选最便宜的那档即可，**不要**为了这点负载买高配套餐。

**没有域名也能上 HTTPS**：脚本会用 `<公网IP>.sslip.io` 这种免费解析（`1.2.3.4.sslip.io` 会解析到该 IP），Caddy 能正常签发证书。等你有域名了再重新跑一次 `--Domain` 即可。

## 0.5 先体检（不改服务器）

```powershell
.\infra\deploy\deploy.ps1 -Server <IP> -Preflight
```

输出会告诉你：发行版、架构、内存/磁盘、是否已有 node/caddy、80/443/1234 是否被占、能否访问 nodejs.org 与 github.com、SELinux 状态。**装之前先看这个，能省掉大半排障。**


## 1. 部署（一条命令）

在**本仓库根目录**打开 PowerShell：

```powershell
# 没有域名（自动用 sslip.io）
.\infra\deploy\deploy.ps1 -Server 1.2.3.4

# 有域名（先在 DNS 里加 A 记录指向 1.2.3.4，等生效）
.\infra\deploy\deploy.ps1 -Server 1.2.3.4 -Domain sync.example.com

# 用密钥 + 非 root 用户（该用户需 sudo 免密）
.\infra\deploy\deploy.ps1 -Server 1.2.3.4 -User ubuntu -IdentityFile $env:USERPROFILE\.ssh\id_ed25519
```

脚本做的事（幂等，可重复执行）：

1. `git archive HEAD` 打包**当前本地提交**——所以就算你还没 push，部署上去的也是本地这份；
2. 上传到 `/tmp` 并在服务器上执行 `bootstrap.sh`；
3. 服务器侧：装 Node 24 与 Caddy → 建 `relay` 系统账号 → 生成令牌与工作区 ID → 写 systemd 单元 → 渲染 Caddyfile（从本仓库的模板）→ 开 ufw → 启动 → 自检；
4. 回到本地验证 `https://<站点>/healthz` 与 `/v1/config`。

首次约 **2–4 分钟**（主要是 apt 装 Node 与 Caddy）。

## 2. 把链接发给组员

```powershell
# 在服务器上看加入信息（含令牌，别贴公开群）
ssh root@1.2.3.4 "curl -s -H 'Authorization: Bearer $(grep ^LSW_TOKEN /etc/folder-relay/env | cut -d= -f2)' https://localhost/join >/dev/null; cat /etc/folder-relay/env"
```

更简单的方式：在任意一台**已连接**的机器上执行 `LSW: Copy Join Link`，把链接发给组员。对方点一下就会自动填好地址 / 工作区 / 令牌。

## 3. 验证清单

```powershell
# 1. 健康检查（应返回 status ok）
curl.exe -s https://sync.example.com/healthz

# 2. 能力协商（应返回 proto 1 与 features 列表）
curl.exe -s https://sync.example.com/v1/config

# 3. 反向代理语义自检（在本机跑，用真实 Caddy 进程验证 WS/心跳/Range/鉴权）
node scripts/verify-caddy-proxy.mjs
```

`verify-caddy-proxy.mjs` 在本机拉起真实 Caddy + 真实服务端，检查 7 项：TLS 可达、WS 升级、心跳不被缓冲、提交、事件推送、Range 206、令牌鉴权。**它在开发机上跑过了（7/7）**，说明模板里那四条设置是对的：

- `flush_interval -1`：关响应缓冲，否则 WS 帧被攒着发，心跳像"没到"；
- `read_timeout 0`：长连接默认会被反代超时掐死（表现为"每 60 秒重连一次"）；
- `request_body max_size 8MB`：分片单块 ≤ 512 KiB，旧整块 PUT 留余量；
- `X-Forwarded-*`：服务端 `LSW_TRUST_PROXY=1` 依赖它判断 `wss://` 与 `/join` 的可见性。

## 4. 日常运维

```bash
systemctl status folder-relay caddy      # 状态
journalctl -u folder-relay -f            # 服务端日志
tail -f /var/log/caddy/folder-relay.log  # 反代访问日志
systemctl restart folder-relay           # 重启（客户端 5 秒内自动恢复）

# 改版升级（本地改完直接重跑 deploy.ps1 即可；数据与令牌保留）
# 成员管理（需先停服，因为 SQLite 是单进程独占）
systemctl stop folder-relay
node /opt/folder-relay/apps/collab-server/src/member-cli.mjs add --name alice --role editor
node /opt/folder-relay/apps/collab-server/src/member-cli.mjs list
systemctl start folder-relay

# 备份（一致性快照）
sqlite3 /var/lib/folder-relay/collaboration.sqlite3 ".backup '/root/relay-$(date +%F).sqlite3'"
```

## 5. 排障对照

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 浏览器打不开 `https://域名`，提示证书错误 | DNS 还没生效 / 80 端口没放行 | `dig +short 域名`、检查安全组 |
| `healthz` 200 但 VS Code 连不上 | 地址填成了 `https://` | 客户端要填 `wss://域名` |
| 状态栏每 60 秒重连一次 | 反代读了默认超时 | 确认用的是本仓库模板（`read_timeout 0`） |
| 大文件 413 | 反代请求体上限太小 | 模板里是 8MB；若自己改过要同步放大 |
| `join` 页面 401 | 反代后必须带令牌（安全设计） | 用 `LSW: Copy Join Link` 或带 `Authorization` 头访问 |
| 部署脚本报 `Node 版本过低` | 发行版自带的 node 太老 | 重跑一次让脚本装 NodeSource 的 24.x |

## 6. 这套部署没做的事

- **没有监控/告警**：只有 systemd 的 `Restart=always` 与 `/healthz`。要告警可外挂 Uptime Kuma 之类。
- **没有多节点/高可用**：SQLite 单进程独占，重启期间服务短暂不可用（客户端会自动恢复）。
- **没有端到端加密**：服务器能看到文件明文，适合自己小组用；不要把不可信第三方加进来。
- **没有自动备份**：上面的 `sqlite3 .backup` 需要你自己挂 cron。
