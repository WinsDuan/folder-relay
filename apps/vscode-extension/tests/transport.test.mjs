/**
 * Folder Relay 0.3 线路层的纯逻辑测试。
 *
 * 全部断言针对 `apps/vscode-extension/src/transport.ts` 导出的纯函数（退避、看门狗、
 * 缺口判定、分片 offset、Range 组装、幂等键、帧解析），因此不需要启动 VS Code，
 * 也不需要真实网络。最后一组用注入的假 fetch/拨号器验证通道接线（仍然无网络）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  backoffDelay,
  classifyChanges,
  contiguousPrefix,
  createDialer,
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_STABILITY_POLICY,
  decodeFrame,
  EventChannel,
  failureCount,
  fallbackPollMs,
  handshakeRejected,
  idempotencyKey,
  isLoopbackEndpoint,
  isRemoteChange,
  isUnhealthy,
  LOOPBACK_POLL_MS,
  MAX_BACKOFF_MS,
  mergeReceived,
  nextChunk,
  normalizeChunkBytes,
  parseCapabilities,
  parseChangesPage,
  parseContentRange,
  pickUploadOffset,
  planRangeResponse,
  rangeHeader,
  recordFailure,
  reconnectDelay,
  REMOTE_POLL_MS,
  resolveMode,
  restartBackoffDelay,
  resumeOffsetFromReceived,
  uploadSessionKey,
  watchdogExpired,
  watchdogIntervalMs,
} from '../src/transport.ts';

const change = (seq, extra = {}) => ({
  seq,
  path: 'main.tex',
  revision: seq,
  sha256: 'a'.repeat(64),
  size: 10,
  deleted: false,
  ...extra,
});

/* ── §6.2 抖动退避：可复现序列 ───────────────────────────────────────────── */

test('backoff follows min(30s, 500ms × 1.8^n) with jitter bounds', () => {
  const upper = [0, 1, 2, 3, 4, 5, 6, 7, 8].map(attempt => backoffDelay(attempt, () => 1));
  assert.deepEqual(upper, [500, 900, 1620, 2916, 5249, 9448, 17006, 30000, 30000]);
  const lower = [0, 1, 2, 3, 4].map(attempt => backoffDelay(attempt, () => 0));
  assert.deepEqual(lower, [250, 450, 810, 1458, 2624]);
  // 抖动区间永远落在 base×1.8^n 的 [0.5, 1.0] 内，且封顶 30s。
  for (let attempt = 0; attempt < 12; attempt++) {
    const ceiling = Math.min(MAX_BACKOFF_MS, 500 * Math.pow(1.8, attempt));
    for (const random of [0, 0.25, 0.5, 0.75, 1]) {
      const delay = backoffDelay(attempt, () => random);
      assert.ok(delay >= Math.round(ceiling * 0.5) - 1, `attempt=${attempt} random=${random} delay=${delay}`);
      assert.ok(delay <= Math.round(ceiling) + 1, `attempt=${attempt} random=${random} delay=${delay}`);
      assert.ok(delay <= MAX_BACKOFF_MS);
    }
  }
});

test('backoff survives hostile inputs from timers and random sources', () => {
  assert.equal(backoffDelay(-5, () => 1), 500);
  assert.equal(backoffDelay(Number.NaN, () => 1), 500);
  assert.equal(backoffDelay(Number.POSITIVE_INFINITY, () => 1), MAX_BACKOFF_MS);
  assert.equal(backoffDelay(1_000_000, () => 1), MAX_BACKOFF_MS);
  assert.equal(backoffDelay(0, () => Number.NaN), 375);
  assert.equal(backoffDelay(0, () => { throw new Error('random died'); }), 375);
  assert.equal(backoffDelay(0, () => 42), 500);
});

test('service restart (1012) restarts the backoff from 1s', () => {
  assert.deepEqual([0, 1, 2].map(attempt => restartBackoffDelay(attempt, () => 1)), [1000, 1800, 3240]);
  assert.deepEqual([0, 1].map(attempt => restartBackoffDelay(attempt, () => 0)), [500, 900]);
});

