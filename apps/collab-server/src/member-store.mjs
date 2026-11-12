import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

export const ROLES = ['viewer', 'editor', 'owner'];
const ROLE_RANK = new Map(ROLES.map((role, index) => [role, index]));
const TOKEN = /^lsw1\.([0-9a-fA-F-]{8,64})\.([A-Za-z0-9_-]{16,128})$/;

export function roleAtLeast(role, required) {
  return (ROLE_RANK.get(role) ?? -1) >= (ROLE_RANK.get(required) ?? Number.MAX_SAFE_INTEGER);
}

function digest(value) {
  return createHash('sha256').update(value).digest();
}

export function openMemberStore(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS members (
    member_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    role TEXT NOT NULL,
    secret_sha256 TEXT NOT NULL,
    created_at TEXT NOT NULL,
    revoked_at TEXT
  ) STRICT`);

  const insert = db.prepare(
    'INSERT INTO members(member_id, name, role, secret_sha256, created_at, revoked_at) VALUES(?, ?, ?, ?, ?, NULL)',
  );
  const lookup = db.prepare('SELECT member_id, name, role, secret_sha256, created_at, revoked_at FROM members WHERE member_id = ?');
  const listing = db.prepare('SELECT member_id, name, role, created_at, revoked_at FROM members ORDER BY created_at');
  const revoke = db.prepare('UPDATE members SET revoked_at = ? WHERE member_id = ? AND revoked_at IS NULL');

  return {
    add(name, role = 'editor') {
      if (typeof name !== 'string' || !/^[^\u0000-\u001f]{1,64}$/.test(name)) {
        throw new Error('Member name must be 1–64 printable characters');
      }
      if (!ROLE_RANK.has(role)) {
        throw new Error('Member role must be one of ' + ROLES.join(', '));
      }
      const secret = randomBytes(32).toString('base64url');
      const memberId = randomUUID();
      insert.run(memberId, name, role, digest(secret).toString('hex'), new Date().toISOString());
      return { memberId, name, role, token: 'lsw1.' + memberId + '.' + secret };
    },
    list() {
      return listing.all().map(row => ({
        memberId: row.member_id,
        name: row.name,
        role: row.role,
        createdAt: row.created_at,
        revokedAt: row.revoked_at,
      }));
    },
    revoke(memberId) {
      const result = revoke.run(new Date().toISOString(), memberId);
      return Number(result.changes) > 0;
    },
    /**
     * Member tokens are `lsw1.<memberId>.<secret>`; only sha256(secret) is stored.
     * Returns null for malformed, unknown or revoked tokens.
     */
    authenticate(candidate) {
      if (typeof candidate !== 'string') return null;
      const match = TOKEN.exec(candidate);
      if (!match) return null;
      const row = lookup.get(match[1]);
      if (!row || row.revoked_at !== null) return null;
      const presented = digest(match[2]);
      const stored = Buffer.from(row.secret_sha256, 'hex');
      if (presented.length !== stored.length || !timingSafeEqual(presented, stored)) return null;
      return { memberId: row.member_id, name: row.name, role: row.role };
    },
  };
}
