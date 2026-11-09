import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { openSnapshotStore, sha256 } from '../src/snapshot-store.mjs';

test('snapshot proof is idempotent and survives reopening the database', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'lsw-snapshot-'));
  const databasePath = join(directory, 'snapshots.sqlite3');
  const documentId = '11111111-1111-4111-8111-111111111111';
  let store = openSnapshotStore(databasePath);
  t.after(() => {
    store?.close();
    for (const name of readdirSync(directory)) unlinkSync(join(directory, name));
    rmdirSync(directory);
  });

  const snapshot = Uint8Array.of(1, 2, 3);
  assert.equal(store.proof(documentId), undefined);
  store.commit(documentId, snapshot);
  const committed = store.proof(documentId);
  assert.equal(committed.sha256, sha256(snapshot));
  assert.ok(Number.isFinite(Date.parse(committed.updatedAt)));
  store.commit(documentId, snapshot);
  assert.deepEqual(store.proof(documentId), committed);

  // A second live owner could compute a snapshot from stale in-memory state.
  assert.throws(() => openSnapshotStore(databasePath), /locked/);
  store.close();
  store = undefined;
  store = openSnapshotStore(databasePath);
  assert.deepEqual(store.load(documentId), snapshot);
  assert.deepEqual(store.proof(documentId), committed);
});

test('rejects an unrelated existing SQLite database without changing its journal mode', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'lsw-snapshot-'));
  const databasePath = join(directory, 'other.sqlite3');
  const other = new DatabaseSync(databasePath);
  other.exec('CREATE TABLE existing (value INTEGER); INSERT INTO existing VALUES (42);');
  other.close();
  t.after(() => {
    for (const name of readdirSync(directory)) unlinkSync(join(directory, name));
    rmdirSync(directory);
  });

  assert.throws(() => openSnapshotStore(databasePath), /owned by another application/);
  const check = new DatabaseSync(databasePath);
  try {
    assert.equal(check.prepare('SELECT value FROM existing').get().value, 42);
    assert.equal(check.prepare('PRAGMA journal_mode').get().journal_mode, 'delete');
  } finally {
    check.close();
  }
});
