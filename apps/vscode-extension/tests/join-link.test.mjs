/**
 * 一键加入链接的纯逻辑测试（不启动 VS Code）。
 *
 * 这些用例锁住的是"链接格式契约"：服务端 `/join` 页面生成的链接、扩展解析的链接、
 * 以及粘贴进 VS Code 的 `vscode://` 链接必须是同一套字段与编码规则。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildJoinLink,
  endpointToJoinUrl,
  isPrivateHost,
  JOIN_OWNER,
  JOIN_PATH,
  normalizeJoinUrl,
  parseJoinLink,
} from '../src/join-link.ts';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const TOKEN = 'abcdefghijklmnopqrstuvwx0123456789';
const REMOTE = 'wss://sync.example.com';

test('生成的链接使用 vscode:// 且能被同一套解析器还原', () => {
  const link = buildJoinLink({ url: REMOTE, workspaceId: WORKSPACE, token: TOKEN });
  assert.ok(link.startsWith('vscode://' + JOIN_OWNER + JOIN_PATH + '?'), link);
  assert.deepEqual(parseJoinLink(link), { url: REMOTE, workspaceId: WORKSPACE, token: TOKEN });
});

test('令牌里的 + / = 会被正确转义并原样还原', () => {
  const token = 'ab+/cdefghijklmnopqrstuv/012345678=';
  const link = buildJoinLink({ url: REMOTE, workspaceId: WORKSPACE, token });
  assert.ok(!link.includes(token), '令牌不能以明文形式直接出现在查询串里');
  assert.equal(parseJoinLink(link)?.token, token);
});

test('工作区 ID 大小写归一，地址尾斜杠被去掉', () => {
  const link = buildJoinLink({ url: REMOTE + '/', workspaceId: WORKSPACE.toUpperCase(), token: TOKEN });
  assert.deepEqual(parseJoinLink(link), { url: REMOTE, workspaceId: WORKSPACE, token: TOKEN });
});

test('接受手写的 folderrelay:// 形式', () => {
  const link = 'folderrelay://join?url=' + encodeURIComponent(REMOTE)
    + '&workspace=' + WORKSPACE + '&token=' + encodeURIComponent(TOKEN);
  assert.deepEqual(parseJoinLink(link), { url: REMOTE, workspaceId: WORKSPACE, token: TOKEN });
});

test('无关链接返回 undefined，不抛错（VS Code 会把所有 URI 都转过来）', () => {
  assert.equal(parseJoinLink('vscode://other.publisher/join'), undefined);
  assert.equal(parseJoinLink('https://example.com/join'), undefined);
  assert.equal(parseJoinLink('not a url'), undefined);
  assert.equal(parseJoinLink(''), undefined);
  // 同一扩展的其它命令也应该被忽略
  assert.equal(parseJoinLink('vscode://' + JOIN_OWNER + '/other?x=1'), undefined);
});

test('缺参数或参数非法时抛错（这类错误必须让用户看到）', () => {
  assert.throws(() => parseJoinLink('vscode://' + JOIN_OWNER + '/join?url=' + encodeURIComponent(REMOTE)), /不完整/);
  assert.throws(
    () => parseJoinLink('vscode://' + JOIN_OWNER + '/join?url=' + encodeURIComponent(REMOTE) + '&workspace=bad&token=' + TOKEN),
    /UUID/,
  );
  assert.throws(
    () => parseJoinLink('vscode://' + JOIN_OWNER + '/join?url=' + encodeURIComponent(REMOTE) + '&workspace=' + WORKSPACE + '&token=short'),
    /令牌/,
  );
});

test('远程必须 wss，ws 只允许回环', () => {
  assert.throws(() => normalizeJoinUrl('ws://sync.example.com'), /wss/);
  assert.equal(normalizeJoinUrl('ws://127.0.0.1:1234'), 'ws://127.0.0.1:1234');
  assert.equal(normalizeJoinUrl('ws://localhost:1234'), 'ws://localhost:1234');
  assert.throws(() => normalizeJoinUrl('wss://user:pass@sync.example.com'), /账号/);
  assert.throws(() => normalizeJoinUrl('wss://sync.example.com/?x=1'), /查询串/);
});

test('endpointToJoinUrl 把 http(s) 端点折成 ws(s)', () => {
  assert.equal(endpointToJoinUrl('https://sync.example.com/'), 'wss://sync.example.com');
  assert.equal(endpointToJoinUrl('http://127.0.0.1:1234'), 'ws://127.0.0.1:1234');
  assert.equal(endpointToJoinUrl(new URL('wss://sync.example.com')), 'wss://sync.example.com');
});

// ---------------------------------------------------------------- 局域网明文

const LAN = 'ws://192.168.1.23:1234';

test('ws:// 私有网段：未同意时报错，带同意标记才放行', () => {
  assert.throws(() => normalizeJoinUrl(LAN), /wss/);
  assert.equal(normalizeJoinUrl(LAN, { allowInsecureLan: true }), LAN);
});

test('ws:// 公网地址即使勾选也拒绝（勾选只对私有网段有效）', () => {
  assert.throws(() => normalizeJoinUrl('ws://sync.example.com', { allowInsecureLan: true }), /wss/);
  assert.throws(() => normalizeJoinUrl('ws://8.8.8.8:1234', { allowInsecureLan: true }), /wss/);
});

test('私有网段判定覆盖 10 / 172.16-31 / 192.168 / CGNAT / .local', () => {
  for (const host of ['10.1.2.3', '172.16.5.4', '172.31.255.1', '192.168.1.1', '100.101.102.103', 'relay.local', 'localhost']) {
    assert.equal(isPrivateHost(host), true, host + ' 应判定为私有');
  }
  for (const host of ['172.15.0.1', '172.32.0.1', '8.8.8.8', 'sync.example.com', '192.169.1.1']) {
    assert.equal(isPrivateHost(host), false, host + ' 不应判定为私有');
  }
});

test('局域网加入链接往返：自动带 insecure=1，解析后仍带同意标记', () => {
  const link = buildJoinLink({ url: LAN, workspaceId: WORKSPACE, token: TOKEN, allowInsecureLan: true });
  assert.match(link, /insecure=1/);
  const parsed = parseJoinLink(link);
  assert.equal(parsed.url, LAN);
  assert.equal(parsed.allowInsecureLan, true);
});

test('未同意的局域网地址无法生成链接（防止手滑把明文连接发出去）', () => {
  assert.throws(() => buildJoinLink({ url: LAN, workspaceId: WORKSPACE, token: TOKEN }), /wss/);
});

test('手写的不带 insecure 的局域网链接会被拒，不能被静默接受', () => {
  const link = 'vscode://' + JOIN_OWNER + JOIN_PATH + '?url=' + encodeURIComponent(LAN)
    + '&workspace=' + WORKSPACE + '&token=' + encodeURIComponent(TOKEN);
  assert.throws(() => parseJoinLink(link), /wss/);
});

test('回环的 ws:// 链接不需要 insecure 标记', () => {
  const link = buildJoinLink({ url: 'ws://127.0.0.1:1234', workspaceId: WORKSPACE, token: TOKEN });
  assert.ok(!link.includes('insecure'));
  assert.equal(parseJoinLink(link)?.allowInsecureLan, undefined);
});
