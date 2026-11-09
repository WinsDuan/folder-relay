# 构建与验证

从仓库根目录安装依赖并执行下面的命令。VS Code 测试使用临时协作服务和隔离的用户目录，结果输出到 `.artifacts/`。

```powershell
npm ci
npm test
npm run typecheck -w apps/vscode-extension
npm run test:project
npm run test:vscode
npm run package:vsix
```

| 命令 | 验证范围 |
| --- | --- |
| `npm test` | 服务配置、鉴权、文件与快照持久化、编辑器模型和同步协议 |
| `npm run test:project` | 两个 VS Code 实例的工作区下载、磁盘写入、服务重启、离线恢复、文本合并和冲突保护 |
| `npm run test:vscode` | 旧单文件模式的编辑器同步、并发操作、断线和外部写入 |
| `npm run package:vsix` | 生成可安装的 VSIX，包含编译后的扩展、README、MIT 许可证及打包依赖的声明 |

如果使用便携版 VS Code，先将 `LSW_VSCODE_EXECUTABLE` 设置为实际的 `Code.exe` 路径。要复测本地 LaTeX 编译，在安装 `latexmk` 和 XeLaTeX 后，将 `LSW_E2E_COMPILE` 设为 `1`，再运行工作区测试。

## 连接窗口试用

1. 在两个 VS Code 窗口打开独立的试验目录。A 有一份 `main.tex`，B 为空目录。
2. 在 A 的连接窗口输入一个错误令牌，确认窗口给出提示。换成正确令牌后连接，等 A 显示 **工作区已同步**。
3. B 用相同地址、工作区 ID 和正确令牌加入。确认 B 下载了 `main.tex`。在 B 修改一行，再确认 A 收到修改。
4. 暂停试验服务，在两份副本不同段落各做一次修改。用相同配置恢复服务，观察两端重新同步。

0.2.2 的连接窗口已在同一台 Windows 电脑的两个隔离 VS Code 窗口验证，覆盖错误令牌提示、主稿上传、空目录下载和反向同步。实际跨电脑接入、不同网络下的延迟和团队负载，需要在使用的部署环境中验证。

重新构建的 0.2.2 安装包已在 Windows 上用 VS Code 1.122.1 复测，工作区和旧单文件模式均通过端到端测试，本地 XeLaTeX 编译通过。`npm test` 共 12 项通过，TypeScript 检查通过。

0.2.3 添加了扩展图标。安装包和 GitHub README 使用同一份 256 × 256 PNG，已核对安装后的图标文件。同步程序与已验证的 0.2.2 构建一致。
