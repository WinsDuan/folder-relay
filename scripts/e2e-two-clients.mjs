#!/usr/bin/env node
/**
 * 双客户端在线协作验收（不需要 VS Code）。
 *
 * 为什么能脱离 VS Code 跑：`apps/vscode-extension/src/project-sync.ts` 只依赖
 * node:fs / node:path / node:crypto 与本地 `editor-model` / `transport` 模块，
 * 不 import `vscode`。所以可以把**真实的 ProjectSync**（不是替身）跑在 Node 里，
 * 对接**真实的服务端进程**，验证"推送 + seq 续传 + 分片 + 离线合并"整条链路。
 *
 *   node scripts/e2e-two-clients.mjs
 *
 * 它会自建临时目录与服务端，跑完打印 PASS/FAIL 表与关键耗时，退出码即结果。
 */
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = join(repoRoot, 'apps', 'collab-server', 'src', 'server.mjs');
const BUNDLE = join(repoRoot, '.artifacts', 'e2e', 'project-sync.cjs');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const sleep = ms => new Promise(done => setTimeout(done, ms));

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log((ok ? '✔ ' : '✖ ') + name + (detail ? '  ' + detail : ''));
}

async function waitFor(label, predicate, timeoutMs = 15_000, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(intervalMs);
  }
  throw new Error('超时：' + label);
}

async function bundleClient() {
  mkdirSync(dirname(BUNDLE), { recursive: true });
  await build({
    entryPoints: [join(repoRoot, 'apps', 'vscode-extension', 'src', 'project-sync.ts')],
    outfile: BUNDLE,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    external: ['bufferutil', 'utf-8-validate', 'vscode'],
    logLevel: 'silent',
  });
  const { createRequire } = await import('node:module');
  const load = createRequire(import.meta.url);
  delete load.cache?.[BUNDLE];
  return load(BUNDLE);
}

async function startServer({ port = '0', dataDir, token, workspace }) {
  const child = spawn(process.execPath, [SERVER], {
    cwd: repoRoot,
    env: {
      ...process.env,
      LSW_PORT: String(port),
      LSW_TOKEN: token,
      LSW_DOCUMENT_ID: workspace,
      LSW_DB_PATH: join(dataDir, 'state.sqlite3'),
      LSW_DATA_DIR: dataDir,
      LSW_HEARTBEAT_MS: '250',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const listening = await new Promise((resolveStart, rejectStart) => {
    const timer = setTimeout(() => rejectStart(new Error('服务端 15s 未启动')), 15_000);
    let buffer = '';
    child.stdout.on('data', chunk => {
      buffer += chunk.toString();
      for (const line of buffer.split('\n')) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.event === 'listening') { clearTimeout(timer); resolveStart(event); }
        } catch { /* 忽略非 JSON */ }
      }
    });
    child.stderr.on('data', chunk => process.stderr.write('[server] ' + chunk));
    child.once('exit', code => { clearTimeout(timer); rejectStart(new Error('服务端退出 code=' + code)); });
  });
  return { child, port: listening.port, async stop() {
    if (child.exitCode !== null) return;
    child.kill('SIGTERM');
    await new Promise(done => {
      const timer = setTimeout(() => { child.kill('SIGKILL'); done(); }, 5000);
      child.once('exit', () => { clearTimeout(timer); done(); });
    });
  } };
}

function makeClient(ProjectSync, { root, storage, port, workspace, token }) {
  mkdirSync(root, { recursive: true });
  const statuses = [];
  const sync = new ProjectSync({
    root,
    storage,
    endpoint: new URL('http://127.0.0.1:' + port),
    workspaceId: workspace,
    token,
    isDirty: () => false,
    onStatus: status => statuses.push(status),
  });
  return { sync, statuses };
}

