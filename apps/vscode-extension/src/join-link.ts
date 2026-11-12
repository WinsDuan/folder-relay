/**
 * 一键加入链接。
 *
 * 手抄「wss 地址 + 工作区 UUID + 32 位令牌」是加入失败的头号原因（令牌抄错、少了字符、
 * 中文输入法全角符号）。所以把三样东西编码成一个链接：点一下（或粘进浏览器/微信）
 * 就交给 VS Code 的 URI handler。
 *
 * 格式（VS Code 只会把 `vscode://<publisher>.<name>/...` 路由给扩展，自定义 scheme 收不到）：
 *
 *   vscode://lsw-local.latex-sync-workspace/join?url=wss%3A%2F%2Fsync.example.com&workspace=<uuid>&token=<t>
 *   vscode://lsw-local.latex-sync-workspace/join?url=ws%3A%2F%2F192.168.1.23%3A1234&…&insecure=1
 *
 * 第二条是**局域网明文**模式：同一个 WiFi 里直连，没有 TLS。它必须显式带 `insecure=1`，
 * 因为 `ws://` 默认只允许回环地址——不能让一个手滑的 `ws://` 悄悄把文件明文传上公网。
 *
 * 本文件刻意不 import `vscode`：纯函数，Node 的类型剥离可以直接跑测试。
 */

export const JOIN_OWNER = 'lsw-local.latex-sync-workspace';
export const JOIN_PATH = '/join';
const JOIN_SCHEMES = new Set(['vscode', 'folderrelay']);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const TOKEN = /^[!-~]{24,1024}$/;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export interface JoinTarget {
  url: string;
  workspaceId: string;
  token: string;
  /** 局域网明文（`ws://` 私有网段）已由用户显式同意。 */
  allowInsecureLan?: boolean;
}

/** RFC1918 私有网段 + CGNAT（Tailscale 也在这段里）+ mDNS 名字。 */
export function isPrivateHost(hostname: string): boolean {
  const host = String(hostname).toLowerCase().replace(/^\[|\]$/g, '');
  if (LOOPBACK.has(host) || host.endsWith('.local') || host === 'localhost') return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK.has(String(hostname).toLowerCase());
}

/**
 * 校验并归一一条 ws/wss 地址：
 * - `wss://` 任何地址都可以；
 * - `ws://` 只允许回环，或"私有网段 + 调用方显式同意局域网明文"。
 */
export function normalizeJoinUrl(value: string, options: { allowInsecureLan?: boolean } = {}): string {
  const url = new URL(value);
  const loopback = isLoopbackHost(url.hostname);
  if (url.protocol !== 'wss:') {
    if (url.protocol !== 'ws:') throw new Error('地址必须以 wss:// 或 ws:// 开头。');
    if (!loopback && !(options.allowInsecureLan && isPrivateHost(url.hostname))) {
      throw new Error('远程地址必须用 wss://；只有本机回环、或已勾选「局域网明文」时才能用 ws://。');
    }
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('地址里不要带账号、查询串或片段。');
  }
  return url.href.replace(/\/$/, '');
}

function needsInsecureFlag(url: string): boolean {
  if (!url.startsWith('ws://')) return false;
  return !isLoopbackHost(new URL(url).hostname);
}

export function buildJoinLink(target: JoinTarget): string {
  const allowInsecureLan = target.allowInsecureLan === true;
  const url = normalizeJoinUrl(target.url, { allowInsecureLan });
  const workspaceId = target.workspaceId.trim().toLowerCase();
  if (!UUID.test(workspaceId)) throw new Error('工作区 ID 必须是 UUID。');
  if (!TOKEN.test(target.token)) throw new Error('令牌长度不合法。');
  // 用 URLSearchParams 保证 token 里的 + / = 之类被正确转义。
  const query = new URLSearchParams({ url, workspace: workspaceId, token: target.token });
  if (needsInsecureFlag(url)) query.set('insecure', '1');
  return 'vscode://' + JOIN_OWNER + JOIN_PATH + '?' + query.toString();
}

/**
 * 解析一键加入链接。失败返回 `undefined`（调用方据此决定是否提示"这不是加入链接"），
 * 校验失败抛错（例如令牌被截断——这类错误要显式告诉用户，不能静默忽略）。
 */
export function parseJoinLink(input: string): JoinTarget | undefined {
  const text = input.trim();
  if (!text) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return undefined;
  }
  const scheme = parsed.protocol.replace(/:$/, '').toLowerCase();
  if (!JOIN_SCHEMES.has(scheme)) return undefined;
  if (scheme === 'vscode' && parsed.host.toLowerCase() !== JOIN_OWNER) return undefined;
  const path = parsed.pathname.replace(/\/+$/, '');
  if (path !== '' && path !== JOIN_PATH) return undefined;

  const url = parsed.searchParams.get('url');
  const workspaceId = parsed.searchParams.get('workspace');
  const token = parsed.searchParams.get('token');
  if (!url || !workspaceId || !token) throw new Error('加入链接不完整，需要 url、workspace、token 三个参数。');

  const allowInsecureLan = parsed.searchParams.get('insecure') === '1';
  const normalizedUrl = normalizeJoinUrl(url, { allowInsecureLan });
  const normalizedWorkspace = workspaceId.trim().toLowerCase();
  if (!UUID.test(normalizedWorkspace)) throw new Error('加入链接里的工作区 ID 不是合法 UUID。');
  if (!TOKEN.test(token)) throw new Error('加入链接里的令牌被截断或含非法字符。');
  const target: JoinTarget = { url: normalizedUrl, workspaceId: normalizedWorkspace, token };
  if (needsInsecureFlag(normalizedUrl)) target.allowInsecureLan = true;
  return target;
}

/** 从服务端根地址推导显式的 ws/wss 地址（与连接窗口里手填的规则一致）。 */
export function endpointToJoinUrl(endpoint: string | URL): string {
  const url = new URL(String(endpoint));
  url.protocol = url.protocol === 'https:' || url.protocol === 'wss:' ? 'wss:' : 'ws:';
  return url.href.replace(/\/$/, '');
}
