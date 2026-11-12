/**
 * Folder Relay 远程协议 v1 的线路层（`docs/remote-protocol.md` §2/§3/§5/§6）。
 *
 * 职责边界：
 * - `ProjectSync` 仍然拥有全部**正确性**判断（sha256 + revision 双校验、3-way 合并、
 *   冲突副本、intent 崩溃恢复）。本文件只负责「多久发现变化」与「字节怎么搬」。
 * - 这里只做：能力探测、推送订阅、序号续传、心跳看门狗、抖动退避、分片/区间搬运的
 *   纯计算。降级与升级只改变延迟，不改变校验强度。
 *
 * 设计约束（便于 `tests/transport.test.mjs` 直接 import 而不需要真实 VS Code）：
 * - 不 import 任何本地模块（只有 `node:*` 与 `ws`），所以 Node 的类型剥离加载器可以直接跑。
 * - 时钟、随机源、fetch、WebSocket 拨号器全部可注入，退避序列与看门狗判定可复现断言。
 */

import { createHash } from 'node:crypto';
import WebSocket from 'ws';

/* ─────────────────────────── 协议常量 ─────────────────────────── */

/** 默认心跳间隔为 25 s。 */
export const DEFAULT_HEARTBEAT_MS = 25_000;
/** §6.1 静默超过 2.5 × heartbeatMs 视为连接死亡。 */
export const HEARTBEAT_SILENCE_FACTOR = 2.5;
/** §6.2 基础退避：500 ms × 1.8^n。 */
export const BASE_BACKOFF_MS = 500;
/** §7 收到 1012（服务端重启）用 1 s 起的短退避。 */
export const RESTART_BACKOFF_MS = 1_000;
export const BACKOFF_FACTOR = 1.8;
export const MAX_BACKOFF_MS = 30_000;
/** 退避指数上限，防止 `NaN`/巨数值污染。 */
export const MAX_BACKOFF_ATTEMPT = 48;
/** §6.4 定时间隔轮询：loopback 650 ms，远程 3000 ms。 */
export const LOOPBACK_POLL_MS = 650;
export const REMOTE_POLL_MS = 3_000;
/** 推送可用时的兜底全量对齐间隔（推送只是「更快发现」，仍要周期性自证）。 */
export const SAFETY_POLL_MS = 30_000;
/** §3.1 长轮询挂起上限 25000 ms（服务端上限 30000）。 */
export const LONG_POLL_WAIT_MS = 25_000;
export const MAX_LONG_POLL_WAIT_MS = 30_000;
/** 401/403 后不要打爆服务端：退避到重探。 */
export const LEGACY_REPROBE_MS = 30_000;
/** 增量应用遇到 Retry 时的本地重排延迟。 */
export const PENDING_RETRY_MS = 600;
/** 能力探测超时。 */
export const CHANNEL_PROBE_TIMEOUT_MS = 5_000;

/** §5 分片：默认 512 KiB，> 256 KiB 才走分片。 */
export const DEFAULT_CHUNK_BYTES = 512 * 1024;
export const MIN_CHUNK_BYTES = 4 * 1024;
export const MAX_CHUNK_BYTES = 8 * 1024 * 1024;
export const CHUNKED_UPLOAD_THRESHOLD = 256 * 1024;
/** 分片上传默认并发数与单块重试次数。 */
export const DEFAULT_MAX_CHUNK_CONCURRENCY = 3;
export const DEFAULT_PART_RETRY = 3;
/** 连续失败达到阈值时固定冷却 30 s。 */
export const DEFAULT_COOLDOWN_AFTER_FAILURES = 5;
export const DEFAULT_COOLDOWN_MS = 30_000;
/** 60 s 内出现至少 5 次网络或解析错误时重新连接。 */
export const DEFAULT_UNHEALTHY_AFTER_ERRORS = 5;
export const DEFAULT_ERROR_WINDOW_MS = 60_000;
/** §4 大文件下载用 Range 续传的起点。 */
export const RANGE_RESUME_THRESHOLD = 256 * 1024;
/** §7 service restart 关闭码。 */
export const RESTART_CLOSE_CODE = 1012;
/** WS 主动重连时使用的关闭码。 */
export const CLIENT_RECONNECT_CODE = 1000;

/* ─────────────────────────── 类型 ─────────────────────────── */

/** 一条工作区事件（§3.1 `changes[]` / §6 `changes` 帧）。 */
export interface RemoteChange {
  seq: number;
  path: string;
  revision: number;
  sha256: string | null;
  size: number;
  deleted: boolean;
}

/** §3.1 响应体。 */
export interface ChangesPage {
  head: number;
  floor: number;
  reset: boolean;
  changes: RemoteChange[];
}

/** §2 能力协商结果（只保留本客户端用得到的字段）。 */
export interface Capabilities {
  proto: number;
  features: ReadonlySet<string>;
  heartbeatMs: number;
  chunkBytes: number;
  maxFileBytes: number;
  maxPaths: number;
  pollFallbackMs: number;
  maxChunkConcurrency: number;
  partRetry: number;
  cooldownAfterFailures: number;
  cooldownMs: number;
  unhealthyAfterErrors: number;
  errorWindowMs: number;
}

/** §6.1/§6.2 稳定性策略：全部来自 `/v1/config`，缺省值与协议一致。 */
export interface StabilityPolicy {
  cooldownAfterFailures: number;
  cooldownMs: number;
  unhealthyAfterErrors: number;
  errorWindowMs: number;
}

export const DEFAULT_STABILITY_POLICY: StabilityPolicy = {
  cooldownAfterFailures: DEFAULT_COOLDOWN_AFTER_FAILURES,
  cooldownMs: DEFAULT_COOLDOWN_MS,
  unhealthyAfterErrors: DEFAULT_UNHEALTHY_AFTER_ERRORS,
  errorWindowMs: DEFAULT_ERROR_WINDOW_MS,
};

/** §6 链路状态。 */
export type LinkState = 'online' | 'degraded' | 'offline';
/** 当前采用的发现机制。 */
export type ChannelMode = 'ws' | 'longpoll' | 'timer';

