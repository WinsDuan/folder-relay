/**
 * Commit service shared by the 0.2 endpoints (`/workspace/file`) and the v1
 * endpoint (`/v1/workspace/commit`), so both paths use one storage, one
 * revision counter and one seq timeline.
 *
 * Idempotency: the same `Idempotency-Key` inside the 10 minute window replays
 * the original `{file, seq}` without allocating a new revision or seq.
 */
const IDEMPOTENCY_TTL_MS = 10 * 60 * 1000;

export function createCommitService({ db, workspace, seq, now = () => Date.now() }) {
  db.exec(`CREATE TABLE IF NOT EXISTS commit_idempotency (
    workspace_id TEXT NOT NULL,
    idem_key TEXT NOT NULL,
    response TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    PRIMARY KEY (workspace_id, idem_key)
  ) STRICT`);

  const lookup = db.prepare(
    'SELECT response, expires_at FROM commit_idempotency WHERE workspace_id = ? AND idem_key = ?',
  );
  const save = db.prepare(
    'INSERT INTO commit_idempotency(workspace_id, idem_key, response, expires_at) VALUES(?, ?, ?, ?) '
    + 'ON CONFLICT(workspace_id, idem_key) DO UPDATE SET response = excluded.response, expires_at = excluded.expires_at',
  );
  const purge = db.prepare('DELETE FROM commit_idempotency WHERE expires_at <= ?');

  return {
    /**
     * @returns {{status:number, body?:object, error?:string, file?:object, replay?:boolean}}
     */
    commit(workspaceId, path, base, bytes, { idempotencyKey = null } = {}) {
      const at = now();
      if (idempotencyKey) {
        const existing = lookup.get(workspaceId, idempotencyKey);
        if (existing && Number(existing.expires_at) > at) {
          return { status: 200, body: JSON.parse(existing.response), replay: true };
        }
      }

      let body;
      const result = workspace.commit(workspaceId, path, base, bytes, (file) => {
        const event = seq.append(workspaceId, {
          path: file.path,
          revision: file.revision,
          sha256: file.sha256,
          size: file.size,
          deleted: file.sha256 === null,
          at: new Date(at).toISOString(),
        });
        body = { file, seq: event.seq };
        if (idempotencyKey) {
          pruneExpired();
          save.run(workspaceId, idempotencyKey, JSON.stringify(body), at + IDEMPOTENCY_TTL_MS);
        }
        return event;
      });

      if (result.status !== 200) {
        return { status: result.status, error: result.error, file: result.file };
      }
      if (!body) {
        // Content identical to the stored blob: no revision, no seq, no event.
        body = { file: result.file, seq: seq.head(workspaceId) };
        if (idempotencyKey) {
          pruneExpired();
          save.run(workspaceId, idempotencyKey, JSON.stringify(body), at + IDEMPOTENCY_TTL_MS);
        }
      }
      return { status: 200, body, file: body.file, event: result.extra ?? null };
    },
    head(workspaceId) {
      return seq.head(workspaceId);
    },
    /**
     * Replay lookup for endpoints that mutate a session as they commit (the
     * chunked-upload `finish` deletes its session). A retry after the session is
     * gone must still observe the original `{file, seq}` instead of 410/412.
     */
    replay(workspaceId, idempotencyKey) {
      if (!idempotencyKey) return null;
      const existing = lookup.get(workspaceId, idempotencyKey);
      if (!existing || Number(existing.expires_at) <= now()) return null;
      return JSON.parse(existing.response);
    },
  };

  function pruneExpired() {
    try {
      purge.run(now());
    } catch {
      // Pruning is best-effort; a failure must not break a successful commit.
    }
  }
}

export { IDEMPOTENCY_TTL_MS };
