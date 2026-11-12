# 远程部署

把协作服务放到"组员都能连到、且不会半夜掉线"的位置，有四条可选路径。按你的条件选一条，别混着做。

| 你的条件 | 选它 | 公网 IP | 证书 | 适合人数 |
| --- | --- | --- | --- | --- |
| 有一台云服务器 | [A. 云主机 + Caddy](#a-云主机--caddy推荐) | 需要 | Caddy 自动签发 | 3–30 |
| 有服务器但用 Nginx 站群 | [B. Nginx 反代](#b-nginx-反代) | 需要 | 自己管 | 3–30 |
| 没有公网 IP（宿舍/家里宽带） | [C. Cloudflare Tunnel 或 Tailscale](#c-没有公网-ip) | 不需要 | 隧道自带 | 3–10 |
| 只有 2–3 人，临时用 | [D. SSH 转发](#d-小规模临时ssh-转发) | 不需要 | 不需要 | 2–3 |

> **想省事直接上 A 档**：仓库里有现成的一键部署包 [`infra/deploy`](../infra/deploy/README.md)。买好 Ubuntu 云主机后，在本地仓库根目录跑
> `.\infra\deploy\deploy.ps1 -Server <公网IP>` 即可（无域名也行，会自动用 `<IP>.sslip.io` 签证书）。
> 它打包你**当前本地提交**上传部署，所以不依赖是否已 push；重复执行可原地升级，数据与令牌保留。
> Caddy 那四条关键设置（关缓冲、关读超时、8 MB 请求体、`X-Forwarded-*`）已由 `node scripts/verify-caddy-proxy.mjs` 用真实 Caddy 进程验证（7/7）。

无论哪条路径，**先做这两件事**，否则后面所有排查都是在猜：

1. 确认服务端能公网监听（0.3 起需显式开关，这是防误暴露的设计）：
   ```bash
   LSW_BIND_PUBLIC=1 LSW_HOST=0.0.0.0 LSW_PORT=1234 \
   LSW_TOKEN='<24-1024位无空格可打印ASCII>' \
   LSW_DOCUMENT_ID='<工作区UUID>' \
   LSW_DB_PATH=/var/lib/folder-relay/collaboration.sqlite3 \
   node apps/collab-server/src/server.mjs
   ```
2. 拿 `curl` 打一发健康检查，确认链路通了再开 VS Code：
   ```bash
   curl -sS https://sync.example.com/healthz
   # {"status":"ok","seq":42,"sockets":1,"uptimeMs":123456,"version":"0.3.0","stopping":false}
   ```

## 启动方式：systemd

不要用 `npm start` 挂终端。远程协作的稳定性一半来自"进程崩了会被拉起来、发版时能优雅重启"。

```ini
# /etc/systemd/system/folder-relay.service
[Unit]
Description=Folder Relay collaboration server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=relay
Group=relay
WorkingDirectory=/opt/folder-relay
EnvironmentFile=/etc/folder-relay/env
ExecStart=/usr/bin/node apps/collab-server/src/server.mjs
Restart=always
RestartSec=2
# 优雅停机：服务端收到 SIGTERM 后广播 reset 并以 1012 关闭 WS，等 10s 落盘
KillSignal=SIGTERM
TimeoutStopSec=15
LimitNOFILE=65536
# 只让服务读写自己的状态目录
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/folder-relay
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```bash
# /etc/folder-relay/env  （chmod 600，属主 relay）
LSW_BIND_PUBLIC=1
LSW_HOST=127.0.0.1          # 只让反代连，别直接对公网开端口
LSW_PORT=1234
LSW_TOKEN=替换成随机串
LSW_DOCUMENT_ID=替换成UUID
LSW_DB_PATH=/var/lib/folder-relay/collaboration.sqlite3
LSW_DATA_DIR=/var/lib/folder-relay
LSW_TRUST_PROXY=1           # 反代后置；直连 TLS 时删掉
LSW_HEARTBEAT_MS=25000
LSW_EVENT_LOG_SIZE=4096
```

```bash
sudo useradd --system --home /var/lib/folder-relay relay
sudo install -d -o relay -g relay /var/lib/folder-relay
sudo systemctl daemon-reload && sudo systemctl enable --now folder-relay
sudo systemctl status folder-relay --no-pager
```

`Restart=always` + `TimeoutStopSec=15` 是远程场景的硬要求：前者保证崩溃自愈，后者给优雅停机留出广播 `reset` 和落盘的时间。

## A. 云主机 + Caddy（推荐）

Caddy 原生支持 WebSocket，不需要额外配置 `Upgrade` 头；证书自动申请和续期。

```caddyfile
sync.example.com {
    encode zstd gzip

    # 长连接不能被超时掐死：事件流可能长时间只有心跳
    reverse_proxy 127.0.0.1:1234 {
        flush_interval -1
        transport http {
            read_timeout 0
            write_timeout 0
            dial_timeout 5s
        }
    }

    # 分片上传单块 ≤ 512 KiB，整文件走多块；留 8 MiB 余量给旧整块 PUT
    request_body {
        max_size 8MB
    }

    log {
        output file /var/log/caddy/folder-relay.log {
            roll_size 20MiB
            roll_keep 5
        }
        # 别把 Authorization 头写进日志
        format json {
            fields {
                request>headers>Authorization delete
            }
        }
    }
}
```

要点：

- `flush_interval -1` 关掉响应缓冲，否则 WS 帧会被攒着发，心跳看起来"没到"。
- `read_timeout 0`：Caddy 默认对后端有超时，长连接会被掐。这是"每 N 秒重连一次"最常见的原因。
- `request_body max_size` 与协议里的分片大小对齐；设太小会让大文件在反代层就 413，看起来像服务端 bug。

## B. Nginx 反代

Nginx 的默认值**全部**对长连接不友好，四项都要改：

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 443 ssl http2;
    server_name sync.example.com;

    ssl_certificate     /etc/letsencrypt/live/sync.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/sync.example.com/privkey.pem;

    client_max_body_size 8m;

    location / {
        proxy_pass http://127.0.0.1:1234;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # WebSocket 升级（/v1/events）
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection $connection_upgrade;

        # 关键：默认 60s 会掐断事件流，表现为「每 60 秒重连一次」
        proxy_read_timeout  3600s;
        proxy_send_timeout  3600s;

        # 分片上传不要缓冲到磁盘再转发
        proxy_request_buffering off;
        proxy_buffering off;
    }
}
```

自查命令（登不上之前先跑这个）：

```bash
curl -sS -o /dev/null -w '%{http_code}\n' https://sync.example.com/healthz           # 期望 200
curl -sS -o /dev/null -w '%{http_code}\n' https://sync.example.com/workspace/manifest  # 期望 401（说明到了服务端且鉴权生效）
```

## C. 没有公网 IP

### C1. Cloudflare Tunnel（推荐给宿舍/家庭宽带）

不需要公网 IP、不需要开端口、自带 TLS 与 WS 支持。

```bash
# 服务器上（被协作的那台常在线机器）
cloudflared tunnel login
cloudflared tunnel create folder-relay
cloudflared tunnel route dns folder-relay sync.example.com
cloudflared tunnel run --url http://127.0.0.1:1234 folder-relay
```

或在 `~/.cloudflared/config.yml`：

```yaml
tunnel: folder-relay
credentials-file: /etc/cloudflared/<tunnel-id>.json
ingress:
  - hostname: sync.example.com
    service: http://127.0.0.1:1234
    originRequest:
      noTLSVerify: false
      connectTimeout: 10s
      tcpKeepAlive: 30s
  - service: http_status:404
```

注意事项：

- **免费版对长连接有软限制**，事件流被重置时客户端会走抖动退避自动重连，功能不受影响，只是延迟毛刺变多。人多时把 `LSW_HEARTBEAT_MS` 调到 20000–25000 减少重连频率。
- `tcpKeepAlive: 30s` 别关，NAT 表项靠它保活。
- 服务端保留 `LSW_BIND_PUBLIC=1`（`cloudflared` 从本机回环连也行，但显式打开更省事）。

### C2. Tailscale（组内小范围、不想暴露公网）

给每位成员和服务器各装 Tailscale，组成一个私有网段，直接用 `100.x.y.z` 互访。适合"只有我们几个人"，不适合对外。

```bash
# 服务器
tailscale up --hostname relay
tailscale serve --bg 1234                       # 生成 https://relay.<tailnet>.ts.net
# 成员：VS Code 填 wss://relay.<tailnet>.ts.net
```

`tailscale serve` 自带有效证书，VS Code 的 `wss://` 校验直接通过；不需要再配 Caddy。**这条路最省事，也最稳**（WireGuard 直连打洞，握手失败才走 DERP 中继）。

### C3. frp（自有中转机）

有一台公网小机器但不想把项目放上去时：

```toml
# frps.toml（公网侧）
bindPort = 7000
vhostHTTPSPort = 443
```

```toml
# frpc.toml（跑协作服务的那台）
serverAddr = "relay.example.com"
serverPort = 7000
[[proxies]]
name = "folder-relay"
type = "https"
customDomains = ["sync.example.com"]
localIP = "127.0.0.1"
localPort = 1234
```

frp 的 `https` 类型会透传 WebSocket，但要在公网侧自己配证书（`plugin = "https2http"` 或前置 Caddy）。

## D. 小规模临时：SSH 转发

两三人临时用，最省资源。关键是加保活，否则 SSH 空闲会被掐：

```powershell
ssh -N `
  -o ExitOnForwardFailure=yes `
  -o ServerAliveInterval=15 -o ServerAliveCountMax=3 `
  -o TCPKeepAlive=yes `
  -L 127.0.0.1:1235:127.0.0.1:1234 teamuser@team-host.example.com
```

然后 VS Code 里填 `ws://127.0.0.1:1235`。这条通道上推的也是 0.3 协议，功能完整，只是每人要各自起一条隧道。

## 加入方式：一键链接（推荐，替代手抄）

手抄「wss 地址 + 工作区 UUID + 32 位令牌」是加入失败的头号原因（令牌抄错一位、中文输入法打成全角、`wss` 写成 `ws`）。0.3 起服务端提供加入信息页，把三样东西折成一个链接：

```bash
npm start
# {"event":"listening","host":"127.0.0.1","port":1234,...}
# 加入信息页（发给人前先自己看一眼）：http://127.0.0.1:1234/join
```

在**跑服务的那台机器**上打开 `/join`，页面给出：

- 一键加入链接：`vscode://lsw-local.latex-sync-workspace/join?url=…&workspace=…&token=…`
- 三行可单独复制的地址 / 工作区 ID / 令牌（备用）

把这个链接丢进微信/QQ 发给组员，对方**点开就会唤起 VS Code** 并自动填好三项，不用手抄。也可以在已连接的 VS Code 里执行 `LSW: Copy Join Link` 直接复制。

> **安全边界**：`/join` 页面含令牌明文。服务端只在 **回环地址**（发起人本机）或 **已带对 Bearer 令牌**时才返回；经反向代理转发（`LSW_TRUST_PROXY=1` 或带 `X-Forwarded-For`）时一律要求令牌，避免"能访问端口就能拿到钥匙"。

### 关于二维码

二维码不是另一种连接方式，它只是**把同一个链接画成图片**。所以：

```text
现在：链接 ──(任意二维码工具)──► 图片 ──► 手机扫码 ──► 得到同一条链接
```

结论与取舍：

| 场景 | 更顺的做法 | 原因 |
| --- | --- | --- |
| 电脑 A → 电脑 B（最常见） | **一键链接** | 微信/QQ 点一下就完事；二维码还得用手机在中间转一手 |
| 投屏/教室，一次发给一屋子人 | **二维码**（把 `/join` 的链接生成二维码投屏） | 大屏上的长链接没人会手抄，扫码最省事 |
| 手机 ↔ 电脑 | 二维码 | 手机有摄像头和扫码入口，这是它唯一明显强于链接的场景 |

要二维码不需要改扩展：把 `/join` 页面里的链接丢进任意二维码生成器（或系统自带的"分享为二维码"）即可，扫出来就是同一条 `vscode://` 链接。**真正值得做的下一步是局域网自动发现**（mDNS/多播广播 `_folderrelay._tcp`，扩展列出"附近的共享工作区"，点一下就连接），它比扫码更符合桌面场景，也不需要摄像头。这一步尚未实现。

## E. 同一 WiFi / 校园网直连（局域网明文，零部署）

适合"都在同一个教室 WiFi"或比赛现场：一台电脑当服务器，其他人直接填它的内网 IP。**不需要云主机、不需要域名、不需要证书、不需要隧道。**

代价：流量在该局域网内**不加密**（`ws://`），同网段的人理论上可嗅探。所以它只适合可信局域网；跨互联网请用 A/B/C。

### 1. 当服务器的那台

```powershell
cd <仓库根目录>
$env:LSW_BIND_PUBLIC="1"          # 显式允许非回环绑定（防误暴露的设计）
$env:LSW_HOST="0.0.0.0"
$env:LSW_PORT="1234"
$env:LSW_TOKEN="自定一串24位以上、无空格的随机串"
$env:LSW_DOCUMENT_ID="11111111-1111-4111-8111-111111111111"
npm start
```

看到 `{"event":"listening","host":"0.0.0.0","port":1234,...}` 即已就绪。查自己的内网 IP：

```powershell
ipconfig | Select-String "IPv4"     # 取 192.168.x.x / 10.x.x.x / 172.16-31.x.x
```

**放行 Windows 防火墙**（管理员 PowerShell；这一步最容易被忽略）：

```powershell
New-NetFirewallRule -DisplayName "Folder Relay 1234" -Direction Inbound -Action Allow `
  -Protocol TCP -LocalPort 1234 -Profile Any
```

### 2. 其他人先验连通

```powershell
Test-NetConnection 192.168.1.23 -Port 1234     # 换成服务器那台的 IP
```

`TcpTestSucceeded : True` 才继续。

### 3. VS Code 里连接

- 服务器那台自己：填 `ws://127.0.0.1:1234`（回环，不需要勾选）。
- 其他人：填 `ws://192.168.1.23:1234`，**并勾选连接窗口里的「同一 WiFi / 校园网直连（局域网明文）」**。不勾选会被客户端以"ws:// 只允许回环"拒绝——这是刻意的安全默认，防止手滑把明文连接发到公网。
- 工作区 ID 与令牌和服务器那台一致。

> 想让同学点链接就进：服务器那台**自己也用内网 IP 连接**并勾选，再执行 `LSW: Copy Join Link`；链接会自动带 `insecure=1`。若自己连的是 `127.0.0.1`，生成的链接只对本机有效。

### 4. 失败对照

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `Test-NetConnection` 不通 | 校园网开了**客户端隔离**（同一 WiFi 也互相不可见） | 换手机热点再试；仍不行改用 C 档 Cloudflare Tunnel |
| 服务器本机 `curl http://127.0.0.1:1234/healthz` 通、别人不通 | 防火墙没放行 | 执行上面的 `New-NetFirewallRule`，注意 `-Profile Any` |
| 客户端提示"远程地址必须用 wss://" | 没勾选「局域网明文」 | 勾选后重试 |
| 状态栏一直"正在重新连接" | 服务端没起 / 端口或 IP 错 | 看服务器终端有没有 `listening` 行 |
| 连上但不同步 | 工作区 ID 或令牌抄错 | 用 `LSW: Copy Join Link` 代替手抄 |

## 弱网验收（上线前必须做一次）

不要只用办公室 WiFi 测。用 [Clumsy](https://jagt.github.io/clumsy/)（Windows）或 `tc netem`（Linux）造这三种网络各跑 3 分钟：

```bash
# Linux 发送端模拟：200ms RTT + 1% 丢包 + 20ms 抖动
sudo tc qdisc add dev eth0 root netem delay 100ms 20ms loss 1%
# 撤销
sudo tc qdisc del dev eth0 root
```

| 验收项 | 通过标准 |
| --- | --- |
| 编辑可见延迟 | A 保存后，B 的文件在 **300 ms 内**出现新内容（`scripts/bench-remote.mjs` 的 p95） |
| 断网恢复 | 拔网线 60 s 再插回：无需点任何按钮，30 s 内回到 `Saved`；期间本地编辑不丢 |
| 服务端重启 | `systemctl restart folder-relay`：客户端 5 s 内自动回到 `Saved`，无冲突副本产生 |
| 大文件 | 16 MiB 文件在 1% 丢包下上传成功；人为中断后重试从断点继续（日志里能看到 offset 递增） |
| 代理超时 | 静置 30 分钟不动：不出现"连接断开/重连"刷屏（说明心跳与反代超时配对正确） |
| 空转成本 | `scripts/bench-remote.mjs --mode push` 的 `requests` 为 0，`frames` ≈ 窗口内心跳数 |

## 常见故障对照

| 现象 | 最可能原因 | 处理 |
| --- | --- | --- |
| 连接窗口提示"连不上协作服务器" | 反代没转发 `/workspace/manifest`，或 DNS/证书不对 | `curl` 上面两条自查命令 |
| 状态一直"同步中" | 反代缓冲了响应（缺 `flush_interval -1` / `proxy_buffering off`） | 按 A/B 段补配置 |
| 每 60 秒重连一次 | Nginx `proxy_read_timeout` 默认值 | 改成 3600s |
| 大文件 413 | 反代 `client_max_body_size` 太小 | 提到 8m，走分片协议 |
| 401 但令牌没错 | 反代改了请求方法或丢了 `Authorization` 头 | 检查 `proxy_set_header`；Caddy 默认透传 |
| 重启后全员卡在"离线" | 缺优雅停机（`KillSignal`/`TimeoutStopSec`）或客户端退避太长 | 用上面的 unit；看客户端日志的 close code 是否 1012 |
| 上游 `X-Forwarded-For` 拿不到真实 IP | 没开 `LSW_TRUST_PROXY=1` 或反代没设头 | 两者都要 |
