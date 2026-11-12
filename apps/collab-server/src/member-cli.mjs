import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openMemberStore, ROLES } from './member-store.mjs';
import { openSnapshotStore } from './snapshot-store.mjs';

const USAGE = `Usage: node apps/collab-server/src/member-cli.mjs <command> [options]

  add <name> [role]   create a member token (role: ${ROLES.join('|')}, default editor)
  list                list members (secrets are never stored or printed)
  revoke <memberId>   revoke one member token

Environment: LSW_DB_PATH (default data/collaboration.sqlite3).
The server holds an exclusive SQLite lock (locking_mode=EXCLUSIVE), so stop it
before changing members.`;

function main(argv) {
  const databasePath = process.env.LSW_DB_PATH || 'data/collaboration.sqlite3';
  const command = argv[0];
  if (!command || command === '-h' || command === '--help' || command === 'help') {
    console.log(USAGE);
    return 0;
  }
  const store = openSnapshotStore(databasePath);
  try {
    const members = openMemberStore(store.database);
    switch (command) {
      case 'add': {
        const name = argv[1];
        if (!name) throw new Error('add requires a member name');
        const role = argv[2] ?? 'editor';
        const created = members.add(name, role);
        console.log(JSON.stringify({ memberId: created.memberId, name: created.name, role: created.role }));
        console.log(created.token);
        return 0;
      }
      case 'list': {
        const rows = members.list();
        if (argv.includes('--json')) {
          console.log(JSON.stringify(rows, null, 2));
          return 0;
        }
        if (rows.length === 0) {
          console.log('(no members)');
          return 0;
        }
        for (const row of rows) {
          console.log([
            row.memberId,
            row.role.padEnd(6),
            row.revokedAt ? 'revoked ' + row.revokedAt : 'active',
            row.name,
          ].join('\t'));
        }
        return 0;
      }
      case 'revoke': {
        const memberId = argv[1];
        if (!memberId) throw new Error('revoke requires a memberId');
        if (!members.revoke(memberId)) {
          console.error('No active member with that id.');
          return 1;
        }
        console.log('revoked ' + memberId);
        return 0;
      }
      default:
        console.error('Unknown command ' + JSON.stringify(command) + '\n\n' + USAGE);
        return 2;
    }
  } finally {
    store.close();
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error('[LSW] member-cli failed:', error.message);
    process.exitCode = 1;
  }
}
