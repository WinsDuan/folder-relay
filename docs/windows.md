# Windows 单文件模式

共享工作区的使用请见[共享工作区指南](project.md)。本文记录由 0.1 引入、在当前版本中保留的旧单文件模式。

## 1. 准备

在项目根目录打开 PowerShell。使用 Node.js 24 LTS、npm 和符合扩展清单 `engines.vscode` 的 VS Code。

```powershell
node --version
npm --version
npm ci
npm run build
npm run package:vsix
```

VSIX 打包在 `apps/vscode-extension`。可以在 VS Code 命令面板选择 `Extensions: Install from VSIX...` 并选择生成的文件。下方命令适用于已将 `code` 加入 PATH 的环境。

```powershell
code --install-extension .\apps\vscode-extension\latex-sync-workspace-0.2.2.vsix
```

## 2. 启动协作服务

在同一个 PowerShell 窗口生成测试令牌并启动服务。保留该终端窗口。

```powershell
$env:LSW_TOKEN = [Guid]::NewGuid().ToString('N')
$env:LSW_HOST = '127.0.0.1'
$env:LSW_PORT = '1234'
$env:LSW_DOCUMENT_ID = '11111111-1111-4111-8111-111111111111'
$env:LSW_DB_PATH = Join-Path $PWD 'data\collaboration.sqlite3'
Set-Clipboard -Value $env:LSW_TOKEN
npm run start --workspace @lsw/collab-server
```

令牌用于当前本地验证。两个窗口连接时粘贴同一个值，随后可清空剪贴板。重启持久化测试应沿用同一个数据库和文档 UUID，可在服务窗口停止后重用同一个环境变量。另开终端检查 `Invoke-RestMethod http://127.0.0.1:1234/healthz`。

## 3. 验证两窗口同步

1. 创建两个独立目录，各自创建一个空白 `main.tex`。分别用 VS Code 打开两个目录。
2. 在每个窗口打开 `main.tex`，执行 `LSW: Connect Single File (Legacy)`，填入 `ws://127.0.0.1:1234`、默认文档 UUID `11111111-1111-4111-8111-111111111111` 及同一个测试令牌。
3. 在 A 窗口键入一行 LaTeX，在 B 窗口确认实时显示。反向编辑，再在两窗口同一位置编辑，检查两端收敛且各自输入都保留。
4. `LSW: Show Sync Status` 查看协作状态。界面显示 Saved 后，执行 Ctrl+S 将当前缓冲区写入本地真实文件。若共享文档已有内容，初次接入一个空白文件时按界面提示选择加载共享版本。
5. 停止服务后在两个仍保持连接会话的窗口分别编辑。以同一命令重启，观察两端重新连接后保留各自改动。等待 Saved，再停止并重启服务，从新窗口打开另一个空白副本，读取已持久化内容。
6. 完成后可执行 `LSW: Disconnect`。外部程序改写磁盘文件造成的冲突按界面提示保留并处理。

在同一个服务实例中，文档 UUID 对应同一个持久化状态。开启全新测试时，为测试指定独立的 `LSW_DB_PATH` 与新的 `LSW_DOCUMENT_ID`。连接时填入新 UUID，避免上次测试的本地协作缓存进入新数据库。

## 常见问题

- **连接失败**。检查服务终端与健康接口，确认两端的 URL、UUID 和令牌一致。使用回环地址并保持服务进程运行。
- **端口已使用**。选择另一个本地 `LSW_PORT`，并在两个窗口使用同一端口。
- **编辑器有未保存标记**。同步状态和 VS Code 的 Ctrl+S 分别表示服务端提交和写入本地磁盘。
- **第一次连接显示内容不同**。检查所选 UUID，按提示查看共享版本，并在继续前保留本地文件。
- **显示 Conflict**。点击状态栏，或运行 `LSW: Review Conflict`。对比窗口左侧为冲突时的共享版，右侧为磁盘版。把需要保留的内容合进仍在线的编辑器，等它显示 Saved 后再按 Ctrl+S。回到暂停的窗口，运行 `LSW: Disconnect`，打开原 `.tex` 标签页，运行 `File: Revert File` 从磁盘重载，再重新连接并选择 Load Shared Version。最后按 Ctrl+S。扩展重载后可通过命令按时间打开此前保留的冲突记录。

## 使用 AI 修改本地文件

1. 两端安装当前 VSIX，并连接同一协作服务的旧单文件模式。升级时沿用原令牌、文档 UUID 和 SQLite 数据库。
2. 在准备让 AI 修改的一端打开已连接的 `.tex`，等状态栏显示 LSW Saved，按 Ctrl+S。执行 **LSW: Prepare AI Edit**，状态栏显示 **AI 就绪**。
3. 让 AI 修改该 `.tex`，再运行 LaTeX 编译。磁盘内容稳定后，LSW 核对准备时的共享版本并提交改动。另一端看到新源码后，保存并编译即可生成自己的 PDF。
4. 其他成员可以继续编辑。共享版本已经更新时，基于旧版本的外部写入会进入 Conflict，按上面的对比流程合入两边内容。准备下一次 AI 任务前，在当前已保存的版本上重新执行 **LSW: Prepare AI Edit**。

从文件 1 换到文件 2 调用 AI 时，在文件 2 保存刚同步过来的最新版，并在文件 2 的窗口执行 **LSW: Prepare AI Edit**。看到 **AI 就绪** 后再让 AI 写入。

需要自动生成 PDF 时，在各自 VS Code 工作区启用自动保存，并配置 LaTeX Workshop 在文件变化时构建。每台电脑安装 LaTeX 工具链并选用相同的编译方式。项目依赖的 `.bib`、图片和 `\input` 子文件由成员事先放到各自的相同相对路径。参考 [VS Code 自动保存](https://code.visualstudio.com/docs/editing/codebasics#_save-auto-save) 与 [LaTeX Workshop 编译设置](https://github.com/James-Yu/LaTeX-Workshop/wiki/Compile#latex-workshoplatexautobuildrun)。

```json
{
  "files.autoSave": "afterDelay",
  "files.autoSaveDelay": 1000,
  "latex-workshop.latex.autoBuild.run": "onFileChange"
}
```

## 多台电脑连接同一份源码

选一台团队成员能够通过 SSH 登录的主机，在主机上启动一个 LSW 服务，监听 `127.0.0.1:1234`。主机上的 VS Code 直接连 `ws://127.0.0.1:1234`。其他成员在各自电脑的 PowerShell 或终端运行下方命令，将示例用户名和主机名替换为自己的 SSH 登录信息。主机需允许成员转发到 `127.0.0.1:1234`。参考 [OpenSSH 本地端口转发](https://man.openbsd.org/ssh#L)。

```powershell
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:1235:127.0.0.1:1234 teamuser@team-host.example.com
```

保持 SSH 窗口开启。成员打开自己的 `.tex`，运行 **LSW: Connect Single File (Legacy)**，地址填 `ws://127.0.0.1:1235`，使用主机上的文档 UUID 和共享令牌。首次连接建议使用独立目录里的空白 `main.tex` 并加载共享版本。两端先交换一行文字，再按上面的流程验证 AI 写入和本地编译。
