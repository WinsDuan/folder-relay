import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { get as httpGet } from 'node:http';
import { get as httpsGet } from 'node:https';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { HocuspocusProvider, MessageType } from '@hocuspocus/provider';
import { readConfig, startServer } from '../src/server.mjs';
import { TLS_CERT, TLS_KEY } from './fixtures/tls.mjs';

const sourceDir = dirname(fileURLToPath(import.meta.url));
const cli = join(sourceDir, '..', 'src', 'member-cli.mjs');
const sha256 = value => createHash('sha256').update(value).digest('hex');

function url(base, pathname, params = {}) {
  const target = new URL(pathname, base);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) target.searchParams.set(key, String(value));
  }
  return target;
}

async function boot(t, overrides = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'lsw-v1-'));
  const token = randomBytes(24).toString('base64url');
  const documentId = randomUUID();
  const config = readConfig({
    LSW_PORT: '0',
    LSW_TOKEN: token,
    LSW_DOCUMENT_ID: documentId,
    LSW_DB_PATH: join(directory, 'state.sqlite3'),
    LSW_DATA_DIR: directory,
    LSW_HEARTBEAT_MS: '60000',
    ...overrides,
  });
  const server = await startServer(config);
  const base = 'http://127.0.0.1:' + server.port;
  t.after(async () => {
    await server.stop();
    rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  });
  return { server, base, wsBase: base.replace('http', 'ws'), token, documentId, directory, config };
}

function auth(ctx, extra = {}, token = ctx.token) {
  return { Authorization: 'Bearer ' + token, ...extra };
}

async function readJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function commit(ctx, path, revision, payload, options = {}) {
  const response = await fetch(url(ctx.base, '/v1/workspace/commit', {
    workspace: ctx.documentId, path, delete: options.delete ? '1' : undefined,
  }), {
    method: 'POST',
    headers: auth(ctx, {
      'If-Match': '"' + revision + '"',
      'Content-Type': 'application/octet-stream',
      ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}),
      ...(options.token ? { Authorization: 'Bearer ' + options.token } : {}),
    }, options.token),
    body: options.delete ? undefined : payload,
  });
  return { status: response.status, body: await readJson(response), headers: response.headers };
}

function openEvents(ctx, { since, token = ctx.token, protocols } = {}) {
  const target = url(ctx.wsBase, '/v1/events', { workspace: ctx.documentId, since });
  const socket = new WebSocket(target, protocols ?? ['lsw.v1', 'lsw.token.' + token]);
  const frames = [];
  const state = { opened: false, closed: false, errors: 0 };
  socket.addEventListener('open', () => { state.opened = true; });
  socket.addEventListener('message', event => {
    try {
      frames.push(JSON.parse(event.data));
    } catch {
      frames.push({ t: 'raw' });
    }
  });
  socket.addEventListener('error', () => { state.errors++; });
  const closed = new Promise(resolveClose => {
    socket.addEventListener('close', event => {
      state.closed = true;
      resolveClose(event);
    });
  });
  const waitFor = async (predicate, timeout = 5000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const found = frames.find(predicate);
      if (found) return found;
      await delay(20);
    }
    throw new Error('missing frame; saw ' + JSON.stringify(frames.slice(-6)));
  };
  return { socket, frames, state, closed, waitFor, close: () => socket.close() };
}

test('v1 config negotiates proto 1 with the documented tuning values', async (t) => {
  const ctx = await boot(t);
  const response = await fetch(url(ctx.base, '/v1/config'));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await readJson(response);
  assert.equal(body.proto, 1);
  assert.equal(body.workspace, null);
  for (const feature of ['ws', 'longpoll', 'chunked-upload', 'range', 'idempotency', 'member-tokens']) {
    assert.ok(body.features.includes(feature), feature);
  }
  assert.equal(body.heartbeatMs, 60000);
  assert.equal(body.chunkBytes, 524288);
  assert.equal(body.maxFileBytes, 16 * 1024 * 1024);
  assert.equal(body.maxPaths, 4096);
  assert.equal(body.pollFallbackMs, 3000);
  assert.equal(body.maxChunkConcurrency, 3);
  assert.equal(body.partRetry, 3);
  assert.equal(body.cooldownAfterFailures, 5);
  assert.equal(body.cooldownMs, 30000);
  assert.equal(body.unhealthyAfterErrors, 5);
  assert.equal(body.errorWindowMs, 60000);

  const missing = await fetch(url(ctx.base, '/workspace/manifest', { workspace: ctx.documentId }));
  assert.equal(missing.status, 401);
  const wrong = await fetch(url(ctx.base, '/workspace/manifest', { workspace: ctx.documentId }), {
    headers: { Authorization: 'Bearer ' + 'z'.repeat(40) },
  });
  assert.equal(wrong.status, 401);
});

