import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { patches, type TextPatch } from './editor-model.js';
import { hasOfficeOwnerFile, isOfficeDocument, isOfficeOwnerFile } from './office-files.js';
import {
  CHUNKED_UPLOAD_THRESHOLD,
  DEFAULT_CHUNK_BYTES,
  EventChannel,
  PENDING_RETRY_MS,
  RANGE_RESUME_THRESHOLD,
  SAFETY_POLL_MS,
  fallbackPollMs,
  idempotencyKey,
  isLoopbackEndpoint,
  nextChunk,
  normalizeChunkBytes,
  parseContentRange,
  pickUploadOffset,
  planRangeResponse,
  rangeHeader,
  resumeOffsetFromReceived,
  uploadSessionKey,
  type Capabilities,
  type LinkState,
  type RemoteChange,
} from './transport.js';

const FILE_LIMIT = 16 * 1024 * 1024;
const TEXT_MERGE_LIMIT = 1024 * 1024;
const MANIFEST_LIMIT = 4096;
const POLL_MS = 650;
const DEBOUNCE_MS = 150;
/** 续传水位落盘位置（与 `base.row.revision` 同在 checkout 目录，§6.6）。 */
const SEQUENCE_FILE = 'sequence.json';
/** 单次 Range 下载的网络抖动重试次数（buffer 只在内存里，跨轮重来由内核负责）。 */
const RANGE_RETRIES = 2;
const INVALID_NAME = /[\u0000-\u001f\u007f<>:"\\|?*]/;
const DEVICE_NAME = /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])$/i;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const GENERATED = /\.(?:aux|log|toc|bbl|blg|bcf|fls|fdb_latexmk|synctex(?:\.gz)?|lof|lot|out|nav|snm|vrb|xdv|dvi|run\.xml|pyc|pyo)$/i;
const LOCAL_DIRS = new Set(['node_modules', '__pycache__', 'build', 'out', 'dist']);
const TEXT_EXTENSION = /\.(?:tex|bib|sty|cls|bst|def|cfg|ltx|txt|md|rst|json|xml|csv|tsv|py|r|m|c|h|cpp|hpp|js|ts|html|css|yaml|yml|toml|ini|sh|ps1|sql)$/i;

interface FileRevision {
  path: string;
  revision: number;
  sha256: string | null;
  size: number;
}

interface FileVersion {
  row: FileRevision;
  text?: string;
}

interface Conflict {
  id: string;
  path: string;
  local: string | null;
  shared: FileVersion;
  hasBase: boolean;
}

export interface ProjectConflict {
  id: string;
  path: string;
  directory: string;
  local?: string;
  shared?: string;
  base?: string;
}

interface Projection {
  before: string | null;
  after: FileVersion;
  payload?: string;
}

interface Checkout {
  base?: FileVersion;
  intent?: Projection;
  conflict?: Conflict;
  resolution?: { local: string | null };
}

interface LocalFile {
  sha256: string | null;
  size: number;
}

interface ProjectOptions {
  root: string;
  storage: string;
  endpoint: URL;
  workspaceId: string;
  token: string;
  isDirty: (relative: string) => boolean;
  onStatus: (status: ProjectStatus) => void;
}

export interface ProjectStatus {
  state: 'Starting' | 'Syncing' | 'Saved' | 'Offline' | 'Reconnecting' | 'Conflict' | 'Error' | 'Disconnected';
  files: number;
  conflicts: number;
  error?: string;
}

class Offline extends Error {}
class Retry extends Error {}
/** 服务端没有这个 v1 接口（404/405/501）：不是错误，而是「该降级」。 */
class Unsupported extends Error {}