const state = () => {};
async function main() {
  const projectSyncModule = await bundleClient();
  const ProjectSync = projectSyncModule.ProjectSync ?? projectSyncModule.default?.ProjectSync;
  if (typeof ProjectSync !== 'function') throw new Error('无法从打包产物拿到 ProjectSync');

  const workdir = mkdtempSync(join(tmpdir(), 'lsw-e2e-clients-'));
  const serverDir = mkdtempSync(join(tmpdir(), 'lsw-e2e-server-'));
  const token = randomBytes(24).toString('base64url');
  const workspace = randomUUID();
  let server = await startServer({ dataDir: serverDir, token, workspace });
  let clients = [];

  const dirs = {
    aRoot: join(workdir, 'a'), bRoot: join(workdir, 'b'),
    aStore: join(workdir, 'store-a'), bStore: join(workdir, 'store-b'),
  };

  try {
    // 1. A 先写一份文件，作为共享初始版本
    mkdirSync(dirs.aRoot, { recursive: true });
    const texParagraph = (tag) => '% ' + tag + '\n\\documentclass{article}\n\\begin{document}\n段落 ' + tag + '\n\\end{document}\n';
    writeFileSync(join(dirs.aRoot, 'main.tex'), texParagraph('A0'));

    const a = makeClient(ProjectSync, { root: dirs.aRoot, storage: dirs.aStore, port: server.port, workspace, token });
    const b = makeClient(ProjectSync, { root: dirs.bRoot, storage: dirs.bStore, port: server.port, workspace, token });
    clients = [a, b];
    a.sync.start();
    await waitFor('A 首次上传完成', () => readText(join(dirs.aRoot, 'main.tex')) !== undefined && sha256(readFileSync(join(dirs.aRoot, 'main.tex'))) !== '', 15_000);
    await sleep(500);

    // 2. B 加入空目录 → 应下载到同一份内容
    b.sync.start();
    await waitFor('B 下载到 main.tex', () => existsSync(join(dirs.bRoot, 'main.tex'))
      && readText(join(dirs.bRoot, 'main.tex')) === readText(join(dirs.aRoot, 'main.tex')), 20_000);
    check('新成员加入即拿到共享文件', true);

    // 3. 推送延迟：A 改文件 → B 可见
    const start = Date.now();
    writeFileSync(join(dirs.aRoot, 'main.tex'), texParagraph('A1'));
    a.sync.wake();
    await waitFor('B 收到 A1', () => readText(join(dirs.bRoot, 'main.tex')) === texParagraph('A1'), 15_000);
    const pushMs = Date.now() - start;
    check('A 保存后 B 收到（推送链路）', pushMs < 3000, pushMs + ' ms');

    // 4. 新增文件也走推送
    writeFileSync(join(dirs.aRoot, 'notes.md'), '# 讨论记录\n\n- 第一版\n');
    a.sync.wake();
    await waitFor('B 收到 notes.md', () => readText(join(dirs.bRoot, 'notes.md')) !== undefined, 15_000);
    check('新增文件双向可见', readText(join(dirs.bRoot, 'notes.md')) === '# 讨论记录\n\n- 第一版\n');

    // 5. 大文件走分片上传（> 256 KiB）
    const big = Buffer.alloc(900 * 1024);
    for (let index = 0; index < big.length; index++) big[index] = (index * 31 + 7) & 0xff;
    writeFileSync(join(dirs.aRoot, 'data.csv'), big);
    a.sync.wake();
    await waitFor('B 收到大文件', () => existsSync(join(dirs.bRoot, 'data.csv'))
      && sha256(readFileSync(join(dirs.bRoot, 'data.csv'))) === sha256(big), 30_000);
    check('900 KiB 文件完整同步（分片上传 + 整文件校验）', true);

    // 6. 离线各自新增不同文件 → 重启后自动收敛
    const port = server.port;
    const mark = b.statuses.length;
    await server.stop();
    await sleep(2500);
    const downtimeStates = [...new Set(b.statuses.slice(mark).map(status => status.state))];
    check('服务端宕机时客户端进入离线/重连态（而不是静默卡死）',
      downtimeStates.some(name => name === 'Offline' || name === 'Reconnecting'), downtimeStates.join(',') || '无状态变化');
    writeFileSync(join(dirs.aRoot, 'alpha.md'), 'alpha by A\n');
    writeFileSync(join(dirs.bRoot, 'beta.md'), 'beta by B\n');
    server = await startServer({ port, dataDir: serverDir, token, workspace });
    for (const client of clients) client.sync.wake();
    await waitFor('离线改动重新上线', () => existsSync(join(dirs.aRoot, 'beta.md')) && existsSync(join(dirs.bRoot, 'alpha.md')), 40_000);
    check('服务端重启 + 双方离线改动：自动收敛，无需人工干预',
      readText(join(dirs.aRoot, 'beta.md')) === 'beta by B\n' && readText(join(dirs.bRoot, 'alpha.md')) === 'alpha by A\n');

    await waitFor('状态回到已同步', () => b.sync.status().state === 'Saved', 20_000);
    check('恢复后状态自动回到「已同步」', b.sync.status().state === 'Saved', 'state=' + b.sync.status().state);

    await sleep(800);
    const conflictsAfterMerge = [...a.sync.listConflicts(), ...b.sync.listConflicts()];
    check('改不同文件不产生冲突副本', conflictsAfterMerge.length === 0, 'conflicts=' + conflictsAfterMerge.length);

    // 7. 离线整份覆盖同一文件 → 必须产出冲突副本，而不是静默覆盖
    const wholeA = 'A 的整份版本\n第二行 A\n';
    const wholeB = 'B 的整份版本\n完全不同的第二行\n';
    await server.stop();
    await sleep(300);
    writeFileSync(join(dirs.aRoot, 'main.tex'), wholeA);
    writeFileSync(join(dirs.bRoot, 'main.tex'), wholeB);
    server = await startServer({ port, dataDir: serverDir, token, workspace });
    for (const client of clients) client.sync.wake();
    await waitFor('整份覆盖被识别为冲突', () =>
      [...a.sync.listConflicts(), ...b.sync.listConflicts()].some(item => item.path === 'main.tex'), 40_000);
    const conflict = [...a.sync.listConflicts(), ...b.sync.listConflicts()].find(item => item.path === 'main.tex');
    check('整份覆盖同一文件 → 产出冲突副本而不是静默覆盖',
      Boolean(conflict) && existsSync(join(conflict.directory, 'versions.json')),
      conflict ? conflict.directory.replace(workdir, '<tmp>') : '无冲突');

    // 8. 双方同时改同一文件的不同段落 → 应自动三方合并
    const base = '% merge\nline1\nline2\nline3\nline4\nline5\n';
    writeFileSync(join(dirs.aRoot, 'merge.md'), base);
    a.sync.wake();
    await waitFor('merge.md 上线', () => readText(join(dirs.bRoot, 'merge.md')) === base, 20_000);
    await server.stop();
    await sleep(300);
    writeFileSync(join(dirs.aRoot, 'merge.md'), base.replace('line2', 'line2-A'));
    writeFileSync(join(dirs.bRoot, 'merge.md'), base.replace('line5', 'line5-B'));
    server = await startServer({ port, dataDir: serverDir, token, workspace });
    for (const client of clients) client.sync.wake();
    await waitFor('合并完成', () => {
      const merged = readText(join(dirs.aRoot, 'merge.md')) ?? '';
      return merged.includes('line2-A') && merged.includes('line5-B');
    }, 40_000);
    const merged = readText(join(dirs.aRoot, 'merge.md')) ?? '';
    check('双方改同一文件不同段落 → 自动三方合并',
      merged.includes('line2-A') && merged.includes('line5-B'), JSON.stringify(merged.slice(0, 40)));
  } finally {
    for (const client of clients) {
      try { client.sync.dispose(); } catch { /* ignore */ }
    }
    await server?.stop().catch(() => {});
    rmSync(workdir, { recursive: true, force: true });
    rmSync(serverDir, { recursive: true, force: true });
  }

  const failed = results.filter(item => !item.ok);
  console.log('\n' + results.length + ' 项检查，' + (results.length - failed.length) + ' 通过，' + failed.length + ' 失败');
  if (failed.length) process.exitCode = 1;
}

function readText(file) {
  try { return readFileSync(file, 'utf8'); } catch { return undefined; }
}

main().catch(error => {
  console.error('\n[FAIL] ' + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});
