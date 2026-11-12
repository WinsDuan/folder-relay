/**
 * 远程协议 v1 端到端验收。
 *
 * 这些用例只依赖 docs/remote-protocol.md 的文本契约，不 import 服务端内部模块：
 * 每轮都用真实子进程拉起服务端，用 HTTP/WS 从外部验证，避免"自己的 mock 对自己的实现"。
 *
 * 运行：node --test tests/remote-e2e.test.mjs
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = join(repoRoot, 'apps', 'collab-server', 'src', 'server.mjs');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const sleep = ms => new Promise(done => setTimeout(done, ms));

async function launchServer(overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'lsw-e2e-'));
  const token = randomBytes(24).toString('base64url');
  const workspace = randomUUID();
  const env = {
    ...process.env,
    LSW_PORT: '0',
    LSW_TOKEN: token,
    LSW_DOCUMENT_ID: workspace,
    LSW_DB_PATH: join(directory, 'state.sqlite3'),
    LSW_DATA_DIR: directory,
    LSW_HEARTBEAT_MS: '200',
    ...overrides,
  };
  for (const [key, value] of Object.entries(overrides)) if (value === undefined) delete env[key];
  const child = spawn(process.execPath, [SERVER], { cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  const started = await new Promise((resolveStart, rejectStart) => {
    const timer = setTimeout(() => rejectStart(new Error('服务端 12 秒内未启动\n' + stderr)), 12_000);
    let buffer = '';
    child.stdout.on('data', chunk => {
      buffer += chunk.toString();
      for (const line of buffer.split('\n')) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.event === 'listening') { clearTimeout(timer); resolveStart(event); }
        } catch { /* 非 JSON 行 */ }
      }
    });
    child.once('exit', code => { clearTimeout(timer); rejectStart(new Error('服务端提前退出 code=' + code + '\n' + stderr)); });
  });
  const base = `http://${started.host.includes(':') ? '[' + started.host + ']' : started.host}:${started.port}`;
  return {
    base, token, workspace, child, directory,
    wsBase: base.replace(/^http/, 'ws'),
    headers: { Authorization: 'Bearer ' + token },
    async stop() {
      if (child.exitCode !== null) return;
      child.kill('SIGTERM');
      await new Promise(done => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); done(); }, 6000);
        child.once('exit', () => { clearTimeout(timer); done(); });
      });
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

function url(server, pathname, params = {}) {
  const target = new URL(pathname, server.base);
  for (const [key, value] of Object.entries(params)) if (value !== undefined) target.searchParams.set(key, String(value));
  return target;
}

async function getJson(server, pathname, params = {}) {
  const response = await fetch(url(server, pathname, params), { headers: server.headers, redirect: 'error' });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: response.status, headers: response.headers, body };
}

async function commit(server, path, revision, payload, { idempotencyKey } = {}) {
  const response = await fetch(url(server, '/v1/workspace/commit', { workspace: server.workspace, path }), {
    method: 'POST',
    headers: {
      ...server.headers,
      'If-Match': '"' + revision + '"',
      'Content-Type': 'application/octet-stream',
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
    },
    body: payload,
  });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: response.status, body };
}

function openEvents(server, since = 0) {
  const target = url(server, '/v1/events', { workspace: server.workspace, since });
  target.protocol = 'ws:';
  const socket = new WebSocket(target.href, ['lsw.v1', 'lsw.token.' + server.token]);
  const messages = [];
  socket.on('message', raw => {
    try { messages.push(JSON.parse(raw.toString())); } catch { messages.push({ t: 'raw' }); }
  });
  const waitFor = async (predicate, timeoutMs = 5000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = messages.find(predicate);
      if (found) return found;
      await sleep(25);
    }
    throw new Error('未在 ' + timeoutMs + 'ms 内收到期望事件，已知：' + JSON.stringify(messages.slice(-8)));
  };
  return { socket, messages, waitFor, close: () => socket.close() };
}

