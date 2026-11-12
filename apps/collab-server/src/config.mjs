import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const VERSION = '0.3.2';
export const DEFAULT_DOCUMENT_ID = '11111111-1111-4111-8111-111111111111';
const MIB = 1024 * 1024;
export const MAX_FILE_BYTES = 16 * MIB;
export const DEFAULT_MAX_WORKSPACE_BYTES = 128 * MIB;
export const CHUNK_BYTES = 512 * 1024;
export const MAX_PATHS = 4096;

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const ORIGIN = /^https?:\/\/[^/?#\s]+$/i;

export function isLoopbackHost(host) {
  return LOOPBACK_HOSTS.has(host);
}

/**
 * A non-loopback bind is only allowed behind an explicit switch. LSW_HOST keeps
 * defaulting to 127.0.0.1 so a stale deployment cannot silently expose the server.
 */
export function assertBindable(host, bindPublic) {
  if (typeof host !== 'string' || host.length === 0) {
    throw new Error('LSW_HOST must be a non-empty host name or address');
  }
  if (isLoopbackHost(host) || bindPublic === true) return;
  throw new Error('LSW_HOST ' + JSON.stringify(host) + ' is not a loopback address: '
    + 'set LSW_BIND_PUBLIC=1 to allow binding to a public/non-loopback interface');
}

function integer(env, name, fallback, minimum, maximum) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^(?:0|[1-9][0-9]{0,15})$/.test(raw)) {
    throw new Error(name + ' must be a non-negative integer');
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(name + ' must be between ' + minimum + ' and ' + maximum);
  }
  return value;
}

function origins(env) {
  const raw = env.LSW_ALLOW_ORIGINS ?? '';
  const list = raw.split(',').map(value => value.trim()).filter(Boolean);
  for (const value of list) {
    if (!ORIGIN.test(value)) {
      throw new Error('LSW_ALLOW_ORIGINS entries must be bare origins such as https://relay.example.com');
    }
  }
  return list;
}

function readTls(env) {
  const certPath = env.LSW_TLS_CERT;
  const keyPath = env.LSW_TLS_KEY;
  if (!certPath && !keyPath) return null;
  if (!certPath || !keyPath) {
    throw new Error('LSW_TLS_CERT and LSW_TLS_KEY must be provided together');
  }
  const load = (name, file) => {
    try {
      return readFileSync(resolve(file));
    } catch (error) {
      throw new Error(name + ' could not be read: ' + error.message);
    }
  };
  const cert = load('LSW_TLS_CERT', certPath);
  const key = load('LSW_TLS_KEY', keyPath);
  return { cert, key };
}

export function readConfig(env = process.env) {
  const bindPublic = env.LSW_BIND_PUBLIC === '1';
  const host = env.LSW_HOST || '127.0.0.1';
  assertBindable(host, bindPublic);
  const token = env.LSW_TOKEN ?? '';
  if (!/^[!-~]{24,1024}$/.test(token)) {
    throw new Error('Set LSW_TOKEN to 24–1024 printable ASCII characters without spaces');
  }
  const documentId = env.LSW_DOCUMENT_ID ?? DEFAULT_DOCUMENT_ID;
  if (!UUID.test(documentId)) {
    throw new Error('LSW_DOCUMENT_ID must be a lowercase UUID');
  }
  const databasePath = env.LSW_DB_PATH || 'data/collaboration.sqlite3';
  const dataDir = resolve(env.LSW_DATA_DIR || dirname(resolve(databasePath)));
  return {
    version: VERSION,
    host,
    port: integer(env, 'LSW_PORT', 1234, 0, 65535),
    bindPublic,
    token,
    documentId,
    databasePath,
    dataDir,
    tls: readTls(env),
    trustProxy: env.LSW_TRUST_PROXY === '1',
    allowOrigins: origins(env),
    heartbeatMs: integer(env, 'LSW_HEARTBEAT_MS', 25000, 50, 600000),
    eventLogSize: integer(env, 'LSW_EVENT_LOG_SIZE', 4096, 8, 1_000_000),
    uploadTtlMs: integer(env, 'LSW_UPLOAD_TTL_MS', 30 * 60 * 1000, 1000, 24 * 60 * 60 * 1000),
    maxFileBytes: MAX_FILE_BYTES,
    maxWorkspaceBytes: integer(
      env, 'LSW_MAX_WORKSPACE_MIB', DEFAULT_MAX_WORKSPACE_BYTES / MIB, 1, MAX_PATHS * MAX_FILE_BYTES / MIB,
    ) * MIB,
    chunkBytes: CHUNK_BYTES,
    maxPaths: MAX_PATHS,
    // Transport defaults advertised by the workspace protocol.
    maxChunkConcurrency: 3,
    partRetry: 3,
    cooldownAfterFailures: 5,
    cooldownMs: 30000,
    unhealthyAfterErrors: 5,
    errorWindowMs: 60000,
    pollFallbackMs: 3000,
  };
}
