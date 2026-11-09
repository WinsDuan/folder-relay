import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { TestServer, artifactDir, documentId, waitFor } from './helpers.mjs';

function connect(server, token = server.token, name = documentId) {
  const doc = new Y.Doc();
  let rejected = false;
  let synced = false;
  const socket = new HocuspocusProviderWebsocket({
    url: server.ws,
    WebSocketPolyfill: WebSocket,
    delay: 100,
    minDelay: 100,
    maxDelay: 500,
  });
  const provider = new HocuspocusProvider({
    websocketProvider: socket,
    name,
    document: doc,
    token,
    onSynced: ({ state }) => { synced = state; },
    onAuthenticationFailed: () => { rejected = true; },
  });
  provider.attach();
  return {
    doc,
    text: doc.getText('content'),
    socket,
    get synced() { return synced; },
    get rejected() { return rejected; },
    destroy() {
      provider.destroy();
      if (socket.webSocket?.readyState === WebSocket.CONNECTING) socket.webSocket.once('error', () => {});
      socket.destroy();
      doc.destroy();
    },
  };
}

async function committed(server, doc) {
  const response = await fetch(server.http + '/persisted?document=' + documentId, {
    headers: { Authorization: 'Bearer ' + server.token },
  });
  assert.equal(response.status, 200);
  const proof = await response.json();
  return proof.sha256 === digest(doc);
}

function digest(doc) {
  return createHash('sha256').update(Y.encodeStateAsUpdate(doc)).digest('hex');
}

test('auth, parallel Yjs operations, offline reconnect, delete-aware proof and crash recovery', { timeout: 65_000 }, async () => {
  const dir = artifactDir('protocol');
  const server = new TestServer(dir);
  const clients = [];
  try {
    await server.start();
    assert.equal((await fetch(server.http + '/persisted?document=' + documentId)).status, 401);
    const invalid = connect(server, 'wrong-token');
    clients.push(invalid);
    await waitFor(() => invalid.rejected, 'bad token rejection');
    assert.equal(invalid.synced, false);
    const wrongDocument = connect(server, server.token, '22222222-2222-4222-8222-222222222222');
    clients.push(wrongDocument);
    await waitFor(() => wrongDocument.rejected, 'document authorization');

    const a = connect(server);
    const b = connect(server);
    clients.push(a, b);
    await waitFor(() => a.synced && b.synced, 'initial sync');
    a.text.insert(0, 'LaTeX 协作 ✨');
    await waitFor(() => b.text.toString() === a.text.toString(), 'edit delivery');
    await waitFor(() => committed(server, a.doc), 'committed initial edit');

    // Both clients fork from the same state, then exchange edits on reconnect.
    await server.stop();
    a.text.insert(0, '甲');
    b.text.insert(0, '乙');
    await server.start();
    await waitFor(() => {
      const value = a.text.toString();
      return value === b.text.toString() && value.includes('甲') && value.includes('乙');
    }, 'both offline operations to merge');
    const beforeDelete = a.text.toString();
    const oldVector = Buffer.from(Y.encodeStateVector(a.doc));
    a.text.delete(beforeDelete.indexOf('✨'), 1);
    assert.deepEqual(Buffer.from(Y.encodeStateVector(a.doc)), oldVector);
    await waitFor(() => b.text.toString() === a.text.toString(), 'delete delivery');
    await waitFor(() => committed(server, a.doc), 'delete-aware committed hash');
    const expected = a.text.toString();
    a.destroy();
    b.destroy();
    clients.splice(clients.indexOf(a), 2);
    await server.stop();
    await server.start();
    const fresh = connect(server);
    clients.push(fresh);
    await waitFor(() => fresh.synced, 'fresh client after forced stop');
    assert.equal(fresh.text.toString(), expected);
    assert.ok(await committed(server, fresh.doc));
    console.log('Evidence: ' + dir);
  } finally {
    for (const client of clients) client.destroy();
    await server.stop();
  }
});

test('disk edits commit against a delete-aware base and reject competing rewrites', { timeout: 20_000 }, async () => {
  const server = new TestServer(artifactDir('disk-edit'));
  const clients = [];
  try {
    await server.start();
    const a = connect(server);
    const b = connect(server);
    clients.push(a, b);
    await waitFor(() => a.synced && b.synced, 'initial sync');
    a.text.insert(0, '甲😀乙\n');
    await waitFor(() => b.text.toString() === a.text.toString(), 'base delivery');
    await waitFor(() => committed(server, a.doc), 'base committed');
    const oldBase = digest(a.doc);
    const oldVector = Y.encodeStateVector(a.doc);
    b.text.delete(0, 1);
    await waitFor(() => a.text.toString() === '😀乙\n', 'peer deletion');
    await waitFor(() => committed(server, a.doc), 'peer deletion committed');
    assert.deepEqual(Y.encodeStateVector(a.doc), oldVector);

    const post = (body, base, headers = {}) => fetch(server.http + '/disk-edit?document=' + documentId, {
      method: 'POST', body,
      headers: { Authorization: 'Bearer ' + server.token, 'If-Match': '"' + base + '"', ...headers },
    });
    assert.equal((await post('stale', oldBase)).status, 412);
    const base = digest(a.doc);
    assert.equal((await post('unauthorized', base, { Authorization: '' })).status, 401);
    assert.equal((await post('browser', base, { Origin: 'https://example.invalid' })).status, 403);
    assert.equal((await post('missing base', '', { 'If-Match': '' })).status, 428);
    const bodies = ['😀丙\r\n新一行\r\n', '乙🚀\n另一行\n'];
    const responses = await Promise.all(bodies.map(body => post(body, base)));
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 412]);
    const index = responses.findIndex(response => response.ok);
    const accepted = responses[index];
    const snapshot = new Uint8Array(await accepted.arrayBuffer());
    const expected = bodies[index].replace(/\r\n/g, '\n');
    assert.equal(createHash('sha256').update(snapshot).digest('hex'), accepted.headers.get('x-lsw-sha256'));
    await waitFor(() => a.text.toString() === expected && b.text.toString() === expected, 'accepted disk edit on both clients');
    assert.ok(await committed(server, a.doc));
    assert.deepEqual(snapshot, Y.encodeStateAsUpdate(a.doc));
    assert.equal((await post('', digest(a.doc))).status, 200);
    await waitFor(() => a.text.length === 0 && b.text.length === 0, 'empty rewrite delivered');
    assert.ok(await committed(server, b.doc));
  } finally {
    for (const client of clients) client.destroy();
    await server.stop();
  }
});

test('pre-authentication message queue closes an unauthenticated socket', { timeout: 10_000 }, async () => {
  const server = new TestServer(artifactDir('pre-auth'));
  let socket;
  try {
    await server.start();
    socket = new WebSocket(server.ws);
    await once(socket, 'open');
    const closed = once(socket, 'close', { signal: AbortSignal.timeout(3000) });
    const frame = Buffer.from([documentId.length, ...Buffer.from(documentId), 0]);
    for (let index = 0; index < 65; index++) socket.send(frame);
    const [code] = await closed;
    assert.equal(code, 4205);
    assert.ok((await fetch(server.http + '/healthz')).ok);
  } finally {
    socket?.terminate();
    await server.stop();
  }
});