/* ── §6.1 心跳看门狗 ───────────────────────────────────────────────────── */

test('watchdog declares death strictly after 2.5 × heartbeatMs of silence', () => {
  const heartbeatMs = 15_000;
  assert.equal(watchdogExpired(1_000, 1_000 + 37_500, heartbeatMs), false); // 恰好 2.5× 仍算活
  assert.equal(watchdogExpired(1_000, 1_000 + 37_501, heartbeatMs), true);
  assert.equal(watchdogExpired(1_000, 1_000 + 12_000, heartbeatMs), false);
  // 时钟回拨不应误判为死亡。
  assert.equal(watchdogExpired(10_000, 5_000, heartbeatMs), false);
  // heartbeat 缺失时用协议默认值（25 s → 62.5 s），而不是 NaN（NaN 比较恒 false 会导致永不重连）。
  assert.equal(watchdogExpired(0, 62_501, Number.NaN), true);
});

test('watchdog polling period stays between 250ms and 5s', () => {
  assert.equal(watchdogIntervalMs(15_000), 5_000);
  assert.equal(watchdogIntervalMs(1_000), 500);
  assert.equal(watchdogIntervalMs(200), 250);
  assert.equal(watchdogIntervalMs(Number.NaN), 5_000);
});

test('协议默认心跳是 25s（2.5× 判死 ≈ 62.5s）', () => {
  assert.equal(DEFAULT_HEARTBEAT_MS, 25_000);
  assert.equal(parseCapabilities({ proto: 1 }).heartbeatMs, 25_000);
  assert.equal(watchdogExpired(0, 62_500, DEFAULT_HEARTBEAT_MS), false);
  assert.equal(watchdogExpired(0, 62_501, DEFAULT_HEARTBEAT_MS), true);
});

/* ── §6.1 双路判死：错误计数窗口 ───────────────────────────────────────── */

test('error-count window declares death before the silence timer would', () => {
  const windowMs = 60_000;
  const threshold = 5;
  let events = [];
  // 4 次失败仍在容忍范围（服务端 GC 抖动不该引发重连风暴）。
  for (const at of [1_000, 2_000, 3_000, 4_000]) events = recordFailure(events, at, windowMs);
  assert.equal(failureCount(events, 5_000, windowMs), 4);
  assert.equal(isUnhealthy(events, 5_000, windowMs, threshold), false);
  // 第 5 次触发判死。
  events = recordFailure(events, 5_000, windowMs);
  assert.equal(isUnhealthy(events, 5_000, windowMs, threshold), true);
  // 32.5 s 内 5 次：远早于 62.5 s 的静默判据。
  assert.ok(5_000 < 2.5 * DEFAULT_HEARTBEAT_MS);
});

test('failures older than the window are pruned instead of accumulating forever', () => {
  const windowMs = 60_000;
  let events = [];
  for (const at of [0, 1_000, 2_000, 3_000, 4_000]) events = recordFailure(events, at, windowMs);
  assert.equal(isUnhealthy(events, 4_000, windowMs, 5), true);
  // 最近一次失败（4 s）在窗口内到 64 s：61 s 时仍有 4 条（0 s 那条已出窗口），不判死。
  assert.equal(failureCount(events, 61_000, windowMs), 4);
  assert.equal(isUnhealthy(events, 61_000, windowMs, 5), false);
  // 70 s：全部出窗口 → 计数归零，不会永远"脏"下去。
  assert.equal(failureCount(events, 70_000, windowMs), 0);
  assert.equal(isUnhealthy(events, 70_000, windowMs, 5), false);
  const pruned = recordFailure(events, 70_000, windowMs);
  assert.deepEqual(pruned, [70_000]);
  assert.equal(failureCount(pruned, 70_001, windowMs), 1);
  assert.equal(isUnhealthy([], 0, windowMs, 5), false);
  // 阈值缺失时用协议默认值 5。
  assert.equal(isUnhealthy(events, 4_000, windowMs, Number.NaN), true);
});

