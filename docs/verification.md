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

更名为 Folder Relay 前，用 0.2.3 安装包在两个隔离的 VS Code 窗口验证了混合工作区。Markdown、Python 和 CSV 与 LaTeX、BibTeX、PNG 一起下载。双方先后编辑同一 Markdown 文件，验证了编辑器保存与外部程序写盘的双向同步。两端离线修改另一份 Markdown 的不同段落，重连后自动合并。

0.2.4 更新扩展显示名称和连接窗口标题。TypeScript 检查、12 项自动测试和两个隔离 VS Code 窗口的工作区测试均通过。

## 0.3 远程协作

0.3 把工作区同步从"650 ms 全量轮询"换成"服务端推送 + seq 增量 + 分片续传"。协议见[远程协议 v1](remote-protocol.md)，架构取舍见[远程架构](remote-architecture.md)。

### 自动测试

| 命令 | 覆盖 | 结果 |
| --- | --- | --- |
| `npm test` | 服务端 22 项 + 扩展 46 项 + 根 16 项（协议 3 + 远程端到端 13） | **84 项，83 通过，1 跳过，0 失败** |
| `node --test tests/remote-e2e.test.mjs` | 从外部黑盒验证 v1 契约：能力协商、manifest 的 `X-LSW-Seq`、commit 幂等、412 带当前版本、changes 单调、WS hello/changes/since 重放、分片断点续传、Range 206、鉴权拒绝、公网开关、`/join` 加入页（含与客户端解析器的格式互认） | 12 通过 / 1 跳过 |
| `node scripts/e2e-two-clients.mjs` | **真实 ProjectSync × 2 + 真实服务端进程**：加入即下载、推送可见、新增文件、900 KiB 分片上传、宕机进入重连态、重启后离线改动自动收敛、整份覆盖产出冲突副本、同文件不同段落三方合并 | **10 项全通过** |
| `npx tsc -p apps/vscode-extension/tsconfig.json --noEmit` | 扩展类型检查 | 通过 |
| `npm run build` | esbuild 打包 `dist/extension.cjs` | 通过 |

唯一跳过项：`优雅停机：广播 reset 并以 1012 关闭`。Windows 上 `child.kill('SIGTERM')` 走 `TerminateProcess`，不会触发子进程的 SIGTERM 监听，所以子进程版本无法在 Windows 验证；同一逻辑由 `apps/collab-server/test/remote-v1.test.mjs` 的 in-process 用例覆盖（`startServer().stop()` → 广播 `reset(reason=restart)` + close 1012 + 503 stopping）。

### 实测对比（同一进程、同一链路，只换传输方式）

`node scripts/bench-remote.mjs --self --seconds 20`：

| 模式 | HTTP 请求 | 请求/小时 | 变化可见 p50 | p95 |
| --- | --- | --- | --- | --- |
| 650 ms 全量轮询（0.2） | 31 | 5 580 | 287 ms | 630 ms |
| WS 推送 + seq 增量（0.3） | 0 | **0** | **14 ms** | 122 ms |

口径：`latency` = 写入端**发起提交**到观察端**收到新版本**，含服务端落盘与广播。两者都在本机回环，跨城的绝对数值会叠加 RTT，但"轮询被周期钉死 / 推送只付单程"的关系不变。

### 尚未验证的部分

- **两个真实 VS Code 窗口 + 两个不同网络的端到端**：`npm run test:project` 需要 VS Code 1.106.1（本机未安装，`@vscode/test-electron` 需下载约 110 MB）；本次用 `scripts/e2e-two-clients.mjs` 以真实 `ProjectSync` 代码在 Node 侧完成等价链路验证，但仍建议在装好 VS Code 的机器上跑一次 `npm run test:project`。
- **公网 TLS / 反向代理 / Cloudflare Tunnel 实测**：配置见[远程部署](deployment-remote.md)，本地未起公网入口，故未验证证书链与代理超时配对。
- **弱网（丢包/高 RTT）实测**：脚本只在本机回环跑过；上线前请按[远程部署·弱网验收](deployment-remote.md#弱网验收上线前必须做一次)用 Clumsy 或 `tc netem` 复测。
- **多节点 / 滚动升级**：v1 明确不实现（见协议 §8）。