/** §6 服务端帧。 */
export type ServerFrame =
  | { t: 'hello'; seq: number; heartbeatMs?: number; proto?: number; resumeWindow?: number }
  | { t: 'changes'; head: number; changes: unknown[] }
  | { t: 'reset'; head: number; reason?: string }
  | { t: 'ping'; seq: number }
  | { t: 'unknown'; type: string };

/** 抽象 WebSocket，便于注入假连接。 */
export interface SocketLike {
  send(text: string): void;
  close(code?: number, reason?: string): void;
  onMessage(handler: (text: string) => void): void;
  onClose(handler: (code: number, reason: string) => void): void;
  onError(handler: (error: unknown) => void): void;
}

/** 拨号器：解析后代表「握手已完成」。 */
export type SocketDialer = (url: string, headers: Record<string, string>, protocols: string[]) => Promise<SocketLike>;

/* ─────────────────────────── 错误分类 ─────────────────────────── */

export class TransportError extends Error {}

/** 可重试（网络抖动/5xx/超时）。 */
export class TransportOffline extends TransportError {}

/** 不可重试（令牌无效等），但仍保持通道存活以便用户修好后自愈。 */
export class TransportFatal extends TransportError {}

/** 服务端没有这个接口（404/501）→ 降级。 */
export class TransportGone extends TransportError {}

/* ─────────────────────────── 纯函数：退避与看门狗 ─────────────────────────── */

function clampRandom(random: () => number): number {
  let value: number;
  try {
    value = random();
  } catch {
    return 0.5;
  }
  if (!Number.isFinite(value)) return 0.5;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * §6.2：`delay = min(30s, base × 1.8^n) × (0.5 + random() × 0.5)`。
 * `attempt` 从 0 开始，收到 `hello` 后由调用方复位为 0。
 */
export function backoffDelay(attempt: number, random: () => number, base: number = BASE_BACKOFF_MS): number {
  const raw = typeof attempt === 'number' ? attempt : Number(attempt);
  // NaN/负数视为第 0 次（尽快重试），+∞ 视为上限（最慢，绝不空转打爆服务端）。
  const step = Number.isNaN(raw) ? 0
    : raw <= 0 ? 0
      : raw >= MAX_BACKOFF_ATTEMPT ? MAX_BACKOFF_ATTEMPT
        : Math.trunc(raw);
  const floor = Number.isFinite(base) && base > 0 ? base : BASE_BACKOFF_MS;
  const ceiling = Math.min(MAX_BACKOFF_MS, floor * Math.pow(BACKOFF_FACTOR, step));
  const jitter = 0.5 + clampRandom(random) * 0.5;
  return Math.round(ceiling * jitter);
}

/** §7：1012 之后的短退避（1 s 起）。 */
export function restartBackoffDelay(attempt: number, random: () => number): number {
  return backoffDelay(attempt, random, RESTART_BACKOFF_MS);
}

/** §6.1：静默超过 2.5 × heartbeatMs 判死（恰好等于阈值时仍算活）。 */
export function watchdogExpired(lastSeen: number, now: number, heartbeatMs: number): boolean {
  const window = Number.isFinite(heartbeatMs) && heartbeatMs > 0 ? heartbeatMs : DEFAULT_HEARTBEAT_MS;
  return now - lastSeen > HEARTBEAT_SILENCE_FACTOR * window;
}

/** 看门狗定时器周期：心跳的一半，夹在 250 ms..5 s 之间。 */
export function watchdogIntervalMs(heartbeatMs: number): number {
  const window = Number.isFinite(heartbeatMs) && heartbeatMs > 0 ? heartbeatMs : DEFAULT_HEARTBEAT_MS;
  return Math.max(250, Math.min(5_000, Math.floor(window / 2)));
}

/* ─────────────────── 纯函数：错误计数窗口与冷却（§6.1/§6.2） ─────────────────── */

function windowMsOf(value: unknown): number {
  const ms = Number(value);
  return Number.isSafeInteger(ms) && ms > 0 ? ms : DEFAULT_ERROR_WINDOW_MS;
}

/** 记录一次失败并裁掉窗口外的记录（返回新数组，便于测试与无副作用调用）。 */
export function recordFailure(events: readonly number[], now: number, windowMs: number): number[] {
  const limit = windowMsOf(windowMs);
  const kept = events.filter(at => Number.isFinite(at) && now - at <= limit);
  kept.push(now);
  return kept.sort((a, b) => a - b);
}

/** 窗口内失败次数。 */
export function failureCount(events: readonly number[], now: number, windowMs: number): number {
  const limit = windowMsOf(windowMs);
  return events.filter(at => Number.isFinite(at) && now - at <= limit).length;
}

/**
 * §6.1 错误计数判死：`errorWindowMs` 内 ≥ `unhealthyAfterErrors` 次网络/解析失败。
 * 与静默判据并行——单靠静默会把服务端 GC 抖动误判成断线。
 */
export function isUnhealthy(
  events: readonly number[], now: number, windowMs: number, threshold: number,
): boolean {
  const limit = Number.isSafeInteger(threshold) && threshold > 0 ? threshold : DEFAULT_UNHEALTHY_AFTER_ERRORS;
  return failureCount(events, now, windowMs) >= limit;
}

export interface ReconnectTiming {
  /** 第几次尝试（hello 后复位为 0）。 */
  attempt: number;
  /** 连续失败次数（成功一次即清零）。 */
  failures: number;
  random: () => number;
  base?: number;
  policy?: StabilityPolicy;
}

/**
 * §6.2 重连间隔：
 * - 连续失败 < `cooldownAfterFailures`：`min(30s, base × 1.8^n) × (0.5 + random × 0.5)`；
 * - 连续失败 ≥ `cooldownAfterFailures`：固定 `cooldownMs`，**不加抖动**（冷却期防群体敲服务端）。
 */
export function reconnectDelay(timing: ReconnectTiming): number {
  const policy = timing.policy ?? DEFAULT_STABILITY_POLICY;
  const failures = Number.isFinite(timing.failures) ? Math.max(0, Math.trunc(timing.failures)) : 0;
  if (policy.cooldownAfterFailures > 0 && failures >= policy.cooldownAfterFailures) {
    return Math.round(policy.cooldownMs);
  }
  return backoffDelay(timing.attempt, timing.random, timing.base ?? BASE_BACKOFF_MS);
}

/* ─────────────────────────── 纯函数：容量与模式 ─────────────────────────── */

export function isLoopbackEndpoint(endpoint: URL): boolean {
  const host = endpoint.hostname.toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

/** §6.4：降级后的定时间隔。 */
export function fallbackPollMs(loopback: boolean): number {
  return loopback ? LOOPBACK_POLL_MS : REMOTE_POLL_MS;
}

/** 分片大小归一（服务端给的值不可信时回到 512 KiB）。 */
export function normalizeChunkBytes(value: unknown): number {
  const size = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(size) || size <= 0) return DEFAULT_CHUNK_BYTES;
  return Math.max(MIN_CHUNK_BYTES, Math.min(MAX_CHUNK_BYTES, size));
}

/** §6.4 / §9：选发现机制。`socket` 表示运行时是否具备 WebSocket 实现。 */
export function resolveMode(capabilities: Capabilities | undefined, socket: boolean): ChannelMode {
  if (!capabilities) return 'timer';
  if (socket && capabilities.features.has('ws')) return 'ws';
  // 即使 features 没声明 longpoll 也试一次：404 会再降级到 timer。
  return 'longpoll';
}

/* ─────────────────────────── 纯函数：分片上传 ─────────────────────────── */

export interface ChunkPlan {
  offset: number;
  length: number;
}

/** 只做「能不能用」的取值（非法 → 默认 512 KiB），不夹紧上下限：调用方给的片大小要照用。 */
function usableChunkBytes(value: number): number {
  const size = Number(value);
  return Number.isSafeInteger(size) && size > 0 ? size : DEFAULT_CHUNK_BYTES;
}

/** §5 下一片；`offset >= size` 时返回 undefined（该 finish 了）。 */
export function nextChunk(size: number, chunkBytes: number, offset: number): ChunkPlan | undefined {
  const total = Number.isSafeInteger(size) && size > 0 ? size : 0;
  const limit = usableChunkBytes(chunkBytes);
  const start = Number.isSafeInteger(offset) && offset > 0 ? Math.min(offset, total) : 0;
  if (start >= total) return undefined;
  return { offset: start, length: Math.min(limit, total - start) };
}

/**
 * §5 断点续传的恢复点选择：服务端 `expected`/`GET /v1/upload/<id>` 的 offset 优先，
 * 其次本地记录，最后 0。非法值一律跳过（宁可重传也不能跳过字节）。
 */
export function pickUploadOffset(candidates: readonly unknown[], size: number): number {
  const total = Number.isSafeInteger(size) && size > 0 ? size : 0;
  for (const candidate of candidates) {
    const value = typeof candidate === 'number' ? candidate : Number(candidate);
    if (Number.isSafeInteger(value) && value >= 0 && value <= total) return value;
  }
  return 0;
}

/** 分片会话的稳定 cache key：同一份内容重复上传会复用同一 offset。 */
export function uploadSessionKey(workspaceId: string, path: string, size: number, sha256: string, base: number): string {
  return createHash('sha256')
    .update(JSON.stringify(['upload', workspaceId, path.toLowerCase(), size, sha256, base]))
    .digest('hex');
}

export interface ReceivedRange {
  offset: number;
  length: number;
}

/**
 * §5.1 `received[]` 归一：丢掉非法区间、裁剪到文件范围内、按 offset 排序并合并重叠。
 * 服务端故意不回「排序且不重叠」的保证（它是已收块集合），所以这里自己收敛。
 */
export function mergeReceived(received: unknown, size: number): ReceivedRange[] {
  const total = Number.isSafeInteger(size) && size > 0 ? size : 0;
  const rows = Array.isArray(received) ? received : [];
  const parts: ReceivedRange[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const offset = Number((row as { offset?: unknown }).offset);
    const length = Number((row as { length?: unknown }).length);
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length <= 0) continue;
    if (offset >= total) continue;
    parts.push({ offset, length: Math.min(length, total - offset) });
  }
  parts.sort((a, b) => a.offset - b.offset);
  const merged: ReceivedRange[] = [];
  for (const part of parts) {
    const last = merged[merged.length - 1];
    if (last && part.offset <= last.offset + last.length) {
      last.length = Math.max(last.offset + last.length, part.offset + part.length) - last.offset;
    } else {
      merged.push({ offset: part.offset, length: part.length });
    }
  }
  return merged;
}

