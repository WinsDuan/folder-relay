import { timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Server } from '@hocuspocus/server';
import diff from 'fast-diff';
import * as Y from 'yjs';
import { openSnapshotStore, sha256 } from './snapshot-store.mjs';
import { workspaceHandler } from './workspace-http.mjs';

const DEFAULT_DOCUMENT_ID = '11111111-1111-4111-8111-111111111111';
const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
const MAX_EDIT_BYTES = 1024 * 1024;
const MAX_SOCKETS = 24;

function assertLoopback(host) {
  if (host !== '127.0.0.1' && host !== '::1') {
    throw new Error('LSW_HOST must be 127.0.0.1 or ::1');
  }
}

export function readConfig(env = process.env) {
  const port = Number(env.LSW_PORT ?? '1234');
  const host = env.LSW_HOST || '127.0.0.1';
  const token = env.LSW_TOKEN ?? '';
  const documentId = env.LSW_DOCUMENT_ID ?? DEFAULT_DOCUMENT_ID;
  assertLoopback(host);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('LSW_PORT must be an integer between 0 and 65535');
  }
  if (!/^[!-~]{24,1024}$/.test(token)) {
    throw new Error('Set LSW_TOKEN to 24–1024 printable ASCII characters without spaces');
  }
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(documentId)) {
    throw new Error('LSW_DOCUMENT_ID must be a lowercase UUID');
  }
  return {
    host,
    port,
    token,
    documentId,
    databasePath: env.LSW_DB_PATH || 'data/collaboration.sqlite3',
  };
}

function reply(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(JSON.stringify(body));
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

export async function startServer(config) {
  const { host, port, token, documentId, databasePath } = config;
  assertLoopback(host);
  const expectedToken = Buffer.from(sha256(token), 'hex');
  const authenticated = (candidate) => typeof candidate === 'string'
    && timingSafeEqual(Buffer.from(sha256(candidate), 'hex'), expectedToken);
  const snapshots = openSnapshotStore(databasePath);
  const sockets = new Set();
  let closing = false;
  const workspace = workspaceHandler({
    store: snapshots.workspace,
    workspaceId: documentId,
    reply,
    readBody,
    stopping: () => closing,
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

  const server = new Server({
    address: host,
    port,
    quiet: true,
    stopOnSignals: false,
    websocketOptions: { maxPayload: MAX_MESSAGE_BYTES, perMessageDeflate: false },
    maxUnauthenticatedQueueSize: MAX_MESSAGE_BYTES,
    maxUnauthenticatedQueueMessages: 64,
    async onAuthenticate({ documentName, token: candidate }) {
      if (closing || documentName !== documentId || !authenticated(candidate)) {
        throw { reason: 'permission-denied' };
      }
    },
    async onUpgrade({ request, socket }) {
      // Browser pages send Origin on WebSocket upgrades. Only the native VS
      // Code transport is supported.
      if (request.headers.origin !== undefined) {
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
      const bearer = request.headers.authorization?.match(/^Bearer ([!-~]{24,1024})$/i)?.[1];
      if (closing) {
        reply(response, 503, { error: 'stopping' });
      } else if (url.pathname === '/workspace/manifest' || url.pathname === '/workspace/file') {
        if (request.headers.origin !== undefined) {
          reply(response, 403, { error: 'origin-not-allowed' });
        } else if (!authenticated(bearer)) {
          reply(response, 401, { error: 'unauthorized' });
        } else {
          try {
            await workspace(request, response, url);
          } catch (error) {
            console.error('[LSW] Workspace operation failed.', error.message);
            if (!response.headersSent && !response.destroyed) reply(response, 503, { error: 'workspace-unavailable' });
          }
        }
      } else if (url.pathname === '/disk-edit') {
        if (request.method !== 'POST') {
          response.setHeader('Allow', 'POST');
          reply(response, 405, { error: 'method-not-allowed' });
        } else if (request.headers.origin !== undefined) {
          reply(response, 403, { error: 'origin-not-allowed' });
        } else if (!authenticated(bearer)) {
          reply(response, 401, { error: 'unauthorized' });
        } else if (url.searchParams.get('document') !== documentId) {
          reply(response, 404, { error: 'document-not-found' });
        } else {
          await acceptDiskEdit(request, response);
        }
      } else if (request.method !== 'GET') {
        response.setHeader('Allow', 'GET');
        reply(response, 405, { error: 'method-not-allowed' });
      } else if (url.pathname === '/healthz') {
        reply(response, 200, { status: 'ok' });
      } else if (url.pathname === '/persisted') {
        if (!authenticated(bearer)) {
          reply(response, 401, { error: 'unauthorized' });
        } else if (url.searchParams.get('document') !== documentId) {
          reply(response, 404, { error: 'document-not-found' });
        } else {
          try {
            const result = snapshots.proof(documentId);
            reply(response, result ? 200 : 503, result ?? { error: 'snapshot-unavailable' });
          } catch {
            reply(response, 503, { error: 'snapshot-unavailable' });
          }
        }
      } else {
        reply(response, 404, { error: 'not-found' });
      }
      // Stop the default Hocuspocus HTTP response after writing ours.
      throw undefined;
    },
  });

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
    stop() {
      if (!stopPromise) {
        closing = true;
        for (const socket of sockets) socket.destroy();
        stopPromise = server.destroy().finally(() => snapshots.close());
      }
      return stopPromise;
    },
  };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const server = await startServer(readConfig());
    console.log(JSON.stringify({
      event: 'listening', host: server.host, port: server.port, documentId: server.documentId,
    }));
    const stop = () => {
      void server.stop().catch((error) => {
        console.error('[LSW] Shutdown failed:', error.message);
        process.exitCode = 1;
      });
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  } catch (error) {
    console.error('[LSW] Startup failed:', error.message);
    process.exitCode = 1;
  }
}
