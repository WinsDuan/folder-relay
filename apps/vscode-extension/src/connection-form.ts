import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';

export interface ConnectionFormState {
  folder: string;
  url: string;
  workspaceId: string;
}

export interface ConnectionFormInput {
  url: string;
  workspaceId: string;
  token: string;
}

type FormStatus =
  | { state: 'idle' | 'connecting' | 'connected' }
  | { state: 'error'; message: string };

const HTML_ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => HTML_ENTITIES[char]);
}

export function openConnectionForm(
  initial: ConnectionFormState,
  connect: (input: ConnectionFormInput) => Promise<void>,
): vscode.WebviewPanel {
  const panel = vscode.window.createWebviewPanel('lsw.connectionForm', 'Folder Relay · 连接共享工作区', vscode.ViewColumn.Active, {
    enableScripts: true,
    localResourceRoots: [],
  });
  let status: FormStatus = { state: 'idle' };
  let disposed = false;
  const postStatus = () => {
    if (!disposed) void panel.webview.postMessage(status);
  };
  const messages = panel.webview.onDidReceiveMessage(async (message: unknown) => {
    if (disposed || !message || typeof message !== 'object') return;
    const data = message as Partial<ConnectionFormInput> & { type?: string };
    if (data.type === 'ready') {
      postStatus();
      return;
    }
    if (data.type !== 'connect' || status.state === 'connecting' || status.state === 'connected') return;
    const { url, workspaceId, token } = data;
    if (typeof url !== 'string' || typeof workspaceId !== 'string' || typeof token !== 'string') return;
    status = { state: 'connecting' };
    postStatus();
    try {
      await connect({ url, workspaceId, token });
      status = { state: 'connected' };
    } catch (error) {
      const message = error instanceof Error && error.message ? error.message : '无法连接共享工作区。';
      status = { state: 'error', message: token ? message.replaceAll(token, '••••••') : message };
    }
    postStatus();
  });
  panel.onDidDispose(() => {
    disposed = true;
    messages.dispose();
  });
  panel.webview.html = connectionHtml(initial, randomBytes(16).toString('hex'));
  return panel;
}

function connectionHtml(initial: ConnectionFormState, nonce: string): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; form-action 'none'; base-uri 'none'">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>连接共享工作区</title>
  <style nonce="${nonce}">
    :root { color-scheme: light dark; }
    *, *::before, *::after { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--vscode-editor-foreground);
      background: var(--vscode-editor-background);
      font: var(--vscode-font-size, 13px)/1.55 var(--vscode-font-family, sans-serif);
    }
    main { width: min(100%, 660px); margin: 0 auto; padding: 36px 28px; }
    h1, p { margin: 0; }
    h1 { font-size: 1.85em; font-weight: 600; line-height: 1.3; margin-bottom: 8px; }
    .product { color: var(--vscode-descriptionForeground); font-size: .92em; margin-bottom: 6px; }
    .muted, .hint { color: var(--vscode-descriptionForeground); }
    .folder {
      padding: 12px 14px;
      margin: 20px 0;
      border: 1px solid var(--vscode-panel-border, var(--vscode-focusBorder));
      border-radius: 4px;
    }
    .folder p + p { margin-top: 3px; }
    .path { overflow-wrap: anywhere; }
    fieldset { margin: 0; padding: 0; border: 0; min-width: 0; display: grid; gap: 16px; }
    label { display: block; font-weight: 600; margin-bottom: 5px; }
    input, button { font: inherit; }
    input {
      width: 100%;
      padding: 8px 10px;
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 3px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
    }
    input::placeholder { color: var(--vscode-input-placeholderForeground); }
    input:focus-visible, button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
    input[aria-invalid="true"] { border-color: var(--vscode-inputValidation-errorBorder, var(--vscode-errorForeground)); }
    .hint { font-size: .92em; margin-top: 5px; }
    code { font-family: var(--vscode-editor-font-family, monospace); color: var(--vscode-textPreformat-foreground, inherit); overflow-wrap: anywhere; }
    button {
      margin-top: 20px;
      padding: 7px 16px;
      border: 1px solid var(--vscode-button-border, transparent);
      border-radius: 3px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      cursor: pointer;
    }
    button:hover:not(:disabled) { background: var(--vscode-button-hoverBackground); }
    button:disabled { opacity: .65; cursor: default; }
    .feedback:not(:empty) { margin-top: 12px; overflow-wrap: anywhere; }
    .feedback[data-state="error"] { color: var(--vscode-errorForeground); }
    @media (max-width: 400px) { main { padding: 24px 16px; } }
  </style>
