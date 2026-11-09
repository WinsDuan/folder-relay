import { createHash } from 'node:crypto';

export const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_WORKSPACE_BYTES = 128 * 1024 * 1024;
const MAX_PATHS = 4096;
const INVALID_NAME = /[<>:"\\|?*\u0000-\u001f\u007f]/u;
const RESERVED_NAME = /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])$/iu;

export function isWorkspacePath(path) {
  return typeof path === 'string' && Buffer.byteLength(path) <= 1024 && path.normalize('NFC') === path
    && path.split('/').every(name => name && Buffer.byteLength(name) <= 255
      && !INVALID_NAME.test(name) && !/[. ]$/u.test(name)
      && !RESERVED_NAME.test(name.split('.')[0].trimEnd()));
}

function pathsCollide(path, other) {
  const parts = path.split('/');
  const theirs = other.split('/');
  const shared = Math.min(parts.length, theirs.length);
  for (let index = 0; index < shared; index++) {
    if (parts[index].toLowerCase() !== theirs[index].toLowerCase()) return false;
    if (parts[index] !== theirs[index]) return true;
  }
  // A live file may not also be a parent directory.
  return true;
}

export function openWorkspaceStore(db) {
  db.exec('CREATE TABLE IF NOT EXISTS workspace_files ('
    + 'workspace_id TEXT NOT NULL, path_key TEXT NOT NULL, path TEXT NOT NULL,'
    + 'revision INTEGER NOT NULL CHECK(revision > 0), sha256 TEXT, bytes BLOB,'
    + 'PRIMARY KEY (workspace_id, path_key),'
    + 'CHECK((bytes IS NULL AND sha256 IS NULL) OR (bytes IS NOT NULL AND sha256 IS NOT NULL))'
    + ') STRICT');

  const metadata = 'path, revision, sha256, COALESCE(length(bytes), 0) AS size';
  const list = db.prepare('SELECT ' + metadata + ' FROM workspace_files WHERE workspace_id = ? ORDER BY path');
  const entry = db.prepare('SELECT ' + metadata + ' FROM workspace_files WHERE workspace_id = ? AND path_key = ?');
  const read = db.prepare(
    'SELECT sha256, bytes FROM workspace_files WHERE workspace_id = ? AND path_key = ? AND path = ? AND revision = ? AND bytes IS NOT NULL',
  );
  const write = db.prepare(
    'INSERT INTO workspace_files (workspace_id, path_key, path, revision, sha256, bytes) VALUES (?, ?, ?, ?, ?, ?) '
    + 'ON CONFLICT(workspace_id, path_key) DO UPDATE SET revision = excluded.revision, sha256 = excluded.sha256, bytes = excluded.bytes',
  );

  return {
    manifest(workspaceId) {
      return list.all(workspaceId);
    },
    read(workspaceId, path, revision) {
      return read.get(workspaceId, path.toLowerCase(), path, revision);
    },
    commit(workspaceId, path, base, bytes) {
      const key = path.toLowerCase();
      const current = entry.get(workspaceId, key);
      if (current && current.path !== path) return { status: 409, error: 'path-collision' };
      if ((current?.revision ?? 0) !== base) return { status: 412, error: 'revision-changed' };
      const digest = bytes === null ? null : createHash('sha256').update(bytes).digest('hex');
      if (digest === (current?.sha256 ?? null)) {
        return { status: 200, file: current ?? { path, revision: 0, sha256: null, size: 0 } };
      }
      const size = bytes?.byteLength ?? 0;
      if (size > MAX_FILE_BYTES) return { status: 413, error: 'file-too-large' };

      if (bytes !== null) {
        const files = list.all(workspaceId);
        if (files.some(file => file.sha256 !== null && file.path !== path && pathsCollide(path, file.path))) {
          return { status: 409, error: 'path-collision' };
        }
        const total = files.reduce((sum, file) => sum + file.size, 0);
        if ((!current && files.length >= MAX_PATHS) || total - (current?.size ?? 0) + size > MAX_WORKSPACE_BYTES) {
          return { status: 507, error: 'workspace-capacity' };
        }
      }

      // A single process owns this connection. No request can interleave
      // between the revision check and the synchronous WAL commit.
      const revision = base + 1;
      write.run(workspaceId, key, path, revision, digest, bytes);
      return { status: 200, file: { path, revision, sha256: digest, size } };
    },
  };
}