/** 从 0 开始连续覆盖到哪个字节（顺序续传点）。 */
export function contiguousPrefix(received: readonly ReceivedRange[]): number {
  let end = 0;
  for (const range of received) {
    if (range.offset > end) break;
    end = Math.max(end, range.offset + range.length);
  }
  return end;
}

/**
 * §5.1 续传点：**优先用 `received` 判断缺块**（乱序也认），
 * `offset` 只在完全没有 `received` 信息时当作"从哪继续最快"的提示。
 */
export function resumeOffsetFromReceived(received: unknown, size: number, hint?: unknown): number {
  const rows = Array.isArray(received) ? received : [];
  if (rows.length) {
    const total = Number.isSafeInteger(size) && size > 0 ? size : 0;
    return Math.min(contiguousPrefix(mergeReceived(rows, size)), total);
  }
  return pickUploadOffset([hint], size);
}

/* ─────────────────────────── 纯函数：Range 下载 ─────────────────────────── */

/** `offset > 0` 时组装 `Range` 头；0 表示不需要续传。 */
export function rangeHeader(offset: number): string | undefined {
  if (!Number.isSafeInteger(offset) || offset <= 0) return undefined;
  return 'bytes=' + offset + '-';
}

export interface ContentRange {
  start: number;
  end: number;
  total: number;
}

/** 解析 `bytes 1024-2047/2048`。 */
export function parseContentRange(value: string | null | undefined): ContentRange | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/.exec(value.trim());
  if (!match) return undefined;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (![start, end, total].every(Number.isSafeInteger)) return undefined;
  if (end < start || total <= end) return undefined;
  return { start, end, total };
}

export interface RangePlan {
  /** 本次响应体应写入的缓冲区起点。 */
  start: number;
  /** true 表示服务端没按 Range 续传，必须从 0 重新覆盖。 */
  restart: boolean;
}

/**
 * 根据状态码与 `Content-Range` 决定写入位置。
 * 206 + 匹配的起点 → 续传；200（服务端忽略 Range）或 206 起点不符 → 从头覆盖。
 */