test('legacy and v1 writes share the configured workspace capacity', async (t) => {
  const ctx = await boot(t, { LSW_MAX_WORKSPACE_MIB: '1' });
  const legacyUrl = path => url(ctx.base, '/workspace/file', { workspace: ctx.documentId, path });
  const legacyPut = (path, body) => fetch(legacyUrl(path), {
    method: 'PUT',
    headers: auth(ctx, { 'If-Match': '"0"' }),
    body,
  });

  const first = await legacyPut('first.bin', Buffer.alloc(512 * 1024));
  assert.equal(first.status, 200);
  await first.json();
  assert.equal((await commit(ctx, 'second.bin', 0, Buffer.alloc(512 * 1024))).status, 200);

  const legacyOverflow = await legacyPut('overflow.bin', 'x');
  assert.equal(legacyOverflow.status, 507);
  assert.deepEqual(await legacyOverflow.json(), { error: 'workspace-capacity' });
  const v1Overflow = await commit(ctx, 'overflow.bin', 0, 'x');
  assert.equal(v1Overflow.status, 507);
  assert.deepEqual(v1Overflow.body, { error: 'workspace-capacity' });

  assert.equal((await commit(ctx, 'first.bin', 1, undefined, { delete: true })).status, 200);
  assert.equal((await commit(ctx, 'overflow.bin', 0, 'x')).status, 200);
});

test('commit allocates seq, replays idempotent keys and reports the current revision on 412', async (t) => {
  const ctx = await boot(t);
  const key = randomUUID();
  const first = await commit(ctx, 'docs/a.tex', 0, 'hello', { idempotencyKey: key });
  assert.equal(first.status, 200);
  assert.equal(first.body.file.revision, 1);
  assert.equal(first.body.seq, 1);

  // Replay with the same key and a now-stale If-Match must return the original result.
  const replay = await commit(ctx, 'docs/a.tex', 0, 'hello', { idempotencyKey: key });
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body, first.body);

  const stale = await commit(ctx, 'docs/a.tex', 0, 'other');
  assert.equal(stale.status, 412);
  assert.equal(stale.body.error, 'revision-changed');
  assert.equal(stale.body.file.revision, 1);
  assert.equal(stale.body.file.sha256, sha256('hello'));

  const missingPrecondition = await fetch(url(ctx.base, '/v1/workspace/commit', {
    workspace: ctx.documentId, path: 'docs/a.tex',
  }), { method: 'POST', headers: auth(ctx), body: 'x' });
  assert.equal(missingPrecondition.status, 428);
  assert.equal((await readJson(missingPrecondition)).error, 'revision-precondition-required');

  // A delete is a tombstone event with sha256 null and deleted true.
  const removed = await commit(ctx, 'docs/a.tex', 1, null, { delete: true });
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.body.file, { path: 'docs/a.tex', revision: 2, sha256: null, size: 0 });
  assert.ok(removed.body.seq > first.body.seq);

  const changes = await readJson(await fetch(url(ctx.base, '/v1/workspace/changes', {
    workspace: ctx.documentId, since: 0,
  }), { headers: auth(ctx) }));
  assert.equal(changes.reset, false);
  assert.equal(changes.changes.length, 2);
  assert.deepEqual(changes.changes.map(change => change.seq), [first.body.seq, removed.body.seq]);
  assert.equal(changes.changes[1].deleted, true);
  assert.equal(changes.changes[1].sha256, null);

  // The legacy 0.2 endpoint shares the same timeline.
  const legacy = await fetch(url(ctx.base, '/workspace/file', {
    workspace: ctx.documentId, path: 'docs/legacy.tex',
  }), { method: 'PUT', headers: auth(ctx, { 'If-Match': '"0"' }), body: 'legacy' });
  assert.equal(legacy.status, 200);
  assert.equal(legacy.headers.get('x-lsw-seq'), '3');
  const manifest = await fetch(url(ctx.base, '/workspace/manifest', { workspace: ctx.documentId }), { headers: auth(ctx) });
  assert.equal(manifest.headers.get('x-lsw-seq'), '3');
});

