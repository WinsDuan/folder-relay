/**
 * `GET /join`：发起人本机打开的一个"加入信息"页面。
 *
 * 它做的事情只有一件：把「服务器地址 / 工作区 ID / 访问令牌」三样东西，
 * 变成一个可点、可复制、可转发的 **VS Code 一键加入链接**，消除手抄出错。
 *
 * 安全边界（重要）：这个页面**包含令牌明文**，所以只在两种情况下返回：
 *   1) 请求来自回环地址（发起人自己的电脑）；或
 *   2) 请求带正确的 Bearer 令牌（相当于已经知道令牌的人）。
 * 其余情况一律 401，避免"能访问端口就能拿到令牌"。
 *
 * 二维码：这里不做服务端渲染。桌面↔桌面场景一键链接更快（粘贴一次即可），
 * 而二维码需要引入 QR 编码依赖（见 docs/deployment-remote.md 的说明）。
 */

const REVIEW_SECTION = `
    <section class="card">
      <h2>这个页面为什么只在本机可见</h2>
      <p>页面里含访问令牌明文。服务端只在<strong>回环地址</strong>或<strong>已经带对令牌</strong>的请求上返回它，
         所以别人即使能访问这个端口，也拿不到令牌。</p>
    </section>`;

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character]));
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/** 与扩展 `isPrivateHost` 保持一致：私有网段 / CGNAT / mDNS 名字。 */
export function isPrivateHost(hostname) {
  const host = String(hostname).toLowerCase().replace(/^\[|\]$/g, '');
  if (LOOPBACK.has(host) || host.endsWith('.local')) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!v4) return false;
  const a = Number(v4[1]);
  const b = Number(v4[2]);
  return a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127);
}

/**
 * 服务端侧构造一键加入链接，与扩展 `join-link.ts` 的格式必须一致。
 * 局域网（http 入口、私有网段）产生的链接要带 `insecure=1`，
 * 否则客户端会以"ws:// 只允许回环"为由拒绝——那是刻意的默认安全策略。
 */
export function buildJoinLink({ endpoint, workspaceId, token }) {
  const query = new URLSearchParams({ url: endpoint, workspace: workspaceId, token });
  try {
    const url = new URL(endpoint);
    if (url.protocol === 'ws:' && !LOOPBACK.has(url.hostname) && isPrivateHost(url.hostname)) {
      query.set('insecure', '1');
    }
  } catch { /* endpoint 由调用方保证合法 */ }
  return 'vscode://lsw-local.latex-sync-workspace/join?' + query.toString();
}

export function renderJoinPage({ endpoint, workspaceId, token, version, requestHost }) {
  const link = buildJoinLink({ endpoint, workspaceId, token });
  const safe = {
    endpoint: escapeHtml(endpoint),
    workspaceId: escapeHtml(workspaceId),
    token: escapeHtml(token),
    link: escapeHtml(link),
    version: escapeHtml(version ?? ''),
    host: escapeHtml(requestHost ?? endpoint),
  };
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Folder Relay · 加入共享工作区</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; margin: 0; padding: 32px 20px; background: #f6f7f9; color: #1c1f24; }
  main { max-width: 760px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 6px; }
  .sub { color: #5b6472; margin: 0 0 22px; }
  .card { background: #fff; border: 1px solid #e2e5ea; border-radius: 10px; padding: 18px 20px; margin-bottom: 16px; }
  .card h2 { font-size: 15px; margin: 0 0 10px; color: #414a58; }
  .row { display: grid; grid-template-columns: 96px 1fr auto; gap: 10px; align-items: center; margin-bottom: 10px; }
  .row label { color: #5b6472; font-size: 13px; }
  code, textarea { font: 13px/1.5 ui-monospace, "Cascadia Code", Consolas, monospace; }
  textarea { width: 100%; box-sizing: border-box; border: 1px solid #d7dbe2; border-radius: 8px; padding: 10px; background: #fbfcfd; resize: vertical; }
  button { border: 1px solid #d7dbe2; background: #fff; border-radius: 8px; padding: 6px 12px; cursor: pointer; font-size: 13px; }
  button:hover { background: #f1f3f6; }
  .big textarea { font-size: 13px; }
  ol { margin: 6px 0 0; padding-left: 22px; }
  li { margin-bottom: 6px; }
  .hint { color: #67707e; font-size: 13px; }
  @media (prefers-color-scheme: dark) {
    body { background: #16181c; color: #e6e8ec; }
    .card { background: #1d2025; border-color: #2b3038; }
    .card h2, .row label, .sub, .hint { color: #9aa3b1; }
    textarea { background: #14161a; color: #e6e8ec; border-color: #2b3038; }
    button { background: #23272d; color: #e6e8ec; border-color: #2b3038; }
    button:hover { background: #2b3038; }
  }
</style>
</head>
<body>
<main>
  <h1>加入这个共享工作区</h1>
  <p class="sub">服务端 ${safe.version} · 工作区 ${safe.workspaceId}</p>

  <section class="card big">
    <h2>第一步：把这个链接发给组员</h2>
    <textarea id="link" rows="3" readonly>${safe.link}</textarea>
    <p class="hint">对方点开链接（微信/QQ 里也可以）会直接唤起 VS Code 并自动填好地址、工作区与令牌，不需要手抄。</p>
    <button id="copy-link">复制加入链接</button>
  </section>

  <section class="card">
    <h2>第二步：对方在自己的文件夹里确认</h2>
    <ol>
      <li>VS Code 打开要参与协作的<strong>本地文件夹</strong>（空目录也可以，会自动下载）。</li>
      <li>信任该文件夹后点开链接；状态栏会显示 <code>同步中</code>，随后变成 <code>工作区已同步</code>。</li>
      <li>如果没有自动跳转，用命令面板执行 <code>LSW: Join Shared Project</code>，把下面三行手动填进去。</li>
    </ol>
  </section>

  <section class="card">
    <h2>手动填写（备用）</h2>
    <div class="row"><label for="endpoint">服务器地址</label><textarea id="endpoint" rows="1" readonly>${safe.endpoint}</textarea><button data-copy="endpoint">复制</button></div>
    <div class="row"><label for="workspace">工作区 ID</label><textarea id="workspace" rows="1" readonly>${safe.workspaceId}</textarea><button data-copy="workspace">复制</button></div>
    <div class="row"><label for="token">访问令牌</label><textarea id="token" rows="1" readonly>${safe.token}</textarea><button data-copy="token">复制</button></div>
    <p class="hint">令牌等价于仓库钥匙：拿到的人可以读写共享文件。只发给组内成员，别贴到公开群里。</p>
  </section>
${REVIEW_SECTION}
</main>
<script>
  const copy = async value => {
    try { await navigator.clipboard.writeText(value); return true; } catch { return false; }
  };
  document.getElementById('copy-link').addEventListener('click', async event => {
    const ok = await copy(document.getElementById('link').value);
    event.target.textContent = ok ? '已复制' : '复制失败，请手动选中';
    setTimeout(() => { event.target.textContent = '复制加入链接'; }, 1500);
  });
  for (const button of document.querySelectorAll('button[data-copy]')) {
    button.addEventListener('click', async () => {
      const target = document.getElementById(button.dataset.copy);
      const field = button.closest('.row');
      const area = document.createElement('textarea');
      area.value = target.value;
      field.replaceChild(area, target);
      area.select();
      document.execCommand('copy');
      field.replaceChild(target, area);
      button.textContent = '已复制';
      setTimeout(() => { button.textContent = '复制'; }, 1500);
    });
  }
</script>
</body>
</html>`;
}
