import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readConfig, startServer } from '../src/server.mjs';

const token = 'test-token-with-sufficient-length';

test('configuration accepts numeric loopback addresses and rejects public binding', () => {
  assert.equal(readConfig({ LSW_TOKEN: token }).host, '127.0.0.1');
  assert.equal(readConfig({ LSW_TOKEN: token, LSW_HOST: '::1' }).host, '::1');
  assert.throws(() => readConfig({ LSW_TOKEN: token, LSW_HOST: '0.0.0.0' }), /LSW_HOST/);
  assert.throws(() => readConfig({ LSW_TOKEN: token, LSW_HOST: '192.0.2.1' }), /LSW_HOST/);
});

test('rejects a browser WebSocket upgrade before opening a collaboration socket', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'lsw-server-'));
  const config = readConfig({ LSW_TOKEN: token, LSW_PORT: '0', LSW_DB_PATH: join(directory, 'state.sqlite3') });
  let server;
  t.after(async () => {
    await server?.stop();
    for (const name of readdirSync(directory)) unlinkSync(join(directory, name));
    rmdirSync(directory);
  });
  server = await startServer(config);
  assert.equal(server.host, '127.0.0.1');
  const status = await new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port: server.port,
      headers: {
        Connection: 'Upgrade',
        Upgrade: 'websocket',
        Origin: 'https://example.invalid',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
        'Sec-WebSocket-Version': '13',
      },
    }, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    req.on('upgrade', (_response, socket) => {
      socket.destroy();
      reject(new Error('Browser upgrade was unexpectedly accepted'));
    });
    req.setTimeout(3000, () => req.destroy(new Error('Timed out waiting for upgrade denial')));
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 403);
});

test('workspace persists binary files, serializes writes and guards deleted revisions', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'lsw-workspace-'));
  const config = readConfig({ LSW_TOKEN: token, LSW_PORT: '0', LSW_DB_PATH: join(directory, 'state.sqlite3') });
  let server = await startServer(config);
  t.after(async () => {
    await server?.stop();
    for (const name of readdirSync(directory)) unlinkSync(join(directory, name));
    rmdirSync(directory);
  });
  const { documentId } = config;
  const manifest = '/workspace/manifest?workspace=' + documentId;
  const file = '/workspace/file?workspace=' + documentId + '&path=' + encodeURIComponent('图表/图 1.png');
  function call(route, options = {}) {
    return fetch('http://127.0.0.1:' + server.port + route, {
      ...options,
      headers: { Authorization: 'Bearer ' + token, ...options.headers },
    });
  }
  function change(method, route, base, body) {
    return call(route, { method, headers: { 'If-Match': '"' + base + '"' }, body });
  }

  assert.deepEqual(await (await call(manifest)).json(), { files: [] });
  const contenders = [Uint8Array.of(0, 10, 13, 255), Uint8Array.of(128, 129, 254, 0)];
  const responses = await Promise.all(contenders.map(bytes => change('PUT', file, 0, bytes)));
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 412]);
  const winner = responses.findIndex(response => response.ok);
  const committed = await responses[winner].json();
  assert.equal(committed.revision, 1);
  assert.equal(committed.size, contenders[winner].byteLength);
  assert.deepEqual(await (await call(manifest)).json(), { files: [committed] });
  const first = await call(file + '&revision=1');
  assert.equal(first.headers.get('etag'), '"1"');
  assert.equal(first.headers.get('x-lsw-sha256'), committed.sha256);
  assert.deepEqual(new Uint8Array(await first.arrayBuffer()), contenders[winner]);
  assert.deepEqual(await (await change('PUT', file, 1, contenders[winner])).json(), committed);

  assert.equal((await change('DELETE', file, 0)).status, 412);
  const deleted = await change('DELETE', file, 1);
  assert.equal(deleted.status, 200);
  const tombstone = await deleted.json();
  assert.deepEqual(tombstone, { path: committed.path, revision: 2, sha256: null, size: 0 });
  assert.equal((await call(file + '&revision=1')).status, 412);
  assert.equal((await change('PUT', file, 0, contenders[0])).status, 412);
  assert.equal((await change('PUT', file, 1, contenders[0])).status, 412);

  await server.stop();
  server = await startServer(config);
  assert.deepEqual(await (await call(manifest)).json(), { files: [tombstone] });
  const created = await change('PUT', file, 2, new Uint8Array());
  assert.equal(created.status, 200);
  const empty = await created.json();
  assert.equal(empty.revision, 3);
  assert.equal(empty.size, 0);
  assert.match(empty.sha256, /^[0-9a-f]{64}$/);
  const last = await call(file + '&revision=3');
  assert.equal(last.status, 200);
  assert.equal((await last.arrayBuffer()).byteLength, 0);
});

test('workspace requires native authentication and rejects nonportable paths', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'lsw-workspace-'));
  const config = readConfig({ LSW_TOKEN: token, LSW_PORT: '0', LSW_DB_PATH: join(directory, 'state.sqlite3') });
  const server = await startServer(config);
  t.after(async () => {
    await server.stop();
    for (const name of readdirSync(directory)) unlinkSync(join(directory, name));
    rmdirSync(directory);
  });
  const endpoint = 'http://127.0.0.1:' + server.port;
  const workspace = '?workspace=' + config.documentId;
  const manifest = endpoint + '/workspace/manifest' + workspace;
  const authorization = 'Bearer ' + token;
  assert.equal((await fetch(manifest)).status, 401);
  assert.equal((await fetch(manifest, { headers: { Authorization: authorization, Origin: 'https://example.invalid' } })).status, 403);
  assert.equal((await fetch(endpoint + '/workspace/manifest?workspace=wrong', { headers: { Authorization: authorization } })).status, 404);
  const upload = (path, ifMatch = '"0"') => fetch(endpoint + '/workspace/file' + workspace + '&path=' + encodeURIComponent(path), {
    method: 'PUT',
    headers: { Authorization: authorization, 'If-Match': ifMatch },
    body: 'source',
  });
  assert.equal((await upload('main.tex', '')).status, 428);
  for (const path of ['../main.tex', 'C:/main.tex', '\\main.tex', 'a//b', 'a/./b', 'a/CON.tex', 'a/NUL .txt', 'a./b', 'a/b ', 'a/cafe\u0301.tex']) {
    assert.equal((await upload(path)).status, 400, path);
  }
  assert.equal((await upload('Figures/a.png')).status, 200);
  assert.equal((await upload('Figures/A.png')).status, 409);
  assert.equal((await upload('figures/b.png')).status, 409);
  assert.equal((await upload('Figures')).status, 409);
  assert.equal((await upload('Figures/a.png/page.tex')).status, 409);
});