test('concurrent commits serialize per file and never reuse a seq', async (t) => {
  const ctx = await boot(t);
  const same = await Promise.all(Array.from({ length: 6 }, (_, index) => commit(ctx, 'same.tex', 0, 'v' + index)));
  assert.deepEqual(same.map(result => result.status).sort(), [200, 412, 412, 412, 412, 412]);
  const winner = same.find(result => result.status === 200);
  assert.equal(winner.body.file.revision, 1);

  const distinct = await Promise.all(Array.from({ length: 8 }, (_, index) => commit(ctx, 'many-' + index + '.tex', 0, 'x')));
  assert.deepEqual(distinct.map(result => result.status), Array(8).fill(200));
  const seqs = distinct.map(result => result.body.seq).sort((left, right) => left - right);
  assert.equal(new Set(seqs).size, 8);
  assert.deepEqual(seqs, Array.from({ length: 8 }, (_, index) => index + 2));

  const manifest = await readJson(await fetch(url(ctx.base, '/workspace/manifest', { workspace: ctx.documentId }), { headers: auth(ctx) }));
  const revisions = manifest.files.filter(file => file.path !== 'same.tex').map(file => file.revision);
  assert.deepEqual(revisions, Array(8).fill(1));
});

test('changes long-polls until a commit lands and caps wait at 30s', async (t) => {
  const ctx = await boot(t);
  const started = Date.now();
  const pending = fetch(url(ctx.base, '/v1/workspace/changes', {
    workspace: ctx.documentId, since: 0, wait: 5000,
  }), { headers: auth(ctx) });
  await delay(80);
  await commit(ctx, 'poll.tex', 0, 'wake');
  const response = await pending;
  const body = await readJson(response);
  assert.equal(body.changes.length, 1);
  assert.equal(body.changes[0].path, 'poll.tex');
  assert.ok(Date.now() - started < 4000, 'long poll should return as soon as the event lands');

  const immediate = await readJson(await fetch(url(ctx.base, '/v1/workspace/changes', {
    workspace: ctx.documentId, since: 1,
  }), { headers: auth(ctx) }));
  assert.equal(immediate.changes.length, 0);
  assert.equal(immediate.from, 2);
  assert.equal(immediate.head, 1);
});

test('websocket push: hello first, changes after commit, since replay and token rejection', async (t) => {
  const ctx = await boot(t);
  // Contract note: a commit broadcasts its `changes` frame before the HTTP
  // response is written, so on a healthy loopback the event can (and usually
  // does) reach the WebSocket client before `fetch()` resolves. Clients must
  // tolerate seeing their own commit's event first.
  const events = openEvents(ctx, { since: 0 });
  t.after(() => events.close());
  const hello = await events.waitFor(frame => frame.t === 'hello');
  assert.equal(hello.proto, 1);
  assert.equal(hello.workspace, ctx.documentId);
  assert.equal(hello.seq, 0);
  assert.equal(hello.floor, 1);
  assert.equal(hello.heartbeatMs, 60000);
  assert.equal(hello.resumeWindow, 4096);

  await commit(ctx, 'push.tex', 0, 'pushed');
  const pushed = await events.waitFor(frame => frame.t === 'changes');
  assert.ok(pushed.changes.some(change => change.path === 'push.tex'));
  assert.equal(pushed.head, 1);
  assert.equal(pushed.floor, 1);
  events.close();

  const replay = openEvents(ctx, { since: 0 });
  t.after(() => replay.close());
  const replayed = await replay.waitFor(frame => frame.t === 'changes' && frame.changes.some(change => change.path === 'push.tex'));
  assert.equal(replayed.changes[0].seq, 1);
  replay.close();

  const rejected = openEvents(ctx, { token: 'lsw1.' + randomUUID() + '.' + 'x'.repeat(40) });
  await rejected.closed;
  assert.equal(rejected.state.opened, false);
  assert.equal(rejected.frames.length, 0);

  const plain = await fetch(url(ctx.base, '/v1/events', { workspace: ctx.documentId, since: 0 }), { headers: auth(ctx) });
  assert.equal(plain.status, 426);
  const body = await readJson(plain);
  assert.equal(body.minProto, 1);
  assert.ok(body.features.includes('ws'));
});