export function planRangeResponse(
  offset: number, size: number, status: number, contentRange: ContentRange | undefined,
): RangePlan {
  if (!Number.isSafeInteger(offset) || offset <= 0) return { start: 0, restart: false };
  if (status !== 206 || !contentRange) return { start: 0, restart: true };
  if (contentRange.start !== offset || contentRange.total !== size) return { start: 0, restart: true };
  return { start: offset, restart: false };
}

/* ─────────────────────────── 纯函数：幂等键 ─────────────────────────── */

/**
 * 确定性 `Idempotency-Key`（§4.1）：同一逻辑写入的重试必须落到同一个 key，
 * 否则服务端无法识别重放。取 sha256 前 128 bit 编成 UUID 形状。
 */
export function idempotencyKey(...parts: readonly string[]): string {
  const hex = createHash('sha256').update(parts.join('\u0000')).digest('hex');
  const variant = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-5' + hex.slice(13, 16)
    + '-' + variant + hex.slice(17, 20) + '-' + hex.slice(20, 32);
}

/* ─────────────────────────── 纯函数：帧与事件解析 ─────────────────────────── */

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/** §3.1 事件行校验：字段类型 + sha256/size 自洽（null sha 必为 size 0）。 */
export function isRemoteChange(value: unknown): value is RemoteChange {
  if (!value || typeof value !== 'object') return false;
  const row = value as Partial<RemoteChange>;
  if (typeof row.path !== 'string' || row.path.length === 0) return false;
  if (!isCount(row.seq) || !isCount(row.revision) || !isCount(row.size)) return false;
  if (row.sha256 !== null && !(typeof row.sha256 === 'string' && /^[a-f0-9]{64}$/.test(row.sha256))) return false;
  if (row.sha256 === null && row.size !== 0) return false;
  return typeof row.deleted === 'boolean';
}

/** §3.1 响应体解析（形状不对就返回 undefined → 调用方全量重置）。 */
export function parseChangesPage(value: unknown): ChangesPage | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  if (!isCount(raw.head)) return undefined;
  const floor = isCount(raw.floor) ? raw.floor : 0;
  const reset = raw.reset === true;
  const rows = Array.isArray(raw.changes) ? raw.changes : [];
  if (!rows.every(isRemoteChange)) return undefined;
  return { head: raw.head, floor, reset, changes: rows as RemoteChange[] };
}

export type ChangeVerdict =
  | { kind: 'apply'; changes: RemoteChange[] }
  | { kind: 'ignore' }
  | { kind: 'reset'; head: number; reason: 'flagged' | 'floor' | 'gap' | 'malformed' };

/**
 * §3.1 / §6 缺口判定：
 * - 服务端显式 `reset` 或 `since < floor` → 全量重置；
 * - 序号必须严格连续（每个 seq = 前一个 + 1）→ 否则重置；
 * - 重复投递（seq ≤ 本地水位）直接过滤掉；
 * - 空批次不算缺口（长轮询超时），避免无谓的全量重建。
 */
export function classifyChanges(
  lastSeq: number, page: { head: number; floor: number; reset: boolean; changes: unknown[] },
): ChangeVerdict {
  const head = isCount(page.head) ? page.head : 0;
  const floor = isCount(page.floor) ? page.floor : 0;
  if (page.reset) return { kind: 'reset', head, reason: 'flagged' };
  if (!Array.isArray(page.changes)) return { kind: 'reset', head, reason: 'malformed' };
  if (!page.changes.every(isRemoteChange)) return { kind: 'reset', head, reason: 'malformed' };
  const watermark = isCount(lastSeq) ? lastSeq : 0;
  if (floor > 0 && watermark + 1 < floor) return { kind: 'reset', head, reason: 'floor' };

  const seen = new Set<number>();
  const fresh: RemoteChange[] = [];
  for (const change of [...(page.changes as RemoteChange[])].sort((a, b) => a.seq - b.seq)) {
    if (change.seq <= watermark || seen.has(change.seq)) continue;
    seen.add(change.seq);
    fresh.push(change);
  }
  if (!fresh.length) return { kind: 'ignore' };
  let expected = watermark + 1;
  for (const change of fresh) {
    if (change.seq !== expected) return { kind: 'reset', head, reason: 'gap' };
    expected++;
  }
  return { kind: 'apply', changes: fresh };
}

/** §6 服务端帧解析。无法识别的帧返回 unknown（仍然算「有流量」，看门狗不该误杀）。 */
export function decodeFrame(text: string): ServerFrame | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const type = typeof raw.t === 'string' ? raw.t : '';
  switch (type) {
    case 'hello':
      return {
        t: 'hello',
        seq: isCount(raw.seq) ? raw.seq : 0,
        heartbeatMs: isCount(raw.heartbeatMs) && raw.heartbeatMs > 0 ? raw.heartbeatMs : undefined,
        proto: isCount(raw.proto) ? raw.proto : undefined,
        resumeWindow: isCount(raw.resumeWindow) ? raw.resumeWindow : undefined,
      };
    case 'changes':
      return { t: 'changes', head: isCount(raw.head) ? raw.head : 0, changes: Array.isArray(raw.changes) ? raw.changes : [] };
    case 'reset':
      return { t: 'reset', head: isCount(raw.head) ? raw.head : 0, reason: typeof raw.reason === 'string' ? raw.reason : undefined };
    case 'ping':
      return { t: 'ping', seq: isCount(raw.seq) ? raw.seq : 0 };
    default:
      return { t: 'unknown', type };
  }
}