describe('远程协议 v1', () => {
  let server;
  before(async () => { server = await launchServer(); });
  after(async () => { await server?.stop(); });

  it('能力协商暴露 proto 1 与推送/分片能力', async () => {
    const { status, body } = await getJson(server, '/v1/config');
    assert.equal(status, 200);
    assert.equal(body.proto, 1);
    for (const feature of ['ws', 'longpoll', 'chunked-upload', 'range', 'idempotency']) {
      assert.ok(body.features.includes(feature), '缺少能力 ' + feature);
    }
    assert.ok(body.heartbeatMs > 0);
    assert.ok(body.chunkBytes > 0);
  });

  it('旧 manifest 仍可用，并带上 X-LSW-Seq', async () => {
    const response = await fetch(url(server, '/workspace/manifest', { workspace: server.workspace }), { headers: server.headers });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(Array.isArray(body.files));
    assert.match(response.headers.get('x-lsw-seq') ?? '', /^\d+$/, 'manifest 必须带 X-LSW-Seq');
  });

  it('commit 返回 seq，幂等键重放不重复递增', async () => {
    const first = await commit(server, 'docs/a.tex', 0, 'hello', { idempotencyKey: randomUUID() });
    assert.equal(first.status, 200);
    assert.equal(first.body.file.revision, 1);
    assert.ok(first.body.seq >= 1);

    const key = randomUUID();
    const one = await commit(server, 'docs/b.tex', 0, 'one', { idempotencyKey: key });
    const replay = await commit(server, 'docs/b.tex', 1, 'one', { idempotencyKey: key });
    assert.equal(one.status, 200);
    assert.equal(replay.status, 200, '相同幂等键应返回原结果而不是 412');
    assert.equal(replay.body.file.revision, one.body.file.revision);
    assert.equal(replay.body.seq, one.body.seq);
  });

  it('过期 If-Match 返回 412 且带当前版本', async () => {
    await commit(server, 'docs/c.tex', 0, 'v1');
    const stale = await commit(server, 'docs/c.tex', 0, 'v2');
    assert.equal(stale.status, 412);
    assert.equal(stale.body.error, 'revision-changed');
    assert.equal(stale.body.file.revision, 1);
  });

  it('changes 增量自 since 起单调递增', async () => {
    const before = await getJson(server, '/v1/workspace/changes', { workspace: server.workspace, since: 0 });
    assert.equal(before.status, 200);
    assert.equal(before.body.reset, false);
    const changes = before.body.changes;
    assert.ok(changes.length > 0);
    for (let index = 1; index < changes.length; index++) {
      assert.ok(changes[index].seq > changes[index - 1].seq, 'seq 必须严格递增');
    }
    const cursor = changes.at(-1).seq;
    await commit(server, 'docs/d.tex', 0, 'delta');
    const after = await getJson(server, '/v1/workspace/changes', { workspace: server.workspace, since: cursor });
    assert.equal(after.body.from, cursor + 1);
    assert.ok(after.body.changes.some(change => change.path === 'docs/d.tex'));
  });

  it('WS 首帧是 hello，commit 后收到 changes，since 可重放', async () => {
    const events = openEvents(server, 0);
    const hello = await events.waitFor(message => message.t === 'hello');
    assert.equal(hello.proto, 1);
    assert.ok(hello.seq >= 0);
    await commit(server, 'docs/ws.tex', 0, 'push me');
    const pushed = await events.waitFor(message => message.t === 'changes' && message.changes.some(change => change.path === 'docs/ws.tex'));
    assert.ok(pushed.head >= pushed.changes[0].seq);
    events.close();

    const replay = openEvents(server, 0);
    const replayed = await replay.waitFor(message => message.t === 'changes' && message.changes.some(change => change.path === 'docs/ws.tex'));
    assert.ok(replayed.changes.length > 0);
    replay.close();
  });

  it('分片上传：断点恢复、hash 校验、完成后对端可见', async () => {
    const payload = randomBytes(1024 * 1024 + 1234);
    const digest = sha256(payload);
    const chunkBytes = 512 * 1024;
    const path = 'figures/big.bin';

    const created = await fetch(url(server, '/v1/upload', {
      workspace: server.workspace, path, size: String(payload.length), sha256: digest, base: '0',
    }), { method: 'POST', headers: server.headers });
    // 注意：断言消息会被**立即求值**，若在这里 await body 就会把响应体消费掉，
    // 后面的 json() 会抛 "Body is unusable"。先读一次文本，再解析。
    const createdText = await created.text();
    assert.equal(created.status, 201, createdText);
    const session = JSON.parse(createdText);
    assert.equal(session.offset, 0);
    assert.deepEqual(session.received ?? [], [], '新会话的 received 应为空数组');
    assert.ok(session.chunkBytes > 0);

    const put = async (id, offset) => {
      const response = await fetch(url(server, '/v1/upload/' + id, { offset: String(offset) }), {
        method: 'PUT', headers: server.headers, body: payload.subarray(offset, offset + chunkBytes),
      });
      return { status: response.status, body: await response.json().catch(() => ({})) };
    };

    const firstChunk = await put(session.upload, 0);
    assert.equal(firstChunk.status, 200);
    assert.equal(firstChunk.body.offset, chunkBytes);

    // 模拟客户端崩溃后重建会话：同 (path,size,sha256) 必须能拿回已收偏移
    const resumed = await fetch(url(server, '/v1/upload', {
      workspace: server.workspace, path, size: String(payload.length), sha256: digest, base: '0',
    }), { method: 'POST', headers: server.headers });
    const resumedBody = await resumed.json();
    assert.equal(resumedBody.offset, chunkBytes, '同名同 hash 的会话应续传');
    const id = resumedBody.upload;

    let offset = resumedBody.offset;
    while (offset < payload.length) {
      const step = await put(id, offset);
      assert.equal(step.status, 200, JSON.stringify(step.body));
      offset = step.body.offset;
    }

    const finished = await fetch(url(server, '/v1/upload/' + id + '/finish'), { method: 'POST', headers: server.headers });
    const finishedBody = await finished.json();
    assert.equal(finished.status, 200, JSON.stringify(finishedBody));
    assert.equal(finishedBody.file.sha256, digest);
    assert.equal(finishedBody.file.size, payload.length);

    const manifest = await fetch(url(server, '/workspace/manifest', { workspace: server.workspace }), { headers: server.headers });
    const listed = (await manifest.json()).files.find(file => file.path === path);
    assert.ok(listed, '分片上传完成后应出现在清单里');
    assert.equal(listed.sha256, digest);
  });

  it('Range 下载返回 206 + Content-Range', async () => {
    await commit(server, 'docs/range.txt', 0, 'x'.repeat(5000));
    const manifest = await fetch(url(server, '/workspace/manifest', { workspace: server.workspace }), { headers: server.headers });
    const row = (await manifest.json()).files.find(file => file.path === 'docs/range.txt');
    assert.ok(row);
    const response = await fetch(url(server, '/workspace/file', { workspace: server.workspace, path: row.path, revision: row.revision }), {
      headers: { ...server.headers, Range: 'bytes=100-199' },
    });
    assert.equal(response.status, 206);
    assert.match(response.headers.get('content-range') ?? '', /^bytes 100-199\/5000$/);
    assert.equal((await response.arrayBuffer()).byteLength, 100);
  });

  it('一键加入页面：回环可读、反代来的必须带令牌、生成的链接能被客户端解析', async () => {
    const page = await fetch(url(server, '/join'));
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type') ?? '', /text\/html/);
    const html = await page.text();
    assert.match(html, /vscode:\/\/lsw-local\.latex-sync-workspace\/join\?/, '页面必须含一键加入链接');
    assert.ok(html.includes(server.workspace), '页面应带工作区 ID');
    assert.ok(html.includes(server.token), '回环请求应能看到令牌（发起人本机）');

    // 从链接里抠出 URL 并用扩展的解析器验证：服务端与客户端的格式契约。
    const link = html.match(/vscode:\/\/lsw-local\.latex-sync-workspace\/join\?[^"<\s]+/)[0]
      .replace(/&amp;/g, '&');
    const { parseJoinLink } = await import('../apps/vscode-extension/src/join-link.ts');
    assert.deepEqual(parseJoinLink(link), {
      url: 'ws://' + new URL(server.base).host,
      workspaceId: server.workspace,
      token: server.token,
    });

    // 反代场景：请求看起来来自回环，但带 X-Forwarded-For → 必须带对令牌。
    const proxied = await fetch(url(server, '/join'), { headers: { 'X-Forwarded-For': '203.0.113.7' } });
    assert.equal(proxied.status, 401, '反代转发且无令牌时必须拒绝，否则等于把令牌公开');
    const proxiedAuthorized = await fetch(url(server, '/join'), {
      headers: { 'X-Forwarded-For': '203.0.113.7', ...server.headers },
    });
    assert.equal(proxiedAuthorized.status, 200);

    const wrongMethod = await fetch(url(server, '/join'), { method: 'POST', headers: server.headers });
    assert.equal(wrongMethod.status, 405);
  });

  it('无令牌与错误令牌都被拒', async () => {    const anonymous = await fetch(url(server, '/v1/workspace/changes', { workspace: server.workspace, since: 0 }));
    assert.equal(anonymous.status, 401);
    const wrong = await fetch(url(server, '/v1/workspace/changes', { workspace: server.workspace, since: 0 }), {
      headers: { Authorization: 'Bearer ' + 'z'.repeat(32) },
    });
    assert.equal(wrong.status, 401);
  });

  it('优雅停机：广播 reset 并以 1012 关闭', { skip: process.platform === 'win32'
    ? 'Windows 上 child.kill() 走 TerminateProcess，不会触发子进程的 SIGTERM 监听；'
      + '该路径由 apps/collab-server/test 里的 in-process startServer().stop() 用例覆盖'
    : false }, async () => {
    const local = await launchServer();
    const events = openEvents(local, 0);
    await events.waitFor(message => message.t === 'hello');
    const closed = new Promise(done => events.socket.once('close', code => done(code)));
    local.child.kill('SIGTERM');
    const code = await closed;
    await local.stop();
    assert.ok(
      events.messages.some(message => message.t === 'reset'),
      '停机前应广播 reset，实际：' + JSON.stringify(events.messages.slice(-5)),
    );
    assert.equal(code, 1012);
  });
});

describe('公网绑定开关', () => {
  it('未开 LSW_BIND_PUBLIC 时拒绝非回环地址', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'lsw-bind-'));
    const child = spawn(process.execPath, [SERVER], {
      cwd: repoRoot,
      env: {
        ...process.env, LSW_PORT: '0', LSW_HOST: '0.0.0.0',
        LSW_TOKEN: randomBytes(24).toString('base64url'),
        LSW_DOCUMENT_ID: randomUUID(),
        LSW_DB_PATH: join(directory, 's.sqlite3'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    const code = await new Promise(done => child.once('exit', done));
    rmSync(directory, { recursive: true, force: true });
    assert.notEqual(code, 0, '未显式开启公网绑定时应拒绝启动');
    assert.match(stderr, /LSW_BIND_PUBLIC|loopback|回环/i, '错误信息应指明需要显式开关，实际：' + stderr);
  });

  it('开启 LSW_BIND_PUBLIC 后可以监听 0.0.0.0', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'lsw-bind2-'));
    const child = spawn(process.execPath, [SERVER], {
      cwd: repoRoot,
      env: {
        ...process.env, LSW_PORT: '0', LSW_HOST: '0.0.0.0', LSW_BIND_PUBLIC: '1',
        LSW_TOKEN: randomBytes(24).toString('base64url'),
        LSW_DOCUMENT_ID: randomUUID(),
        LSW_DB_PATH: join(directory, 's.sqlite3'),
        LSW_DATA_DIR: directory,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    const started = await new Promise((resolveStart, rejectStart) => {
      const timer = setTimeout(() => rejectStart(new Error('未监听：' + stderr)), 12_000);
      let buffer = '';
      child.stdout.on('data', chunk => {
        buffer += chunk.toString();
        for (const line of buffer.split('\n')) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            if (event.event === 'listening') { clearTimeout(timer); resolveStart(event); }
          } catch { /* ignore */ }
        }
      });
      child.once('exit', code => { clearTimeout(timer); rejectStart(new Error('退出 code=' + code + '\n' + stderr)); });
    });
    child.kill('SIGTERM');
    await new Promise(done => child.once('exit', done));
    rmSync(directory, { recursive: true, force: true });
    assert.ok(started.port > 0);
  });
});