test('ping is emitted on an idle connection at the configured heartbeat', async (t) => {
  const ctx = await boot(t, { LSW_HEARTBEAT_MS: '100' });
  const events = openEvents(ctx, { since: 0 });
  t.after(() => events.close());
  await events.waitFor(frame => frame.t === 'hello');
  const deadline = Date.now() + 3000;
  while (events.frames.filter(frame => frame.t === 'ping').length < 3 && Date.now() < deadline) {
    await delay(20);
  }
  const pings = events.frames.filter(frame => frame.t === 'ping');
  assert.ok(pings.length >= 3, 'expected periodic pings without any commit, saw ' + pings.length);
  for (const ping of pings) assert.equal(typeof ping.seq, 'number');
  assert.equal(events.frames.filter(frame => frame.t === 'changes').length, 0);
});

test('chunked upload resumes, rejects a bad hash and publishes on finish', async (t) => {
  const ctx = await boot(t);
  const payload = randomBytes(1024 * 1024 + 1234);
  const digest = sha256(payload);
  const chunkBytes = 524288;
  const path = 'figures/big.bin';
  const create = () => fetch(url(ctx.base, '/v1/upload', {
    workspace: ctx.documentId, path, size: payload.length, sha256: digest, base: 0,
  }), { method: 'POST', headers: auth(ctx) });

  const created = await create();
  assert.equal(created.status, 201);
  const createdBody = await readJson(created);
  assert.equal(createdBody.offset, 0);
  assert.equal(createdBody.chunkBytes, chunkBytes);
  assert.deepEqual(createdBody.received, []);
  const id = createdBody.upload;

  const put = async (offset, bytes) => {
    const response = await fetch(url(ctx.base, '/v1/upload/' + id, { offset }), {
      method: 'PUT', headers: auth(ctx), body: bytes,
    });
    return { status: response.status, body: await readJson(response) };
  };

  const chunk = await put(0, payload.subarray(0, chunkBytes));
  assert.equal(chunk.status, 200);
  assert.equal(chunk.body.offset, chunkBytes);

  const mismatch = await put(chunkBytes + 10, payload.subarray(chunkBytes, chunkBytes + 10));
  assert.equal(mismatch.status, 409);
  assert.equal(mismatch.body.error, 'upload-offset-mismatch');
  assert.equal(mismatch.body.expected, chunkBytes);

  const resumed = await create();
  assert.equal(resumed.status, 200);
  const resumedBody = await readJson(resumed);
  assert.equal(resumedBody.offset, chunkBytes);
  assert.deepEqual(resumedBody.received, [{ offset: 0, length: chunkBytes }]);

  const badDigest = randomBytes(1024);
  const badCreate = await fetch(url(ctx.base, '/v1/upload', {
    workspace: ctx.documentId, path: 'figures/bad.bin', size: badDigest.length, sha256: sha256('expected'), base: 0,
  }), { method: 'POST', headers: auth(ctx) });
  const badId = (await readJson(badCreate)).upload;
  await fetch(url(ctx.base, '/v1/upload/' + badId, { offset: 0 }), {
    method: 'PUT', headers: auth(ctx), body: badDigest,
  });
  const finishBad = await fetch(url(ctx.base, '/v1/upload/' + badId + '/finish'), { method: 'POST', headers: auth(ctx) });
  assert.equal(finishBad.status, 422);
  assert.equal((await readJson(finishBad)).error, 'upload-hash-mismatch');
  const stillThere = await fetch(url(ctx.base, '/v1/upload/' + badId), { headers: auth(ctx) });
  assert.equal(stillThere.status, 200);

  let offset = chunkBytes;
  while (offset < payload.length) {
    const step = await put(offset, payload.subarray(offset, offset + chunkBytes));
    assert.equal(step.status, 200);
    offset = step.body.offset;
  }

  const listed = await fetch(url(ctx.base, '/v1/upload/' + id), { headers: auth(ctx) });
  const listedBody = await readJson(listed);
  assert.equal(listedBody.offset, payload.length);
  assert.equal(listedBody.received.length, 3);

  const finishKey = randomUUID();
  const finish = await fetch(url(ctx.base, '/v1/upload/' + id + '/finish'), {
    method: 'POST', headers: auth(ctx, { 'Idempotency-Key': finishKey }),
  });
  const finished = await readJson(finish);
  assert.equal(finish.status, 200);
  assert.equal(finished.file.sha256, digest);
  assert.equal(finished.file.size, payload.length);
  assert.equal(finished.seq, 1);

  // `finish` is a commit: a retry with the same key must replay the original
  // result even though the upload session (and its parts) are gone.
  const replayFinish = await fetch(url(ctx.base, '/v1/upload/' + id + '/finish'), {
    method: 'POST', headers: auth(ctx, { 'Idempotency-Key': finishKey }),
  });
  assert.equal(replayFinish.status, 200);
  assert.deepEqual(await readJson(replayFinish), finished);
  const afterReplay = await readJson(await fetch(url(ctx.base, '/v1/workspace/changes', {
    workspace: ctx.documentId, since: 0,
  }), { headers: auth(ctx) }));
  assert.equal(afterReplay.changes.length, 1, 'a replayed finish must not allocate a second seq');

  const manifest = await readJson(await fetch(url(ctx.base, '/workspace/manifest', { workspace: ctx.documentId }), { headers: auth(ctx) }));
  assert.ok(manifest.files.some(file => file.path === path && file.sha256 === digest));

  const cancelled = await fetch(url(ctx.base, '/v1/upload/' + badId), { method: 'DELETE', headers: auth(ctx) });
  assert.equal(cancelled.status, 200);
  assert.equal((await fetch(url(ctx.base, '/v1/upload/' + badId), { headers: auth(ctx) })).status, 410);

  const tooLarge = await fetch(url(ctx.base, '/v1/upload', {
    workspace: ctx.documentId, path: 'figures/huge.bin', size: 32 * 1024 * 1024, sha256: digest, base: 0,
  }), { method: 'POST', headers: auth(ctx) });
  assert.equal(tooLarge.status, 413);
  assert.equal((await readJson(tooLarge)).error, 'file-too-large');
});

