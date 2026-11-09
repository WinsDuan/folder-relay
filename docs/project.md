# 共享工作区使用指南

每个共享项目由一个协作服务保存，成员用 VS Code 的 Folder Relay 扩展连接。发起人打开已有项目文件夹，其他成员首次加入时使用空文件夹。各自的目录位置可以不同，代码、Markdown、CSV、LaTeX 和图片按项目内的相对路径同步。命令仍以 `LSW:` 开头，服务环境变量也沿用 `LSW_` 前缀。

## 启动本机服务

服务主机需要 Node.js 24 或更新版本。在新建一个试用工作区时，从仓库根目录运行以下命令。示例用默认端口 `1234`、默认工作区 ID 和仓库下的 `data/collaboration.sqlite3`。令牌只在初始化时生成一次。

```powershell
npm ci
$env:LSW_HOST = '127.0.0.1'
$env:LSW_PORT = '1234'
$env:LSW_DOCUMENT_ID = '11111111-1111-4111-8111-111111111111'
$env:LSW_DB_PATH = Join-Path $PWD 'data\collaboration.sqlite3'
$env:LSW_TOKEN = [Guid]::NewGuid().ToString('N')
Write-Host "访问令牌：$env:LSW_TOKEN"
Set-Clipboard -Value $env:LSW_TOKEN
npm start
```

看到 `listening` 后，保留这个 PowerShell 窗口。令牌已显示并复制到剪贴板，可以直接粘贴到连接表单。在共享屏幕时，可省略 `Write-Host`。请将原令牌保存在密码管理器等私密位置，供重新启动或邀请组员时使用。

如果端口 `1234` 已被占用，可以在第一次启动前改成 `1236`。VS Code 填写的地址也要改成 `ws://127.0.0.1:1236`。同一个服务实例使用一个工作区 ID。

### 重启时沿用原令牌

如果服务正在运行，先在原窗口按 `Ctrl+C`，等提示符出现。仍在这个 PowerShell 窗口中运行：

```powershell
if ($env:LSW_TOKEN) {
    Write-Host "访问令牌：$env:LSW_TOKEN"
    Set-Clipboard -Value $env:LSW_TOKEN
    npm start
} else {
    Write-Warning '当前窗口没有原来的访问令牌。'
}
```

这会在终端显示令牌、复制令牌并重启服务。如果需要录屏或共享终端，可以省略 `Write-Host`。同一个工作区继续沿用原来的端口、工作区 ID、数据库路径和令牌。重新运行 `NewGuid()` 会换令牌，已保存旧令牌的成员需要重新连接。

如果改用一个新的 PowerShell 窗口，先回到仓库根目录，恢复上面相同的端口、工作区 ID 和数据库路径。用下面的命令输入原令牌，输入时会遮蔽：

```powershell
$lswSavedToken = Read-Host '输入原来的访问令牌' -AsSecureString
$env:LSW_TOKEN = [System.Net.NetworkCredential]::new('', $lswSavedToken).Password
Remove-Variable lswSavedToken
Set-Clipboard -Value $env:LSW_TOKEN
npm start
```

## 在本机用两个窗口试用

1. 在仓库根目录执行 `npm run package:vsix`。在 VS Code 的扩展面板选择 **从 VSIX 安装**，选取 `apps/vscode-extension/latex-sync-workspace-0.2.4.vsix`。也可以安装组员拿到的同版本 VSIX。
2. 在第一个 VS Code 窗口用 **文件 → 打开文件夹** 打开一份试验项目。点击状态栏 **Folder Relay 连接工作区**，也可以按 `Ctrl+Shift+P` 搜索 `LSW: Join Shared Project`。
3. 在 **连接共享工作区** 窗口确认当前本地文件夹，再填写下表。点 **连接工作区**，等状态栏显示 **工作区已同步**。

   | 输入框 | 本机示例 |
   | --- | --- |
   | 服务器地址 | `ws://127.0.0.1:1234` |
   | 工作区 ID | `11111111-1111-4111-8111-111111111111` |
   | 访问令牌 | 启动服务时生成并复制的 `LSW_TOKEN` |

4. 用 **文件 → 新建窗口** 打开第二个 VS Code 窗口，选一个新建的空文件夹。用完全相同的三项信息连接。项目文件会自动下载。
5. 在第二个窗口编辑并保存 `notes.md`、`main.tex` 或其他项目文件，观察第一个窗口对应文件是否更新，再反向试一次。以后打开各自原来的文件夹，扩展会恢复连接。

## 三台电脑怎么连接

三台电脑分别连接同一个协作服务。发起人可以用自己的已有文件夹发起共享，服务也可以运行在另一台常在线主机上。

| 电脑 | 第一次加入怎么做 |
| --- | --- |
| A，发起人 | 打开已有项目文件夹。先连接一个空的共享工作区，等文件上传完成。 |
| B，同学 | 安装扩展，打开新建的空文件夹，填写同一个工作区 ID 和令牌，等文件下载。 |
| C，同学 | 与 B 操作相同，可以用自己的文件夹路径。 |

如果服务已部署了固定的加密地址，三人都在表单填写该地址，例如 `wss://sync.example.com`。这是示例，要替换成实际可访问的地址。组员只需用 VS Code 的连接窗口。采用 SSH 私有转发时，组员先按[部署指南](deployment.md)建立转发，再在 VS Code 填转发后的本机地址。`127.0.0.1` 指向每台电脑自己。

## 日常编辑、编译与离线

- 普通编辑、Codex 或 Claude 修改，以及脚本写入项目的文件，都可以在保存到磁盘后同步。使用各自电脑上的 XeLaTeX 等工具编译。如需预览自动刷新，可在本机配置 LaTeX Workshop。
- 成员关掉 VS Code 或离线时，其他在线成员仍能向运行中的服务保存。如果某个成员断网，该成员仍可编辑和编译已有文件，恢复连接后扩展会重试并同步。运行服务的主机离线期间，所有成员只能使用本地副本。
- 修改了不同位置的文本有机会自动合并。同一处文字或同一个二进制文件同时改动时，扩展可能保留冲突副本，其余文件继续同步。点击状态栏的 **工作区有冲突** 查看副本。整理并保存实际项目文件后，执行 `LSW: Publish Resolved Project File`。共享版本又有变化时，扩展会更新冲突副本。
- Git、VS Code 的本机配置、依赖目录和常见构建产物在共享范围之外。当前单文件上限 16 MiB，整个工作区上限 128 MiB。同步规则独立于 `.gitignore`，共享前请选择只包含组员可见内容的项目目录。
- 旧版单文件会话仍可通过 `LSW: Connect Single File (Legacy)` 打开。若要将旧项目转到工作区模式，先把合并后的源码放进项目文件夹，再用该文件夹发起共享。

## 常见问题

- **令牌未通过。** 确认地址和工作区 ID 后，重新复制运行该服务所用的完整 `LSW_TOKEN`。默认工作区 ID 和访问令牌是两项不同的信息。
- **同一台电脑能连，另一台不能。** `127.0.0.1` 只能访问当前电脑。按[部署指南](deployment.md)提供可访问的固定地址或 SSH 转发。
- **想再做一次空目录测试。** 新建一个独立目录加入。删除仍连接目录里的文件可能同步删除共享版本。
- **改了源码但 PDF 没变。** 先确认源码在两端已经同步，再在各自电脑上编译。与 `.tex` 同名的生成 PDF 不会随源码同步。
