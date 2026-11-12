#!/usr/bin/env node
/**
 * Folder Relay 远程链路基准：把「650ms 全量轮询」和「推送 + seq 增量」放到同一台机器、同一条链路上量化对比。
 *
 * 用法：
 *   node scripts/bench-remote.mjs --self            # 自己拉起一个临时服务端，跑完两个模式并打印对比表
 *   node scripts/bench-remote.mjs --url http://127.0.0.1:1234 --token <t> --workspace <uuid> [--mode poll|push|both] [--seconds 20]
 *
 * 指标定义（务必按此理解，别过度解读）：
 *   requests     观察窗口内客户端发出的 HTTP 请求数（推送模式下应接近 0）
 *   frames       观察窗口内收到的 WS 帧数（含心跳）
 *   idleBytes    窗口内下行字节数估算（清单体积 × 次数 / 帧体积）
 *   latency      写入端提交成功后，观察端第一次「看到新版本」的耗时；p50/p95/max 单位 ms
 *                这是端到端可感知延迟，含服务端落盘与观测端探测间隔
 *
 * 本脚本只做观测，不修改工作区内容以外的任何东西；临时服务端的数据库在系统临时目录，跑完即删。
 */

import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const SERVER = join(repoRoot, 'apps', 'collab-server', 'src', 'server.mjs');

function parseArgs(argv) {
  const out = { seconds: 20, mode: 'both', benchPath: 'bench/probe.txt' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--self') out.self = true;
    else if (arg === '--url') out.url = argv[++i];
    else if (arg === '--token') out.token = argv[++i];
    else if (arg === '--workspace') out.workspace = argv[++i];
    else if (arg === '--mode') out.mode = argv[++i];
    else if (arg === '--seconds') out.seconds = Number(argv[++i]);
    else if (arg === '--path') out.benchPath = argv[++i];
    else throw new Error('未知参数：' + arg);
  }
  return out;
}

const sleep = ms => new Promise(done => setTimeout(done, ms));

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