test('range downloads answer 206 with Content-Range and 416 for unsatisfiable ranges', async (t) => {
  const ctx = await boot(t);
  await commit(ctx, 'docs/range.txt', 0, 'abcdefghij');
  const manifest = await readJson(await fetch(url(ctx.base, '/workspace/manifest', { workspace: ctx.documentId }), { headers: auth(ctx) }));
  const row = manifest.files.find(file => file.path === 'docs/range.txt');

  const partial = await fetch(url(ctx.base, '/workspace/file', {
    workspace: ctx.documentId, path: row.path, revision: row.revision,
  }), { headers: auth(ctx, { Range: 'bytes=2-5' }) });
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get('content-range'), 'bytes 2-5/10');
  assert.equal(await partial.text(), 'cdef');

  const open = await fetch(url(ctx.base, '/workspace/file', {
    workspace: ctx.documentId, path: row.path, revision: row.revision,
  }), { headers: auth(ctx, { Range: 'bytes=8-' }) });
  assert.equal(open.status, 206);
  assert.equal(open.headers.get('content-range'), 'bytes 8-9/10');
  assert.equal(await open.text(), 'ij');

  const suffix = await fetch(url(ctx.base, '/workspace/file', {
    workspace: ctx.documentId, path: row.path, revision: row.revision,
  }), { headers: auth(ctx, { Range: 'bytes=-3' }) });
  assert.equal(suffix.status, 206);
  assert.equal(await suffix.text(), 'hij');

  const unsatisfiable = await fetch(url(ctx.base, '/workspace/file', {
    workspace: ctx.documentId, path: row.path, revision: row.revision,
  }), { headers: auth(ctx, { Range: 'bytes=50-' }) });
  assert.equal(unsatisfiable.status, 416);
  assert.equal(unsatisfiable.headers.get('content-range'), 'bytes */10');

  const full = await fetch(url(ctx.base, '/workspace/file', {
    workspace: ctx.documentId, path: row.path, revision: row.revision,
  }), { headers: auth(ctx) });
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('accept-ranges'), 'bytes');
  assert.equal(await full.text(), 'abcdefghij');
});

