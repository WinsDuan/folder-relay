# LaTeX Sync Workspace

LaTeX Sync Workspace（LSW）让多位成员在各自的 VS Code 中编辑同一份 LaTeX 项目。项目文件保存在各自的电脑上，可以用本机编辑器、Codex 或 Claude 修改，也可以用本机的 LaTeX 工具链编译。连上协作服务后，LSW 同步文件。断网时仍可编辑已有文件，恢复连接后再同步。

| 你想做什么 | 从哪里开始 |
| --- | --- |
| 安装扩展、启动本机服务、试用两个窗口 | [使用指南](docs/project.md) |
| 让另外两台电脑加入同一项目 | [三台电脑怎么连接](docs/project.md#三台电脑怎么连接) |
| 给小组配置一个常在线的服务地址 | [部署指南](docs/deployment.md) |
| 上传源码、分发安装包、发布到 VS Code 扩展商店 | [发布指南](docs/publishing.md) |

## 本机试用

准备 Node.js 24 或更新版本，以及 VS Code 1.96 或更新版本。打开仓库根目录，在 PowerShell 中运行：

```powershell
npm ci
npm run package:vsix
```

从 VS Code 的扩展面板选择 **从 VSIX 安装**，安装 `apps/vscode-extension/latex-sync-workspace-0.2.2.vsix`。按[使用指南](docs/project.md#启动本机服务)启动服务，然后用 VS Code 打开要分享的项目目录，点击状态栏的 **LSW 连接工作区**。另开一个 VS Code 窗口，打开新建的空文件夹，用相同的连接信息加入。第一次可以用 [LaTeX 示例](examples/phase1/main.tex)做测试。

## 仓库内容

- `apps/vscode-extension` 包含 VS Code 扩展、连接窗口和文件同步逻辑。
- `apps/collab-server` 包含协作服务和 SQLite 持久化。
- `examples` 包含可用于试用的 LaTeX 文件。`tests` 包含协议测试和 VS Code 测试。
- [架构记录](docs/architecture.md)、[技术选型记录](docs/phase-0.md)和[远程编译可行性记录](docs/github-actions.md)保留早期设计背景。现有的旧版单文件工作流见[单文件模式](docs/windows.md)。

## 构建与验证

```powershell
npm test
npm run test:project
npm run test:vscode
npm run package:vsix
```

VS Code 测试使用隔离的用户和扩展目录。若 VS Code 安装在自定义路径，可以设置 `LSW_VSCODE_EXECUTABLE` 指定可执行文件。查看[验证说明](docs/verification.md)了解各项测试的范围。

项目代码采用 [MIT 许可证](LICENSE)。扩展安装包附带打包依赖的许可证。