/* ── §6.2 冷却：≥5 次连续失败后固定 30 s、无抖动 ─────────────────────────── */

test('cooldown replaces jittered backoff after repeated failures', () => {
  assert.equal(DEFAULT_STABILITY_POLICY.cooldownAfterFailures, 5);
  assert.equal(DEFAULT_STABILITY_POLICY.cooldownMs, 30_000);
  // 还没到冷却阈值：照常抖动退避（attempt 归零过，所以只有 500 ms 档）。
  for (const random of [0, 0.5, 1]) {
    const delay = reconnectDelay({ attempt: 0, failures: 4, random: () => random });
    assert.ok(delay >= 250 && delay <= 500, `delay=${delay}`);
  }
  // 到阈值：固定 30 s，且随机源完全不参与（与抖动无关）。
  for (const random of [0, 0.25, 0.5, 1]) {
    assert.equal(reconnectDelay({ attempt: 0, failures: 5, random: () => random }), 30_000);
    assert.equal(reconnectDelay({ attempt: 9, failures: 12, random: () => random }), 30_000);
  }
  // 自定义策略（服务端 /v1/config 下发的值）同样生效。
  const policy = { ...DEFAULT_STABILITY_POLICY, cooldownAfterFailures: 2, cooldownMs: 7_000 };
  assert.equal(reconnectDelay({ attempt: 0, failures: 2, random: () => 0, policy }), 7_000);
  assert.equal(reconnectDelay({ attempt: 0, failures: 1, random: () => 1, policy }), 500);
  // 冷却不改变 1012 重启路径的短退避（failure 未到阈值时仍是 1 s 起）。
  assert.equal(reconnectDelay({ attempt: 0, failures: 0, random: () => 1, base: 1_000 }), 1_000);
});

/* ── §3.1 seq 缺口判定 ─────────────────────────────────────────────────── */

test('contiguous changes are applied, duplicates are dropped', () => {
  const verdict = classifyChanges(10, {
    head: 12,
    floor: 1,
    reset: false,
    changes: [change(12), change(11), change(10)],
  });
  assert.equal(verdict.kind, 'apply');
  assert.deepEqual(verdict.changes.map(row => row.seq), [11, 12]);
});

test('a seq gap forces a full resync instead of a partial apply', () => {
  assert.deepEqual(classifyChanges(10, { head: 13, floor: 1, reset: false, changes: [change(11), change(13)] }), {
    kind: 'reset',
    head: 13,
    reason: 'gap',
  });
});

test('a trimmed log (since < floor) forces a full resync', () => {
  assert.deepEqual(classifyChanges(3, { head: 40, floor: 8, reset: false, changes: [change(8), change(9)] }), {
    kind: 'reset',
    head: 40,
    reason: 'floor',
  });
  // since+1 === floor 仍然可以续传（最后一个保留的事件可用）。
  assert.equal(classifyChanges(7, { head: 9, floor: 8, reset: false, changes: [change(8), change(9)] }).kind, 'apply');
});

test('explicit reset flag and malformed payloads force a full resync', () => {
  assert.deepEqual(classifyChanges(5, { head: 9, floor: 1, reset: true, changes: [] }), {
    kind: 'reset',
    head: 9,
    reason: 'flagged',
  });
  assert.equal(classifyChanges(5, { head: 9, floor: 1, reset: false, changes: [{ seq: 6 }] }).reason, 'malformed');
  assert.equal(classifyChanges(5, { head: 9, floor: 1, reset: false, changes: 'nope' }).reason, 'malformed');
});

test('an empty long-poll timeout is not a gap', () => {
  assert.deepEqual(classifyChanges(42, { head: 42, floor: 1, reset: false, changes: [] }), { kind: 'ignore' });
  // 水位之后只剩重复事件 → 同样无需全量重建。
  assert.deepEqual(classifyChanges(42, { head: 42, floor: 1, reset: false, changes: [change(42)] }), { kind: 'ignore' });
});