test('member tokens enforce roles, revoke cleanly and the CLI manages them', { timeout: 20_000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'lsw-members-'));
  const databasePath = join(directory, 'state.sqlite3');
  const documentId = randomUUID();
  const token = randomBytes(24).toString('base64url');
  let server;
  t.after(async () => {
    await server?.stop();
    rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  });
  const env = { ...process.env, LSW_DB_PATH: databasePath };
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8' });

  const viewerAdd = run('add', 'viewer-one', 'viewer');
  assert.equal(viewerAdd.status, 0, viewerAdd.stderr);
  const viewerToken = viewerAdd.stdout.trim().split('\n').at(-1);
  assert.match(viewerToken, /^lsw1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{40,}$/);
  const editorAdd = run('add', 'editor-one', 'editor');
  assert.equal(editorAdd.status, 0, editorAdd.stderr);
  const editorToken = editorAdd.stdout.trim().split('\n').at(-1);
  const editorId = JSON.parse(editorAdd.stdout.trim().split('\n')[0]).memberId;

  const listing = run('list');
  assert.equal(listing.status, 0);
  assert.match(listing.stdout, /viewer-one/);
  assert.match(listing.stdout, /editor-one/);
  assert.ok(!listing.stdout.includes(viewerToken.split('.')[2]), 'list must not print secrets');

  const config = readConfig({
    LSW_PORT: '0', LSW_TOKEN: token, LSW_DOCUMENT_ID: documentId,
    LSW_DB_PATH: databasePath, LSW_DATA_DIR: directory,
  });
  server = await startServer(config);
  const base = 'http://127.0.0.1:' + server.port;
  const manifestUrl = () => url(base, '/workspace/manifest', { workspace: documentId });
  const joinUrl = url(base, '/join');

  const localJoin = await fetch(joinUrl);
  assert.equal(localJoin.status, 200);
  assert.ok((await localJoin.text()).includes(token));

  for (const extra of [{}, { 'X-Forwarded-For': '203.0.113.7' }]) {
    const viewerJoin = await fetch(joinUrl, { headers: { ...extra, Authorization: 'Bearer ' + viewerToken } });
    assert.equal(viewerJoin.status, 200);
    const html = await viewerJoin.text();
    assert.ok(html.includes(viewerToken), 'join page must contain the caller’s token');
    assert.ok(!html.includes(token), 'join page must not expose the owner token');
  }
  assert.equal((await fetch(joinUrl, { headers: { Authorization: 'Bearer invalid-token' } })).status, 401);
  assert.equal((await fetch(joinUrl, { headers: { 'X-Forwarded-For': '203.0.113.7' } })).status, 401);
  assert.equal((await fetch(joinUrl, { headers: { Forwarded: 'for=203.0.113.7' } })).status, 401);
  const untrustedHostStatus = await new Promise((resolve, reject) => {
    httpGet(joinUrl, { headers: { Host: 'relay.example.test' } }, response => {
      response.resume();
      resolve(response.statusCode);
    }).once('error', reject);
  });
  assert.equal(untrustedHostStatus, 401);

  const synced = Promise.withResolvers();
  const rejectedWrite = Promise.withResolvers();
  const legacyViewer = new HocuspocusProvider({
    url: base.replace('http', 'ws'),
    name: documentId,
    token: viewerToken,
    onSynced: ({ state }) => { if (state) synced.resolve(); },
    onAuthenticationFailed: ({ reason }) => { synced.reject(new Error(reason)); },
  });
  legacyViewer.on('message', ({ message }) => {
    message.readVarString(); // Routing key
    if (message.readVarUint() === MessageType.SyncStatus && message.readVarUint() === 0) {
      rejectedWrite.resolve();
    }
  });
  try {
    await synced.promise;
    assert.equal(legacyViewer.authorizedScope, 'readonly');
    const proofUrl = url(base, '/persisted', { document: documentId });
    const ownerHeaders = { Authorization: 'Bearer ' + token };
    const before = await readJson(await fetch(proofUrl, { headers: ownerHeaders }));
    legacyViewer.document.getText('content').insert(0, 'forbidden edit');
    await rejectedWrite.promise;
    const after = await readJson(await fetch(proofUrl, { headers: ownerHeaders }));
    assert.equal(after.sha256, before.sha256, 'viewer edits must not affect the persisted document');
  } finally {
    legacyViewer.destroy();
    legacyViewer.document.destroy();
  }

  assert.equal((await fetch(manifestUrl(), { headers: { Authorization: 'Bearer ' + viewerToken } })).status, 200);
  const viewerCommit = await fetch(url(base, '/v1/workspace/commit', { workspace: documentId, path: 'x.tex' }), {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + viewerToken, 'If-Match': '"0"' },
    body: 'x',
  });
  assert.equal(viewerCommit.status, 403);
  assert.equal((await readJson(viewerCommit)).error, 'insufficient-role');

  const editorCommit = await fetch(url(base, '/v1/workspace/commit', { workspace: documentId, path: 'x.tex' }), {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + editorToken, 'If-Match': '"0"' },
    body: 'x',
  });
  assert.equal(editorCommit.status, 200);

  const forged = 'lsw1.' + editorId + '.' + 'A'.repeat(43);
  assert.equal((await fetch(manifestUrl(), { headers: { Authorization: 'Bearer ' + forged } })).status, 401);

  const events = openEvents({ wsBase: base.replace('http', 'ws'), documentId }, { since: 0, token: viewerToken });
  const hello = await events.waitFor(frame => frame.t === 'hello');
  assert.equal(hello.proto, 1);
  events.close();

  await server.stop();
  const revoked = run('revoke', editorId);
  assert.equal(revoked.status, 0, revoked.stderr);
  assert.match(run('list').stdout, /revoked/);

  server = await startServer(config);
  const restartedBase = 'http://127.0.0.1:' + server.port;
  try {
    const afterRevoke = await fetch(url(restartedBase, '/workspace/manifest', { workspace: documentId }), {
      headers: { Authorization: 'Bearer ' + editorToken },
    });
    assert.equal(afterRevoke.status, 401);
    const shared = await fetch(url(restartedBase, '/workspace/manifest', { workspace: documentId }), {
      headers: { Authorization: 'Bearer ' + token },
    });
    assert.equal(shared.status, 200);
  } finally {
    await server.stop();
  }
});