</head>
<body>
  <main>
    <header>
      <p class="product">Folder Relay</p>
      <h1>连接共享工作区</h1>
      <p class="muted">填写发起人提供的连接信息。加入后，重新打开此文件夹会自动连接。</p>
    </header>
    <section class="folder" aria-label="当前本地文件夹">
      <p class="muted">当前本地文件夹</p>
      <p class="path">${escapeHtml(initial.folder)}</p>
      <p class="hint">发起人可打开已有项目文件夹上传。其他成员首次加入时请选择新建的空文件夹。</p>
    </section>
    <form id="connection-form" autocomplete="off" novalidate>
      <fieldset id="connection-fields" aria-label="连接信息">
        <div>
          <label for="server-address">服务器地址</label>
          <input id="server-address" type="text" value="${escapeHtml(initial.url)}" required spellcheck="false" autocapitalize="none" aria-describedby="server-help">
          <p id="server-help" class="hint">本机测试示例 <code>ws://127.0.0.1:1236</code>。跨电脑请填管理员提供的加密地址，例如 <code>wss://sync.example.com</code>。</p>
        </div>
        <div>
          <label for="workspace-id">工作区 ID</label>
          <input id="workspace-id" type="text" value="${escapeHtml(initial.workspaceId)}" required spellcheck="false" autocapitalize="none" aria-describedby="workspace-help">
          <p id="workspace-help" class="hint">同一个共享项目的成员使用相同的 ID。</p>
        </div>
        <div>
          <label for="access-token">访问令牌</label>
          <input id="access-token" type="password" placeholder="粘贴完整令牌" required autocomplete="off" aria-describedby="token-help">
          <p id="token-help" class="hint">从发起人处获取。至少 24 个字符，不含空格。</p>
        </div>
      </fieldset>
      <button id="connect" type="submit">连接工作区</button>
      <p id="connection-feedback" class="feedback" aria-live="polite" aria-atomic="true"></p>
    </form>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const form = document.getElementById('connection-form');
    const fields = document.getElementById('connection-fields');
    const address = document.getElementById('server-address');
    const workspaceId = document.getElementById('workspace-id');
    const token = document.getElementById('access-token');
    const button = document.getElementById('connect');
    const feedback = document.getElementById('connection-feedback');
    const draft = vscode.getState();

    if (typeof draft?.url === 'string') address.value = draft.url;
    if (typeof draft?.workspaceId === 'string') workspaceId.value = draft.workspaceId;
    for (const input of [address, workspaceId]) {
      input.addEventListener('input', () => vscode.setState({ url: address.value, workspaceId: workspaceId.value }));
    }
    for (const input of [address, workspaceId, token]) {
      input.addEventListener('input', () => input.removeAttribute('aria-invalid'));
    }

    function showStatus(state, message) {
      fields.disabled = button.disabled = state === 'connecting' || state === 'connected';
      button.textContent = state === 'connecting' ? '正在连接…' : state === 'connected' ? '已连接' : '连接工作区';
      feedback.dataset.state = state;
      feedback.textContent = message;
      if (state === 'connected') token.value = '';
    }

    form.addEventListener('submit', event => {
      event.preventDefault();
      if (button.disabled) return;
      const inputs = [[address, '服务器地址'], [workspaceId, '工作区 ID'], [token, '访问令牌']];
      for (const [input, name] of inputs) {
        if (input.value.trim()) continue;
        input.setAttribute('aria-invalid', 'true');
        input.focus();
        showStatus('error', '请填写' + name + '。');
        return;
      }
      showStatus('connecting', '正在验证地址、工作区 ID 和令牌…');
      vscode.postMessage({ type: 'connect', url: address.value.trim(), workspaceId: workspaceId.value.trim(), token: token.value });
    });

    window.addEventListener('message', ({ data }) => {
      if (data?.state === 'connecting') showStatus('connecting', '正在验证地址、工作区 ID 和令牌…');
      if (data?.state === 'connected') showStatus('connected', '已连接，正在同步。可在 VS Code 底部状态栏查看进度。');
      if (data?.state === 'error') showStatus('error', data.message);
    });
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
}
