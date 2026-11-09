# 跨电脑连接与部署

LSW 服务端默认只监听本机回环地址。小组正式使用时，可以让一台常在线的主机运行 LSW，再配置带证书的固定入口。成员各自在 VS Code 中填写同一地址、工作区 ID 和令牌。使用局域网做私有试用时，也可以通过 SSH 转发。

## 固定地址

1. 在服务主机安装 Node.js 24 或更新版本，复制或克隆本仓库，在根目录运行 `npm ci --omit=dev`。
2. 为服务设置 `LSW_HOST=127.0.0.1`、`LSW_PORT=1234`、一个 `LSW_DOCUMENT_ID`、一个 `LSW_TOKEN`，以及指向持久磁盘的 `LSW_DB_PATH`。令牌需为 24 至 1024 个无空格的可打印 ASCII 字符。每个服务实例对应一个工作区。重启沿用同一组配置。
3. 让系统服务管理器以专用普通账号运行 `npm start`，设为开机启动、失败后重启。把环境变量和数据库放在服务机的私密配置和数据目录里。可先用[只读预检脚本](../infra/preflight/linux-readonly.sh)检查主机资源。
4. 将实际域名指向服务主机，配置 HTTPS 入口，把 `/workspace/manifest` 和 `/workspace/file` 转发到本地 LSW，保留 `Authorization`、`If-Match` 请求头和 HTTP 请求方法。工作区模式在界面填 `wss://`，实际文件同步走同一域名下的 HTTPS 接口。

例如，用 Caddy 提供工作区和健康检查入口。将域名和端口替换为实际值，确保 DNS、证书和网络入口可用。已有站点时，可在现有代理中为 LSW 配独立域名。参考 [Caddy 反向代理](https://caddyserver.com/docs/quick-starts/reverse-proxy)。

```caddyfile
sync.example.com {
    @lsw path /healthz /workspace/manifest /workspace/file
    handle @lsw {
        reverse_proxy 127.0.0.1:1234
    }
    handle {
        respond 404
    }
}
```

从另一台电脑访问 `https://sync.example.com/healthz` 确认能到达服务，再在 VS Code 的连接窗口填 `wss://sync.example.com` 和实际的工作区 ID、令牌。用合成项目验证上传、下载、反向编辑、断线恢复和服务重启，再导入正式项目。旧单文件模式另有 WebSocket、`/persisted` 和 `/disk-edit` 接口，见[同步架构](architecture.md)。

当前小组共用一串令牌，持有令牌的成员可以修改和删除共享文件。可以把入口放在团队私有网络中并限制访问来源。若要移除某位持有者的权限，需要更换共享令牌并让保留的成员重新连接。数据库使用 SQLite WAL，运行时可用 SQLite `.backup` 生成一致性备份。参考 [SQLite 在线备份](https://sqlite.org/backup.html)。

## SSH 私有转发

服务主机开启 SSH，并允许组员登录和转发到 LSW 的回环端口。组员在各自电脑上运行下面同一条命令。`teamuser` 和主机名换成自己的 SSH 登录信息，末尾的 `1234` 要与主机上的 LSW 端口一致。参考 [OpenSSH `-L` 说明](https://man.openbsd.org/ssh#L)。

```powershell
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:1235:127.0.0.1:1234 teamuser@team-host.example.com
```

保持 SSH 连接，在 VS Code 填 `ws://127.0.0.1:1235`，再填主机的工作区 ID 和令牌。服务主机自己的 VS Code 可直接填 `ws://127.0.0.1:1234`。SSH 通道关闭后，恢复转发即可让 LSW 继续重试。
