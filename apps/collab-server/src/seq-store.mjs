/**
 * Workspace-level event log.
 *
 * `seq` is a per-workspace monotonic counter (timeline), `revision` is per-file
 * (optimistic concurrency). Every successful mutation appends exactly one event
 * and the log is trimmed to `logSize` entries; `floor` is the smallest seq that
 * can still be replayed.
 */
const MAX_CHANGES_PER_PAGE = 512;

function rowToChange(row) {
  return {
    seq: Number(row.seq),
    path: row.path,
    revision: Number(row.revision),
    sha256: row.sha256,
    size: Number(row.size),
    deleted: Number(row.deleted) === 1,
    at: row.at,
  };
}

export function openSeqStore(db, { logSize = 4096 } = {}) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_seq (
      workspace_id TEXT PRIMARY KEY,
      head INTEGER NOT NULL CHECK(head >= 0),
      floor INTEGER NOT NULL CHECK(floor >= 1)
    ) STRICT;
    CREATE TABLE IF NOT EXISTS workspace_events (
      workspace_id TEXT NOT NULL,
      seq INTEGER NOT NULL CHECK(seq >= 1),
      path_key TEXT NOT NULL,
      path TEXT NOT NULL,
      revision INTEGER NOT NULL,
      sha256 TEXT,
      size INTEGER NOT NULL,
      deleted INTEGER NOT NULL CHECK(deleted IN (0, 1)),
      at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, seq)
    ) STRICT;
  `);

  const ensure = db.prepare(
    'INSERT INTO workspace_seq(workspace_id, head, floor) VALUES(?, 0, 1) ON CONFLICT(workspace_id) DO NOTHING',
  );
  const state = db.prepare('SELECT head, floor FROM workspace_seq WHERE workspace_id = ?');
  const bump = db.prepare('UPDATE workspace_seq SET head = head + 1 WHERE workspace_id = ? RETURNING head');
  const insert = db.prepare(
    'INSERT INTO workspace_events(workspace_id, seq, path_key, path, revision, sha256, size, deleted, at) '
    + 'VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const page = db.prepare(
    'SELECT seq, path, revision, sha256, size, deleted, at FROM workspace_events '
    + 'WHERE workspace_id = ? AND seq > ? ORDER BY seq LIMIT ?',
  );
  const trim = db.prepare('DELETE FROM workspace_events WHERE workspace_id = ? AND seq < ?');
  const setFloor = db.prepare('UPDATE workspace_seq SET floor = ? WHERE workspace_id = ?');

  function stateOf(workspaceId) {
    ensure.run(workspaceId);
    const row = state.get(workspaceId);
    return { head: Number(row.head), floor: Number(row.floor) };
  }

  return {
    logSize,
    ensure: stateOf,
    head(workspaceId) {
      return stateOf(workspaceId).head;
    },
    floor(workspaceId) {
      return stateOf(workspaceId).floor;
    },
    /**
     * Append one event and trim the log. MUST run inside the caller's SQLite
     * transaction so the revision write, seq allocation and event row commit
     * atomically (or roll back together).
     */
    append(workspaceId, change) {
      const current = stateOf(workspaceId);
      const { head: seq } = bump.get(workspaceId);
      insert.run(
        workspaceId,
        Number(seq),
        change.path.toLowerCase(),
        change.path,
        change.revision,
        change.sha256 ?? null,
        change.size ?? 0,
        change.deleted ? 1 : 0,
        change.at,
      );
      const keepFrom = Math.max(1, Number(seq) - logSize + 1);
      if (keepFrom > current.floor) {
        trim.run(workspaceId, keepFrom);
        setFloor.run(keepFrom, workspaceId);
      }
      return {
        seq: Number(seq),
        path: change.path,
        revision: change.revision,
        sha256: change.sha256 ?? null,
        size: change.size ?? 0,
        deleted: Boolean(change.deleted),
        at: change.at,
      };
    },
    /**
     * `since` is the largest seq the client already applied, so the page starts
     * at since+1. A page is unreplayable when its first seq (since+1) is below
     * the trimmed floor — that is the only case that forces a full resync.
     * (The prose rule "since < floor" would also flag since=0 on a fresh log,
     * which would make every first connection reset needlessly.)
     */
    since(workspaceId, since, limit = MAX_CHANGES_PER_PAGE) {
      const { head, floor } = stateOf(workspaceId);
      const from = since + 1;
      const reset = from < floor;
      const changes = reset ? [] : page.all(workspaceId, since, limit).map(rowToChange);
      return { workspace: workspaceId, head, floor, from, reset, changes };
    },
  };
}

export { MAX_CHANGES_PER_PAGE };
