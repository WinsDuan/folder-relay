import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdirSync, mkdtempSync } from 'node:fs';
import { once } from 'node:events';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const documentId = '11111111-1111-4111-8111-111111111111';

export function artifactDir(label) {
  const base = join(root, '.artifacts');
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, label + '-'));
}

export async function waitFor(condition, description, timeout = 20_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await condition();
    if (value) return value;
    await delay(25);
  }
  throw new Error('Timed out waiting for ' + description);
}

export class TestServer {
  constructor(dir) {
    this.dir = dir;
    this.token = randomBytes(32).toString('hex');
    this.port = 0;
  }

  async start() {
    this.child = spawn(process.execPath, [join(root, 'apps/collab-server/src/server.mjs')], {
      cwd: root,
      windowsHide: true,
      env: {
        ...process.env,
        LSW_HOST: '127.0.0.1',
        LSW_PORT: String(this.port),
        LSW_DB_PATH: join(this.dir, 'test.sqlite3'),
        LSW_DOCUMENT_ID: documentId,
        LSW_TOKEN: this.token,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const child = this.child;
    let output = '';
    let listening;
    let failure;
    child.on('error', error => { failure = error; });
    child.stdout.on('data', chunk => {
      appendFileSync(join(this.dir, 'server.log'), chunk);
      output += chunk.toString();
      const lines = output.split(/\r?\n/);
      output = lines.pop();
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (event.event === 'listening') listening = event;
        } catch { /* startup diagnostics are logged verbatim */ }
      }
    });
    child.stderr.on('data', chunk => appendFileSync(join(this.dir, 'server.log'), chunk));
    try {
      const info = await waitFor(() => {
        if (failure || child.exitCode !== null) {
          throw new Error('Server failed to start. See ' + join(this.dir, 'server.log'), { cause: failure });
        }
        return listening;
      }, 'server startup');
      this.port = info.port;
      this.http = 'http://127.0.0.1:' + info.port;
      this.ws = 'ws://127.0.0.1:' + info.port;
      await waitFor(async () => (await fetch(this.http + '/healthz')).ok, 'server health');
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async stop() {
    const child = this.child;
    this.child = undefined;
    if (!child || !child.pid || child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
  }
}
