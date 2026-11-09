# Phase 0 技术选型（历史设计）

这份文档记录早期单文件原型的取舍。现行共享工作区的操作和版本信息见[使用指南](project.md)及仓库的依赖锁文件。

## 开源组件

下表依据上游公开 README、文档和仓库许可证。版本以本项目的锁文件为准。

| 项目 | 能解决的问题 | 许可证与使用方式 |
| --- | --- | --- |
| [Yjs](https://github.com/yjs/yjs) | `Y.Text` 表示协作文本。二进制更新可交换、可重复应用，客户端可用状态向量交换缺失更新。 | [MIT](https://github.com/yjs/yjs/blob/main/LICENSE)。直接依赖。文件路径、磁盘投影、权限和落盘确认由 LSW 处理。 |
| [Hocuspocus](https://github.com/ueberdosis/hocuspocus) | Yjs WebSocket provider、服务端鉴权及持久化挂钩。 | [MIT](https://github.com/ueberdosis/hocuspocus/blob/main/LICENSE.md)。直接依赖。客户端和服务端锁定同一版本，使用 SQLite 存储 Yjs 二进制快照。 |
| [Eclipse Open Collaboration Tools](https://github.com/eclipse-oct/open-collaboration-tools) | VS Code 和 Theia 的实时分享、选区和光标。官方设计中有发起会话并分享其工作区的宿主，服务端会话状态在内存。 | [MIT](https://github.com/eclipse-oct/open-collaboration-tools/blob/main/LICENSE)。参考协作界面与协议分层。独立永久工作区、磁盘副本和重连恢复需另行实现。 |
| [Overleaf Workshop](https://github.com/overleaf-workshop/Overleaf-Workshop) | 连接 Overleaf/ShareLaTeX，可本地打开项目，并提供编译、预览及 SyncTeX。 | [AGPL-3.0](https://github.com/overleaf-workshop/Overleaf-Workshop/blob/master/LICENSE)。参考 LaTeX 工作流。实际后端是 Overleaf。上游 README 列出的已验证 CE 镜像版本不能代替当前环境的兼容性测试。 |
| [LaTeX Workshop](https://github.com/James-Yu/LaTeX-Workshop) | 本地 TeX 构建、PDF 预览、SyncTeX 和 LaTeX 编辑辅助。 | [MIT](https://github.com/James-Yu/LaTeX-Workshop/blob/master/LICENSE.txt)。作为可选独立安装扩展使用，用户可直接对 LSW 投影出的真实文件运行编译。 |
| [LeafRelay](https://github.com/yunhaoli24/leafrelay) | 最接近目标的现有方案。提供真实本地目录、文件监听、三方合并和冲突暂停，复用 daemon 保持多窗口一致，可连接 Overleaf 或自建 Overleaf。 | [AGPL-3.0-only](https://github.com/yunhaoli24/leafrelay/blob/main/LICENSE)。作为独立方案评估，也可参考冲突处理设计。它复用 Overleaf 的服务和协议，无法直接作为本项目的轻量协作后端。 |

LeafRelay 加 Overleaf 覆盖本地 AI 修改、远端协作和编译等多项需求，适合先验证完整使用体验。Overleaf Toolkit 的默认部署同时运行应用、MongoDB 和 Redis。社区版的编译隔离也要求部署方信任用户。现有 2 GB ECS 还承担网站，优先验证轻量单进程服务的资源占用，再评估共享服务器部署。参考 [Overleaf Toolkit 架构](https://github.com/overleaf/toolkit/blob/master/doc/docker-compose.md) 与 [Overleaf CE 隔离说明](https://docs.overleaf.com/on-premises/welcome/server-pro-vs.-community-edition)。

MIT 组件进入 VSIX 或容器再分发时，保留随包的版权和许可证文本，并检查锁文件内的传递依赖。两个 AGPL 项目只作为参考。若以后采用其实现，应按对应条款评估组合作品、分发与网络交互的源码提供义务。许可证见各仓库及 [GNU AGPL 第 13 节](https://www.gnu.org/licenses/agpl-3.0.en.html#section13)。

## MVP 选型

Yjs 处理文本操作的合并。Hocuspocus 负责鉴权和更新交换。SQLite WAL 保存已提交的 Yjs 更新快照，VS Code 扩展处理编辑器缓冲区、真实文件以及本地恢复。采用永久文档 UUID，给文件重命名和多文件项目留出扩展点。项目文件树、二进制文件和多用户权限进入后续阶段。

Phase 1 固定使用 Hocuspocus v3.4.4。两项上游公告覆盖该版本，分别涉及鉴权前消息队列耗尽内存和客户端触发服务端广播。服务端限制回环绑定，拒绝带 `Origin` 的 WebSocket 升级。当前版本仅用于可信本机客户端，禁止通过反向代理、端口转发或隧道将其对外暴露。远程试点需先升级并验证修复和防护。上游发行说明记录了 v4.3.0 的鉴权前资源限制和 v4.1.1 的广播修复。参考 [GHSA-xwhh-v746-pj9m](https://github.com/ueberdosis/hocuspocus/security/advisories/GHSA-xwhh-v746-pj9m)、[GHSA-8v8m-xjrm-95h6](https://github.com/ueberdosis/hocuspocus/security/advisories/GHSA-8v8m-xjrm-95h6)、[v4.3.0](https://github.com/ueberdosis/hocuspocus/releases/tag/v4.3.0) 和 [v4.1.1](https://github.com/ueberdosis/hocuspocus/releases/tag/v4.1.1)。

标准 `synced` 或 WebSocket 发送成功只说明连接协议的状态。服务端另提供已提交快照的摘要。摘要取完整 Yjs 更新并包含删除集合，客户端仅在完整摘要匹配时显示 Saved。状态向量可用于增量交换，但相同状态向量不能单独证明删除已持久化。参考 [Yjs 更新 API](https://docs.yjs.dev/api/document-updates) 与 [Hocuspocus 持久化指南](https://tiptap.dev/docs/hocuspocus/guides/persistence)。

保留本地文件需要单独处理三种状态。编辑器缓冲区可包含未保存改动，磁盘只代表最后一次文件写入，CRDT 更新携带协作身份和因果信息。同步时以增量文本操作更新 Yjs，并把远端操作投影回编辑器。已有内容与初始协作状态不符、磁盘被替换或缓冲区发生竞态时，保留各版本并提示处理。Phase 2 再引入以已知基线为输入的外部编辑三方合并。

## 验证边界

- 本机 Windows PowerShell 可运行 Node.js v24.16.0、npm 11.13.0 与 Git。TeX Live 2025 已用 latexmk、XeLaTeX 和 Biber 编译合成中文文档。双 VS Code Extension Host 验证结果见本项目测试记录，安装步骤见 [Windows 本地运行](windows.md)。
- 单机回环环境可验证实时传播、并发合并与持久化语义。跨城 300 ms、3–6 人负载以及外部 AI 的多种写入方式各需独立实测。
- 阿里云的可用内存、CPU、磁盘和网站峰值延迟需要目标机采样后才能判断。已提供 [部署预检](deployment.md)。
- Actions 的运行环境、调用 API 和额度可用性有官方依据。实际账号权限、私仓配额、排队和完整编译流程仍需运行获准的合成项目验证。见 [远程编译可行性](github-actions.md)。
