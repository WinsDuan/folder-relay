# 介绍图的生成提示

使用 Codex 内置图像生成工具制作和修订。成品见 [介绍图](latex-sync-workspace-overview.png)。

## 初次生成

```text
Use case: infographic-diagram.
Asset: a refined, landscape 16:9 product introduction banner for the GitHub README of LaTeX Sync Workspace. The audience is students and researchers using VS Code to write LaTeX together.
Information design: generous warm-white background, dark ink-navy typography, muted blue diagram lines and restrained cobalt accents. Clean vector-like editorial illustration, crisp and readable even at half size, simple forms and generous margins.
Layout: large product title and smaller Chinese subtitle on top. Below, depict exactly one central server labeled “LSW 协作服务” and exactly three separate VS Code laptops in a row labeled “发起人 A”, “成员 B”, “成员 C”. Draw three distinct bidirectional connections, one from each laptop directly to the same server. The three computers must not connect to one another. Put “main.tex” on every screen to show three real local copies of the same file. Use abstract editor lines, not a fake application screenshot. Along the bottom set a quiet strip with three evenly spaced feature labels.
Render only the following text, verbatim, in crisp modern sans-serif:
“LaTeX Sync Workspace”
“在 VS Code 中协作写 LaTeX”
“LSW 协作服务”
“发起人 A”
“成员 B”
“成员 C”
“main.tex” (on all three laptop screens)
“自动同步”
“离线编辑”
“本地编译”
Keep the three feature labels separate from the server so the diagram does not imply server-side compilation. No credentials, real IPs, URLs, brand logos, extra text, watermark, badges, cloud compilation, or multiplayer cursor effects.
```

## 定向修订

```text
Targeted edit of the supplied finished infographic. Change only the three small blue angular VS Code logos in the upper left sidebar of each laptop screen. Replace each with the same small generic light-blue outlined sheet-of-paper icon. No product mark, chevron, or angular logo in those three locations. Keep everything else pixel-close to the reference: canvas aspect ratio, colors, title, Chinese text verbatim, three laptops with main.tex, single server, all three bidirectional connections, bottom feature labels, and margins. No extra text or decoration.
```
