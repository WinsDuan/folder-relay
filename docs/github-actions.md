# GitHub Actions 远程编译（设计记录）

当前发布版使用成员电脑上的 LaTeX 工具链编译。本文保留远程编译的设计和合成样例，仓库尚未接入远程编译工作流。

## 运行环境与额度

如果以后接入，按目标账号、仓库可见性、运行器类型和产物保留期核对额度。参考 [GitHub Actions 计费](https://docs.github.com/en/billing/concepts/product-billing/github-actions) 和 [预算控制](https://docs.github.com/en/billing/how-tos/set-up-budgets)。

选择标准 Linux runner、手动请求编译。启动、下载依赖、准备 TeX 和队列都会增加等待时间。界面按提交、排队、运行、成功、失败或额度耗尽显示，编译失败保留日志，额度耗尽时继续协作编辑，暂停提交新构建。紧急情况下可由当前成员在其机器上用 LaTeX Workshop 本地编译。独立 Worker 以后可接入同一个构建接口。

## 快照与任务绑定

1. 编译入口核对最新快照是否已经提交，使用已持久化的内容生成文件清单、文件哈希及确定性的项目版本 ID，冻结编译输入。
2. 只有获得私有源码上传授权后，构建服务才将快照放入指定的私有仓库。保存不可变对象哈希及构建请求 ID。同一个项目版本和编译配置可复用同一构建结果。由服务端提供队列，防止不同版本的排队任务相互覆盖。
3. 调用私仓可信默认分支中的 `workflow_dispatch` 工作流，显式传入快照标识及版本 ID。固定可信工作流版本，不执行快照内附带的工作流。GitHub REST 2026-03-10 文档列明 dispatch 返回 HTTP 200 及 `workflow_run_id`。持久化该 ID，并以其轮询任务和产物。参考 [创建 workflow dispatch](https://docs.github.com/en/rest/actions/workflows?apiVersion=2026-03-10#create-a-workflow-dispatch-event)。
4. 读取该 run 的产物和日志，校验内附项目版本及文件清单。保存 PDF 与明确的版本关联。清理过期产物，短期保留失败日志，日志和编译输出继承项目的访问权限。

## 权限与隔离

私有仓库仍属于第三方托管。提交对象、历史、产物、运行日志和访问控制进入 GitHub 的管理边界，删除分支也不能视作彻底抹除对象。先确定团队批准的源码范围、产物保留期和账号所有者。推送限于指定仓库的快照目录，避免提交凭证、内部配置与无关数据。

优先使用限定仓库和权限的 GitHub App installation token，按操作划分 Contents 和 Actions 权限。构建服务的凭证保存在服务端私有配置中，普通协作客户端只调用本服务。工作流的 `GITHUB_TOKEN` 使用最小只读权限，拉取时关闭凭证持久化。将输入快照作为数据解包，拒绝绝对路径、路径穿越、符号链接、超量文件和文件尺寸。

XeLaTeX、BibTeX/Biber 和 latexmk 应在无宿主密钥、无网络、CPU/内存/时间/进程数均受限的沙箱运行。编译容器仅挂载只读快照和独立输出目录，非 root，禁用 shell escape，禁用快照自带的 latexmkrc。runner 层不把 Docker socket 或服务凭证传入编译容器。latexmk 命令可使用 `latexmk -norc -xelatex -no-shell-escape -halt-on-error -interaction=nonstopmode main.tex`。禁止 shell escape 仍需搭配文件及网络隔离。

## Phase 0 验证范围

标准 Linux runner 可运行 TeX Live 工具链。固定基础镜像或镜像摘要，准备 XeLaTeX、latexmk、BibTeX、Biber 与 CJK 宏包和字体。先用 `infra/github-actions/smoke` 的合成文档验证中文、公式和 Biber，再单独验证 GitHub 端到端任务、排队、下载、失败日志及预算阻断。参考 [GitHub-hosted runner 标签及资源](https://docs.github.com/en/actions/how-tos/write-workflows/choose-where-workflows-run/choose-the-runner-for-a-job)。

该合成样例曾在 Windows 的 TeX Live 2025 下使用 latexmk 和 Biber 成功编译。可以将样例复制到临时目录复测。

当前阶段未触发云端工作流，未检验目标账号的额度和权限。用户审批后可先上传合成测试项目，独立验证流程和实际耗时，再决定论文接入。