test('graceful stop broadcasts reset and closes sockets with 1012', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'lsw-stop-'));
  const documentId = randomUUID();
  const token = randomBytes(24).toString('base64url');
  const config = readConfig({
    LSW_PORT: '0', LSW_TOKEN: token, LSW_DOCUMENT_ID: documentId,
    LSW_DB_PATH: join(directory, 'state.sqlite3'), LSW_DATA_DIR: directory,
  });
  const server = await startServer(config);
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }));
  const base = 'http://127.0.0.1:' + server.port;
  const events = openEvents({ wsBase: base.replace('http', 'ws'), documentId, token }, {});
  await events.waitFor(frame => frame.t === 'hello');
  const closed = events.closed;
  await server.stop();
  const event = await closed;
  assert.equal(event.code, 1012);
  assert.ok(events.frames.some(frame => frame.t === 'reset' && frame.reason === 'restart'));
  const health = await fetch(url(base, '/healthz')).catch(() => null);
  assert.equal(health, null, 'the listener must be closed after stop');
});

test('TLS terminates directly when a cert and key are configured', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'lsw-tls-'));
  const certPath = join(directory, 'cert.pem');
  const keyPath = join(directory, 'key.pem');
  writeFileSync(certPath, TLS_CERT);
  writeFileSync(keyPath, TLS_KEY);
  const documentId = randomUUID();
  const config = readConfig({
    LSW_PORT: '0', LSW_TOKEN: randomBytes(24).toString('base64url'), LSW_DOCUMENT_ID: documentId,
    LSW_DB_PATH: join(directory, 'state.sqlite3'), LSW_DATA_DIR: directory,
    LSW_TLS_CERT: certPath, LSW_TLS_KEY: keyPath,
  });
  const server = await startServer(config);
  t.after(async () => {
    await server.stop();
    rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  });
  assert.equal(server.secure, true);
  const body = await new Promise((resolve, reject) => {
    const request = httpsGet({
      host: '127.0.0.1', port: server.port, path: '/healthz', rejectUnauthorized: false,
    }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, body: text }));
    });
    request.on('error', reject);
    request.setTimeout(5000, () => request.destroy(new Error('tls request timed out')));
  });
  assert.equal(body.status, 200);
  const health = JSON.parse(body.body);
  assert.equal(health.secure, true);
  assert.equal(health.status, 'ok');
});