/** §2 `/v1/config` 解析。 */
export function parseCapabilities(value: unknown): Capabilities | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  if (!isCount(raw.proto) || raw.proto < 1) return undefined;
  const features = new Set<string>(
    Array.isArray(raw.features) ? raw.features.filter((item): item is string => typeof item === 'string') : [],
  );
  const positive = (input: unknown, fallback: number, min: number, max: number): number => {
    const number = typeof input === 'number' ? input : Number(input);
    if (!Number.isSafeInteger(number) || number < min) return fallback;
    return Math.min(max, number);
  };
  return {
    proto: raw.proto,
    features,
    heartbeatMs: positive(raw.heartbeatMs, DEFAULT_HEARTBEAT_MS, 1_000, 120_000),
    chunkBytes: normalizeChunkBytes(raw.chunkBytes),
    maxFileBytes: positive(raw.maxFileBytes, 16 * 1024 * 1024, 1, 512 * 1024 * 1024),
    maxPaths: positive(raw.maxPaths, 4096, 1, 1_000_000),
    pollFallbackMs: positive(raw.pollFallbackMs, REMOTE_POLL_MS, 250, 60_000),
    maxChunkConcurrency: positive(raw.maxChunkConcurrency, DEFAULT_MAX_CHUNK_CONCURRENCY, 1, 16),
    partRetry: positive(raw.partRetry, DEFAULT_PART_RETRY, 1, 16),
    cooldownAfterFailures: positive(raw.cooldownAfterFailures, DEFAULT_COOLDOWN_AFTER_FAILURES, 1, 1000),
    cooldownMs: positive(raw.cooldownMs, DEFAULT_COOLDOWN_MS, 1_000, 600_000),
    unhealthyAfterErrors: positive(raw.unhealthyAfterErrors, DEFAULT_UNHEALTHY_AFTER_ERRORS, 1, 1000),
    errorWindowMs: positive(raw.errorWindowMs, DEFAULT_ERROR_WINDOW_MS, 1_000, 600_000),
  };
}

/* ─────────────────────────── WebSocket 适配 ─────────────────────────── */

function toText(data: unknown): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (Array.isArray(data)) {
    return Buffer.concat(data.map(part => (Buffer.isBuffer(part) ? part : Buffer.from(part as ArrayBuffer)))).toString('utf8');
  }
  return String(data);
}

function adaptWs(socket: InstanceType<typeof WebSocket>): SocketLike {
  // 服务端在握手成功后立刻推 `hello`（甚至紧跟 `ping`）。拨号器解析（open）到
  // 通道注册 onMessage 之间隔着一个微任务窗口，这里必须缓存早到的帧，否则 hello 会丢。
  let messageHandler: ((text: string) => void) | undefined;
  let closeHandler: ((code: number, reason: string) => void) | undefined;
  let errorHandler: ((error: unknown) => void) | undefined;
  const early: string[] = [];
  let earlyClose: { code: number; reason: string } | undefined;
  let earlyError: { error: unknown } | undefined;
  const flush = (action: () => void) => queueMicrotask(action);

  socket.on('message', data => {
    const text = toText(data);
    if (messageHandler) messageHandler(text);
    else early.push(text);
  });
  socket.on('close', (code: number, reason: Buffer) => {
    const detail = { code, reason: String(reason ?? '') };
    if (closeHandler) closeHandler(detail.code, detail.reason);
    else earlyClose = detail;
  });
  socket.on('error', error => {
    if (errorHandler) errorHandler(error);
    else earlyError = { error };
  });

  return {
    send: text => {
      if (socket.readyState === socket.OPEN) socket.send(text);
    },
    close: (code, reason) => {
      try {
        socket.close(code ?? CLIENT_RECONNECT_CODE, reason ?? '');
      } catch {
        // 已经关闭或不可写：重连逻辑会照常推进。
      }
    },
    onMessage: handler => {
      messageHandler = handler;
      if (!early.length) return;
      flush(() => {
        for (const text of early.splice(0)) handler(text);
      });
    },
    onClose: handler => {
      closeHandler = handler;
      if (earlyClose) flush(() => handler(earlyClose!.code, earlyClose!.reason));
    },
    onError: handler => {
      errorHandler = handler;
      if (earlyError) flush(() => handler(earlyError!.error));
    },
  };
}

type NativeSocket = {
  send(text: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'message', handler: (event: { data: unknown }) => void): void;
  addEventListener(type: 'close', handler: (event: { code: number; reason: string }) => void): void;
  addEventListener(type: 'error', handler: (event: unknown) => void): void;
};

function adaptNative(socket: NativeSocket): SocketLike {
  // 与 `adaptWs` 相同的原因：握手后第一帧可能早于处理器注册。
  let messageHandler: ((text: string) => void) | undefined;
  let closeHandler: ((code: number, reason: string) => void) | undefined;
  let errorHandler: ((error: unknown) => void) | undefined;
  const early: string[] = [];
  let earlyClose: { code: number; reason: string } | undefined;
  let earlyError: { error: unknown } | undefined;

  socket.addEventListener('message', event => {
    const text = toText(event.data);
    if (messageHandler) messageHandler(text);
    else early.push(text);
  });
  socket.addEventListener('close', event => {
    const detail = { code: event.code, reason: String(event.reason ?? '') };
    if (closeHandler) closeHandler(detail.code, detail.reason);
    else earlyClose = detail;
  });
  socket.addEventListener('error', event => {
    if (errorHandler) errorHandler(event);
    else earlyError = { error: event };
  });

  return {
    send: text => {
      try {
        socket.send(text);
      } catch {
        // 同上。
      }
    },
    close: (code, reason) => {
      try {
        socket.close(code ?? CLIENT_RECONNECT_CODE, reason ?? '');
      } catch {
        // 同上。
      }
    },
    onMessage: handler => {
      messageHandler = handler;
      if (!early.length) return;
      queueMicrotask(() => {
        for (const text of early.splice(0)) handler(text);
      });
    },
    onClose: handler => {
      closeHandler = handler;
      if (earlyClose) queueMicrotask(() => handler(earlyClose!.code, earlyClose!.reason));
    },
    onError: handler => {
      errorHandler = handler;
      if (earlyError) queueMicrotask(() => handler(earlyError!.error));
    },
  };
}

function hasNativeSocket(): boolean {
  return typeof (globalThis as { WebSocket?: unknown }).WebSocket === 'function';
}

/**
 * 默认拨号器。
 *
 * 为什么用 `ws` 而不是 Node 24 内置的（undici）WebSocket：协议 §1 的主鉴权路径是
 * `Authorization` 请求头，而 undici 的实现是浏览器同构 API，无法附带自定义请求头；
 * `ws` 早就是这个扩展的生产依赖（`extension.ts` 已经在 import），并带 `@types/ws`，
 * 所以「用 ws」= 零新增依赖。（内置 WebSocket 只在 `ws` 不可用时作为兜底，此时靠
 * §1 允许的 `lsw.token.<token>` 子协议携带令牌。）
 */
