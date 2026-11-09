<img src="apps/vscode-extension/media/lsw-icon.png" alt="Folder Relay 图标" width="64" height="64">

# Folder Relay

**VS Code 多文件工作区协作**

Folder Relay 让小组成员在各自的 VS Code 中维护同一个项目目录。把 Markdown 说明、Python 脚本、CSV 数据、LaTeX 正文和图片放在一起，保存后的文件版本会按项目内的相对路径同步。项目在每台电脑上都有一份本地副本，断网时也能继续编辑，恢复连接后再同步。符合条件的非重叠文本改动可以自动合并，图片等二进制文件按整份同步。

![Folder Relay 产品图，浅色文件夹中叠放文档、图片和代码卡片](docs/assets/folder-relay-overview.png)

项目原名 LaTeX Sync Workspace。新版沿用已有扩展 ID、`LSW:` 命令和工作区连接配置，可直接从旧版升级。

组员可以从 [GitHub Releases](https://github.com/WinsDuan/folder-relay/releases/latest) 下载 `.vsix`，在 VS Code 扩展面板选择 **从 VSIX 安装**。协作服务由发起人启动。

| 你想做什么 | 从哪里开始 |
| --- | --- |
| 了解主要功能、适用场景和三人分工示例 | [项目说明](docs/overview.md) |
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

从 VS Code 的扩展面板选择 **从 VSIX 安装**，安装 `apps/vscode-extension/latex-sync-workspace-0.2.4.vsix`。按[使用指南](docs/project.md#启动本机服务)启动服务，然后用 VS Code 打开要分享的项目目录，点击状态栏的 **Folder Relay 连接工作区**。另开一个 VS Code 窗口，打开新建的空文件夹，用相同的连接信息加入。可以用几个 Markdown、Python、CSV 文件试同步，也可以复制 [LaTeX 示例](examples/phase1)体验写作和本地编译。

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
