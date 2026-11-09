# 源码、安装包和扩展商店发布

[Folder Relay 的 GitHub 仓库](https://github.com/WinsDuan/folder-relay)托管源码和文档。[GitHub Releases](https://github.com/WinsDuan/folder-relay/releases) 提供 `.vsix`，下载后可在 VS Code 选择 **从 VSIX 安装**。要让用户直接在 VS Code 扩展面板里搜索和安装，还需要将扩展发布到 Visual Studio Marketplace。

## 推送源码到 GitHub

1. 在 GitHub 新建一个仓库，名称可以用 `folder-relay`。本地仓库已经有 README、许可证和忽略规则，新建远程仓库时无需再生成这些文件。
2. 从 GitHub 的 Quick Setup 复制实际仓库地址。在本地仓库根目录运行以下命令，将 `OWNER` 替换为实际账号或组织名。

   ```powershell
   git remote add origin https://github.com/OWNER/folder-relay.git
   git remote -v
   git push -u origin main
   ```

3. 检查 GitHub 页面是否显示源码、README 和许可证。拿到实际地址后，可以补充扩展清单 `apps/vscode-extension/package.json` 的 `repository`、`homepage` 和 `bugs` 信息。

如果希望 GitHub 将初始提交归到你的账号，可在首次推送前，用账号已验证的邮箱或 GitHub 提供的 noreply 邮箱设置 Git 作者，再运行 `git commit --amend --reset-author --no-edit`。

[GitHub 的本地仓库导入说明](https://docs.github.com/en/migrations/importing-source-code/using-the-command-line-to-import-source-code/adding-locally-hosted-code-to-github)

## 用 GitHub Release 分发 VSIX

在仓库根目录执行以下命令，生成 `apps/vscode-extension/latex-sync-workspace-0.2.4.vsix`。

```powershell
npm ci
npm test
npm run package:vsix
```

推送源码后，在 GitHub 的 **Releases** 页面新建发行版，例如使用标签 `v0.2.4`，附上构建出的 VSIX。把 VSIX 作为发行版附件，源码仓库保持可重建。下载安装包的同学可以在 VS Code 的扩展面板选择 **从 VSIX 安装**。

[GitHub Release 官方说明](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository)

## 让用户在 VS Code 扩展面板搜索到

1. 登录 [Marketplace 发布者管理页](https://marketplace.visualstudio.com/manage/publishers/)，创建自己的发布者，记下实际的 Publisher ID。
2. 在 `apps/vscode-extension/package.json` 将 `publisher` 改成你名下的实际 ID。当前值 `lsw-local` 用于本地试用。确认扩展名称 `latex-sync-workspace` 和版本号，更新该版本的发行说明。
3. 重新运行 `npm run package:vsix`，在一个独立的测试工作区安装新 VSIX，验证连接窗口、下载和双向同步。若发布者 ID 改了，新旧扩展 ID 也不同。原先用 `lsw-local` 安装的用户需要保存连接信息和本地文件，切换到新扩展后重新加入。
4. 在发布者管理页上传刚构建的 VSIX，确认列表中的发布者、版本和描述。发布可用后，在 VS Code 按 `Ctrl+Shift+X` 搜索 **Folder Relay**，也可以用精确查询 `@id:你的发布者ID.latex-sync-workspace`。

从商店安装的是 VS Code 扩展。每组成员仍需连接自己小组的协作服务，服务地址、工作区 ID 和访问令牌由服务发起人提供。

扩展清单和仓库首页都使用 [同一份 PNG 图标](../apps/vscode-extension/media/lsw-icon.png)。推送源码后，图标会显示在 GitHub README 中。Marketplace 审核通过后，商店和 VS Code 扩展搜索使用 VSIX 内的图标。[图标要求](https://code.visualstudio.com/api/references/extension-manifest)

[VS Code 官方发布说明](https://code.visualstudio.com/api/working-with-extensions/publishing-extension) · [VS Code 扩展搜索说明](https://code.visualstudio.com/docs/configure/extensions/extension-marketplace#search-for-an-extension)