export function createDialer(token: string, timeoutMs: number = 10_000): SocketDialer {
  return (url, headers, protocols) => new Promise<SocketLike>((resolve, reject) => {
    const fail = (error: unknown) => reject(error instanceof Error ? error : new TransportOffline('WebSocket 握手失败。'));
    let socket: InstanceType<typeof WebSocket>;
    try {
      socket = new WebSocket(url, protocols, { headers, handshakeTimeout: timeoutMs });
    } catch (error) {
      // `ws` 不可用 → 内置 WebSocket（只能靠子协议带令牌）。
      const Native = (globalThis as { WebSocket?: new (url: string, protocols?: string[]) => unknown }).WebSocket;
      if (typeof Native !== 'function') {
        fail(error);
        return;
      }
      let native: NativeSocket;
      try {
        native = new Native(url, [...protocols, 'lsw.token.' + token]) as NativeSocket;
      } catch (fallbackError) {
        fail(fallbackError);
        return;
      }
      native.addEventListener('error', event => fail(event));
      // 内置实现没有 open 事件等待点：握手成功后第一条消息/错误会自然到达。
      resolve(adaptNative(native));
      return;
    }
    const timer = setTimeout(() => {
      try {
        socket.terminate();
      } catch {
        // ignore
      }
      fail(new TransportOffline('WebSocket 握手超时。'));
    }, timeoutMs);
    timer.unref?.();
    socket.once('open', () => {
      clearTimeout(timer);
      resolve(adaptWs(socket));
    });
    socket.once('error', error => {
      clearTimeout(timer);
      fail(error);
    });
  });
}

/** 服务端直接没有 `/v1/events`（404/501）时，握手错误会带状态码。 */
export function handshakeRejected(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /unexpected server response:\s*(?:404|501)\b/i.test(message) || /\b(?:404|501)\b.*\b(?:not found|unsupported)\b/i.test(message);
}

/* ─────────────────────────── 事件通道 ─────────────────────────── */

export interface ChannelCallbacks {
  /** 连续的一批增量（`seq` 是本批最后一条的 seq，用于 ack/续传水位）。 */
  onChanges: (seq: number, changes: RemoteChange[]) => void;
  /** 需要全量重建（日志裁剪 / 缺口 / 服务端重置 / hello 回退）。 */
  onReset: (head: number) => void;
  onState: (state: LinkState, detail?: string) => void;
  /** 水位推进（供调用方落盘）。 */
  onSeq: (seq: number) => void;
  /** `/v1/config` 探测成功 → 调用方据此切换 commit/分片/Range 通道。 */
  onCapabilities?: (capabilities: Capabilities) => void;
}

export interface ChannelOptions extends ChannelCallbacks {
  endpoint: URL;
  workspaceId: string;
  token: string;
  lastSeq?: number;
  fetchImpl?: typeof fetch;
  dial?: SocketDialer;
  now?: () => number;
  random?: () => number;
  /** 测试用：覆盖心跳（否则用 `/v1/config` 或 hello 的值）。 */
  heartbeatMs?: number;
}

/**
 * 推送订阅通道：`ws` → 长轮询 → 定时间隔（§6.4）。
 *
 * 水位（`seq`）的所有权在本类：调用方应用完一批增量后调用 `confirm(seq)`；
 * 全量对齐后用 `setSeq(head)` 校准。`since` 永远取水位，因此「崩溃后从 lastSeq 续传」
 * 是默认行为，不需要额外状态。
 */
export class EventChannel {
  private readonly endpoint: URL;
  private readonly workspaceId: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly dial: SocketDialer;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly heartbeatOverride?: number;
  private readonly callbacks: ChannelCallbacks;
  private readonly lifetime = new AbortController();
  private sequence: number;
  private currentMode: ChannelMode = 'timer';
  private capabilities?: Capabilities;
  private started = false;
  private stopped = false;
  private socket?: SocketLike;
  private pauseControl?: () => void;
  private sessionEnd?: () => void;
  private heartbeatMs = DEFAULT_HEARTBEAT_MS;
  private emittedState?: LinkState;
  private emittedDetail?: string;
  private policy: StabilityPolicy = DEFAULT_STABILITY_POLICY;
  /** 失败时间戳（§6.1 错误计数窗口），成功一次即清空。 */
  private readonly failures: number[] = [];

  constructor(options: ChannelOptions) {
    if (!(options.endpoint instanceof URL)) throw new TransportError('协作服务器地址无效。');
    this.endpoint = options.endpoint;
    this.workspaceId = options.workspaceId;
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
    this.dial = options.dial ?? createDialer(options.token);
    this.now = options.now ?? (() => Date.now());
    this.random = options.random ?? Math.random;
    this.heartbeatOverride = options.heartbeatMs;
    this.sequence = Number.isSafeInteger(options.lastSeq) && (options.lastSeq as number) >= 0 ? (options.lastSeq as number) : 0;
    this.callbacks = {
      onChanges: options.onChanges,
      onReset: options.onReset,
      onState: options.onState,
      onSeq: options.onSeq,
      onCapabilities: options.onCapabilities,
    };
  }

  mode(): ChannelMode {
    return this.currentMode;
  }

  /** 推送（ws/长轮询）为 true，定时间隔轮询为 false —— 决定 `ProjectSync` 用哪种节奏。 */
  isPushing(): boolean {
    return this.currentMode !== 'timer';
  }

  seq(): number {
    return this.sequence;
  }

  /** 全量对齐后的水位校准（允许下调：服务端日志被重置时必须从头续）。 */
  setSeq(seq: number): void {
    if (!Number.isSafeInteger(seq) || seq < 0) return;
    this.sequence = seq;
  }

