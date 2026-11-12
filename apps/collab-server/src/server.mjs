import { timingSafeEqual } from 'node:crypto';
import { createServer as createHttpsServer } from 'node:https';
import { isIPv4 } from 'node:net';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Server } from '@hocuspocus/server';
import diff from 'fast-diff';
import * as Y from 'yjs';
import { assertBindable, DEFAULT_MAX_WORKSPACE_BYTES, isLoopbackHost, readConfig, VERSION } from './config.mjs';
import { createCommitService } from './commit-api.mjs';
import { renderJoinPage } from './join-page.mjs';
import { openMemberStore, roleAtLeast } from './member-store.mjs';
import { createRealtime } from './realtime.mjs';
import { MAX_CHANGES_PER_PAGE, openSeqStore } from './seq-store.mjs';
import { openSnapshotStore, sha256 } from './snapshot-store.mjs';
import { openUploadStore } from './upload-store.mjs';
import { workspaceHandler } from './workspace-http.mjs';
import { isWorkspacePath } from './workspace-store.mjs';

export { readConfig, VERSION };

const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
const MAX_EDIT_BYTES = 1024 * 1024;
const MAX_SOCKETS = 24;
const MAX_WAIT_MS = 30_000;
const STOP_DRAIN_MS = 10_000;
const V1_FEATURES = ['ws', 'longpoll', 'chunked-upload', 'range', 'idempotency', 'member-tokens'];

class HttpFailure extends Error {
  constructor(status, error, extra = {}) {
    super(error);
    this.status = status;
    this.error = error;
    this.extra = extra;
  }

  body() {
    return { error: this.error, ...this.extra };
  }
}

function reply(response, status, body, headers = {}) {
  if (response.destroyed || response.writableEnded) return;
  if (response.headersSent) {
    response.end();
    return;
  }
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...(status === 413 ? { Connection: 'close' } : {}),
    ...headers,
  });
  response.end(JSON.stringify(body));
}

function methodNotAllowed(response, allow) {
  response.setHeader('Allow', allow);
  reply(response, 405, { error: 'method-not-allowed' });
}

async function readBody(request, length, timeout = 5000) {
  const chunks = [];
  let bytes = 0;
  const deadline = setTimeout(() => request.destroy(), timeout);
  try {
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > length) throw new Error('Invalid length');
      chunks.push(chunk);
    }
    if (bytes !== length) throw new Error('Invalid length');
    return Buffer.concat(chunks, bytes);
  } finally {
    clearTimeout(deadline);
  }
}