/* ── §3.1 / §6 事件与帧解析 ────────────────────────────────────────────── */

test('change rows require a self-consistent sha256/size pair', () => {
  assert.equal(isRemoteChange(change(1)), true);
  assert.equal(isRemoteChange({ ...change(1), sha256: null, size: 0, deleted: true }), true);
  assert.equal(isRemoteChange({ ...change(1), sha256: null, size: 12, deleted: true }), false);
  assert.equal(isRemoteChange({ ...change(1), sha256: 'XYZ' }), false);
  assert.equal(isRemoteChange({ ...change(1), seq: -1 }), false);
  assert.equal(isRemoteChange({ ...change(1), path: '' }), false);
  assert.equal(isRemoteChange(null), false);
});

test('changes page parsing rejects shapes the client cannot trust', () => {
  const page = parseChangesPage({ workspace: 'w', head: 7, floor: 2, reset: false, changes: [change(3)] });
  assert.deepEqual(page, { head: 7, floor: 2, reset: false, changes: [change(3)] });
  assert.equal(parseChangesPage({ head: 7, changes: [change(3)] }).floor, 0);
  assert.equal(parseChangesPage({ head: 'x' }), undefined);
  assert.equal(parseChangesPage({ head: 7, changes: [{ seq: 8 }] }), undefined);
  assert.equal(parseChangesPage(undefined), undefined);
});

test('server frames decode to typed events and unknown frames stay observable', () => {
  assert.deepEqual(decodeFrame('{"t":"hello","seq":9,"heartbeatMs":15000,"proto":1}'), {
    t: 'hello',
    seq: 9,
    heartbeatMs: 15000,
    proto: 1,
    resumeWindow: undefined,
  });
  assert.deepEqual(decodeFrame('{"t":"ping","seq":9}'), { t: 'ping', seq: 9 });
  assert.deepEqual(decodeFrame('{"t":"reset","head":3,"reason":"restart"}'), { t: 'reset', head: 3, reason: 'restart' });
  assert.deepEqual(decodeFrame('{"t":"changes","head":2,"changes":[{"seq":2}]}'), { t: 'changes', head: 2, changes: [{ seq: 2 }] });
  assert.deepEqual(decodeFrame('{"t":"future-frame"}'), { t: 'unknown', type: 'future-frame' });
  assert.equal(decodeFrame('not json'), undefined);
  assert.equal(decodeFrame('null'), undefined);
});

/* ── §2 能力协商与降级选择 ─────────────────────────────────────────────── */

test('capabilities parsing keeps the documented defaults', () => {
  const caps = parseCapabilities({
    proto: 1,
    features: ['ws', 'longpoll', 'chunked-upload', 'range'],
    heartbeatMs: 25000,
    chunkBytes: 524288,
    maxFileBytes: 16777216,
    maxPaths: 4096,
    maxChunkConcurrency: 3,
    partRetry: 3,
    cooldownAfterFailures: 5,
    cooldownMs: 30000,
    unhealthyAfterErrors: 5,
    errorWindowMs: 60000,
    pollFallbackMs: 3000,
  });
  assert.equal(caps.proto, 1);
  assert.equal(caps.heartbeatMs, 25000);
  assert.equal(caps.chunkBytes, 524288);
  assert.equal(caps.features.has('chunked-upload'), true);
  assert.equal(parseCapabilities({ proto: 0 }), undefined);
  assert.equal(parseCapabilities(null), undefined);
  // 缺字段时回落到协议默认值，而不是 NaN。
  const sparse = parseCapabilities({ proto: 1 });
  assert.equal(sparse.heartbeatMs, 25_000);
  assert.equal(sparse.chunkBytes, 524288);
  assert.equal(sparse.pollFallbackMs, 3000);
  assert.equal(sparse.features.size, 0);
  assert.equal(sparse.maxChunkConcurrency, 3);
  assert.equal(sparse.partRetry, 3);
  assert.equal(sparse.cooldownAfterFailures, 5);
  assert.equal(sparse.cooldownMs, 30_000);
  assert.equal(sparse.unhealthyAfterErrors, 5);
  assert.equal(sparse.errorWindowMs, 60_000);
  // 离谱值被夹紧，不会让客户端按 0 并发或 0 毫秒冷却空转。
  const hostile = parseCapabilities({
    proto: 1, maxChunkConcurrency: 0, partRetry: 0, cooldownMs: 0, cooldownAfterFailures: 0, errorWindowMs: 1,
  });
  assert.equal(hostile.maxChunkConcurrency, 3);
  assert.equal(hostile.partRetry, 3);
  assert.equal(hostile.cooldownMs, 30_000);
  assert.equal(hostile.cooldownAfterFailures, 5);
  assert.equal(hostile.errorWindowMs, 60_000);
  // 合法但偏小的值原样采用（服务端有调参权）。
  assert.equal(parseCapabilities({ proto: 1, errorWindowMs: 1_000 }).errorWindowMs, 1_000);
  assert.equal(parseCapabilities({ proto: 1, maxChunkConcurrency: 1 }).maxChunkConcurrency, 1);
});

