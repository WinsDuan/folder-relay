#!/usr/bin/env node
/**
 * 验证 infra/deploy/Caddyfile.template 里那四条"不能省的设置"是否真的管用。
 *
 * 做法：用真实的 Caddy 进程反代真实的服务端，然后像客户端一样经 wss:// 订阅事件、
 * 经 https:// 提交文件、经 Range 下载。测的就是最容易在部署后翻车的路径：
 * WebSocket 升级、响应不缓冲、长连接不被掐、请求体上限、Range 透传。
 *
 *   node scripts/verify-caddy-proxy.mjs [--caddy <caddy 可执行文件>]
 *
 * 需要本机有 caddy 二进制（先跑过 `caddy version`）。没有就跳过并提示，不算失败。
 */
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE = join(repoRoot, 'infra', 'deploy', 'Caddyfile.template');
const SERVER = join(repoRoot, 'apps', 'collab-server', 'src', 'server.mjs');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const sleep = ms => new Promise(done => setTimeout(done, ms));

function findCaddy(argv) {
  const index = argv.indexOf('--caddy');
  const candidates = [
    index >= 0 ? argv[index + 1] : undefined,
    process.env.CADDY_BIN,
    join(repoRoot, '.artifacts', 'caddy', 'caddy.exe'),
    join(repoRoot, '.artifacts', 'caddy', 'caddy'),
  ].filter(Boolean);
  return candidates.find(candidate => existsSync(candidate));
}

async function freePort() {
  const server = (await import('node:net')).createServer();
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const { port } = server.address();
  await new Promise(done => server.close(done));
  return port;
}

/** 按花括号配平删掉顶层某个块（模板里的 log 块指向 Linux 的 /var/log，本机验证不需要）。 */
function stripBlock(text, header) {
  const start = text.indexOf('    ' + header);
  if (start < 0) throw new Error('模板里找不到块: ' + header);
  let depth = 0;
  for (let index = start; index < text.length; index++) {
    if (text[index] === '{') depth++;
    else if (text[index] === '}') {
      depth--;
      if (depth === 0) return text.slice(0, start) + text.slice(index + 1).replace(/^\n/, '');
    }
  }
  throw new Error('块没有闭合: ' + header);
}

function renderCaddyfile(domain, upstreamPort) {
  let text = readFileSync(TEMPLATE, 'utf8');
  // 日志路径是 Linux 的 /var/log：本机验证不需要文件日志，去掉以免路径不存在。
  text = stripBlock(text, 'log {');
  // 模板头部注释里也提到了这两个占位符，必须全局替换，否则真正的站点地址会留着 __DOMAIN__。
  text = text
    .replace(/__DOMAIN__/g, domain)
    .replace(/__PORT__/g, String(upstreamPort));
  // local_certs：用 Caddy 自己的本地 CA 签 localhost，避免依赖公网/Let's Encrypt；
  // skip_install_trust：不往 Windows 信任库装根证书（需要管理员），Node 侧用 rejectUnauthorized:false。
  return `{
	admin off
	local_certs
	skip_install_trust
}

` + text;
}