test('public binding needs LSW_BIND_PUBLIC and config rejects half-configured TLS', async (t) => {
  assert.equal(readConfig({ LSW_TOKEN: 'x'.repeat(32) }).heartbeatMs, 25000, 'documented heartbeat default');
  assert.throws(() => readConfig({ LSW_TOKEN: 'x'.repeat(32), LSW_HOST: '0.0.0.0' }), /LSW_BIND_PUBLIC/);
  assert.throws(() => readConfig({ LSW_TOKEN: 'x'.repeat(32), LSW_HOST: 'relay.example.com' }), /loopback|LSW_BIND_PUBLIC/i);
  assert.throws(() => readConfig({ LSW_TOKEN: 'x'.repeat(32), LSW_TLS_CERT: 'a.pem' }), /LSW_TLS_CERT and LSW_TLS_KEY/);
  assert.throws(() => readConfig({
    LSW_TOKEN: 'x'.repeat(32), LSW_ALLOW_ORIGINS: 'https://ok.test,not-an-origin',
  }), /LSW_ALLOW_ORIGINS/);

  const directory = mkdtempSync(join(tmpdir(), 'lsw-public-'));
  t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }));
  const config = readConfig({
    LSW_PORT: '0', LSW_HOST: '0.0.0.0', LSW_BIND_PUBLIC: '1',
    LSW_TOKEN: randomBytes(24).toString('base64url'),
    LSW_DOCUMENT_ID: randomUUID(),
    LSW_DB_PATH: join(directory, 'state.sqlite3'),
    LSW_DATA_DIR: directory,
    LSW_ALLOW_ORIGINS: 'https://relay.test',
  });
  const server = await startServer(config);
  try {
    assert.equal(server.host, '0.0.0.0');
    const response = await fetch('http://127.0.0.1:' + server.port + '/v1/config');
    assert.equal(response.status, 200);
    const blocked = await fetch('http://127.0.0.1:' + server.port + '/v1/config', {
      headers: { Origin: 'https://evil.test' },
    });
    assert.equal(blocked.status, 403);
    const allowed = await fetch('http://127.0.0.1:' + server.port + '/v1/config', {
      headers: { Origin: 'https://relay.test' },
    });
    assert.equal(allowed.status, 200);
    const proxied = await fetch('http://127.0.0.1:' + server.port + '/healthz', {
      headers: { 'X-Forwarded-Proto': 'https' },
    });
    assert.equal((await readJson(proxied)).secure, false, 'X-Forwarded-Proto is ignored without LSW_TRUST_PROXY');
  } finally {
    await server.stop();
  }

  // With LSW_TRUST_PROXY=1 the proxy header is authoritative.
  const trusted = readConfig({
    LSW_PORT: '0', LSW_HOST: '0.0.0.0', LSW_BIND_PUBLIC: '1',
    LSW_TRUST_PROXY: '1',
    LSW_TOKEN: randomBytes(24).toString('base64url'),
    LSW_DOCUMENT_ID: randomUUID(),
    LSW_DB_PATH: join(directory, 'trusted.sqlite3'),
    LSW_DATA_DIR: join(directory, 'trusted'),
  });
  const trustedServer = await startServer(trusted);
  try {
    const proxied = await fetch('http://127.0.0.1:' + trustedServer.port + '/healthz', {
      headers: { 'X-Forwarded-Proto': 'https' },
    });
    assert.equal((await readJson(proxied)).secure, true);
  } finally {
    await trustedServer.stop();
  }
});

test('an idle upload session expires with 410 after LSW_UPLOAD_TTL_MS', async (t) => {
  const ctx = await boot(t, { LSW_UPLOAD_TTL_MS: '1000' });
  const created = await fetch(url(ctx.base, '/v1/upload', {
    workspace: ctx.documentId, path: 'slow.bin', size: 4, sha256: sha256('abcd'), base: 0,
  }), { method: 'POST', headers: auth(ctx) });
  assert.equal(created.status, 201);
  const { upload } = await readJson(created);
  await delay(1200);
  const expired = await fetch(url(ctx.base, '/v1/upload/' + upload), { headers: auth(ctx) });
  assert.equal(expired.status, 410);
  assert.equal((await readJson(expired)).error, 'upload-expired');
  const put = await fetch(url(ctx.base, '/v1/upload/' + upload, { offset: 0 }), {
    method: 'PUT', headers: auth(ctx), body: 'abcd',
  });
  assert.equal(put.status, 410);
});
