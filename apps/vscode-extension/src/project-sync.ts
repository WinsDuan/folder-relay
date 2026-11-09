import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { patches, type TextPatch } from './editor-model.js';

const FILE_LIMIT = 16 * 1024 * 1024;
const TEXT_MERGE_LIMIT = 1024 * 1024;
const MANIFEST_LIMIT = 4096;
const POLL_MS = 650;
const DEBOUNCE_MS = 150;
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
  state: 'Starting' | 'Syncing' | 'Saved' | 'Offline' | 'Conflict' | 'Error' | 'Disconnected';
  files: number;
  conflicts: number;
  error?: string;
}

class Offline extends Error {}
class Retry extends Error {}

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
  private watcher?: fs.FSWatcher;
  private timer?: ReturnType<typeof setTimeout>;
  private scheduledAt = 0;
  private running = false;
  private awakened = false;
  private started = false;
  private failures = 0;
  private retryAt = 0;
  private current: ProjectStatus = { state: 'Starting', files: 0, conflicts: 0 };

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
        if (!filename || isProjectPath(filename.split(path.sep).join('/'))) this.wake();
      });
      this.watcher.on('error', () => this.watcher?.close());
    } catch {
      // Periodic reconciliation still catches external changes when watch is unavailable.
    }
    this.schedule(0);
  }

  wake(): void {
    if (!this.started || this.lifetime.signal.aborted) return;
    if (this.running) {
      this.awakened = true;
    } else {
      this.schedule(DEBOUNCE_MS, true);
    }
  }

  dispose(): void {
    this.lifetime.abort();
    clearTimeout(this.timer);
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
      void this.reconcile();
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

  private async request(url: URL, init: RequestInit = {}): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(url, {
        ...init,
        headers: { ...init.headers, Authorization: 'Bearer ' + this.options.token },
        redirect: 'error',
        signal: AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(15000)]),
      });
    } catch {
      throw new Offline('协作服务器暂不可用，本地文件会保留并自动重试。');
    }
    if (response.ok) return response;
    await response.body?.cancel();
    if (response.status === 412) throw new Retry();
    if (response.status === 401 || response.status === 403) throw new Error('共享工作区令牌未通过验证。');
    if (response.status === 404) throw new Error('找不到共享工作区或工作区接口，请检查工作区 ID 和服务版本。');
    if (response.status === 507) throw new Error('共享工作区已达到容量上限。');
    if (response.status >= 500) throw new Offline('协作服务器暂不可用，本地文件会保留并自动重试。');
    throw new Error('协作服务器拒绝了文件同步（HTTP ' + response.status + '）。');
  }

  private async manifest(): Promise<Map<string, FileRevision>> {
    const response = await this.request(this.url());
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
    return result;
  }

  private async download(row: FileRevision): Promise<Buffer | undefined> {
    if (row.sha256 === null) return;
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

  private async upload(relative: string, before: FileRevision | undefined, bytes: Buffer | undefined): Promise<FileRevision> {
    const response = await this.request(this.url(before?.path ?? relative), {
      method: bytes === undefined ? 'DELETE' : 'PUT',
      headers: { 'If-Match': '"' + (before?.revision ?? 0) + '"', 'Content-Type': 'application/octet-stream' },
      body: bytes === undefined ? undefined : new Uint8Array(bytes),
    });
    const row: unknown = await response.json();
    if (!isRevision(row) || keyFor(row.path) !== keyFor(relative) || row.revision < (before?.revision ?? 0)
      || row.sha256 !== (bytes === undefined ? null : hash(bytes)) || row.size !== (bytes?.length ?? 0)) {
      throw new Error('服务器的保存回执与写入文件不一致。');
    }
    return row;
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

  private project(key: string, relative: string, intent: Projection): void {
    if (this.lifetime.signal.aborted || this.options.isDirty(relative) || this.inspect(relative, false).sha256 !== intent.before) {
      throw new Retry();
    }
    const bytes = intent.payload === undefined ? undefined : fs.readFileSync(path.join(this.checkoutDir, intent.payload + '.project'));
    const { row } = intent.after;
    if ((bytes === undefined ? null : hash(bytes)) !== row.sha256 || (bytes?.length ?? 0) !== row.size) {
      throw new Error('本地同步暂存文件校验失败。');
    }
    const file = this.localPath(relative, bytes !== undefined);
    const target = lstat(file);
    if (target && (target.isSymbolicLink() || !target.isFile())) {
      throw new Error('本地目录或链接挡住了共享文件：' + relative);
    }
    if (bytes !== undefined) writeAtomic(file, bytes);
    else if (target) fs.unlinkSync(file);
    this.fingerprints.delete(relative);
    this.save(key, { base: intent.after });
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
    if (local.sha256 !== null) this.missingSince.delete(key);
    let state = this.checkouts.get(key) ?? {};
    if (state.intent) {
      const { before, after } = state.intent;
      if (local.sha256 === after.row.sha256) {
        state = { base: after };
        this.save(key, state);
      } else if (local.sha256 === before && remote) {
        this.project(key, relative, state.intent);
        return sameRevision(after.row, remote);
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
        if (since === undefined || Date.now() - since < 250) return false;
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
      this.project(key, relative, intent);
      return true;
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
    this.project(key, relative, intent);
    return true;
  }

  private async reconcile(): Promise<void> {
    if (this.running || this.lifetime.signal.aborted) return;
    this.running = true;
    this.awakened = false;
    try {
      const remote = await this.manifest();
      if (this.lifetime.signal.aborted) return;
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
      const conflicts = [...this.checkouts.values()].filter(item => item.conflict).length;
      const files = [...remote.values()].filter(row => row.sha256 !== null).length;
      this.publish(firstError ? 'Error' : conflicts ? 'Conflict' : settled ? 'Saved' : 'Syncing', files, firstError);
    } catch (error) {
      this.failures++;
      this.retryAt = Date.now() + Math.min(5000, POLL_MS * 2 ** this.failures);
      this.publish(error instanceof Offline ? 'Offline' : 'Error', this.current.files, errorMessage(error));
    } finally {
      this.running = false;
      this.schedule(this.awakened ? DEBOUNCE_MS : POLL_MS);
    }
  }
}