async function startEphemeralServer() {
  const directory = mkdtempSync(join(tmpdir(), 'lsw-bench-'));
  const token = randomBytes(24).toString('base64url');
  const workspace = randomUUID();
  const child = spawn(process.execPath, [SERVER], {
    cwd: repoRoot,
    env: { ...process.env, LSW_PORT: '0', LSW_TOKEN: token, LSW_DOCUMENT_ID: workspace, LSW_DB_PATH: join(directory, 'bench.sqlite3') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const listening = await new Promise((resolveStart, rejectStart) => {
    let buffer = '';
    const timer = setTimeout(() => rejectStart(new Error('服务端 10 秒内未启动')), 10_000);
    child.stdout.on('data', chunk => {
      buffer += chunk.toString();
      for (const line of buffer.split('\n')) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.event === 'listening') {
            clearTimeout(timer);
            resolveStart(event);
          }
        } catch { /* 非 JSON 行忽略 */ }
      }
    });
    child.stderr.on('data', chunk => process.stderr.write('[server] ' + chunk));
    child.once('exit', code => rejectStart(new Error('服务端提前退出，code=' + code)));
  });
  return {
    url: `http://${listening.host}:${listening.port}`,
    token,
    workspace,
    async stop() {
      child.kill('SIGTERM');
      await new Promise(done => {
        const timer = setTimeout(() => { child.kill('SIGKILL'); done(); }, 5000);
        child.once('exit', () => { clearTimeout(timer); done(); });
      });
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function request(url, token, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: { ...init.headers, Authorization: 'Bearer ' + token },
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  return response;
}

async function readManifest(base, token, workspace) {
  const url = new URL('/workspace/manifest', base);
  url.searchParams.set('workspace', workspace);
  const response = await request(url, token);
  if (!response.ok) throw new Error('manifest HTTP ' + response.status);
  const body = await response.json();
  const text = JSON.stringify(body);
  return { files: body.files ?? [], bytes: Buffer.byteLength(text), seq: Number(response.headers.get('x-lsw-seq') ?? '') || undefined };
}

async function commitFile(base, token, workspace, relative, revision, payload) {
  const url = new URL('/workspace/file', base);
  url.searchParams.set('workspace', workspace);
  url.searchParams.set('path', relative);
  const response = await request(url, token, {
    method: 'PUT',
    headers: {
      'If-Match': '"' + revision + '"',
      'Content-Type': 'application/octet-stream',
      'Idempotency-Key': randomUUID(),
    },
    body: payload,
  });
  if (!response.ok) throw new Error('commit HTTP ' + response.status + ' ' + (await response.text()));
  return response.json();
}

function findRevision(files, relative) {
  const row = files.find(file => file.path === relative);
  return row ? row.revision : 0;
}

/** 写入端：每 intervalMs 提交一次递增内容，作为可观测的「远端变化」。
 *
 * 关键细节（实测踩到）：服务端在 commit 落盘后**先广播事件、后写完 HTTP 响应**，
 * 所以事件帧经常早于 `fetch` 的 resolve 到达。时间戳必须在**发起请求之前**登记，
 * 并且以「期望的下一版 revision」为键，否则永远匹配不上（观测到的现象是 changes=0）。
 */
function startWriter({ base, token, workspace, relative, intervalMs = 1200, onCommitted, onFailed, signal }) {
  let revision = 0;
  let counter = 0;
  (async () => {
    try {
      const manifest = await readManifest(base, token, workspace);
      revision = findRevision(manifest.files, relative);
    } catch { /* 首次为空也无妨 */ }
    while (!signal.aborted) {
      await sleep(intervalMs);
      if (signal.aborted) break;
      counter++;
      const expected = revision + 1;
      onCommitted(counter, Date.now(), expected);
      try {
        const payload = Buffer.from('bench sample ' + counter + ' ' + 'x'.repeat(64) + '\n');
        const committed = await commitFile(base, token, workspace, relative, revision, payload);
        revision = committed.revision;
      } catch (error) {
        onFailed?.(expected);
        process.stderr.write('[writer] ' + error.message + '\n');
      }
    }
  })();
}

async function runPollMode(config, seconds) {
  const samples = [];
  let requests = 0;
  let idleBytes = 0;
  /** key = 期望的下一版 revision，value = 发起该次提交的时刻 */
  const pending = new Map();
  const controller = new AbortController();
  startWriter({
    base: config.url, token: config.token, workspace: config.workspace,
    relative: config.benchPath,
    onCommitted: (_counter, at, expected) => pending.set(expected, at),
    onFailed: expected => pending.delete(expected),
    signal: controller.signal,
  });

  const started = Date.now();
  const deadline = started + seconds * 1000;
  while (Date.now() < deadline) {
    try {
      const manifest = await readManifest(config.url, config.token, config.workspace);
      requests++;
      idleBytes += manifest.bytes;
      const next = findRevision(manifest.files, config.benchPath);
      for (const [expected, at] of [...pending]) {
        if (expected <= next) {
          samples.push(Date.now() - at);
          pending.delete(expected);
        }
      }
    } catch (error) {
      process.stderr.write('[poll] ' + error.message + '\n');
    }
    await sleep(650);
  }
  controller.abort();
  return {
    mode: 'poll-650ms', seconds, requests, frames: 0,
    idleBytes, requestsPerHour: Math.round(requests / seconds * 3600),
    changes: samples.length,
    latency: { p50: percentile(samples, 50), p95: percentile(samples, 95), max: samples.length ? Math.max(...samples) : null },
  };
}

async function runPushMode(config, seconds) {
  const wsUrl = new URL('/v1/events', config.url);
  wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  wsUrl.searchParams.set('workspace', config.workspace);
  wsUrl.searchParams.set('since', '0');
  const socket = new WebSocket(wsUrl.href, ['lsw.v1', 'lsw.token.' + config.token]);
  const samples = [];
  /** key = 期望的下一版 revision，value = 发起该次提交的时刻 */
  const pending = new Map();
  let frames = 0;
  let frameBytes = 0;
  let serverSeq = 0;
  let protocol = 'ws';
  let heartbeatMs = 15_000;

  const opened = new Promise((resolveOpen, rejectOpen) => {
    const timer = setTimeout(() => rejectOpen(new Error('WS 握手 8 秒超时')), 8000);
    socket.once('open', () => { clearTimeout(timer); resolveOpen(); });
    socket.once('error', error => { clearTimeout(timer); rejectOpen(error); });
  });
  await opened;

  socket.on('message', raw => {
    const text = raw.toString();
    frames++;
    frameBytes += text.length;
    let message;
    try { message = JSON.parse(text); } catch { return; }
    if (message.t === 'hello') {
      serverSeq = message.seq ?? 0;
      protocol = 'ws';
      heartbeatMs = message.heartbeatMs ?? heartbeatMs;
    } else if (message.t === 'ping') {
      socket.send(JSON.stringify({ t: 'pong', seq: serverSeq }));
    } else if (message.t === 'changes') {
      serverSeq = message.head ?? serverSeq;
      for (const change of message.changes ?? []) {
        const at = change.path === config.benchPath ? pending.get(change.revision) : undefined;
        if (at !== undefined) {
          samples.push(Date.now() - at);
          pending.delete(change.revision);
          socket.send(JSON.stringify({ t: 'ack', seq: serverSeq }));
        }
      }
    } else if (message.t === 'reset') {
      serverSeq = message.head ?? serverSeq;
    }
  });

  const controller = new AbortController();
  startWriter({
    base: config.url, token: config.token, workspace: config.workspace,
    relative: config.benchPath,
    onCommitted: (_counter, at, expected) => pending.set(expected, at),
    onFailed: expected => pending.delete(expected),
    signal: controller.signal,
  });

  await sleep(seconds * 1000);
  controller.abort();
  const requests = 0;
  socket.close();
  return {
    mode: protocol === 'ws' ? 'ws-push' : 'ws-fallback', seconds, requests, frames,
    idleBytes: frameBytes, requestsPerHour: 0,
    heartbeatMs,
    changes: samples.length,
    latency: { p50: percentile(samples, 50), p95: percentile(samples, 95), max: samples.length ? Math.max(...samples) : null },
  };
}

function formatTable(rows) {
  const header = ['模式', 'HTTP 请求', 'WS 帧', '下行字节', '请求/小时', '变化数', 'p50 ms', 'p95 ms', 'max ms'];
  const body = rows.map(row => [
    row.mode, String(row.requests), String(row.frames), String(row.idleBytes),
    String(row.requestsPerHour), String(row.changes),
    row.latency.p50 === null ? '-' : (row.latency.p50 / 1000).toFixed(3),
    row.latency.p95 === null ? '-' : (row.latency.p95 / 1000).toFixed(3),
    row.latency.max === null ? '-' : (row.latency.max / 1000).toFixed(3),
  ]);
  const widths = header.map((title, index) => Math.max(title.length, ...body.map(row => row[index].length)));
  const line = row => row.map((cell, index) => cell.padEnd(widths[index])).join('  ');
  return [line(header), widths.map(width => '-'.repeat(width)).join('  '), ...body.map(line)].join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.self && (!args.url || !args.token || !args.workspace)) {
    throw new Error('需要 --url/--token/--workspace，或使用 --self');
  }
  const owned = args.self ? await startEphemeralServer() : undefined;
  const config = owned
    ? { url: owned.url, token: owned.token, workspace: owned.workspace, benchPath: args.benchPath }
    : { url: args.url, token: args.token, workspace: args.workspace, benchPath: args.benchPath };

  const results = [];
  try {
    if (args.mode === 'both' || args.mode === 'poll') results.push(await runPollMode(config, args.seconds));
    if (args.mode === 'both' || args.mode === 'push') {
      try {
        results.push(await runPushMode(config, args.seconds));
      } catch (error) {
        process.stderr.write('[push] 推送通道不可用（服务端 < 0.3？）：' + error.message + '\n');
        results.push({ mode: 'ws-push', seconds: args.seconds, requests: 0, frames: 0, idleBytes: 0, requestsPerHour: 0, changes: 0, latency: { p50: null, p95: null, max: null }, unavailable: error.message });
      }
    }
  } finally {
    await owned?.stop();
  }

  const table = formatTable(results);
  console.log(table);
  console.log('\n' + JSON.stringify({ url: config.url.replace(/\/\/([^:]+):\d+$/, '//$1:<port>'), results }, null, 2));
  console.log('\n读法：requests/小时 = 空转成本；latency = 端到端可感知延迟（含写入落盘）。'
    + '\n推送模式下 requests 应为 0，延迟由写入端到事件的单程决定，不受 650ms 轮询粒度限制。');
}

main().catch(error => {
  console.error('[bench] 失败：' + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});