  /** 应用完成后的确认 → 推进水位并回 ack（§6 客户端帧）。 */
  confirm(seq: number): void {
    if (!Number.isSafeInteger(seq) || seq <= this.sequence) return;
    this.sequence = seq;
    this.callbacks.onSeq(seq);
    this.write({ t: 'ack', seq });
  }

  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    void this.loop().catch(() => {
      // 通道不向外抛错：状态回调已经反映失败，ProjectSync 的轮询兜底继续工作。
    });
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.lifetime.abort();
    this.pauseControl?.();
    this.pauseControl = undefined;
    // 会话可能正卡在未完成的握手/静默里：显式收尾，避免看门狗定时器把宿主拖住。
    this.sessionEnd?.();
    this.sessionEnd = undefined;
    try {
      this.socket?.close(CLIENT_RECONNECT_CODE, 'client shutdown');
    } catch {
      // ignore
    }
    this.socket = undefined;
  }

  private authHeaders(): Record<string, string> {
    return { Authorization: 'Bearer ' + this.token };
  }

  private eventsUrl(): URL {
    const url = new URL('/v1/events', this.endpoint);
    url.protocol = this.endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('workspace', this.workspaceId);
    url.searchParams.set('since', String(this.sequence));
    return url;
  }

  private write(payload: unknown): void {
    try {
      this.socket?.send(JSON.stringify(payload));
    } catch {
      // 连接正在关闭：下次重连会带 since 续传。
    }
  }

  private emit(state: LinkState, detail?: string): void {
    if (this.emittedState === state && this.emittedDetail === detail) return;
    this.emittedState = state;
    this.emittedDetail = detail;
    this.callbacks.onState(state, detail);
  }

  private setMode(mode: ChannelMode): void {
    this.currentMode = mode;
  }

  /** §6.1 记录一次网络/解析失败（窗口内累计用于双路判死），并裁掉过期记录。 */
  private noteFailure(): void {
    const now = this.now();
    const kept = recordFailure(this.failures, now, this.policy.errorWindowMs);
    this.failures.length = 0;
    this.failures.push(...kept);
  }

  /** 一次成功（hello / 长轮询 200）即清零失败计数，退出冷却。 */
  private noteSuccess(): void {
    this.failures.length = 0;
  }

  /** §6.1 错误计数判死。 */
  private overBudget(): boolean {
    return isUnhealthy(this.failures, this.now(), this.policy.errorWindowMs, this.policy.unhealthyAfterErrors);
  }

  /** §6.2 下一次重连间隔（含冷却：≥5 次连续失败 → 固定 30 s 无抖动）。 */
  private retryDelay(attempt: number, base?: number): number {
    return reconnectDelay({
      attempt,
      failures: failureCount(this.failures, this.now(), this.policy.errorWindowMs),
      random: this.random,
      base,
      policy: this.policy,
    });
  }

  private pause(ms: number): Promise<void> {
    if (this.stopped) return Promise.resolve();
    return new Promise<void>(resolve => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.pauseControl = undefined;
        resolve();
      };
      const timer = setTimeout(finish, Math.max(0, Math.trunc(ms)));
      this.pauseControl = finish;
    });
  }

  private async loop(): Promise<void> {
    let attempt = 0;
    while (!this.stopped) {
      const probe = await this.probe();
      if (this.stopped) return;
      if (probe.kind === 'offline') {
        this.noteFailure();
        this.emit('offline', '协作服务器的推送接口暂时不可达，正在自动重连。');
        await this.pause(this.retryDelay(attempt++));
        continue;
      }
      if (probe.kind === 'legacy') {
        this.setMode('timer');
        this.emit('degraded', '协作服务端未提供 v1 能力协商（/v1/config 不可用），已退化为 0.2 定时轮询。');
        attempt = 0;
        await this.pause(LEGACY_REPROBE_MS);
        continue;
      }
      this.noteSuccess();
      this.capabilities = probe.capabilities;
      this.policy = {
        cooldownAfterFailures: probe.capabilities.cooldownAfterFailures,
        cooldownMs: probe.capabilities.cooldownMs,
        unhealthyAfterErrors: probe.capabilities.unhealthyAfterErrors,
        errorWindowMs: probe.capabilities.errorWindowMs,
      };
      this.heartbeatMs = this.heartbeatOverride ?? probe.capabilities.heartbeatMs;
      this.callbacks.onCapabilities?.(probe.capabilities);
      const mode = resolveMode(probe.capabilities, typeof WebSocket === 'function' || hasNativeSocket());
      this.setMode(mode);
      if (mode === 'timer') {
        this.emit('degraded', '协作服务端未提供推送或长轮询接口，已退化为定时轮询。');
        attempt = 0;
        await this.pause(LEGACY_REPROBE_MS);
        continue;
      }
      const outcome = mode === 'ws' ? await this.wsCycle() : await this.longPollCycle();
      if (this.stopped) return;
      if (outcome === 'downgrade') {
        // ws 无 → 长轮询；长轮询也无 → 定时。跳回循环顶部重新探测。
        this.setMode(mode === 'ws' ? 'longpoll' : 'timer');
        if (mode === 'longpoll') {
          this.emit('degraded', '协作服务端未提供增量接口，已退化为定时轮询。');
          await this.pause(LEGACY_REPROBE_MS);
        }
        attempt = 0;
      }
    }
  }

  private async probe(): Promise<{ kind: 'caps'; capabilities: Capabilities } | { kind: 'legacy' } | { kind: 'offline' }> {
    const url = new URL('/v1/config', this.endpoint);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: this.authHeaders(),
        redirect: 'error',
        signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(CHANNEL_PROBE_TIMEOUT_MS)]),
      });
    } catch {
      return { kind: 'offline' };
    }
    if (!response.ok) {
      await response.body?.cancel();
      // §9：0.2 服务端没有 /v1/config → 404，必须优雅降级。
      return response.status === 404 || response.status === 501 ? { kind: 'legacy' } : { kind: 'offline' };
    }
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      return { kind: 'legacy' };
    }
    const capabilities = parseCapabilities(data);
    return capabilities ? { kind: 'caps', capabilities } : { kind: 'legacy' };
  }

  private async wsCycle(): Promise<'downgrade' | 'stop'> {
    let attempt = 0;
    while (!this.stopped) {
      const url = this.eventsUrl();
      let socket: SocketLike;
      try {
        socket = await this.dial(url.toString(), this.authHeaders(), ['lsw.v1']);
      } catch (error) {
        if (this.stopped) return 'stop';
        if (handshakeRejected(error)) return 'downgrade';
        this.noteFailure();
        this.emit('offline', '推送通道连接中断，正在自动重连。');
        await this.pause(this.retryDelay(attempt++));
        continue;
      }
      if (this.stopped) {
        try {
          socket.close(CLIENT_RECONNECT_CODE, 'client shutdown');
        } catch {
          // ignore
        }
        return 'stop';
      }
      this.socket = socket;
      const session = await this.wsSession(socket);
      this.socket = undefined;
      if (this.stopped) return 'stop';
      if (session.hello) {
        attempt = 0;
        this.noteSuccess();
      }
      const restart = session.code === RESTART_CLOSE_CODE;
      this.emit('offline', restart
        ? '协作服务器正在重启，正在快速重连。'
        : session.unhealthy
          ? '推送通道错误过多，已按健康度判死并重连。'
          : session.timedOut ? '推送通道静默超时，正在自动重连。' : '推送连接已断开，正在自动重连。');
      await this.pause(this.retryDelay(attempt++, restart ? RESTART_BACKOFF_MS : BASE_BACKOFF_MS));
    }
    return 'stop';
  }

  private wsSession(
    socket: SocketLike,
  ): Promise<{ hello: boolean; code?: number; timedOut: boolean; unhealthy?: boolean }> {
    const heartbeatMs = this.heartbeatOverride ?? this.heartbeatMs;
    let lastSeen = this.now();
    let hello = false;
    return new Promise(resolve => {
      let settled = false;
      let watchdog: ReturnType<typeof setInterval> | undefined;
      const send = (payload: unknown) => {
        try {
          socket.send(JSON.stringify(payload));
        } catch {
          // 关闭中。
        }
      };
      const finish = (result: { hello: boolean; code?: number; timedOut: boolean; unhealthy?: boolean }) => {
        if (settled) return;
        settled = true;
        if (watchdog) clearInterval(watchdog);
        this.sessionEnd = undefined;
        try {
          socket.close(CLIENT_RECONNECT_CODE, 'reconnect');
        } catch {
          // ignore
        }
        resolve(result);
      };
      this.sessionEnd = () => finish({ hello, timedOut: false });
      // §6.1 双路判死之一：错误计数。解析失败也是协议级故障，计入窗口。
      const failure = () => {
        this.noteFailure();
        if (this.overBudget()) finish({ hello, unhealthy: true, timedOut: false });
      };
      socket.onMessage(text => {
        lastSeen = this.now();
        const frame = decodeFrame(text);
        if (!frame) {
          failure();
          return;
        }
        switch (frame.t) {
          case 'ping':
            send({ t: 'pong', seq: frame.seq });
            return;
          case 'hello':
            hello = true;
            this.noteSuccess();
            if (frame.heartbeatMs && !this.heartbeatOverride) this.heartbeatMs = frame.heartbeatMs;
            if (frame.seq < this.sequence) this.callbacks.onReset(frame.seq);
            this.emit('online');
            return;
          case 'changes': {
            this.emit('online');
            const verdict = classifyChanges(this.sequence, { head: frame.head, floor: 0, reset: false, changes: frame.changes });
            this.applyVerdict(verdict);
            return;
          }
          case 'reset':
            this.emit('online');
            this.callbacks.onReset(frame.head);
            return;
          default:
            return;
        }
      });
      socket.onClose(code => finish({ hello, code, timedOut: false }));
      socket.onError(() => {
        // §6.1 双路判死之二：网络错误计数（否则只能等静默超时，抖动会被当成断线）。
        failure();
      });
      watchdog = setInterval(() => {
        if (!watchdogExpired(lastSeen, this.now(), heartbeatMs)) return;
        this.noteFailure();
        finish({ hello, timedOut: true });
      }, watchdogIntervalMs(heartbeatMs));
      watchdog.unref?.();
    });
  }

  private applyVerdict(verdict: ChangeVerdict): void {
    if (verdict.kind === 'reset') {
      this.callbacks.onReset(verdict.head);
      return;
    }
    if (verdict.kind === 'ignore') return;
    const last = verdict.changes[verdict.changes.length - 1];
    this.callbacks.onChanges(last?.seq ?? this.sequence, verdict.changes);
  }

  private async longPollCycle(): Promise<'downgrade' | 'stop'> {
    let attempt = 0;
    while (!this.stopped) {
      const started = this.now();
      let page: ChangesPage;
      try {
        page = await this.fetchChanges(LONG_POLL_WAIT_MS);
      } catch (error) {
        if (this.stopped) return 'stop';
        if (error instanceof TransportGone) return 'downgrade';
        if (error instanceof TransportFatal) {
          this.emit('offline', error.message);
          attempt = 0;
          await this.pause(LEGACY_REPROBE_MS);
          continue;
        }
        this.noteFailure();
        this.emit('offline', '增量通道不可用，正在自动重连。');
        await this.pause(this.retryDelay(attempt++));
        continue;
      }
      if (this.stopped) return 'stop';
      attempt = 0;
      this.noteSuccess();
      this.emit('online');
      this.applyVerdict(classifyChanges(this.sequence, { head: page.head, floor: page.floor, reset: page.reset, changes: page.changes }));
      if (!page.changes.length && !page.reset && this.now() - started < 200) {
        // 服务端没有真正挂起（wait=0）：避免空转打爆 CPU 与服务端。
        await this.pause(250);
      }
    }
    return 'stop';
  }

  private async fetchChanges(waitMs: number): Promise<ChangesPage> {
    const url = new URL('/v1/workspace/changes', this.endpoint);
    url.searchParams.set('workspace', this.workspaceId);
    url.searchParams.set('since', String(this.sequence));
    const wait = Math.max(0, Math.min(MAX_LONG_POLL_WAIT_MS, Math.trunc(waitMs)));
    if (wait > 0) url.searchParams.set('wait', String(wait));
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        headers: { ...this.authHeaders(), Accept: 'application/json' },
        redirect: 'error',
        signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(wait + 10_000)]),
      });
    } catch (error) {
      throw new TransportOffline('增量接口不可达。', { cause: error });
    }
    if (response.status === 404) {
      await response.body?.cancel();
      throw new TransportGone('服务端没有 /v1/workspace/changes。');
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel();
      throw new TransportFatal('共享工作区令牌未通过验证。');
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new TransportOffline('增量接口返回 HTTP ' + response.status + '。');
    }
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new TransportOffline('增量接口返回了无法解析的内容。');
    }
    const page = parseChangesPage(data);
    if (!page) throw new TransportOffline('增量接口响应结构不符合协议。');
    return page;
  }
}