test('transport mode degrades ws → longpoll → timer', () => {
  const caps = features => parseCapabilities({ proto: 1, features });
  assert.equal(resolveMode(undefined, true), 'timer'); // /v1/config 404 = 0.2 服务端
  assert.equal(resolveMode(caps(['ws', 'longpoll']), true), 'ws');
  assert.equal(resolveMode(caps(['ws', 'longpoll']), false), 'longpoll');
  assert.equal(resolveMode(caps(['longpoll']), true), 'longpoll');
  assert.equal(resolveMode(caps([]), true), 'longpoll'); // 未声明也要试一次，404 再降级
});

test('polling fallback keeps the 0.2 cadence for loopback installs', () => {
  assert.equal(fallbackPollMs(true), LOOPBACK_POLL_MS);
  assert.equal(fallbackPollMs(false), REMOTE_POLL_MS);
  assert.equal(LOOPBACK_POLL_MS, 650);
  assert.equal(REMOTE_POLL_MS, 3000);
  assert.equal(isLoopbackEndpoint(new URL('http://127.0.0.1:1234')), true);
  assert.equal(isLoopbackEndpoint(new URL('http://localhost:1234')), true);
  assert.equal(isLoopbackEndpoint(new URL('https://sync.example.com')), false);
});

test('handshake rejection only downgrades on a real 404/501', () => {
  assert.equal(handshakeRejected(new Error('Unexpected server response: 404')), true);
  assert.equal(handshakeRejected(new Error('Unexpected server response: 501')), true);
  assert.equal(handshakeRejected(new Error('Unexpected server response: 401')), false);
  assert.equal(handshakeRejected(new Error('connect ECONNREFUSED 127.0.0.1:1234')), false);
  assert.equal(handshakeRejected('boom'), false);
});

/* ── §5 分片上传 ───────────────────────────────────────────────────────── */

test('chunk planning walks a file by chunkBytes and stops at the end', () => {
  const size = 1_048_576;
  const chunkBytes = 524_288;
  const offsets = [];
  let offset = 0;
  for (let plan = nextChunk(size, chunkBytes, offset); plan; plan = nextChunk(size, chunkBytes, offset)) {
    offsets.push(plan.offset);
    assert.ok(plan.length <= chunkBytes);
    offset += plan.length;
  }
  assert.deepEqual(offsets, [0, 524_288]);
  assert.equal(offset, size);
  assert.equal(nextChunk(size, chunkBytes, size), undefined);
  // 尾片长度必须截断到剩余字节。
  assert.deepEqual(nextChunk(size, chunkBytes, 900_000), { offset: 900_000, length: 148_576 });
  assert.deepEqual(nextChunk(10, 4096, 0), { offset: 0, length: 10 });
});

