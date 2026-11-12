import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { openSeqStore } from '../src/seq-store.mjs';
import { openSnapshotStore, sha256 } from '../src/snapshot-store.mjs';

const documentId = '11111111-1111-4111-8111-111111111111';

function tempDir(t, label) {
  const directory = mkdtempSync(join(tmpdir(), label + '-'));
  t.after(() => {
    try {
      rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch {
      for (const name of readdirSync(directory)) {
        try { unlinkSync(join(directory, name)); } catch { /* best effort */ }
      }
    }
  });
  return directory;
}

function change(seq) {
  return {
    path: 'file-' + seq + '.tex',
    revision: seq,
    sha256: sha256(String(seq)),
    size: String(seq).length,
    deleted: false,
    at: new Date(1_700_000_000_000 + seq).toISOString(),
  };
}

test('seq is monotonic, replay starts at since+1 and trimming moves the floor', (t) => {
  const directory = tempDir(t, 'lsw-seq');
  const snapshots = openSnapshotStore(join(directory, 'state.sqlite3'));
  try {
    const seq = openSeqStore(snapshots.database, { logSize: 3 });

    assert.equal(seq.head(documentId), 0);
    assert.equal(seq.floor(documentId), 1);

    for (let index = 1; index <= 5; index++) {
      const event = seq.append(documentId, change(index));
      assert.equal(event.seq, index);
      assert.equal(seq.head(documentId), index);
    }

    // logSize 3 keeps seq 3..5.
    assert.equal(seq.floor(documentId), 3);
    const reset = seq.since(documentId, 0);
    assert.equal(reset.reset, true);
    assert.deepEqual(reset.changes, []);
    assert.equal(reset.from, 1);
    assert.equal(reset.head, 5);
    assert.equal(reset.floor, 3);

    const replay = seq.since(documentId, 2);
    assert.equal(replay.reset, false);
    assert.deepEqual(replay.changes.map(entry => entry.seq), [3, 4, 5]);
    assert.equal(replay.from, 3);
    assert.equal(replay.changes[0].path, 'file-3.tex');
    assert.equal(replay.changes[0].deleted, false);

    // since === head is up to date, never a reset.
    const current = seq.since(documentId, 5);
    assert.equal(current.reset, false);
    assert.deepEqual(current.changes, []);
  } finally {
    snapshots.close();
  }
});

test('a failed mutation rolls back both the revision and the seq allocation', (t) => {
  const directory = tempDir(t, 'lsw-seq');
  const snapshots = openSnapshotStore(join(directory, 'state.sqlite3'));
  try {
    const seq = openSeqStore(snapshots.database, { logSize: 16 });

    assert.throws(() => snapshots.workspace.commit(documentId, 'a.tex', 0, Buffer.from('x'), () => {
      seq.append(documentId, change(1));
      throw new Error('event write failed');
    }), /event write failed/);

    assert.deepEqual(snapshots.workspace.manifest(documentId), []);
    assert.equal(seq.head(documentId), 0);

    const committed = snapshots.workspace.commit(documentId, 'a.tex', 0, Buffer.from('x'), (file) => {
      return seq.append(documentId, {
        path: file.path,
        revision: file.revision,
        sha256: file.sha256,
        size: file.size,
        deleted: false,
        at: new Date().toISOString(),
      });
    });
    assert.equal(committed.status, 200);
    assert.equal(committed.file.revision, 1);
    assert.equal(committed.extra.seq, 1);
    assert.equal(seq.head(documentId), 1);
    assert.equal(snapshots.workspace.manifest(documentId).length, 1);
  } finally {
    snapshots.close();
  }
});

test('a 0.2 database upgrades in place to the 0.3 schema', (t) => {
  const directory = tempDir(t, 'lsw-migrate');
  const databasePath = join(directory, 'state.sqlite3');
  const snapshot = Uint8Array.of(9, 8, 7);
  const first = openSnapshotStore(databasePath);
  first.commit(documentId, snapshot);
  first.close();

  // Simulate a 0.2 database: v1 schema, none of the 0.3 tables.
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    DROP TABLE IF EXISTS workspace_seq;
    DROP TABLE IF EXISTS workspace_events;
    DROP TABLE IF EXISTS members;
    DROP TABLE IF EXISTS commit_idempotency;
    PRAGMA user_version = 1;
  `);
  legacy.close();

  const store = openSnapshotStore(databasePath);
  let version;
  try {
    const seq = openSeqStore(store.database);
    assert.deepEqual(store.load(documentId), snapshot);
    assert.equal(seq.head(documentId), 0);
    version = store.database.prepare('PRAGMA user_version').get().user_version;
  } finally {
    store.close();
  }
  assert.equal(version, 2);
});