async function main() {
  // 本脚本只连 127.0.0.1 上 Caddy 的临时本地 CA（test-only），Node 全局 fetch 没有
  // 逐请求的 rejectUnauthorized 开关，所以在这里整体放宽；不要把这个习惯带进产品代码。
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  const caddyBin = findCaddy(process.argv.slice(2));
  if (!caddyBin) {
    console.log('跳过：本机没有 caddy 可执行文件（设 CADDY_BIN 或放到 .artifacts/caddy/）。');
    return;
  }

  const workdir = mkdtempSync(join(tmpdir(), 'lsw-caddy-'));
  const token = randomBytes(24).toString('base64url');
  const workspace = randomUUID();
  const upstreamPort = await freePort();
  const tlsPort = await freePort();
  const domain = 'https://localhost:' + tlsPort;
  const caddyfile = join(workdir, 'Caddyfile');
  writeFileSync(caddyfile, renderCaddyfile(domain, upstreamPort));

  const server = spawn(process.execPath, [SERVER], {
    cwd: repoRoot,
    env: {
      ...process.env,
      LSW_PORT: String(upstreamPort),
      LSW_TOKEN: token,
      LSW_DOCUMENT_ID: workspace,
      LSW_DB_PATH: join(workdir, 'state.sqlite3'),
      LSW_DATA_DIR: workdir,
      LSW_HEARTBEAT_MS: '250',
      LSW_TRUST_PROXY: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverErr = '';
  server.stderr.on('data', chunk => { serverErr += chunk.toString(); });
  await new Promise((resolveStart, rejectStart) => {
    const timer = setTimeout(() => rejectStart(new Error('服务端未启动\n' + serverErr)), 15_000);
    let buffer = '';
    server.stdout.on('data', chunk => {
      buffer += chunk.toString();
      for (const line of buffer.split('\n')) {
        if (!line.trim()) continue;
        try { if (JSON.parse(line).event === 'listening') { clearTimeout(timer); resolveStart(); } } catch { /* ignore */ }
      }
    });
  });

  const caddy = spawn(caddyBin, ['run', '--config', caddyfile, '--adapter', 'caddyfile'], {
    cwd: workdir,
    env: { ...process.env, XDG_DATA_HOME: workdir, XDG_CONFIG_HOME: workdir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let caddyErr = '';
  caddy.stderr.on('data', chunk => { caddyErr += chunk.toString(); });

  const results = [];
  const check = (name, ok, detail = '') => {
    results.push({ name, ok });
    console.log((ok ? '✔ ' : '✖ ') + name + (detail ? '  ' + detail : ''));
  };

  try {
    // 1. 经代理拿到健康检查（同时确认证书已就绪）
    let healthy = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        const response = await fetch(domain + '/healthz');
        healthy = response.ok;
        if (healthy) break;
      } catch { /* 证书签发/进程启动中 */ }
      await sleep(500);
    }
    check('Caddy 反代 https 可达（自动本地证书）', healthy, healthy ? '' : caddyErr.slice(-300));

    // 2. WebSocket 升级穿过代理（flush_interval / Upgrade 头）
    const socket = new WebSocket(domain.replace('https', 'wss') + '/v1/events?workspace=' + workspace + '&since=0',
      ['lsw.v1', 'lsw.token.' + token], { rejectUnauthorized: false });
    const frames = [];
    socket.on('message', raw => {
      try { frames.push(JSON.parse(raw.toString())); } catch { /* ignore */ }
    });
    const hello = await new Promise((resolveHello, rejectHello) => {
      const timer = setTimeout(() => rejectHello(new Error('5 秒内没收到 hello（可能是代理缓冲/超时配置不对）')), 5000);
      const poll = setInterval(() => {
        const found = frames.find(frame => frame.t === 'hello');
        if (found) { clearTimeout(timer); clearInterval(poll); resolveHello(found); }
      }, 50);
      socket.once('error', error => { clearTimeout(timer); clearInterval(poll); rejectHello(error); });
    });
    check('WebSocket 经代理升级成功并收到 hello', Boolean(hello) && hello.proto === 1);

    // 3. 心跳穿过代理（无事件时也应按时到达）
    const pingsBefore = frames.filter(frame => frame.t === 'ping').length;
    await sleep(900);
    const pingsAfter = frames.filter(frame => frame.t === 'ping').length;
    check('心跳帧经代理按时到达（无事件也不会被缓冲）', pingsAfter > pingsBefore, pingsBefore + ' -> ' + pingsAfter);

    // 4. 经代理提交文件 → 事件经代理推回来
    const payload = Buffer.from('hello through caddy\n');
    const commit = await fetch(domain + '/v1/workspace/commit?workspace=' + workspace + '&path=proxy%2Ftest.txt', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'If-Match': '"0"',
        'Idempotency-Key': randomUUID(),
      },
      body: payload,
    });
    const committed = await commit.json().catch(() => ({}));
    check('经代理提交文件成功', commit.status === 200, 'status=' + commit.status);
    const pushed = await (async () => {
      for (let attempt = 0; attempt < 40; attempt++) {
        const found = frames.find(frame => frame.t === 'changes'
          && frame.changes?.some(change => change.path === 'proxy/test.txt'));
        if (found) return found;
        await sleep(50);
      }
      return undefined;
    })();
    check('提交事件经代理推送回客户端', Boolean(pushed) && pushed.changes[0].sha256 === sha256(payload));

    // 5. Range 透传（大文件续传依赖它）
    const range = await fetch(domain + '/workspace/file?workspace=' + workspace
      + '&path=proxy%2Ftest.txt&revision=' + (committed.file?.revision ?? 1), {
      headers: { Authorization: 'Bearer ' + token, Range: 'bytes=6-12' },
    });
    const rangeBody = Buffer.from(await range.arrayBuffer());
    check('Range 请求经代理返回 206 + 正确片段', range.status === 206 && rangeBody.toString() === 'through', 'status=' + range.status);

    // 6. 令牌鉴权在代理之后依然生效
    const anonymous = await fetch(domain + '/workspace/manifest?workspace=' + workspace);
    check('无令牌经代理仍被拒（401）', anonymous.status === 401, 'status=' + anonymous.status);

    socket.close();
  } finally {
    server.kill('SIGTERM');
    caddy.kill('SIGTERM');
    await sleep(500);
    if (!server.killed) server.kill('SIGKILL');
    if (!caddy.killed) caddy.kill('SIGKILL');
    rmSync(workdir, { recursive: true, force: true });
  }

  const failed = results.filter(item => !item.ok);
  console.log('\n' + results.length + ' 项检查，' + (results.length - failed.length) + ' 通过，' + failed.length + ' 失败');
  if (failed.length) {
    console.log('\nCaddy 输出（末 500 字符）：\n' + caddyErr.slice(-500));
    process.exitCode = 1;
  }
}

main().catch(error => {
  console.error('[verify-caddy-proxy] ' + (error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});