test('chunk resumes from a server-reported offset instead of restarting', () => {
  // PUT 返回 409 upload-offset-mismatch + {expected}：从 expected 续传。
  assert.deepEqual(nextChunk(1_000, 512, pickUploadOffset([300], 1_000)), { offset: 300, length: 512 });
  // 崩溃后 GET /v1/upload/<id> 的 offset 优先于本地记录。
  assert.equal(pickUploadOffset([640, 512], 1_000), 640);
  // 非法/超界/负数一律跳过，绝不跳字节。
  assert.equal(pickUploadOffset([-1, 2_000, Number.NaN, 'x', 128], 1_000), 128);
  assert.equal(pickUploadOffset([], 1_000), 0);
  assert.equal(pickUploadOffset([0], 0), 0);
  // 归一化：服务端给出离谱的 chunkBytes 时回到 512 KiB。
  assert.equal(normalizeChunkBytes(0), 524_288);
  assert.equal(normalizeChunkBytes('524288'), 524_288);
  assert.equal(normalizeChunkBytes(64 * 1024 * 1024), 8 * 1024 * 1024);
  assert.equal(normalizeChunkBytes(1), 4 * 1024);
});

test('upload session keys are stable per content and base revision', () => {
  const first = uploadSessionKey('w', 'Main.tex', 10, 'a'.repeat(64), 3);
  assert.equal(first, uploadSessionKey('w', 'main.tex', 10, 'a'.repeat(64), 3));
  assert.notEqual(first, uploadSessionKey('w', 'main.tex', 10, 'a'.repeat(64), 4));
  assert.notEqual(first, uploadSessionKey('w', 'main.tex', 11, 'a'.repeat(64), 3));
  assert.match(first, /^[a-f0-9]{64}$/);
});

/* ── §5.1 received 乱序续传点 ──────────────────────────────────────────── */

test('received intervals are merged, clamped and sorted regardless of order', () => {
  assert.deepEqual(mergeReceived([{ offset: 524_288, length: 524_288 }, { offset: 0, length: 524_288 }], 1_048_576), [
    { offset: 0, length: 1_048_576 },
  ]);
  // 重叠合并。
  assert.deepEqual(mergeReceived([{ offset: 0, length: 600_000 }, { offset: 524_288, length: 524_288 }], 1_048_576), [
    { offset: 0, length: 1_048_576 },
  ]);
  // 超出文件大小 → 裁剪。
  assert.deepEqual(mergeReceived([{ offset: 0, length: 9_999_999 }], 1_000), [{ offset: 0, length: 1_000 }]);
  // 非法条目丢弃。
  assert.deepEqual(mergeReceived([{ offset: -1, length: 10 }, { offset: 0, length: 0 }, { offset: 'x', length: 1 }, null, 7], 1_000), []);
  assert.deepEqual(mergeReceived(undefined, 1_000), []);
});

test('resume point prefers received gaps over the offset hint', () => {
  const size = 1_572_864; // 3 × 512 KiB
  const chunk = 524_288;
  // offset 说 0，但 received 表明前两块都在 → 从第三块继续。
  assert.equal(resumeOffsetFromReceived([{ offset: 0, length: chunk }, { offset: chunk, length: chunk }], size, 0), 2 * chunk);
  // 乱序收到块 0 和块 2：缺块 1，续传点必须回落到 524288（而不是 offset 提示的 1.5 MiB）。
  assert.equal(resumeOffsetFromReceived([
    { offset: 2 * chunk, length: chunk },
    { offset: 0, length: chunk },
  ], size, 3 * chunk), chunk);
  // 前半块：从半块处继续，不重传已收字节。
  assert.equal(resumeOffsetFromReceived([{ offset: 0, length: 300_000 }], size, 0), 300_000);
  // 完全没有 received（0.2 风格回包）才用 offset 提示。
  assert.equal(resumeOffsetFromReceived(undefined, size, 1_048_576), 1_048_576);
  assert.equal(resumeOffsetFromReceived([], size, 1_048_576), 1_048_576);
  assert.equal(resumeOffsetFromReceived(undefined, size, undefined), 0);
  // 全部已收：续传点 = size → nextChunk 返回 undefined，直接走 finish。
  const all = [{ offset: 0, length: size }];
  assert.equal(resumeOffsetFromReceived(all, size, 0), size);
  assert.deepEqual(mergeReceived(all, size), [{ offset: 0, length: size }]);
  assert.equal(contiguousPrefix(mergeReceived(all, size)), size);
  assert.equal(nextChunk(size, chunk, resumeOffsetFromReceived(all, size, 0)), undefined);
});

