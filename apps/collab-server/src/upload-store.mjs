import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

const PART = /^(0|[1-9][0-9]{0,15})\.part$/;

function digestOf(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Chunked, resumable upload sessions.
 *
 * Parts live on disk (`<LSW_DATA_DIR>/uploads/<id>/<offset>.part`) so a 16 MiB
 * blob never enters SQLite WAL. A session survives a server restart: metadata
 * and already received parts are reloaded on open, which is what makes
 * `POST /v1/upload` with the same (workspace, path, size, sha256) resume.
 */
export function openUploadStore({ directory, ttlMs, chunkBytes, maxFileBytes, commit, now = () => Date.now() }) {
  const root = join(directory, 'uploads');
  const sessions = new Map();

  // The upload root is created on first use so a read-only deployment (or a
  // test that only exercises the legacy endpoints) leaves no empty directory.
  function ensureRoot() {
    mkdirSync(root, { recursive: true, mode: 0o700 });
  }

  function sessionDir(id) {
    return join(root, id);
  }

  function removeSession(id) {
    sessions.delete(id);
    rmSync(sessionDir(id), { recursive: true, force: true });
  }

  function partsOf(id) {
    const dir = sessionDir(id);
    if (!existsSync(dir)) return [];
    const parts = [];
    for (const name of readdirSync(dir)) {
      const match = PART.exec(name);
      if (!match) continue;
      const offset = Number(match[1]);
      const { size } = statSync(join(dir, name));
      parts.push({ offset, length: size });
    }
    return parts.sort((left, right) => left.offset - right.offset);
  }

  /** Contiguous prefix of received byte ranges — the "resume here" offset. */
  function prefixOf(parts) {
    let offset = 0;
    for (const part of parts) {
      if (part.offset !== offset) return offset;
      offset += part.length;
    }
    return offset;
  }

  function touch(session) {
    session.lastActivity = now();
    try {
      writeFileSync(join(sessionDir(session.upload), 'meta.json'), JSON.stringify({
        upload: session.upload,
        workspaceId: session.workspaceId,
        path: session.path,
        size: session.size,
        sha256: session.sha256,
        base: session.base,
        createdAt: session.createdAt,
        lastActivity: session.lastActivity,
      }));
    } catch {
      // Losing the touch file only shortens resumability after a restart.
    }
  }

  function restore() {
    if (!existsSync(root)) return;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(root, entry.name);
      let meta;
      try {
        meta = JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
      } catch {
        rmSync(dir, { recursive: true, force: true });
        continue;
      }
      if (typeof meta?.upload !== 'string' || typeof meta.path !== 'string'
        || !Number.isSafeInteger(meta.size) || typeof meta.sha256 !== 'string') {
        rmSync(dir, { recursive: true, force: true });
        continue;
      }
      sessions.set(meta.upload, {
        upload: meta.upload,
        workspaceId: meta.workspaceId,
        path: meta.path,
        size: meta.size,
        sha256: meta.sha256,
        base: Number(meta.base ?? 0),
        createdAt: Number(meta.createdAt ?? 0),
        lastActivity: Number(meta.lastActivity ?? 0) || statSync(dir).mtimeMs,
      });
    }
  }

  function sweep() {
    const at = now();
    for (const session of [...sessions.values()]) {
      if (at - session.lastActivity > ttlMs) removeSession(session.upload);
    }
  }

  function sessionFor(id) {
    sweep();
    const session = sessions.get(id);
    if (!session) return null;
    if (now() - session.lastActivity > ttlMs) {
      removeSession(id);
      return null;
    }
    return session;
  }

  function view(session, status) {
    const parts = partsOf(session.upload);
    return {
      status,
      upload: session.upload,
      offset: prefixOf(parts),
      chunkBytes,
      received: parts,
    };
  }

  restore();
  sweep();

  return {
    root,
    sessions,
    create({ workspaceId, path, size, sha256, base }) {
      if (!Number.isSafeInteger(size) || size < 0 || size > maxFileBytes) {
        return { status: 413, error: 'file-too-large' };
      }
      if (!/^[0-9a-f]{64}$/.test(sha256 ?? '')) return { status: 400, error: 'invalid-sha256' };
      if (!Number.isSafeInteger(base) || base < 0) return { status: 400, error: 'invalid-base' };

      for (const session of sessions.values()) {
        if (session.workspaceId === workspaceId && session.path === path
          && session.size === size && session.sha256 === sha256) {
          touch(session);
          return view(session, 200);
        }
      }
      const id = randomUUID();
      const session = {
        upload: id,
        workspaceId,
        path,
        size,
        sha256,
        base,
        createdAt: now(),
        lastActivity: now(),
      };
      mkdirSync(sessionDir(id), { recursive: true, mode: 0o700 });
      ensureRoot();
      sessions.set(id, session);
      touch(session);      const created = view(session, 201);
      created.received = [];
      return created;
    },
    put(id, offset, bytes) {
      const session = sessionFor(id);
      if (!session) return { status: 410, error: 'upload-expired' };
      const expected = prefixOf(partsOf(id));
      if (!Number.isSafeInteger(offset) || offset !== expected) {
        return { status: 409, error: 'upload-offset-mismatch', expected };
      }
      if (bytes.length === 0) return { status: 400, error: 'empty-chunk' };
      if (bytes.length > chunkBytes) return { status: 413, error: 'chunk-too-large' };
      if (offset + bytes.length > session.size) return { status: 413, error: 'chunk-past-end' };
      writeFileSync(join(sessionDir(id), offset + '.part'), bytes);
      touch(session);
      return { status: 200, upload: id, offset: prefixOf(partsOf(id)) };
    },
    get(id) {
      const session = sessionFor(id);
      if (!session) return { status: 410, error: 'upload-expired' };
      const parts = partsOf(id);
      return {
        status: 200,
        upload: session.upload,
        size: session.size,
        sha256: session.sha256,
        base: session.base,
        offset: prefixOf(parts),
        received: parts,
      };
    },
    remove(id) {
      if (!sessions.has(id)) return { status: 410, error: 'upload-expired' };
      removeSession(id);
      return { status: 200, upload: id };
    },
    finish(id, { idempotencyKey = null } = {}) {
      const session = sessionFor(id);
      if (!session) return { status: 410, error: 'upload-expired' };
      const parts = partsOf(id);
      const offset = prefixOf(parts);
      if (offset !== session.size) return { status: 409, error: 'upload-incomplete', expected: offset };
      const chunks = parts.map(part => readFileSync(join(sessionDir(id), part.offset + '.part')));
      const bytes = Buffer.concat(chunks, session.size);
      if (bytes.length !== session.size) return { status: 409, error: 'upload-incomplete', expected: bytes.length };
      const digest = digestOf(bytes);
      if (digest !== session.sha256) {
        return { status: 422, error: 'upload-hash-mismatch', expected: session.sha256, actual: digest };
      }
      const result = commit({
        workspaceId: session.workspaceId,
        path: session.path,
        base: session.base,
        bytes,
        idempotencyKey,
      });
      if (result.status !== 200) return result;
      removeSession(id);
      return result;
    },
  };
}