function hash(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function keyFor(relative: string): string {
  return relative.toLowerCase();
}

function isPortablePath(relative: string): boolean {
  return typeof relative === 'string' && relative.normalize('NFC') === relative
    && Buffer.byteLength(relative) <= 1024 && relative.split('/').every(component =>
      component.length > 0 && Buffer.byteLength(component) <= 255
      && !/[. ]$/.test(component) && !INVALID_NAME.test(component) && !DEVICE_NAME.test(component.split('.')[0].trimEnd()));
}

export function isProjectPath(relative: string): boolean {
  return isPortablePath(relative) && relative.split('/').every(component =>
    (!component.startsWith('.') || component === '.latexmkrc') && !LOCAL_DIRS.has(component.toLowerCase()))
    && !isOfficeOwnerFile(path.posix.basename(relative))
    && !GENERATED.test(relative) && !relative.endsWith('~') && !relative.toLowerCase().endsWith('.tmp');
}

function isRevision(value: unknown): value is FileRevision {
  if (!value || typeof value !== 'object') return false;
  const row = value as FileRevision;
  return isPortablePath(row.path) && Number.isSafeInteger(row.revision) && row.revision > 0
    && Number.isSafeInteger(row.size) && row.size >= 0 && row.size <= FILE_LIMIT
    && (row.sha256 === null ? row.size === 0 : typeof row.sha256 === 'string' && /^[a-f0-9]{64}$/.test(row.sha256));
}

function sameRevision(a: FileRevision | undefined, b: FileRevision | undefined): boolean {
  return a?.revision === b?.revision && a?.sha256 === b?.sha256;
}

function copyExtension(relative: string): string {
  return path.extname(relative).slice(0, 20);
}

function absent(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function lstat(file: string) {
  try {
    return fs.lstatSync(file, { bigint: true });
  } catch (error) {
    if (!absent(error)) throw error;
    return undefined;
  }
}

function writeAtomic(file: string, bytes: string | Uint8Array): void {
  const temporary = path.join(path.dirname(file), '.lsw-' + randomUUID() + '.tmp');
  try {
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function readUtf8(relative: string, bytes: Buffer): string | undefined {
  if (bytes.length > TEXT_MERGE_LIMIT || !TEXT_EXTENSION.test(relative) || bytes.includes(0)) return;
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

function samePatch(first: TextPatch, second: TextPatch): boolean {
  return first.offset === second.offset && first.remove === second.remove && first.insert === second.insert;
}

function mergeText(base: string, local: string, shared: string): Buffer | undefined {
  const left = patches(base, local);
  const right = patches(base, shared);
  const merged: TextPatch[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    const a = left[i];
    const b = right[j];
    if (samePatch(a, b)) {
      merged.push(a);
      i++;
      j++;
    } else if (a.offset < b.offset && a.offset + a.remove <= b.offset) {
      merged.push(a);
      i++;
    } else if (b.offset < a.offset && b.offset + b.remove <= a.offset) {
      merged.push(b);
      j++;
    } else {
      return;
    }
  }
  for (; i < left.length; i++) merged.push(left[i]);
  for (; j < right.length; j++) merged.push(right[j]);
  const parts: string[] = [];
  let offset = 0;
  for (const change of merged) {
    parts.push(base.slice(offset, change.offset), change.insert);
    offset = change.offset + change.remove;
  }
  parts.push(base.slice(offset));
  const bytes = Buffer.from(parts.join(''), 'utf8');
  return bytes.length <= FILE_LIMIT ? bytes : undefined;
}

export class ProjectSync {
  private readonly root: string;
  private readonly checkoutDir: string;
  private readonly checkouts = new Map<string, Checkout>();
  private readonly fingerprints = new Map<string, { stamp: string; file: LocalFile }>();
  private readonly missingSince = new Map<string, number>();
  private readonly lifetime = new AbortController();
  /** 推送送达但还没 reconcile 的 path（key → 事件行；删除事件用 sha256=null/size=0 的墓碑）。 */
  private readonly pending = new Map<string, FileRevision>();
  /** 未完成的分片上传会话（同内容重试复用 offset）。 */
  private readonly uploads = new Map<string, { id: string; offset: number; chunkBytes: number }>();
  private watcher?: fs.FSWatcher;
  private timer?: ReturnType<typeof setTimeout>;
  private scheduledAt = 0;
  private running = false;
  private awakened = false;
  private started = false;
  private failures = 0;
  private retryAt = 0;
  private current: ProjectStatus = { state: 'Starting', files: 0, conflicts: 0 };
  private names?: { at: number; map: Map<string, string> };
  private channel?: EventChannel;
  private link: LinkState = 'degraded';
  private pushing = false;
  private commit: 'unknown' | 'v1' | 'legacy' = 'unknown';
  private features = new Set<string>();
  private chunkBytes = DEFAULT_CHUNK_BYTES;
  private chunkConcurrency = 1;
  private partRetry = 1;
  private lastSeq = 0;
  private pendingSeq = 0;
  private fullRequested = false;
  /** 首次全量对齐完成前，任何增量都必须让位给整轮清单（否则会拿空 checkout 去判断冲突）。 */
  private primed = false;

  constructor(private readonly options: ProjectOptions) {
    if (!lstat(options.root)?.isDirectory()) throw new Error('请选择真实的本地工作区目录。');
    this.root = fs.realpathSync(options.root);
    if (!lstat(this.root)?.isDirectory()) throw new Error('请选择本地工作区目录。');
    const storage = path.resolve(options.storage);
    const relative = path.relative(this.root, storage);
    if (!relative || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep))) {
      throw new Error('同步状态目录必须位于工作区之外。');
    }
    this.checkoutDir = path.join(storage, 'checkout');
    fs.mkdirSync(this.checkoutDir, { recursive: true, mode: 0o700 });
    for (const filename of fs.readdirSync(this.checkoutDir)) {
      if (!/^[a-f0-9]{64}\.json$/.test(filename)) continue;
      const state = JSON.parse(fs.readFileSync(path.join(this.checkoutDir, filename), 'utf8')) as Checkout;
      const row = state.base?.row ?? state.intent?.after.row;
      if (isRevision(row) && isOfficeOwnerFile(path.posix.basename(row.path))) continue;
      if (!row || !isRevision(row) || filename !== hash(keyFor(row.path)) + '.json'
        || (state.intent && (!isRevision(state.intent.after.row) || keyFor(state.intent.after.row.path) !== keyFor(row.path)
          || (state.intent.after.row.sha256 !== null && !UUID.test(state.intent.payload ?? ''))))
        || (state.conflict && (!UUID.test(state.conflict.id) || !isRevision(state.conflict.shared.row)
          || !isProjectPath(state.conflict.path) || keyFor(state.conflict.path) !== keyFor(row.path)
          || keyFor(state.conflict.shared.row.path) !== keyFor(row.path)))) {
        throw new Error('工作区同步缓存损坏。请先保留本地文件和同步缓存。');
      }
      this.checkouts.set(keyFor(row.path), state);
    }
    this.lastSeq = this.loadSequence();
  }

  status(): ProjectStatus {
    return this.current;
  }

  listConflicts(): ProjectConflict[] {
    return [...this.checkouts.values()].flatMap(state => {
      const conflict = state.conflict;
      if (!conflict) return [];
      const relative = conflict.path;
      const directory = path.join(this.options.storage, 'conflicts', conflict.id);
      const extension = copyExtension(relative);
      return [{
        id: conflict.id,
        path: relative,
        directory,
        local: conflict.local === null ? undefined : path.join(directory, 'local' + extension),
        shared: conflict.shared.row.sha256 === null ? undefined : path.join(directory, 'shared' + extension),
        base: conflict.hasBase ? path.join(directory, 'base' + extension) : undefined,
      }];
    });
  }

  acceptResolution(relative: string, conflictId: string): void {
    if (!isProjectPath(relative) || this.lifetime.signal.aborted) throw new Error('当前工作区不能提交冲突解决结果。');
    const key = keyFor(relative);
    const conflict = this.checkouts.get(key)?.conflict;
    if (!conflict || conflict.id !== conflictId) throw new Error('冲突记录已变化，请重新查看。');
    if (this.options.isDirty(relative)) throw new Error('请先保存工作区中已合并的文件。');
    const local = this.inspect(relative, false);
    this.save(key, { base: conflict.shared, resolution: { local: local.sha256 } });
    this.publish('Syncing', this.current.files);
    this.wake();
  }

  start(): void {
    if (this.started || this.lifetime.signal.aborted) return;
    this.started = true;
    try {
      this.watcher = fs.watch(this.root, { recursive: true }, (_event, filename) => {
        if (!filename || isProjectPath(filename.split(path.sep).join('/')) || isOfficeOwnerFile(path.basename(filename))) {
          this.wake();
        }
      });
      this.watcher.on('error', () => this.watcher?.close());
    } catch {
      // Periodic reconciliation still catches external changes when watch is unavailable.
    }
    // 推送通道只决定「多久发现变化」：它一旦不可用就按 0.2 的节奏轮询（§6.4/§9）。
    this.channel = new EventChannel({
      endpoint: this.options.endpoint,
      workspaceId: this.options.workspaceId,
      token: this.options.token,
      lastSeq: this.lastSeq,
      onChanges: (seq, changes) => this.receiveChanges(seq, changes),
      onReset: head => this.receiveReset(head),
      onState: (state, detail) => this.receiveState(state, detail),
      onSeq: seq => this.advanceSeq(seq),
      onCapabilities: capabilities => this.receiveCapabilities(capabilities),
    });
    this.channel.start();
    this.schedule(0);
  }

  wake(): void {
    if (!this.started || this.lifetime.signal.aborted) return;
    // 本地编辑（watcher / 编辑器事件）会让本地状态偏离快照，必须整轮对齐。
    this.fullRequested = true;
    if (this.running) {
      this.awakened = true;
    } else {
      this.schedule(DEBOUNCE_MS, true);
    }
  }

  dispose(): void {
    this.lifetime.abort();
    clearTimeout(this.timer);
    this.channel?.stop();
    this.channel = undefined;
    this.watcher?.close();
    this.current = { ...this.current, state: 'Disconnected' };
  }

  private schedule(delay: number, onlySooner = false): void {
    if (this.lifetime.signal.aborted) return;
    const now = Date.now();
    const at = Math.max(now + delay, this.retryAt);
    if (onlySooner && this.timer && this.scheduledAt <= at) return;
    clearTimeout(this.timer);
    this.scheduledAt = at;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.pump();
    }, at - now);
  }

  private publish(state: ProjectStatus['state'], files: number, error?: string): void {
    if (this.lifetime.signal.aborted) return;
    const conflicts = [...this.checkouts.values()].filter(item => item.conflict).length;
    const next = { state, files, conflicts, error };
    if (this.current.state !== state || this.current.files !== files || this.current.conflicts !== conflicts
      || this.current.error !== error) {
      this.current = next;
      this.options.onStatus(next);
    }
  }

  private url(relative?: string, revision?: number): URL {
    const url = new URL(relative === undefined ? '/workspace/manifest' : '/workspace/file', this.options.endpoint);
    url.searchParams.set('workspace', this.options.workspaceId);
    if (relative !== undefined) url.searchParams.set('path', relative);
    if (revision !== undefined) url.searchParams.set('revision', String(revision));
    return url;
  }

  private async send(url: URL, init: RequestInit = {}): Promise<Response> {
    try {
      return await fetch(url, {
        ...init,
        headers: { ...init.headers, Authorization: 'Bearer ' + this.options.token },
        redirect: 'error',
        signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(15000)]),
      });
    } catch {
      throw new Offline('协作服务器暂不可用，本地文件会保留并自动重试。');
    }
  }

  private async request(url: URL, init: RequestInit = {}): Promise<Response> {
    const response = await this.send(url, init);
    if (response.ok) return response;
    await response.body?.cancel();
    if (response.status === 412) throw new Retry();
    if (response.status === 401 || response.status === 403) throw new Error('共享工作区令牌未通过验证。');
    if (response.status === 404) throw new Error('找不到共享工作区或工作区接口，请检查工作区 ID 和服务版本。');
    if (response.status === 507) throw new Error('共享工作区已达到容量上限。');
    if (response.status >= 500) throw new Offline('协作服务器暂不可用，本地文件会保留并自动重试。');
    throw new Error('协作服务器拒绝了文件同步（HTTP ' + response.status + '）。');
  }

  private async manifest(): Promise<{ files: Map<string, FileRevision>; seq: number | undefined }> {
    const response = await this.request(this.url());
    // §3.2：v1 在响应头带 `X-LSW-Seq`；0.2 没有这个头（undefined → 水位保持不变）。
    const header = response.headers.get('x-lsw-seq');
    const data: unknown = await response.json();
    const files = (data as { files?: unknown } | null)?.files;
    if (!Array.isArray(files) || files.length > MANIFEST_LIMIT) throw new Error('服务器文件列表无效。');
    const result = new Map<string, FileRevision>();
    for (const row of files) {
      if (!isRevision(row)) throw new Error('服务器返回了无效的文件版本。');
      if (!isProjectPath(row.path)) continue;
      const key = keyFor(row.path);
      if (result.has(key)) throw new Error('服务器返回了重复的文件路径。');
      result.set(key, row);
    }
    const seq = header !== null && /^(?:0|[1-9][0-9]{0,15})$/.test(header.trim()) ? Number(header.trim()) : undefined;
    return { files: result, seq: seq !== undefined && Number.isSafeInteger(seq) ? seq : undefined };
  }

  private async download(row: FileRevision): Promise<Buffer | undefined> {
    if (row.sha256 === null) return;
    if (this.features.has('range') && row.size >= RANGE_RESUME_THRESHOLD) return this.downloadRanged(row);
    return this.downloadFull(row);
  }

  /**
   * §4 大文件下载：先取前缀，丢包后用 `Range: bytes=<已收>-` 续传，
   * 最后仍按**整文件** sha256 校验（Range 只省流量，不降低校验强度）。
   */
  private async downloadRanged(row: FileRevision): Promise<Buffer> {
    const bytes = Buffer.alloc(row.size);
    let offset = 0;
    let failures = 0;
    while (offset < row.size) {
      if (this.lifetime.signal.aborted) throw new Retry();
      const headers: Record<string, string> = {};
      const range = rangeHeader(offset);
      if (range) headers.Range = range;
      let response: Response;
      try {
        response = await this.request(this.url(row.path, row.revision), { headers });
      } catch (error) {
        if (error instanceof Offline && failures < RANGE_RETRIES) {
          failures++;
          await this.delay(200 * failures);
          continue;
        }
        throw error;
      }
      if (!response.body) throw new Error('服务器未返回文件内容。');
      const plan = planRangeResponse(offset, row.size, response.status, parseContentRange(response.headers.get('content-range')));
      let cursor = plan.start;
      const reader = response.body.getReader();
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          if (cursor + value.length > row.size) throw new Error('服务器返回了超出预期大小的文件。');
          bytes.set(value, cursor);
          cursor += value.length;
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      const next = Math.max(offset, cursor);
      if (next <= offset) throw new Error('服务器没有返回新的文件字节。');
      offset = next;
      failures = 0;
    }
    if (hash(bytes) !== row.sha256) throw new Error('下载的文件校验失败。');
    return bytes;
  }

  private async downloadFull(row: FileRevision): Promise<Buffer> {
    const response = await this.request(this.url(row.path, row.revision));
    const length = response.headers.get('content-length');
    if (length !== null && Number(length) !== row.size) {
      await response.body?.cancel();
      throw new Error('下载大小与服务器记录不一致。');
    }
    if (!response.body) throw new Error('服务器未返回文件内容。');
    const reader = response.body.getReader();
    const bytes = Buffer.alloc(row.size);
    let offset = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (offset + value.length > row.size) throw new Error('服务器返回了超出预期大小的文件。');
        bytes.set(value, offset);
        offset += value.length;
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    if (offset !== row.size || hash(bytes) !== row.sha256) throw new Error('下载的文件校验失败。');
    return bytes;
  }

  /**
   * 上传入口：v1 提交（含分片）优先，任何「服务端没这个接口」都退回 0.2 的
   * `PUT /workspace/file`，绝不让版本差异吃掉用户的文件。
   */
  private async upload(relative: string, before: FileRevision | undefined, bytes: Buffer | undefined): Promise<FileRevision> {
    const base = before?.revision ?? 0;
    if (this.commit === 'v1') {
      try {
        const committed = await this.commitV1(relative, base, bytes);
        if (committed !== undefined) return this.receipt(committed, relative, base, bytes);
      } catch (error) {
        if (!(error instanceof Unsupported)) throw error;
        this.commit = 'legacy';
      }
    }
    return this.receipt(await this.commitLegacy(relative, before, bytes), relative, base, bytes);
  }

  /** 文件级版本双校验：回执的 path/revision/sha256/size 必须与本地提交完全一致。 */
  private receipt(row: unknown, relative: string, base: number, bytes: Buffer | undefined): FileRevision {
    if (!isRevision(row) || keyFor(row.path) !== keyFor(relative) || row.revision < base
      || row.sha256 !== (bytes === undefined ? null : hash(bytes)) || row.size !== (bytes?.length ?? 0)) {
      throw new Error('服务器的保存回执与写入文件不一致。');
    }
    return row;
  }

  private async commitLegacy(relative: string, before: FileRevision | undefined, bytes: Buffer | undefined): Promise<unknown> {
    const response = await this.request(this.url(before?.path ?? relative), {
      method: bytes === undefined ? 'DELETE' : 'PUT',
      headers: { 'If-Match': '"' + (before?.revision ?? 0) + '"', 'Content-Type': 'application/octet-stream' },
      body: bytes === undefined ? undefined : new Uint8Array(bytes),
    });
    return await response.json();
  }

  /** §4.1 幂等提交；返回 `undefined` 表示服务端没有这个接口（调用方回退 0.2）。 */
  private async commitV1(relative: string, base: number, bytes: Buffer | undefined): Promise<unknown | undefined> {
    if (bytes !== undefined && bytes.length >= CHUNKED_UPLOAD_THRESHOLD && this.features.has('chunked-upload')) {
      try {
        return await this.uploadChunked(relative, base, bytes);
      } catch (error) {
        if (!(error instanceof Unsupported)) throw error;
        // 分片通道缺失 → 摘掉该 feature，本次就用整文件 commit。
        this.features.delete('chunked-upload');
      }
    }
    const url = new URL('/v1/workspace/commit', this.options.endpoint);
    url.searchParams.set('workspace', this.options.workspaceId);
    url.searchParams.set('path', relative);
    if (bytes === undefined) url.searchParams.set('delete', '1');
    const response = await this.send(url, {
      method: 'POST',
      headers: {
        'If-Match': '"' + base + '"',
        'Content-Type': 'application/octet-stream',
        // 同一份内容 + 同一个 base 的重试落同一个 key：重放不会重复递增 revision/seq。
        'Idempotency-Key': idempotencyKey('commit', this.options.workspaceId, keyFor(relative), String(base), bytes === undefined ? 'delete' : hash(bytes)),
      },
      body: bytes === undefined ? undefined : new Uint8Array(bytes),
    });
    if (!response.ok) await this.failure(response, '提交接口');
    const data: unknown = await response.json();
    const file = (data as { file?: unknown } | null)?.file;
    return file ?? data;
  }

  /**
   * §5 分片断点续传：`POST /v1/upload` → 并发 `PUT ?offset=`（并发/单块重试取服务端策略）
   * → `finish`。续传点优先用 `received` 判定缺块，失败按 offset 续。
   */
  private async uploadChunked(relative: string, base: number, bytes: Buffer): Promise<unknown> {
    const digest = hash(bytes);
    const key = uploadSessionKey(this.options.workspaceId, relative, bytes.length, digest, base);
    let session = this.uploads.get(key);
    if (session) {
      const recovered = await this.uploadResume(key, bytes.length, digest);
      if (recovered === undefined) session = undefined;
      else session.offset = recovered;
    }
    if (!session) {
      const created = await this.createUpload(relative, bytes.length, digest, base);
      session = { id: created.id, offset: created.offset, chunkBytes: created.chunkBytes };
      this.uploads.set(key, session);
    }
    await this.uploadParts(session, bytes, digest);
    return await this.finishUpload(session.id, key);
  }

  /** 崩溃恢复：`GET /v1/upload/<id>` 的 `received` 优先，`offset` 只作提示。 */
  private async uploadResume(key: string, size: number, sha256: string): Promise<number | undefined> {
    const session = this.uploads.get(key);
    if (!session) return undefined;
    const url = new URL('/v1/upload/' + encodeURIComponent(session.id), this.options.endpoint);
    const response = await this.send(url, { method: 'GET' });
    if (!response.ok) {
      await response.body?.cancel();
      this.uploads.delete(key);
      return undefined;
    }
    const data = await response.json() as { size?: unknown; sha256?: unknown; offset?: unknown; received?: unknown } | null;
    if (data?.size !== undefined && Number(data.size) !== size) {
      this.uploads.delete(key);
      return undefined;
    }
    if (typeof data?.sha256 === 'string' && data.sha256 !== sha256) {
      this.uploads.delete(key);
      return undefined;
    }
    return resumeOffsetFromReceived(data?.received, size, data?.offset);
  }

  private async createUpload(
    relative: string, size: number, sha256: string, base: number,
  ): Promise<{ id: string; offset: number; chunkBytes: number }> {
    const url = new URL('/v1/upload', this.options.endpoint);
    url.searchParams.set('workspace', this.options.workspaceId);
    url.searchParams.set('path', relative);
    url.searchParams.set('size', String(size));
    url.searchParams.set('sha256', sha256);
    url.searchParams.set('base', String(base));
    const response = await this.send(url, { method: 'POST' });
    if (!response.ok) await this.failure(response, '分片上传接口');
    const data: unknown = await response.json();
    const raw = data as { upload?: unknown; offset?: unknown; chunkBytes?: unknown; received?: unknown } | null;
    if (typeof raw?.upload !== 'string' || !raw.upload) throw new Error('服务器未返回分片上传会话。');
    return {
      id: raw.upload,
      offset: resumeOffsetFromReceived(raw.received, size, raw.offset),
      chunkBytes: normalizeChunkBytes(raw.chunkBytes ?? this.chunkBytes),
    };
  }

  /**
   * 按 `maxChunkConcurrency` 并发推送分片，每片最多 `partRetry` 次。
   * 一旦服务端返回 409（只接受顺序块）就收敛为 1 并发并跳到 `expected`，避免互相踩踏。
   */
  private async uploadParts(session: { id: string; offset: number; chunkBytes: number }, bytes: Buffer, digest: string): Promise<void> {
    let cursor = session.offset;
    let window = Math.max(1, Math.min(this.chunkConcurrency, Math.ceil(bytes.length / session.chunkBytes) || 1));
    while (cursor < bytes.length) {
      if (this.lifetime.signal.aborted) throw new Retry();
      const offsets: number[] = [];
      for (let index = 0; index < window; index++) {
        const offset = cursor + index * session.chunkBytes;
        if (offset >= bytes.length) break;
        offsets.push(offset);
      }
      const results = await Promise.all(offsets.map(offset => this.putPart(session, bytes, offset)));
      const mismatch = results.find(result => result.expected !== undefined);
      if (mismatch) {
        window = 1;
        cursor = mismatch.expected!;
        continue;
      }
      const advanced = Math.max(...results.map(result => result.offset));
      if (advanced <= cursor) throw new Error('服务器分片上传没有推进偏移。');
      cursor = advanced;
      session.offset = cursor;
    }
    if (hash(bytes) !== digest) throw new Error('上传内容在搬运过程中被改动。');
  }

  private async putPart(
    session: { id: string; chunkBytes: number }, bytes: Buffer, offset: number,
  ): Promise<{ offset: number; expected?: number }> {
    let failures = 0;
    for (;;) {
      const plan = nextChunk(bytes.length, session.chunkBytes, offset);
      if (!plan) return { offset: bytes.length };
      const url = new URL('/v1/upload/' + encodeURIComponent(session.id), this.options.endpoint);
      url.searchParams.set('offset', String(plan.offset));
      let response: Response;
      try {
        response = await this.send(url, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: new Uint8Array(bytes.subarray(plan.offset, plan.offset + plan.length)),
        });
      } catch (error) {
        if (error instanceof Offline && failures < this.partRetry) {
          failures++;
          await this.delay(250 * failures);
          continue;
        }
        throw error;
      }
      if (response.status === 409) {
        // 服务端只接受顺序块：跟着 `expected` 走，交给调度器收敛并发。
        const data = await response.json().catch(() => undefined) as { expected?: unknown } | undefined;
        const expected = data?.expected;
        if (typeof expected !== 'number' || !Number.isSafeInteger(expected) || expected < 0 || expected > bytes.length) {
          // 没有可信的期望偏移 → 不能瞎重发（否则原地死循环）。
          throw new Error('分片上传偏移冲突，但服务端没有给出可用的期望偏移。');
        }
        return { offset: plan.offset, expected };
      }
      if (!response.ok) await this.failure(response, '分片上传接口');
      const data = await response.json().catch(() => undefined) as { offset?: unknown } | undefined;
      return { offset: pickUploadOffset([data?.offset], bytes.length) };
    }
  }

  private async finishUpload(id: string, key: string): Promise<unknown> {
    const url = new URL('/v1/upload/' + encodeURIComponent(id) + '/finish', this.options.endpoint);
    const response = await this.send(url, {
      method: 'POST',
      // finish 就是一次 commit：同样带幂等键，重试不会把 revision/seq 再加一次。
      headers: { 'Idempotency-Key': idempotencyKey('finish', this.options.workspaceId, key) },
    });
    if (response.status === 422) {
      await response.body?.cancel();
      // 坏块：丢掉会话，下一轮内核会用新会话重传（会话本身保留在服务端允许重试）。
      this.uploads.delete(key);
      throw new Retry();
    }
    if (!response.ok) await this.failure(response, '分片上传接口');
    const data: unknown = await response.json();
    this.uploads.delete(key);
    const file = (data as { file?: unknown } | null)?.file;
    return file ?? data;
  }

  /** v1 接口的状态码 → 本地语义（404/405/501 判为「没有这个接口」而不是错误）。 */
  private async failure(response: Response, reason: string): Promise<never> {
    await response.body?.cancel();
    if (response.status === 412) throw new Retry();
    if (response.status === 410) {
      this.uploads.clear();
      throw new Retry();
    }
    if (response.status === 401 || response.status === 403) throw new Error('共享工作区令牌未通过验证。');
    if (response.status === 409) throw new Error('共享工作区路径冲突：该路径与已有文件大小写或父子关系冲突。');
    if (response.status === 413) throw new Error('文件超过协作服务器允许的上限。');
    if (response.status === 428) throw new Error('协作服务器要求先取到文件版本再提交。');
    if (response.status === 507) throw new Error('共享工作区已达到容量上限。');
    if (response.status >= 500) throw new Offline('协作服务器暂不可用，本地文件会保留并自动重试。');
    if (response.status === 404 || response.status === 405 || response.status === 501) {
      throw new Unsupported(reason + '不可用。');
    }
    throw new Error('协作服务器拒绝了文件同步（HTTP ' + response.status + '）。');
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
  }

  private scan(): Map<string, string> {
    const files = new Map<string, string>();
    const directories = [''];
    while (directories.length) {
      const parent = directories.pop()!;
      let entries: fs.Dirent[];
      try {
        const directory = this.localDirectory(parent ? parent.split('/') : [], false);
        entries = fs.readdirSync(directory, { withFileTypes: true });
      } catch (error) {
        if (parent && absent(error)) continue;
        throw error;
      }
      for (const entry of entries) {
        const relative = parent ? parent + '/' + entry.name : entry.name;
        if (!isProjectPath(relative) || entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          directories.push(relative);
        } else if (entry.isFile()) {
          const key = keyFor(relative);
          if (files.has(key)) throw new Error('目录中存在仅大小写不同的文件：' + relative);
          files.set(key, relative);
          if (files.size > MANIFEST_LIMIT) throw new Error('工作区文件数量超出同步上限。');
        }
      }
    }
    return files;
  }

  private localPath(relative: string, createParents = false): string {
    if (!isProjectPath(relative)) throw new Error('无效的工作区文件路径：' + relative);
    const parts = relative.split('/');
    return path.join(this.localDirectory(parts.slice(0, -1), createParents), parts.at(-1)!);
  }

  private localDirectory(parts: string[], createParents: boolean): string {
    if (!lstat(this.root)?.isDirectory()) throw new Error('本地工作区目录不可用。');
    let parent = this.root;
    for (const component of parts) {
      parent = path.join(parent, component);
      const stat = lstat(parent);
      if (!stat) {
        if (createParents) fs.mkdirSync(parent);
        else break;
      } else if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error('工作区路径被本地链接或文件占用：' + parts.join('/'));
      }
    }
    return path.join(this.root, ...parts);
  }

  private inspect(relative: string, useCache = true): LocalFile {
    const file = this.localPath(relative);
    const stat = lstat(file);
    if (!stat || stat.isDirectory()) {
      this.fingerprints.delete(relative);
      return { sha256: null, size: 0 };
    }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('跳过本地链接或特殊文件：' + relative);
    if (stat.size > BigInt(FILE_LIMIT)) throw new Error('文件超过 16 MiB：' + relative);
    const stamp = [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
    const cached = this.fingerprints.get(relative);
    if (useCache && cached?.stamp === stamp) return cached.file;
    const bytes = fs.readFileSync(file);
    if (bytes.length > FILE_LIMIT) throw new Error('文件超过 16 MiB：' + relative);
    const result = { sha256: hash(bytes), size: bytes.length };
    this.fingerprints.set(relative, { stamp, file: result });
    return result;
  }

  private readLocal(relative: string, expected: LocalFile): Buffer | undefined {
    if (expected.sha256 === null) {
      if (this.inspect(relative, false).sha256 !== null) throw new Retry();
      return;
    }
    const file = this.localPath(relative);
    const stat = lstat(file);
    if (!stat?.isFile() || stat.isSymbolicLink() || Number(stat.size) !== expected.size) throw new Retry();
    const bytes = fs.readFileSync(file);
    if (bytes.length !== expected.size || hash(bytes) !== expected.sha256) throw new Retry();
    return bytes;
  }

  private save(key: string, state: Checkout): void {
    const previousPayload = this.checkouts.get(key)?.intent?.payload;
    writeAtomic(path.join(this.checkoutDir, hash(key) + '.json'), JSON.stringify(state));
    this.checkouts.set(key, state);
    if (previousPayload && previousPayload !== state.intent?.payload) {
      try {
        fs.rmSync(path.join(this.checkoutDir, previousPayload + '.project'), { force: true });
      } catch {
        // The checkout is already committed. A leftover payload is harmless.
      }
    }
  }

  private version(row: FileRevision, bytes: Buffer | undefined): FileVersion {
    return { row, text: bytes === undefined ? undefined : readUtf8(row.path, bytes) };
  }

  private stageProjection(key: string, state: Checkout, before: LocalFile, after: FileVersion, bytes: Buffer | undefined): Projection {
    const payload = bytes === undefined ? undefined : randomUUID();
    if (payload && bytes !== undefined) writeAtomic(path.join(this.checkoutDir, payload + '.project'), bytes);
    const intent = { before: before.sha256, after, payload };
    this.save(key, { ...state, intent });
    return intent;
  }

  private project(key: string, relative: string, intent: Projection): boolean {
    if (this.lifetime.signal.aborted || this.options.isDirty(relative) || this.inspect(relative, false).sha256 !== intent.before) {
      throw new Retry();
    }
    const file = this.localPath(relative, intent.payload !== undefined);
    const target = lstat(file);
    if (target && (target.isSymbolicLink() || !target.isFile())) {
      throw new Error('本地目录或链接挡住了共享文件：' + relative);
    }
    if (hasOfficeOwnerFile(file)) return false;
    const bytes = intent.payload === undefined ? undefined : fs.readFileSync(path.join(this.checkoutDir, intent.payload + '.project'));
    const { row } = intent.after;
    if ((bytes === undefined ? null : hash(bytes)) !== row.sha256 || (bytes?.length ?? 0) !== row.size) {
      throw new Error('本地同步暂存文件校验失败。');
    }
    if (bytes !== undefined) writeAtomic(file, bytes);
    else if (target) fs.unlinkSync(file);
    this.fingerprints.delete(relative);
    this.names = undefined;
    this.save(key, { base: intent.after });
    return true;
  }

  private saveConflict(key: string, relative: string, local: LocalFile, state: Checkout, row: FileRevision, remote: Buffer | undefined): void {
    if (this.lifetime.signal.aborted || this.options.isDirty(relative) || this.inspect(relative, false).sha256 !== local.sha256) {
      throw new Retry();
    }
    const localBytes = this.readLocal(relative, local);
    const id = randomUUID();
    const directory = path.join(this.options.storage, 'conflicts', id);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const extension = copyExtension(relative);
    if (localBytes !== undefined) writeAtomic(path.join(directory, 'local' + extension), localBytes);
    if (remote !== undefined) writeAtomic(path.join(directory, 'shared' + extension), remote);
    if (state.base?.text !== undefined) writeAtomic(path.join(directory, 'base' + extension), state.base.text);
    writeAtomic(path.join(directory, 'versions.json'), JSON.stringify({
      path: relative,
      local: local.sha256,
      shared: row,
      base: state.base?.row,
    }, null, 2));
    const shared = this.version(row, remote);
    this.save(key, {
      base: state.base ?? shared,
      conflict: { id, path: relative, local: local.sha256, shared, hasBase: state.base?.text !== undefined },
    });
  }

  private async reconcileFile(key: string, relative: string, remote: FileRevision | undefined): Promise<boolean> {
    if (this.options.isDirty(relative)) return false;
    const local = this.inspect(relative);
    if (local.sha256 === null && isOfficeDocument(relative) && hasOfficeOwnerFile(this.localPath(relative))) {
      return false;
    }
    if (local.sha256 !== null) this.missingSince.delete(key);
    let state = this.checkouts.get(key) ?? {};
    if (state.intent) {
      const { before, after } = state.intent;
      if (local.sha256 === after.row.sha256) {
        state = { base: after };
        this.save(key, state);
      } else if (local.sha256 === before && remote) {
        return this.project(key, relative, state.intent) && sameRevision(after.row, remote);
      } else if (remote) {
        const bytes = await this.download(remote);
        this.saveConflict(key, relative, local, state, remote, bytes);
        return true;
      }
    }
    const base = state.base;
    if (!remote && base) throw new Error('服务器缺少已同步文件的版本记录：' + relative);
    if (remote && base && remote.revision <= base.row.revision && !sameRevision(base.row, remote)) {
      throw new Error('服务器版本回退或校验不一致：' + relative);
    }
    if (remote && local.sha256 === remote.sha256) {
      if (base?.row.revision !== remote.revision || state.conflict || state.intent || state.resolution) {
        const bytes = this.readLocal(relative, local);
        this.save(key, { base: this.version(remote, bytes) });
      }
      return true;
    }
    if (state.conflict) return true;
    if (!remote && local.sha256 === null) return true;
    if (state.resolution && remote && (!sameRevision(base?.row, remote) || state.resolution.local !== local.sha256)) {
      const bytes = await this.download(remote);
      this.saveConflict(key, relative, local, state, remote, bytes);
      return true;
    }

    if (!remote || sameRevision(base?.row, remote)) {
      if (local.sha256 === null && remote?.sha256 && !state.resolution) {
        const since = this.missingSince.get(key);
        if (since === undefined) this.missingSince.set(key, Date.now());
        if (since === undefined || Date.now() - since < 250) {
          this.wake();
          return false;
        }
      }
      const bytes = this.readLocal(relative, local);
      const row = await this.upload(relative, remote, bytes);
      if (!this.lifetime.signal.aborted) {
        this.missingSince.delete(key);
        this.save(key, { base: this.version(row, bytes) });
      }
      return true;
    }
    const initialCheckout = !base && (local.sha256 === null || (local.size === 0 && remote.sha256 !== null));
    if ((base && base.row.sha256 === local.sha256) || initialCheckout) {
      const bytes = await this.download(remote);
      if (this.lifetime.signal.aborted) return false;
      const intent = this.stageProjection(key, state, local, this.version(remote, bytes), bytes);
      return this.project(key, relative, intent);
    }

    const shared = await this.download(remote);
    const disk = this.readLocal(relative, local);
    const localText = disk === undefined ? undefined : readUtf8(relative, disk);
    const remoteText = shared === undefined ? undefined : readUtf8(relative, shared);
    const merged = base?.text === undefined || localText === undefined || remoteText === undefined
      ? undefined : mergeText(base.text, localText, remoteText);
    if (merged === undefined) {
      this.saveConflict(key, relative, local, state, remote, shared);
      return true;
    }

    if (this.options.isDirty(relative) || this.inspect(relative, false).sha256 !== local.sha256) throw new Retry();
    const row = await this.upload(relative, remote, merged);
    if (this.lifetime.signal.aborted) return false;
    const intent = this.stageProjection(key, state, local, this.version(row, merged), merged);
    return this.project(key, relative, intent);
  }

  private async reconcile(): Promise<void> {
    if (this.running || this.lifetime.signal.aborted) return;
    this.running = true;
    this.awakened = false;
    try {
      const { files: remote, seq } = await this.manifest();
      if (this.lifetime.signal.aborted) return;
      // 快照之后才收到的增量必须留着：它们比这次 manifest 新。
      this.carry(remote);
      const local = this.scan();
      const keys = new Set([...local.keys(), ...remote.keys(), ...this.checkouts.keys()]);
      let settled = true;
      let firstError: string | undefined;
      for (const key of keys) {
        if (this.lifetime.signal.aborted) return;
        const sourceKey = key.endsWith('.pdf') ? key.slice(0, -4) + '.tex' : undefined;
        if (sourceKey && (local.has(sourceKey) || remote.get(sourceKey)?.sha256)) continue;
        const row = remote.get(key);
        const checkout = this.checkouts.get(key);
        const relative = local.get(key) ?? row?.path ?? checkout?.base?.row.path ?? checkout?.intent?.after.row.path;
        if (!relative) continue;
        try {
          if (!await this.reconcileFile(key, relative, row)) settled = false;
        } catch (error) {
          if (error instanceof Offline) throw error;
          if (error instanceof Retry) settled = false;
          else firstError ??= relative + '：' + errorMessage(error);
        }
      }
      this.failures = 0;
      this.retryAt = 0;
      // §3.2：全量对齐完成 → 把水位校准到响应头里的 head。
      this.advanceSeq(seq);
      this.primed = true;
      const conflicts = [...this.checkouts.values()].filter(item => item.conflict).length;
      const files = [...remote.values()].filter(row => row.sha256 !== null).length;
      this.publish(firstError ? 'Error' : conflicts ? 'Conflict' : settled ? 'Saved' : 'Syncing', files, firstError);
    } catch (error) {
      this.failures++;
      this.retryAt = Date.now() + Math.min(5000, POLL_MS * 2 ** this.failures);
      const offline = error instanceof Offline;
      this.publish(offline && this.pushing ? 'Reconnecting' : offline ? 'Offline' : 'Error',
        this.current.files, errorMessage(error));
    } finally {
      this.running = false;
      this.schedule(this.awakened ? DEBOUNCE_MS : this.pollDelay());
    }
  }

  /** 定时/推送的统一入口：有明确的全量请求就跑整轮，否则只应用增量。 */
  private async pump(): Promise<void> {
    if (this.lifetime.signal.aborted) return;
    if (!this.primed || this.fullRequested || !this.pending.size) {
      this.fullRequested = false;
      await this.reconcile();
      if (this.pending.size) this.schedule(PENDING_RETRY_MS, true);
      return;
    }
    await this.applyPending();
  }

  /**
   * 只对推送涉及的 path 调 `reconcileFile`（不再整轮拉清单）。
   * 校验强度与全量路径完全一致：走的还是同一个 reconciler。
   */
  private async applyPending(): Promise<void> {
    if (this.running || this.lifetime.signal.aborted) return;
    this.running = true;
    this.awakened = false;
    const batch = [...this.pending];
    this.pending.clear();
    const seq = this.pendingSeq;
    this.pendingSeq = 0;
    const requeue: Array<[string, FileRevision]> = [];
    let settled = true;
    let firstError: string | undefined;
    try {
      const names = this.localNames();
      for (let index = 0; index < batch.length; index++) {
        if (this.lifetime.signal.aborted) return;
        const [key, row] = batch[index];
        const relative = names.get(key) ?? row.path;
        try {
          if (this.redundant(key, row)) continue;
          if (!await this.reconcileFile(key, relative, row)) settled = false;
        } catch (error) {
          if (error instanceof Offline || error instanceof Retry) {
            // 未应用的项留在队列里，本轮结束后立刻重排；水位照常推进（不丢工作量）。
            requeue.push(...batch.slice(index));
            if (error instanceof Offline) throw error;
            settled = false;
            break;
          }
          firstError ??= relative + '：' + errorMessage(error);
        }
      }
      this.failures = 0;
      this.retryAt = 0;
      const conflicts = [...this.checkouts.values()].filter(item => item.conflict).length;
      this.publish(firstError ? 'Error' : conflicts ? 'Conflict' : settled ? 'Saved' : 'Syncing', this.current.files, firstError);
    } catch (error) {
      const offline = error instanceof Offline;
      if (!offline) {
        this.failures++;
        this.retryAt = Date.now() + PENDING_RETRY_MS;
      }
      this.publish(offline && this.pushing ? 'Reconnecting' : offline ? 'Offline' : 'Error',
        this.current.files, errorMessage(error));
    } finally {
      for (const [key, row] of requeue) this.pending.set(key, row);
      this.running = false;
      if (this.pending.size) this.schedule(PENDING_RETRY_MS, true);
      else this.schedule(this.awakened ? DEBOUNCE_MS : this.pollDelay());
      // 已应用（或已回队）完毕才确认水位：崩溃时服务端会从旧水位重放，redundant() 会过滤重复。
      if (seq > 0) this.channel?.confirm(seq);
    }
  }

  /** 推送来的增量：只记录相关 path，不立刻整轮重建。 */
  private receiveChanges(seq: number, changes: RemoteChange[]): void {
    if (this.lifetime.signal.aborted || !this.started) return;
    let rebuild = false;
    for (const change of changes) {
      if (!isProjectPath(change.path)) continue;
      const row = this.changeRow(change);
      if (!row || this.pending.size >= MANIFEST_LIMIT) {
        // 事件本身不自洽（或攒得太多）→ 退回整轮清单，绝不做半套应用。
        rebuild = true;
        break;
      }
      this.pending.set(keyFor(change.path), row);
    }
    if (rebuild) {
      this.fullRequested = true;
      this.pending.clear();
      this.pendingSeq = 0;
    } else {
      this.pendingSeq = Math.max(this.pendingSeq, seq);
    }
    if (this.running) this.awakened = true;
    else this.schedule(DEBOUNCE_MS, true);
  }

  /** §3.1/§6：日志不覆盖 since 或序号缺口 → 整轮 manifest 重建。 */
  private receiveReset(head: number): void {
    if (this.lifetime.signal.aborted) return;
    this.pending.clear();
    this.pendingSeq = 0;
    this.fullRequested = true;
    // 先把水位对齐到服务端 head，避免重连又索要已被裁剪的区间；全量对齐后会再用响应头校准。
    this.setSeq(head);
    if (this.running) this.awakened = true;
    else this.schedule(0);
  }

  /** 链路状态 → 状态栏（推送模式下断线是「重连中」，不是「离线可编辑」）。 */
  private receiveState(state: LinkState, detail?: string): void {
    this.link = state;
    this.pushing = this.channel?.isPushing() ?? false;
    if (this.lifetime.signal.aborted) return;
    if (state === 'offline' && this.pushing) {
      if (this.current.state === 'Error' || this.current.state === 'Conflict') return;
      this.publish('Reconnecting', this.current.files, detail ?? '与协作服务器的连接中断，正在自动重连。');
      return;
    }
    if (state === 'online' && this.current.state === 'Reconnecting') {
      this.publish('Syncing', this.current.files);
    }
  }

  /** `/v1/config` 成功 → 启用 v1 提交/分片/Range，并采用服务端的分片策略。 */
  private receiveCapabilities(capabilities: Capabilities): void {
    this.features = new Set(capabilities.features);
    this.chunkBytes = capabilities.chunkBytes;
    this.chunkConcurrency = capabilities.maxChunkConcurrency;
    this.partRetry = capabilities.partRetry;
    this.commit = 'v1';
  }

  /** 删除事件的等价物是 0.2 的墓碑行（sha256=null/size=0），reconciler 已能处理。 */
  private changeRow(change: RemoteChange): FileRevision | undefined {
    const row: FileRevision = change.deleted
      ? { path: change.path, revision: change.revision, sha256: null, size: 0 }
      : { path: change.path, revision: change.revision, sha256: change.sha256, size: change.size };
    return isRevision(row) ? row : undefined;
  }

  /** 重复投递/过期事件：快照已经比它新，直接跳过（不算失败，也不报错）。 */
  private redundant(key: string, row: FileRevision): boolean {
    const base = this.checkouts.get(key)?.base?.row;
    if (!base) return false;
    if (row.revision < base.revision) return true;
    return row.revision === base.revision && row.sha256 === base.sha256;
  }

  /** 全量快照之后仍比快照新的增量保留下来（其余由快照覆盖）。 */
  private carry(remote: Map<string, FileRevision>): void {
    if (!this.pending.size) return;
    const late = new Map<string, FileRevision>();
    for (const [key, row] of this.pending) {
      const snapshot = remote.get(key);
      if (!snapshot || row.revision > snapshot.revision) late.set(key, row);
    }
    this.pending.clear();
    for (const [key, row] of late) this.pending.set(key, row);
  }

  /** 增量路径需要的本地文件名（大小写不敏感平台要保住磁盘上的原始大小写）。 */
  private localNames(): Map<string, string> {
    const now = Date.now();
    if (this.names && now - this.names.at < 1000) return this.names.map;
    let map: Map<string, string>;
    try {
      map = this.scan();
    } catch {
      map = new Map();
    }
    this.names = { at: now, map };
    return map;
  }

  /** 推送可用时用兜底全量自证；降级时回到 0.2 的节奏（loopback 650 ms / 远程 3000 ms）。 */
  private pollDelay(): number {
    return this.pushing ? SAFETY_POLL_MS : fallbackPollMs(isLoopbackEndpoint(this.options.endpoint));
  }

  private setSeq(seq: number): void {
    if (!Number.isSafeInteger(seq) || seq < 0 || seq === this.lastSeq) return;
    this.lastSeq = seq;
    this.channel?.setSeq(seq);
    this.persistSequence(seq);
  }

  private advanceSeq(seq: number | undefined): void {
    if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq <= this.lastSeq) return;
    this.setSeq(seq);
  }

  /** §6.6：水位与 `base.row.revision` 同目录落盘，重启后从它续传。 */
  private persistSequence(seq: number): void {
    try {
      writeAtomic(path.join(this.checkoutDir, SEQUENCE_FILE), JSON.stringify({ seq, at: new Date().toISOString() }));
    } catch {
      // 水位只是重连起点：写失败不影响本轮同步，下次全量对齐会重新校准。
    }
  }

  private loadSequence(): number {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(this.checkoutDir, SEQUENCE_FILE), 'utf8')) as { seq?: unknown };
      return Number.isSafeInteger(raw.seq) && (raw.seq as number) >= 0 ? (raw.seq as number) : 0;
    } catch {
      return 0;
    }
  }
}