async function readPayload(request, maxBytes) {
  const declared = request.headers['content-length'];
  if (declared !== undefined) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0) throw new HttpFailure(400, 'invalid-content-length');
    if (length > maxBytes) throw new HttpFailure(413, 'file-too-large');
    try {
      return await readBody(request, length, 60_000);
    } catch {
      throw new HttpFailure(400, 'invalid-body');
    }
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maxBytes) throw new HttpFailure(413, 'file-too-large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

function sequence(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (!/^(?:0|[1-9][0-9]{0,15})$/.test(String(value))) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

/**
 * `/join` 仅在直接访问本机回环地址时允许省略令牌。
 * 同时检查对端和 Host，避免反向代理或 DNS 重绑定请求拿到所有者令牌。
 */
function isLoopbackAddress(address) {
  const value = String(address ?? '');
  return value === '127.0.0.1' || value === '::1' || value === '::ffff:127.0.0.1'
    || value.startsWith('127.') || value.startsWith('::ffff:127.');
}

function isDirectLoopbackRequest(request, trustProxy) {
  const headers = request.headers;
  const forwarded = ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto']
    .some(name => headers[name] !== undefined);
  if (trustProxy || forwarded || !isLoopbackAddress(request.socket?.remoteAddress)) return false;

  const hostname = /^(\[[a-f0-9:.]+\]|[a-z0-9.]+)(?::\d+)?$/i.exec(headers.host ?? '')?.[1]?.toLowerCase();
  return isLoopbackHost(hostname) || hostname === 'localhost.'
    || (isIPv4(hostname ?? '') && isLoopbackAddress(hostname));
}

function applyDefaults(config) {
  const databasePath = config.databasePath ?? 'data/collaboration.sqlite3';
  return {
    version: VERSION,
    host: config.host ?? '127.0.0.1',
    port: config.port ?? 1234,
    bindPublic: config.bindPublic === true,
    token: config.token,
    documentId: config.documentId,
    databasePath,
    dataDir: config.dataDir ?? dirname(resolve(databasePath)),
    tls: config.tls ?? null,
    trustProxy: config.trustProxy === true,
    allowOrigins: config.allowOrigins ?? [],
    heartbeatMs: config.heartbeatMs ?? 25000,
    eventLogSize: config.eventLogSize ?? 4096,
    uploadTtlMs: config.uploadTtlMs ?? 30 * 60 * 1000,
    maxFileBytes: config.maxFileBytes ?? 16 * 1024 * 1024,
    maxWorkspaceBytes: config.maxWorkspaceBytes ?? DEFAULT_MAX_WORKSPACE_BYTES,
    chunkBytes: config.chunkBytes ?? 512 * 1024,
    maxPaths: config.maxPaths ?? 4096,
    maxChunkConcurrency: config.maxChunkConcurrency ?? 3,
    partRetry: config.partRetry ?? 3,
    cooldownAfterFailures: config.cooldownAfterFailures ?? 5,
    cooldownMs: config.cooldownMs ?? 30000,
    unhealthyAfterErrors: config.unhealthyAfterErrors ?? 5,
    errorWindowMs: config.errorWindowMs ?? 60000,
    pollFallbackMs: config.pollFallbackMs ?? 3000,
  };
}

export async function startServer(config) {
  const settings = applyDefaults(config);
  const { host, port, token, documentId, databasePath, tls } = settings;
  assertBindable(host, settings.bindPublic);
  const startedAt = Date.now();
  const expectedToken = Buffer.from(sha256(token), 'hex');
  const snapshots = openSnapshotStore(databasePath, { maxWorkspaceBytes: settings.maxWorkspaceBytes });
  const db = snapshots.database;
  const seq = openSeqStore(db, { logSize: settings.eventLogSize });
  const members = openMemberStore(db);
  const commits = createCommitService({ db, workspace: snapshots.workspace, seq });
  const sockets = new Set();
  const waiters = new Set();
  let closing = false;
  let secureTransport = Boolean(tls);
  const trustProxy = settings.trustProxy;
  let activeCommits = 0;
  let commitDrain = [];

  function identityOf(candidate) {
    if (typeof candidate !== 'string' || candidate.length === 0) return null;
    const presented = Buffer.from(sha256(candidate), 'hex');
    if (presented.length === expectedToken.length && timingSafeEqual(presented, expectedToken)) {
      return { role: 'owner', memberId: null, name: 'shared-token' };
    }
    return members.authenticate(candidate);
  }

  function requireRole(identity, required) {
    if (!identity) throw new HttpFailure(401, 'unauthorized');
    if (!roleAtLeast(identity.role, required)) throw new HttpFailure(403, 'insufficient-role', { required });
  }

  function originPermitted(request) {
    const origin = request.headers.origin;
    if (origin === undefined) return true;
    return settings.allowOrigins.includes(origin);
  }

  function notifyAppend(event) {
    const head = seq.head(documentId);
    realtime.broadcastChanges(documentId, [event], head);
    for (const waiter of [...waiters]) {
      if (waiter.since < head) {
        clearTimeout(waiter.timer);
        waiters.delete(waiter);
        waiter.resolve();
      }
    }
  }

  function runCommit(path, base, bytes, options) {
    const result = commits.commit(documentId, path, base, bytes, options);
    if (result.event) notifyAppend(result.event);
    return result;
  }

  async function tracked(operation) {
    activeCommits++;
    try {
      return await operation();
    } finally {
      activeCommits--;
      if (activeCommits === 0) {
        const drain = commitDrain;
        commitDrain = [];
        for (const resolveDrain of drain) resolveDrain();
      }
    }
  }

  function waitForCommits(limitMs) {
    if (activeCommits === 0) return Promise.resolve();
    return new Promise(resolveWait => {
      const timer = setTimeout(() => {
        commitDrain = commitDrain.filter(fn => fn !== done);
        resolveWait();
      }, limitMs);
      const done = () => {
        clearTimeout(timer);
        resolveWait();
      };
      commitDrain.push(done);
    });
  }

  function waitForEvents(since, waitMs) {
    const immediate = seq.since(documentId, since, MAX_CHANGES_PER_PAGE);
    if (immediate.reset || immediate.changes.length > 0 || waitMs <= 0 || closing) return Promise.resolve();
    return new Promise(resolveWait => {
      const waiter = { since, resolve: resolveWait, timer: null };
      waiter.timer = setTimeout(() => {
        waiters.delete(waiter);
        resolveWait();
      }, waitMs);
      waiters.add(waiter);
    });
  }

  const uploads = openUploadStore({
    directory: settings.dataDir,
    ttlMs: settings.uploadTtlMs,
    chunkBytes: settings.chunkBytes,
    maxFileBytes: settings.maxFileBytes,
    commit: ({ workspaceId, path, base, bytes, idempotencyKey }) => runCommit(path, base, bytes, { idempotencyKey }),
  });

  const workspace = workspaceHandler({
    store: snapshots.workspace,
    workspaceId: documentId,
    reply,
    readBody,
    stopping: () => closing,
    commit: (workspaceId, path, base, bytes) => runCommit(path, base, bytes, {}),
    head: () => seq.head(documentId),
  });

  try {
    if (!snapshots.load(documentId)) {
      const empty = new Y.Doc();
      try {
        snapshots.commit(documentId, Y.encodeStateAsUpdate(empty));
      } finally {
        empty.destroy();
      }
    }
  } catch (error) {
    snapshots.close();
    throw error;
  }

  const realtime = createRealtime({
    workspaceId: documentId,
    heartbeatMs: settings.heartbeatMs,
    logSize: settings.eventLogSize,
    seq,
    authorize: identityOf,
    isStopping: () => closing,
  });

  function configBody() {
    return {
      proto: 1,
      workspace: null,
      features: V1_FEATURES,
      heartbeatMs: settings.heartbeatMs,
      maxFileBytes: settings.maxFileBytes,
      maxPaths: settings.maxPaths,
      chunkBytes: settings.chunkBytes,
      maxChunkConcurrency: settings.maxChunkConcurrency,
      partRetry: settings.partRetry,
      cooldownAfterFailures: settings.cooldownAfterFailures,
      cooldownMs: settings.cooldownMs,
      unhealthyAfterErrors: settings.unhealthyAfterErrors,
      errorWindowMs: settings.errorWindowMs,
      pollFallbackMs: settings.pollFallbackMs,
    };
  }

  /**
   * TLS terminates either directly here (LSW_TLS_CERT/KEY) or at a reverse
   * proxy. With LSW_TRUST_PROXY=1 the proxy's X-Forwarded-Proto is authoritative;
   * without it the header is ignored so a direct client cannot spoof it.
   */
  function isSecureRequest(request) {
    if (secureTransport) return true;
    if (!trustProxy) return false;
    return String(request.headers['x-forwarded-proto'] ?? '').split(',')[0].trim().toLowerCase() === 'https';
  }

  async function handleV1(request, response, url, bearer) {
    const requestedProto = request.headers['x-lsw-proto'];
    if (requestedProto !== undefined && requestedProto !== '1') {
      throw new HttpFailure(426, 'upgrade-required', { minProto: 1, features: V1_FEATURES });
    }

    if (url.pathname === '/v1/config') {
      if (request.method !== 'GET') return methodNotAllowed(response, 'GET');
      return reply(response, 200, configBody());
    }
    if (url.pathname === '/v1/events') {
      // Push channel requires `Upgrade: websocket`; plain HTTP is a protocol error.
      throw new HttpFailure(426, 'upgrade-required', { minProto: 1, features: V1_FEATURES });
    }

    const identity = identityOf(bearer);

    if (url.pathname === '/v1/workspace/changes') {
      requireRole(identity, 'viewer');
      if (request.method !== 'GET') return methodNotAllowed(response, 'GET');
      if (url.searchParams.get('workspace') !== documentId) throw new HttpFailure(404, 'workspace-not-found');
      const since = sequence(url.searchParams.get('since'), 0);
      if (since === null) throw new HttpFailure(400, 'invalid-since');
      const wait = sequence(url.searchParams.get('wait'), 0);
      if (wait === null) throw new HttpFailure(400, 'invalid-wait');
      const bounded = Math.min(wait, MAX_WAIT_MS);
      if (!closing) await waitForEvents(since, bounded);
      return reply(response, 200, seq.since(documentId, since, MAX_CHANGES_PER_PAGE));
    }

    if (url.pathname === '/v1/workspace/commit') {
      requireRole(identity, 'editor');
      if (request.method !== 'POST') return methodNotAllowed(response, 'POST');
      if (closing) throw new HttpFailure(503, 'stopping');
      if (url.searchParams.get('workspace') !== documentId) throw new HttpFailure(404, 'workspace-not-found');
      const path = url.searchParams.get('path');
      if (!isWorkspacePath(path)) throw new HttpFailure(400, 'invalid-path');
      const match = /^"([0-9]+)"$/.exec(request.headers['if-match'] ?? '');
      if (!match) throw new HttpFailure(428, 'revision-precondition-required');
      const base = Number(match[1]);
      const idempotencyKey = request.headers['idempotency-key'];
      if (idempotencyKey !== undefined && !/^[!-~]{1,128}$/.test(idempotencyKey)) {
        throw new HttpFailure(400, 'invalid-idempotency-key');
      }
      const deleting = url.searchParams.get('delete') === '1';
      const result = await tracked(async () => {
        let bytes = null;
        if (deleting) {
          const declared = request.headers['content-length'];
          if (declared !== undefined && Number(declared) !== 0) {
            throw new HttpFailure(400, 'invalid-content-length');
          }
        } else {
          bytes = await readPayload(request, settings.maxFileBytes);
        }
        return runCommit(path, base, bytes, { idempotencyKey });
      });
      if (result.status === 412) {
        return reply(response, 412, { error: 'revision-changed', file: result.file });
      }
      if (result.status !== 200) return reply(response, result.status, { error: result.error });
      return reply(response, 200, result.body);
    }

    const uploadMatch = /^\/v1\/upload\/([0-9a-f-]{36})(\/finish)?$/.exec(url.pathname);
    if (url.pathname === '/v1/upload') {
      requireRole(identity, 'editor');
      if (request.method !== 'POST') return methodNotAllowed(response, 'POST');
      if (closing) throw new HttpFailure(503, 'stopping');
      const query = url.searchParams;
      if (query.get('workspace') !== documentId) throw new HttpFailure(404, 'workspace-not-found');
      const path = query.get('path');
      if (!isWorkspacePath(path)) throw new HttpFailure(400, 'invalid-path');
      const size = sequence(query.get('size'), null);
      if (size === null) throw new HttpFailure(400, 'invalid-size');
      const base = sequence(query.get('base'), 0);
      if (base === null) throw new HttpFailure(400, 'invalid-base');
      const result = uploads.create({
        workspaceId: documentId,
        path,
        size,
        sha256: query.get('sha256') ?? '',
        base,
      });
      if (result.status !== 200 && result.status !== 201) {
        return reply(response, result.status, { error: result.error });
      }
      return reply(response, result.status, {
        upload: result.upload,
        offset: result.offset,
        chunkBytes: result.chunkBytes,
        received: result.received ?? [],
      });
    }

    if (uploadMatch) {
      requireRole(identity, 'editor');
      if (closing) throw new HttpFailure(503, 'stopping');
      const id = uploadMatch[1];
      if (uploadMatch[2] === '/finish') {
        if (request.method !== 'POST') return methodNotAllowed(response, 'POST');
        const idempotencyKey = request.headers['idempotency-key'];
        if (idempotencyKey !== undefined && !/^[!-~]{1,128}$/.test(idempotencyKey)) {
          throw new HttpFailure(400, 'invalid-idempotency-key');
        }
        // `finish` is a commit; a retry after the session was deleted must replay
        // the original result instead of failing with 410.
        const replayed = commits.replay(documentId, idempotencyKey);
        if (replayed) return reply(response, 200, replayed);
        const result = await tracked(async () => uploads.finish(id, { idempotencyKey: idempotencyKey ?? null }));
        if (result.status === 412) {
          return reply(response, 412, { error: 'revision-changed', file: result.file });
        }
        if (result.status !== 200) {
          const extra = result.expected === undefined ? {} : { expected: result.expected };
          return reply(response, result.status, { error: result.error, ...extra });
        }
        return reply(response, 200, result.body);
      }
      if (request.method === 'GET') {
        const result = uploads.get(id);
        if (result.status !== 200) return reply(response, result.status, { error: result.error });
        return reply(response, 200, {
          upload: result.upload,
          size: result.size,
          sha256: result.sha256,
          base: result.base,
          offset: result.offset,
          received: result.received,
        });
      }
      if (request.method === 'DELETE') {
        const result = uploads.remove(id);
        if (result.status !== 200) return reply(response, result.status, { error: result.error });
        return reply(response, 200, { upload: result.upload });
      }
      if (request.method !== 'PUT') return methodNotAllowed(response, 'GET, PUT, DELETE');
      const offset = sequence(url.searchParams.get('offset'), null);
      if (offset === null) throw new HttpFailure(400, 'invalid-offset');
      const result = await tracked(async () => {
        const bytes = await readPayload(request, settings.chunkBytes + 1);
        if (bytes.length > settings.chunkBytes) throw new HttpFailure(413, 'chunk-too-large');
        return uploads.put(id, offset, bytes);
      });
      if (result.status !== 200) {
        const extra = result.expected === undefined ? {} : { expected: result.expected };
        return reply(response, result.status, { error: result.error, ...extra });
      }
      return reply(response, 200, { upload: result.upload, offset: result.offset });
    }

    throw new HttpFailure(404, 'not-found');
  }

  async function acceptDiskEdit(request, response) {
    const base = request.headers['if-match']?.match(/^"([a-f0-9]{64})"$/)?.[1];
    if (!base) return reply(response, 428, { error: 'snapshot-precondition-required' });
    const length = Number(request.headers['content-length'] ?? NaN);
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_EDIT_BYTES) {
      return reply(response, 413, { error: 'invalid-content-length' });
    }
    let next;
    try {
      const bytes = await readBody(request, length);
      next = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes).replace(/\r\n/g, '\n');
    } catch {
      if (!response.destroyed) reply(response, 400, { error: 'invalid-edit-body' });
      return;
    }
    const document = server.hocuspocus.documents.get(documentId);
    if (closing || !document) return reply(response, 503, { error: 'document-unavailable' });

    // The check, mutation and SQLite commit run in one event-loop turn.
    if (snapshots.proof(documentId)?.sha256 !== base || sha256(Y.encodeStateAsUpdate(document)) !== base) {
      return reply(response, 412, { error: 'shared-version-changed' });
    }
    const text = document.getText('content');
    const changes = diff(text.toString(), next);
    document.transact(() => {
      let offset = 0;
      for (const [kind, value] of changes) {
        if (kind === diff.DELETE) {
          text.delete(offset, value.length);
        } else {
          if (kind === diff.INSERT) text.insert(offset, value);
          offset += value.length;
        }
      }
    });

    const state = Y.encodeStateAsUpdate(document);
    response.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': state.byteLength,
      'Cache-Control': 'no-store',
      'X-LSW-SHA256': sha256(state),
    });
    response.end(state);
  }

  async function handleHttp(request, response, url) {
    if (url.pathname !== '/healthz' && !originPermitted(request)) {
      throw new HttpFailure(403, 'origin-not-allowed');
    }
    const bearer = /^Bearer ([!-~]{8,1024})$/i.exec(request.headers.authorization ?? '')?.[1];

    if (url.pathname === '/healthz') {
      if (request.method !== 'GET') return methodNotAllowed(response, 'GET');
      return reply(response, 200, {
        status: closing ? 'stopping' : 'ok',
        seq: seq.head(documentId),
        sockets: realtime.size,
        clients: realtime.size + (server.hocuspocus?.getConnectionsCount?.() ?? 0),
        uptimeMs: Date.now() - startedAt,
        version: VERSION,
        stopping: closing,
        secure: isSecureRequest(request),
      });
    }

    if (url.pathname.startsWith('/v1/')) {
      return handleV1(request, response, url, bearer);
    }

    // 一键加入页面：把地址/工作区/令牌渲染成可点、可转发的 vscode:// 链接。
    if (url.pathname === '/join') {
      if (request.method !== 'GET') return methodNotAllowed(response, 'GET');
      if (!isDirectLoopbackRequest(request, trustProxy) || request.headers.authorization !== undefined) {
        requireRole(identityOf(bearer), 'viewer');
      }
      const endpoint = (isSecureRequest(request) ? 'wss' : 'ws') + '://'
        + String(request.headers.host ?? (host + ':' + port));
      const html = renderJoinPage({
        endpoint,
        workspaceId: documentId,
        token: bearer ?? token,
        version: VERSION,
        requestHost: request.headers.host,
      });
      response.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': Buffer.byteLength(html),
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        'X-Content-Type-Options': 'nosniff',
      });
      return response.end(html);
    }

    const identity = identityOf(bearer);

    if (url.pathname === '/workspace/manifest' || url.pathname === '/workspace/file') {
      requireRole(identity, request.method === 'GET' ? 'viewer' : 'editor');
      await workspace(request, response, url);
      return;
    }

    if (url.pathname === '/disk-edit') {
      requireRole(identity, 'editor');
      if (request.method !== 'POST') return methodNotAllowed(response, 'POST');
      if (url.searchParams.get('document') !== documentId) throw new HttpFailure(404, 'document-not-found');
      return acceptDiskEdit(request, response);
    }

    if (request.method !== 'GET') return methodNotAllowed(response, 'GET');
    if (url.pathname === '/persisted') {
      requireRole(identity, 'viewer');
      if (url.searchParams.get('document') !== documentId) throw new HttpFailure(404, 'document-not-found');
      const proof = snapshots.proof(documentId);
      return reply(response, proof ? 200 : 503, proof ?? { error: 'snapshot-unavailable' });
    }
    throw new HttpFailure(404, 'not-found');
  }

  const server = new Server({
    address: host,
    port,
    quiet: true,
    stopOnSignals: false,
    websocketOptions: { maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false },
    maxUnauthenticatedQueueSize: MAX_MESSAGE_BYTES,
    maxUnauthenticatedQueueMessages: 64,
    async onAuthenticate({ documentName, token: candidate, connectionConfig }) {
      if (closing || documentName !== documentId) throw { reason: 'permission-denied' };
      const identity = identityOf(candidate);
      if (!identity || !roleAtLeast(identity.role, 'viewer')) throw { reason: 'permission-denied' };
      connectionConfig.readOnly = !roleAtLeast(identity.role, 'editor');
    },
    async onUpgrade({ request, socket, head }) {
      if (realtime.handleUpgrade(request, socket, head)) {
        // Handled by the v1 push hub; keep Hocuspocus/crossws off this socket.
        throw undefined;
      }
      // Browser pages send Origin on WebSocket upgrades. Only the native
      // transport (no Origin) or an explicitly whitelisted origin is accepted.
      if (request.headers.origin !== undefined && !settings.allowOrigins.includes(request.headers.origin)) {
        socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        throw undefined;
      }
      if (closing || sockets.size >= MAX_SOCKETS) {
        socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
        // Hocuspocus interprets a rejected hook with no error as handled.
        throw undefined;
      }
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    },
    async onLoadDocument({ document, documentName }) {
      const state = snapshots.load(documentName);
      if (!state) throw new Error('Document does not exist');
      Y.applyUpdate(document, state);
    },
    async afterLoadDocument({ document, documentName }) {
      document.on('update', () => {
        try {
          snapshots.commit(documentName, Y.encodeStateAsUpdate(document));
        } catch (error) {
          // The Y.Doc has already changed. Stop accepting traffic and force a
          // restart from the last committed snapshot if persistence fails.
          closing = true;
          for (const socket of sockets) socket.destroy();
          realtime.closeAll(1011, 'Internal Error');
          console.error('[LSW] Snapshot commit failed. Restart required.', error.message);
          process.exit(1);
        }
      });
    },
    async onRequest({ request, response }) {
      let url;
      try {
        url = new URL(request.url, 'http://localhost');
      } catch {
        reply(response, 400, { error: 'invalid-request' });
        throw undefined;
      }
      try {
        await handleHttp(request, response, url);
      } catch (error) {
        if (error instanceof HttpFailure) {
          reply(response, error.status, error.body());
        } else {
          console.error('[LSW] HTTP handler failed.', error?.message ?? error);
          if (!response.headersSent && !response.destroyed) reply(response, 500, { error: 'internal' });
        }
      }
      // Stop the default Hocuspocus HTTP response after writing ours.
      throw undefined;
    },
  });

  if (tls) {
    // Hocuspocus always builds a plain http.Server; swap in an https one before
    // listen() and re-attach its upgrade handler to the new server.
    const secure = createHttpsServer({ cert: tls.cert, key: tls.key }, server.requestHandler);
    server.httpServer = secure;
    server.setupHttpUpgrade();
  }

  try {
    await new Promise((resolveStart, rejectStart) => {
      server.httpServer.once('error', rejectStart);
      server.listen().then(resolveStart, rejectStart).finally(() => {
        server.httpServer.off('error', rejectStart);
      });
    });
  } catch (error) {
    snapshots.close();
    throw error;
  }

  let stopPromise;
  return {
    host: server.address.address,
    port: server.address.port,
    documentId,
    secure: Boolean(tls),
    maxWorkspaceBytes: settings.maxWorkspaceBytes,
    version: VERSION,
    head() {
      return seq.head(documentId);
    },
    stop() {
      if (!stopPromise) {
        closing = true;
        try {
          realtime.broadcastReset(seq.head(documentId), 'restart');
        } finally {
          realtime.closeAll(1012, 'Service Restart');
        }
        for (const waiter of [...waiters]) {
          clearTimeout(waiter.timer);
          waiters.delete(waiter);
          waiter.resolve();
        }
        stopPromise = (async () => {
          await waitForCommits(STOP_DRAIN_MS);
          for (const socket of sockets) socket.destroy();
          await server.destroy();
        })().finally(() => snapshots.close());
      }
      return stopPromise;
    },
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const config = readConfig();
    const server = await startServer(config);
    console.log(JSON.stringify({
      event: 'listening',
      host: server.host,
      port: server.port,
      documentId: server.documentId,
      version: server.version,
      secure: server.secure,
      maxWorkspaceMiB: server.maxWorkspaceBytes / (1024 * 1024),
    }));
    const displayHost = server.host === '0.0.0.0' || server.host === '::' ? '127.0.0.1' : server.host;
    if (!config.trustProxy && isLoopbackHost(displayHost)) {
      const browserHost = displayHost.includes(':') ? '[' + displayHost + ']' : displayHost;
      console.log('本机加入信息页：' + (server.secure ? 'https' : 'http')
        + '://' + browserHost + ':' + server.port + '/join');
    } else {
      console.log('加入工作区时，请在 VS Code 填写服务器地址、工作区 ID 和访问令牌。');
    }
    let shuttingDown = false;
    const stop = async (signal) => {
      if (shuttingDown) return;
      shuttingDown = true;
      try {
        await server.stop();
        // Give the close frames a chance to leave the process before exiting.
        await new Promise(done => setTimeout(done, 120));
        process.exit(0);
      } catch (error) {
        console.error('[LSW] Shutdown failed (' + signal + '):', error.message);
        process.exit(1);
      }
    };
    process.once('SIGINT', () => void stop('SIGINT'));
    process.once('SIGTERM', () => void stop('SIGTERM'));
  } catch (error) {
    console.error('[LSW] Startup failed:', error.message);
    process.exitCode = 1;
  }
}
