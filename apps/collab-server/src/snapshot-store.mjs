import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openWorkspaceStore } from './workspace-store.mjs';

const APPLICATION_ID = 0x4c535731;

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function openSnapshotStore(databasePath) {
  const path = resolve(databasePath);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  try {
    // Exclusive locking prevents two server processes from maintaining separate
    // in-memory Y.Docs against the same database. WAL recovers committed writes.
    db.exec(`
      PRAGMA busy_timeout = 1000;
      PRAGMA locking_mode = EXCLUSIVE;
    `);
    const { application_id: applicationId } = db.prepare('PRAGMA application_id').get();
    const { user_version: version } = db.prepare('PRAGMA user_version').get();
    if (applicationId !== APPLICATION_ID) {
      const schemaExists = db.prepare('SELECT 1 FROM sqlite_schema LIMIT 1').get();
      if (applicationId !== 0 || version !== 0 || schemaExists) {
        throw new Error('LSW_DB_PATH refers to a database owned by another application');
      }
    } else if (version !== 1) {
      throw new Error('Unsupported snapshot database version');
    }
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      BEGIN EXCLUSIVE;
      CREATE TABLE IF NOT EXISTS snapshots (
        document_id TEXT PRIMARY KEY,
        state BLOB NOT NULL,
        sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
        updated_at TEXT NOT NULL
      ) STRICT;
      PRAGMA application_id = ${APPLICATION_ID};
      PRAGMA user_version = 1;
      COMMIT;
    `);

    const read = db.prepare('SELECT state, sha256, updated_at FROM snapshots WHERE document_id = ?');
    const proof = db.prepare('SELECT sha256, updated_at AS updatedAt FROM snapshots WHERE document_id = ?');
    const insert = db.prepare(`
      INSERT INTO snapshots(document_id, state, sha256, updated_at) VALUES(?, ?, ?, ?)
      ON CONFLICT(document_id) DO UPDATE SET
        state = excluded.state,
        sha256 = excluded.sha256,
        updated_at = excluded.updated_at
      WHERE snapshots.sha256 <> excluded.sha256
    `);
    const workspace = openWorkspaceStore(db);

    return {
      workspace,
      load(documentId) {
        const row = read.get(documentId);
        if (row && sha256(row.state) !== row.sha256) {
          throw new Error('Snapshot checksum mismatch');
        }
        return row?.state;
      },
      commit(documentId, state) {
        // The statement owns its transaction. SQLite returns after WAL commit
        // and FULL synchronization, or throws and leaves the old row available.
        insert.run(documentId, state, sha256(state), new Date().toISOString());
      },
      proof(documentId) {
        return proof.get(documentId);
      },
      close() {
        db.close();
      },
    };
  } catch (error) {
    db.close();
    throw error;
  }
}