/* ── §4 Range 续传 ─────────────────────────────────────────────────────── */

test('range headers are only sent when resuming an existing prefix', () => {
  assert.equal(rangeHeader(0), undefined);
  assert.equal(rangeHeader(-1), undefined);
  assert.equal(rangeHeader(1024), 'bytes=1024-');
});

test('content-range parsing validates the documented grammar', () => {
  assert.deepEqual(parseContentRange('bytes 1024-2047/2048'), { start: 1024, end: 2047, total: 2048 });
  assert.deepEqual(parseContentRange('bytes 0-0/1'), { start: 0, end: 0, total: 1 });
  assert.equal(parseContentRange('bytes 0-0/0'), undefined); // total 必须 > end
  assert.equal(parseContentRange('bytes */2048'), undefined);
  assert.equal(parseContentRange('items 0-1/2'), undefined);
  assert.equal(parseContentRange('bytes 5-4/9'), undefined);
  assert.equal(parseContentRange(null), undefined);
});

test('range resume writes at the right offset and restarts when ignored', () => {
  const size = 4096;
  // 正常 206 续传。
  assert.deepEqual(planRangeResponse(1024, size, 206, { start: 1024, end: 4095, total: size }), { start: 1024, restart: false });
  // 服务端忽略 Range 直接回 200 → 从 0 覆盖。
  assert.deepEqual(planRangeResponse(1024, size, 200, undefined), { start: 0, restart: true });
  // 206 但起点不符（另一份 blob）→ 从头来。
  assert.deepEqual(planRangeResponse(1024, size, 206, { start: 512, end: 1023, total: size }), { start: 0, restart: true });
  // 文件变长了（size 漂移）→ 从头来，最后仍按整文件 sha256 校验。
  assert.deepEqual(planRangeResponse(1024, size, 206, { start: 1024, end: 8191, total: 8192 }), { start: 0, restart: true });
  // 没有续传需求时永远从 0 写。
  assert.deepEqual(planRangeResponse(0, size, 200, undefined), { start: 0, restart: false });
});

/* ── §4.1 幂等键 ───────────────────────────────────────────────────────── */

