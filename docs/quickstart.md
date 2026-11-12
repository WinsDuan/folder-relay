# Folder Relay 使用教程

Folder Relay 用来在多台电脑的 VS Code 之间同步一个项目文件夹。发起人启动共享服务，并在 VS Code 中将本地项目连接到该服务。组员用自己的本地文件夹加入。成员保存代码、LaTeX、数据、图片或 Office 文档后，其他人会收到对应的文件更新。

本教程适用于 Folder Relay v0.3.2。下载文件集中在 [GitHub 发布页](https://github.com/WinsDuan/folder-relay/releases/tag/v0.3.2)。 [PDF 操作手册](https://github.com/WinsDuan/folder-relay/releases/download/v0.3.2/Folder-Relay-Windows-Guide.pdf)

## 组员怎么加入

组员准备 **VS Code 1.96 或更新版本**和 [Folder Relay Office 版 VSIX](https://github.com/WinsDuan/folder-relay/releases/download/v0.3.2/latex-sync-workspace-0.3.2-office.vsix)。组员的步骤在 VS Code 里完成。服务端和云隧道由发起人运行。

1. 在 VS Code 打开 **扩展 → … → 从 VSIX 安装**，选择发起人发来的 `.vsix`。如果提示重新加载，点 **重新加载**。也可以在命令面板搜索 **Extensions: Install from VSIX**。
2. 首次加入时，新建一个空文件夹，用 **文件 → 打开文件夹** 单独打开它。以后继续协作就打开这一个文件夹。
3. 按 `Ctrl+Shift+P`，运行 **`LSW: Join Shared Project`**。填发起人提供的**服务器地址、工作区 ID、访问令牌**。
4. 用 `wss://` 地址时，保持「同一 WiFi / 校园网直连」未勾选。发起人给的是可达的局域网 `ws://` 地址时，勾选该项。
5. 点 **连接工作区**。文件会陆续下载，进度看 VS Code 底部的 Folder Relay 状态。显示 **工作区已同步** 后，就可以开始协作。

校园网直连和 Office 文件右键菜单都包含在本页链接的 VSIX 中。发起人和组员可用同一个安装包。

## 发起人怎么开共享

下面用 Windows PowerShell 演示。先安装 **Node.js 24 或更新版本**，在发布页下载并解压 **Source code (zip)**，然后用上面的 VSIX 安装扩展。准备一个用于共享资料的项目文件夹，第一次可以先放一个 `测试.md`。 [Node.js 下载](https://nodejs.org/en/download) · [Folder Relay v0.3.2 发布页](https://github.com/WinsDuan/folder-relay/releases/tag/v0.3.2)

### 1. 启动 Folder Relay 服务

打开 PowerShell，执行下面的命令。提示输入路径时，粘贴解压后含 `package.json` 和 `package-lock.json` 的**源码根目录**。确认 `node --version` 显示 24 或更新版本后安装依赖。

```powershell
Set-Location -LiteralPath ((Read-Host '请输入 Folder Relay 源码目录的完整路径').Trim('"')) -ErrorAction Stop
node --version
npm.cmd ci
```

依赖安装成功后，在同一个窗口粘贴下面这段。**这段用于创建一个全新的共享项目**。

```powershell
$env:LSW_HOST = '127.0.0.1'
$env:LSW_PORT = '1234'
$env:LSW_BIND_PUBLIC = '0'
$env:LSW_TRUST_PROXY = '1'
$env:LSW_DOCUMENT_ID = [Guid]::NewGuid().ToString()
$env:LSW_DB_PATH = Join-Path $PWD "data\quickstart-$($env:LSW_DOCUMENT_ID)\workspace.sqlite3"
$env:LSW_TOKEN = [Guid]::NewGuid().ToString('N')

Write-Host "工作区 ID  $env:LSW_DOCUMENT_ID"
Write-Host "访问令牌   $env:LSW_TOKEN"
Write-Host "数据库路径 $env:LSW_DB_PATH"
Set-Clipboard -Value $env:LSW_TOKEN
npm.cmd start
```

看到 `listening` 就保持窗口开着。把终端打印的**工作区 ID、令牌和数据库路径**私下保存好，下次开机还要用。

发起人用 VS Code **打开装有共享资料的项目文件夹**，运行 `LSW: Join Shared Project`，地址填 `ws://127.0.0.1:1234`，填上 ID 和令牌，保持校园网直连未勾选。等底部显示「工作区已同步」，再运行 `LSW: Show Project Status` 查看共享文件数。启动 PowerShell 服务后，还需要这个 VS Code 窗口把文件上传到工作区。邀请组员前，确认发起人这边能看到已同步的测试文件。

### 2. 给不同电脑提供连接地址

**不同网络或校园网直连超时时**，可以由发起人运行 Cloudflare Quick Tunnel。Windows x64 发起人可以直接下载并运行 [cloudflared-windows-amd64.exe](https://github.com/WinsDuan/folder-relay/releases/download/v0.3.2/cloudflared-windows-amd64.exe)。其他系统按官方说明安装后，用 `cloudflared tunnel --url http://127.0.0.1:1234` 启动。 [Cloudflare 官方下载说明](https://developers.cloudflare.com/tunnel/downloads/)

保留 Folder Relay 服务窗口，另开一个 PowerShell 执行下面的命令。提示输入路径时，粘贴下载的 `cloudflared-windows-amd64.exe` 的完整路径。

```powershell
$relayCloudflared = (Read-Host '请输入 cloudflared 可执行文件的完整路径').Trim('"')
& $relayCloudflared tunnel --url http://127.0.0.1:1234
```

看到 `Registered tunnel connection` 后，复制终端给出的 `https://…trycloudflare.com` 域名，把开头换成 `wss://`。把它和**工作区 ID、令牌**私发给组员。发起人继续用本机的 `ws://127.0.0.1:1234`。两个地址都通向同一个工作区。共享期间保持 Folder Relay 和 cloudflared 两个窗口开着。隧道提供临时公网入口，文件访问由 Folder Relay 令牌控制。 [Cloudflare Quick Tunnel 说明](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)

如果你沿用的是已经监听局域网 IP 的服务，把 `--url` 后的地址换成服务实际监听的 HTTP 地址和端口。

**同一个可互通的局域网**可以用内网 IP 直连。发起人在 Windows 执行 `ipconfig`，查找当前 Wi-Fi 或以太网适配器的 IPv4 地址。回到服务窗口按 `Ctrl+C`，等待命令提示符出现，再运行下面的命令并输入查到的 IPv4。

```powershell
$env:LSW_HOST = Read-Host '请输入发起人电脑的局域网 IPv4'
$env:LSW_BIND_PUBLIC = '1'
$env:LSW_TRUST_PROXY = '0'
npm.cmd start
```

两边填写 `ws://发起人IPv4:1234`，使用同一套 ID 和令牌，并勾选校园网直连。Windows 防火墙需要允许组员访问该端口。局域网直连是明文连接，适合互相信任的网络。发起人如果此前已经绑定过本机地址，先在原项目运行 `LSW: Leave Shared Project`，再用局域网地址加入同一个项目。

端口连不上时，Windows 组员可在 PowerShell 中运行下面的检查。输入发起人的 IPv4，查看 `TcpTestSucceeded` 是否为 `True`。

```powershell
Test-NetConnection -ComputerName (Read-Host '请输入发起人的局域网 IPv4') -Port 1234
```

如果本机服务正常，但 Windows 防火墙挡住了组员，发起人可在**管理员 PowerShell**中临时允许该组员的局域网 IPv4 访问 TCP 1234。校园网隔离设备时，使用云隧道。

```powershell
$relayPeerIp = Read-Host '请输入组员的局域网 IPv4'
New-NetFirewallRule -Name 'FolderRelayTest' -DisplayName 'Folder Relay Test' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 1234 -RemoteAddress $relayPeerIp
```

协作结束后，在管理员 PowerShell 移除临时规则。

```powershell
Remove-NetFirewallRule -Name 'FolderRelayTest'
```

### 3. 发给组员的消息模板

```text
先安装我发给你的 Folder Relay VSIX，再在 VS Code 打开一个新建的空文件夹。
按 Ctrl+Shift+P，运行 LSW: Join Shared Project。

服务器地址  <发起人提供的地址>
工作区 ID   <服务启动时打印的工作区 ID>
访问令牌    <服务启动时打印的令牌>

wss:// 地址保持校园网直连未勾选。局域网 ws:// 地址需要勾选直连。
连接后，等 VS Code 底部显示「工作区已同步」。
```

## 怎么确认能双向同步

让组员打开 `测试.md`，加一行并按 **Ctrl+S**。发起人看到这一行后，再回写一行并保存。两边都看到对方的改动，就完成了双向验证。

同步以磁盘上保存的文件为准。VS Code 里手动编辑、AI 修改和脚本写入都可以同步。运行 Python 或编译 LaTeX 时，各自在自己的电脑上运行对应工具。首次加入要逐个下载项目文件，项目里的 PDF、数据包和历史副本会增加等待时间。

## 编辑 Word、Excel 和 PowerPoint

将 `.docx`、`.xlsx` 或 `.pptx` 放进已连接的共享文件夹，等对方收到。在 VS Code 资源管理器里右键选择 **Folder Relay: 在办公应用中打开**，用本机默认的办公应用编辑，然后保存到原路径。另一端收到完整文件的新版本。单文件上限为 16 MiB。

同一份文档适合轮流编辑。保存并关闭文档，再交给下一位成员。如果接收方还开着该文件，检测到 Office 的临时锁后，Folder Relay 会等文件关闭再应用收到的新版本。两边各自保存了不同版本时，可用 `LSW: Review Project Conflict` 查看保留的副本。

## 重启后继续原工作区

在原 PowerShell 窗口按 `Ctrl+C` 停止服务后，如果窗口仍开着，运行 `npm.cmd start` 即可继续使用该窗口里的配置。

重开了终端时，用下列命令恢复原配置。示例是本机或云隧道模式。使用局域网直连时，把 `LSW_HOST` 改为发起人的局域网 IPv4、`LSW_BIND_PUBLIC` 改为 `1`、`LSW_TRUST_PROXY` 改为 `0`。如果之前改过端口，填回 `LSW_PORT`。如果之前改过容量，在运行 `npm.cmd start` 前给 `LSW_MAX_WORKSPACE_MIB` 填回原值。

```powershell
Set-Location -LiteralPath ((Read-Host '请输入 Folder Relay 源码目录的完整路径').Trim('"')) -ErrorAction Stop
$env:LSW_HOST = '127.0.0.1'
$env:LSW_PORT = '1234'
$env:LSW_BIND_PUBLIC = '0'
$env:LSW_TRUST_PROXY = '1'
$env:LSW_DOCUMENT_ID = (Read-Host '请输入原工作区 ID').Trim()
$env:LSW_DB_PATH = (Read-Host '请输入原数据库的完整路径').Trim('"')
$relayToken = Read-Host '请输入原访问令牌' -AsSecureString
$env:LSW_TOKEN = [System.Net.NetworkCredential]::new('', $relayToken).Password
Remove-Variable relayToken
if (Test-Path -LiteralPath $env:LSW_DB_PATH -PathType Leaf) {
    npm.cmd start
} else {
    Write-Error '找不到原工作区数据库，请核对已保存的完整路径。'
}
```

## 下次继续、离线修改和冲突

- **组员下次继续**。打开上次已连接的本地文件夹。服务地址有效时，扩展会自动重连。
- **组员断网或关机**。保存过的改动保留在组员的电脑上。恢复连接后，Folder Relay 会比较本地与共享版本，并同步可应用的改动。
- **发起人关机**。其他人仍能编辑已经下载到本地的文件。恢复同步时，发起人按上面的[重启步骤](#重启后继续原工作区)启动原工作区。
- **临时隧道重新启动**。把新 `wss://` 地址发给组员。组员先把离线修改备份到共享目录外，再在原文件夹运行 `LSW: Leave Shared Project` 和 `LSW: Join Shared Project`，用新地址、原 ID 和原令牌连接。当前版本会按地址建立同步记录，换地址后同一文件的改动可能需要人工合并。 [Cloudflare 临时地址说明](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/)
- **同一个文件被两边修改**。有共同版本且文本改动不重叠时，Folder Relay 可以合并。出现「工作区有冲突」时，运行 `LSW: Review Project Conflict` 比较版本，整理并保存后，再运行 `LSW: Publish Resolved Project File`。 [详细冲突处理](project.md#日常编辑编译与离线)

## 常见问题

| 看到什么 | 怎么处理 |
| --- | --- |
| 同学连不上 | 核对服务器地址和直连开关。发起人确认服务在运行。使用云隧道时，可以先用浏览器打开当前 HTTPS 域名下的 `/healthz`，看到 `"status":"ok"` 表示请求已到服务端。 |
| 连接页面显示「正在同步」 | 以 VS Code 底部状态栏为准，也可以运行 `LSW: Show Project Status` 看具体状态。 |
| 已同步，但显示 0 个文件 | 发起人检查是否在 VS Code 打开了装有资料的项目文件夹，并用和组员相同的工作区 ID 加入。发起人可以新建一个 `同步测试.md`、写一行并保存，再看组员是否收到。 |
| 新建文件夹没出现 | 在文件夹内新建一个普通文件，写入内容并保存。目录会随里面的文件创建。 |
| 显示达到容量上限 | 检查是否选了过大的上级目录。单文件上限是 16 MiB，工作区总量默认 128 MiB。支持容量配置的服务端可在重启前设置 `LSW_MAX_WORKSPACE_MIB`。 |
| 想换成另一个新项目 | 双方先在旧目录运行 `LSW: Leave Shared Project`。发起人用新工作区 ID 和新数据库启动，组员用新的空目录加入。 |

需要让成员在发起人关机时继续互相同步，可以把服务部署到有固定地址的常在线主机。 [远程部署说明](deployment-remote.md) · [云主机部署脚本](../infra/deploy/README.md)
