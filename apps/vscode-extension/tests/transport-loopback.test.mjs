/**
 * 线路层的回环集成测试：真 `node:http` 服务端 + 真 WebSocket 握手（只连 127.0.0.1）。
 *
 * 验证的是纯函数测不到的部分：
 * - `createDialer` 确实把 `Authorization` 头带上（协议 §1 的主鉴权路径）；
 * - hello/ping/changes/ack 的往返与 §6 客户端帧格式；
 * - 断线重连时 `since=<已确认的水位>` 真的出现在 URL 上（§6.3 续传）。
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { WebSocketServer } from 'ws';
import { EventChannel } from '../src/transport.ts';

const TOKEN = 'test-token-' + 'x'.repeat(24);

function connectInfo(request) {
  const url = new URL(request.url, 'http://127.0.0.1');
  return {
    path: url.pathname,
    workspace: url.searchParams.get('workspace'),
    since: url.searchParams.get('since'),
    authorization: request.headers.authorization,
  };
}

function waitFor(predicate, timeoutMs = 5_000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error('等待超时：' + predicate.toString()));
      setTimeout(tick, 10);
    };
    tick();
  });
}

test('loopback: 推送通道用 Authorization 头鉴权、回 pong/ack 并从 since 续传', async () => {
  const connections = [];
  const frames = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (url.pathname === '/v1/config') {
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({
        proto: 1,
        features: ['ws', 'longpoll', 'chunked-upload', 'range'],
        heartbeatMs: 1_000,
        chunkBytes: 524_288,
        maxChunkConcurrency: 3,
        partRetry: 3,
        cooldownAfterFailures: 5,
        cooldownMs: 30_000,
        unhealthyAfterErrors: 5,
        errorWindowMs: 60_000,
      }));
      return;
    }
    response.writeHead(404, { 'Content-Type': 'application/json' });
    response.end('{"error":"not-found"}');
  });
  const sockets = new WebSocketServer({ noServer: true });
  server.on('upgrade', (request, socket, head) => {
    sockets.handleUpgrade(request, socket, head, client => {
      connections.push(connectInfo(request));
      client.on('message', data => frames.push(JSON.parse(String(data))));
      if (connections.length === 1) {
        client.send(JSON.stringify({ t: 'hello', seq: 2, proto: 1, heartbeatMs: 1_000, resumeWindow: 512 }));
        client.send(JSON.stringify({ t: 'ping', seq: 2 }));
        setTimeout(() => {
          client.send(JSON.stringify({
            t: 'changes',
            head: 3,
            changes: [{ seq: 3, path: 'main.tex', revision: 5, sha256: 'a'.repeat(64), size: 12, deleted: false }],
          }));
        }, 50);
      }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  const delivered = [];
  const states = [];
  const channel = new EventChannel({
    endpoint: new URL('http://127.0.0.1:' + port),
    workspaceId: '11111111-1111-1111-1111-111111111111',
    token: TOKEN,
    lastSeq: 2,
    random: () => 0,
    heartbeatMs: 1_000,
    onChanges: (seq, changes) => {
      delivered.push([seq, changes.map(row => row.seq)]);
      channel.confirm(seq);
    },
    onReset: head => delivered.push(['reset', head]),
    onState: state => states.push(state),
    onSeq: () => {},
  });

  try {
    channel.start();
    await waitFor(() => delivered.length > 0);

    // §1：鉴权头必须真的到达服务端（内置 WebSocket 无法设头，所以用的是 `ws`）。
    assert.equal(connections[0].authorization, 'Bearer ' + TOKEN);
    assert.equal(connections[0].path, '/v1/events');
    assert.equal(connections[0].workspace, '11111111-1111-1111-1111-111111111111');
    assert.equal(connections[0].since, '2');
    assert.deepEqual(delivered, [[3, [3]]]);

    // §6 客户端帧：ping → pong，应用完 → ack 到新水位。
    assert.deepEqual(frames[0], { t: 'pong', seq: 2 });
    await waitFor(() => frames.some(frame => frame.t === 'ack'));
    assert.deepEqual(frames.find(frame => frame.t === 'ack'), { t: 'ack', seq: 3 });
    assert.equal(channel.seq(), 3);

    // §6.3 断线重连：新连接必须带 since=<已确认水位>，而不是从 0 重放。
    for (const client of sockets.clients) client.terminate();
    await waitFor(() => connections.length >= 2);
    assert.equal(connections[1].since, '3');
    assert.equal(connections[1].authorization, 'Bearer ' + TOKEN);
    assert.ok(states.includes('online'));
  } finally {
    channel.stop();
    for (const client of sockets.clients) client.terminate();
    sockets.close();
    await new Promise(resolve => server.close(resolve));
  }
});

test('loopback: 长轮询降级路径用 since 续传并在 404 后收敛到定时轮询', async () => {
  const requests = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    requests.push(url.pathname + '?' + url.searchParams.toString());
    if (url.pathname === '/v1/config') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ proto: 1, features: ['longpoll'], heartbeatMs: 1_000 }));
      return;
    }
    response.writeHead(404, { 'Content-Type': 'application/json' });
    response.end('{"error":"not-found"}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const states = [];
  const channel = new EventChannel({
    endpoint: new URL('http://127.0.0.1:' + port),
    workspaceId: 'w',
    token: TOKEN,
    lastSeq: 7,
    random: () => 0,
    onChanges: () => {},
    onReset: () => {},
    onState: (state, detail) => states.push([state, detail]),
    onSeq: () => {},
  });
  try {
    channel.start();
    await waitFor(() => states.some(([state]) => state === 'degraded'));
    assert.ok(requests.some(line => line.startsWith('/v1/workspace/changes?') && line.includes('since=7')));
    // 长轮询也 404 → 定时间隔轮询（0.2 节奏），此时不再持有推送通道。
    assert.equal(channel.mode(), 'timer');
    assert.equal(channel.isPushing(), false);
  } finally {
    channel.stop();
    await new Promise(resolve => server.close(resolve));
  }
});