test('idempotency keys are deterministic, uuid-shaped and content-specific', () => {
  const key = idempotencyKey('commit', 'workspace', 'main.tex', '7', 'f'.repeat(64));
  assert.match(key, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(key, idempotencyKey('commit', 'workspace', 'main.tex', '7', 'f'.repeat(64)));
  assert.notEqual(key, idempotencyKey('commit', 'workspace', 'main.tex', '8', 'f'.repeat(64)));
  assert.notEqual(key, idempotencyKey('commit', 'workspace', 'other.tex', '7', 'f'.repeat(64)));
  // 分隔符参与哈希：拼接歧义不能产生同一个 key。
  assert.notEqual(idempotencyKey('ab', 'c'), idempotencyKey('a', 'bc'));
});

/* ── 通道接线（注入假 fetch/拨号器，无网络） ────────────────────────────── */

function configResponse(features = ['ws', 'longpoll']) {
  return new Response(JSON.stringify({
    proto: 1, workspace: null, features, heartbeatMs: 15000, maxFileBytes: 16777216,
    maxPaths: 4096, chunkBytes: 524288, pollFallbackMs: 3000,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function fakeSocket() {
  const listeners = { message: [], close: [], error: [] };
  return {
    sent: [],
    closed: [],
    send(text) {
      this.sent.push(JSON.parse(text));
    },
    close(code, reason) {
      this.closed.push([code, reason]);
    },
    onMessage(handler) {
      listeners.message.push(handler);
    },
    onClose(handler) {
      listeners.close.push(handler);
    },
    onError(handler) {
      listeners.error.push(handler);
    },
    push(text) {
      for (const handler of listeners.message) handler(text);
    },
    drop(code = 1006) {
      for (const handler of listeners.close) handler(code, '');
    },
  };
}

test('channel emits hello/changes and acks only what the caller confirmed', async () => {
  const socket = fakeSocket();
  const events = [];
  const states = [];
  const seqs = [];
  const channel = new EventChannel({
    endpoint: new URL('http://127.0.0.1:1234'),
    workspaceId: 'w',
    token: 'x'.repeat(32),
    lastSeq: 4,
    fetchImpl: async url => {
      assert.match(String(url), /\/v1\/config$/);
      return configResponse();
    },
    dial: async () => socket,
    now: () => 0,
    random: () => 0.5,
    onChanges: (seq, changes) => events.push([seq, changes.map(row => row.seq)]),
    onReset: head => events.push(['reset', head]),
    onState: state => states.push(state),
    onSeq: seq => seqs.push(seq),
  });
  channel.start();
  // 等到拨号完成（loop 是异步的）。
  for (let i = 0; i < 20 && !states.includes('online'); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(channel.mode(), 'ws');
  assert.equal(states.includes('online'), false, 'hello 之前不应宣布 online');

  socket.push('{"t":"hello","seq":5,"heartbeatMs":15000,"proto":1}');
  assert.equal(states.includes('online'), true);
  socket.push('{"t":"ping","seq":5}');
  assert.deepEqual(socket.sent.at(-1), { t: 'pong', seq: 5 });

  socket.push(JSON.stringify({ t: 'changes', head: 6, changes: [change(5), change(6, { path: 'b.tex' })] }));
  assert.deepEqual(events, [[6, [5, 6]]]);
  assert.equal(channel.seq(), 4, '交付不等于确认：水位仍停在 4');

  channel.confirm(6);
  assert.equal(channel.seq(), 6);
  assert.deepEqual(seqs, [6]);
  assert.deepEqual(socket.sent.at(-1), { t: 'ack', seq: 6 });

  // 缺口：seq 8 之前缺 7 → 请求全量重置而不是半套应用。
  socket.push(JSON.stringify({ t: 'changes', head: 8, changes: [change(8)] }));
  assert.deepEqual(events.at(-1), ['reset', 8]);

  channel.stop();
  // 收尾关闭走正常码（1000），不会把「用户主动停止」误报成异常断开。
  assert.ok(socket.closed.length >= 1);
  assert.deepEqual(socket.closed[0], [1000, 'reconnect']);
  assert.ok(socket.closed.every(([code]) => code === 1000));
});

test('channel degrades to 0.2 polling when /v1/config is missing', async () => {
  const states = [];
  const channel = new EventChannel({
    endpoint: new URL('http://127.0.0.1:1234'),
    workspaceId: 'w',
    token: 'x'.repeat(32),
    fetchImpl: async () => new Response('{"error":"not-found"}', { status: 404 }),
    dial: async () => {
      throw new Error('不应尝试拨号');
    },
    onChanges: () => {},
    onReset: () => {},
    onState: (state, detail) => states.push([state, detail]),
    onSeq: () => {},
  });
  channel.start();
  for (let i = 0; i < 20 && !states.length; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(channel.mode(), 'timer');
  assert.equal(channel.isPushing(), false);
  assert.equal(states[0][0], 'degraded');
  assert.match(states[0][1], /0\.2/);
  channel.stop();
});

test('默认拨号器在没有 ws 可连时给出可重试的错误', async () => {
  const dial = createDialer('x'.repeat(32), 50);
  await assert.rejects(
    () => dial('ws://127.0.0.1:1/v1/events', { Authorization: 'Bearer x' }, ['lsw.v1']),
    error => error instanceof Error && /connect|ECONNREFUSED|握手|socket/i.test(error.message),
  );
});
