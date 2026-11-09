import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import WebSocket from 'ws';
import * as Y from 'yjs';
import * as vscode from 'vscode';
import { canonical, EditorModel, patches } from './editor-model.js';
import { registerProjectCommands } from './project-session.js';

const DEFAULT_URL = 'ws://127.0.0.1:1234';
const DEFAULT_ID = '11111111-1111-4111-8111-111111111111';
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_CACHE_BYTES = 16 * 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONFLICT_SCHEME = 'lsw-conflict';
const CONFLICT_COPIES = ['shared.tex', 'editor.tex', 'disk.tex'];
const DISK_CONFLICT = 'The external disk edit could not be matched to the saved shared version.';

interface ConnectOptions {
  url?: string;
  documentId?: string;
  token?: string;
  file?: string | vscode.Uri;
  acceptRemote?: boolean;
}

interface DiskState {
  bytes: Buffer;
  digest: string;
  text: string;
}

interface DiskImport {
  base: string;
  digest: string;
  deadline: number;
  timer?: ReturnType<typeof setTimeout>;
}

interface Projection {
  snapshot: Uint8Array;
  target: string;
  version: number;
  candidate: boolean;
  laterEdits: string[];
}

type Label = 'Connecting' | 'Syncing' | 'Saved' | 'Offline' | 'Conflict' | 'Disconnected';

function sha256(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function validateUrl(value: string): URL {
  const url = new URL(value);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && loopback)) {
    throw new Error('Use wss:// for a remote server or ws:// for a loopback server.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('Use a server URL without credentials, a query string, or a fragment.');
  }
  return url;
}

function showJoinEntry(bar: vscode.StatusBarItem): void {
  bar.text = '$(plug) LSW 连接工作区';
  bar.command = 'lsw.joinProject';
  bar.tooltip = '打开共享工作区连接窗口';
}

function readDisk(file: string): DiskState {
  if (fs.statSync(file).size > MAX_TEXT_BYTES) throw new Error('The file exceeds 1 MiB.');
  const bytes = fs.readFileSync(file);
  if (bytes.length > MAX_TEXT_BYTES) throw new Error('The file exceeds 1 MiB.');
  const text = canonical(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  return { bytes, digest: sha256(bytes), text };
}

function saveCache(file: string, update: Uint8Array): void {
  if (update.byteLength > MAX_CACHE_BYTES) throw new Error('The local update cache exceeds its size limit.');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    const descriptor = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(descriptor, update);
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function nativeOffset(canonicalText: string, offset: number, crlf: boolean): number {
  if (!crlf) return offset;
  let result = offset;
  for (let index = 0; index < offset; index++) {
    if (canonicalText.charCodeAt(index) === 10) result++;
  }
  return result;
}

async function chooseConflict(storage: string): Promise<string | undefined> {
  const root = path.join(storage, 'conflicts');
  if (!fs.existsSync(root)) return;
  const choices = fs.readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && UUID.test(entry.name))
    .flatMap(entry => {
      const directory = path.join(root, entry.name);
      const shared = path.join(directory, 'shared.tex');
      if (!fs.existsSync(shared)) return [];
      const timestamp = fs.statSync(shared).mtimeMs;
      return [{
        id: entry.name,
        timestamp,
        label: new Date(timestamp).toLocaleString(),
        description: entry.name,
      }];
    }).sort((a, b) => b.timestamp - a.timestamp);
  if (!choices.length) return;
  return (await vscode.window.showQuickPick(choices, { placeHolder: '选择要查看的 LSW 冲突记录' }))?.id;
}

async function showConflictDiff(storage: string, id: string): Promise<void> {
  if (!UUID.test(id)) throw new Error('Invalid LSW conflict ID.');
  const directory = path.join(storage, 'conflicts', id);
  const hasDisk = fs.existsSync(path.join(directory, 'disk.tex'));
  const copy = (file: string) => vscode.Uri.from({ scheme: CONFLICT_SCHEME, path: '/' + id + '/' + file });
  await vscode.commands.executeCommand(
    'vscode.diff', copy('shared.tex'), copy(hasDisk ? 'disk.tex' : 'editor.tex'),
    hasDisk ? 'LSW 冲突 · 左侧共享版，右侧磁盘版' : 'LSW 冲突 · 左侧共享版，右侧编辑器版',
    { preview: false },
  );
}

class Session implements vscode.Disposable {
  private readonly model = new EditorModel();
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly cacheFile: string;
  private socket?: HocuspocusProviderWebsocket;
  private provider?: HocuspocusProvider;
  private proofTimer?: ReturnType<typeof setInterval>;
  private disk: DiskState;
  private diskImport?: DiskImport;
  private saving?: { text: string; deadline: number };
  private expected?: Projection;
  private projectionQueued = false;
  private polling = false;
  private attached = false;
  private disposed = false;
  private authenticated = false;
  private confirmed?: string;
  private aiBase?: string;
  private revision = 0;
  private conflict?: string;
  conflictId?: string;
  private cancelInitial?: (error?: Error) => void;

  constructor(
    private readonly document: vscode.TextDocument,
    private readonly url: URL,
    private readonly documentId: string,
    private readonly token: string,
    private readonly storage: string,
    private readonly statusBar: vscode.StatusBarItem,
  ) {
    this.disk = readDisk(document.uri.fsPath);
    this.cacheFile = path.join(storage, 'updates', sha256(JSON.stringify([
      url.href, documentId, document.uri.fsPath,
    ])) + '.yjs');
  }

  async start(acceptRemote: boolean | undefined): Promise<void> {
    if (fs.existsSync(this.cacheFile)) {
      if (fs.statSync(this.cacheFile).size > MAX_CACHE_BYTES) throw new Error('The local cache exceeds its size limit.');
      Y.applyUpdate(this.model.network, fs.readFileSync(this.cacheFile));
    }

    this.model.network.on('update', () => {
      this.revision++;
      this.confirmed = undefined;
      try {
        saveCache(this.cacheFile, this.model.snapshot());
      } catch {
        // Stop the already registered update listener from sending this edit.
        this.provider?.detach();
        this.pause('Local cache write failed. Synchronization stopped before another update could be sent.');
        return;
      }
      this.refresh();
      this.queueProjection();
    });
    this.refresh();

    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timeout);
        this.cancelInitial = undefined;
        if (error) reject(error);
        else resolve();
      };
      const timeout = setTimeout(() => finish(new Error('Timed out waiting for the server to synchronize.')), 15000);
      this.cancelInitial = finish;
      this.socket = new HocuspocusProviderWebsocket({
        url: this.url.href,
        autoConnect: false,
        WebSocketPolyfill: WebSocket,
      });
      this.provider = new HocuspocusProvider({
        websocketProvider: this.socket,
        name: this.documentId,
        document: this.model.network,
        token: this.token,
        onAuthenticated: () => {
          this.authenticated = true;
          this.refresh();
        },
        onAuthenticationFailed: () => {
          const error = new Error('The server rejected the workspace token or document ID.');
          if (this.cancelInitial) this.cancelInitial(error);
          else this.pause(error.message);
        },
        onSynced: () => {
          this.cancelInitial?.();
          this.refresh();
          this.queueProjection();
        },
        onClose: () => {
          this.authenticated = false;
          this.confirmed = undefined;
          this.refresh();
        },
        onStatus: () => this.refresh(),
      });
      this.provider.attach();
      void this.socket.connect().catch(() => {
        // The provider retries until its connection is destroyed or the initial timeout expires.
      });
    });
    if (this.disposed || this.conflict) throw new Error('The synchronization session stopped.');
    this.installListeners();

    const original = canonical(this.document.getText());
    const version = this.document.version;
    if (original !== this.model.current) {
      this.preserve('Local content differs from the shared document at connection.');
      let approved = acceptRemote;
      if (approved === undefined) {
        approved = await vscode.window.showWarningMessage(
          'Local content differs from the shared version. Local copies were kept in LSW storage.',
          { modal: true }, 'Load Shared Version',
        ) === 'Load Shared Version';
      }
      if (!approved) throw new Error('Local content differs from the shared version.');
      if (this.document.version !== version || !this.checkDisk()) {
        throw new Error('The local document changed while waiting for confirmation.');
      }
      const applied = await this.applyProjection(original, this.model.current, this.model.snapshot());
      if (!applied) throw new Error('The local document changed during connection.');
    } else {
      this.model.project(this.model.snapshot());
    }

    if (this.disposed || this.conflict) throw new Error('The synchronization session stopped.');
    if (canonical(this.document.getText()) !== this.model.projected) {
      throw new Error('The local document changed during connection.');
    }
    this.attached = true;
    this.queueProjection();
    this.proofTimer = setInterval(() => void this.checkPersistence(), 600);
    void this.checkPersistence();
    this.refresh();
  }

  private installListeners(): void {
    const file = this.document.uri.fsPath;
    const watcher = fs.watch(path.dirname(file), (_, changed) => {
      if (!changed || changed === path.basename(file)) this.checkDisk();
    });
    watcher.on('error', () => this.pause('The local file watcher failed.'));
    this.subscriptions.push(
      new vscode.Disposable(() => watcher.close()),
      vscode.workspace.onDidChangeTextDocument(event => {
        if (event.document !== this.document || !event.contentChanges.length || this.conflict || this.disposed) return;
        const next = canonical(event.document.getText());
        if (this.diskImport && event.document.isDirty) {
          this.pause(DISK_CONFLICT);
          return;
        }
        if (event.document.isDirty && this.saving && this.saving.deadline > Date.now()) this.saving.text = next;
        if (!this.checkDisk()) return;
        const expected = this.expected;
        if (expected?.candidate) {
          expected.laterEdits.push(next);
          return;
        }
        if (expected && next === expected.target && event.document.version === expected.version + 1) {
          // An identical native edit can race with a projection. Wait for the
          // version-checked applyEdit result before deciding which event it was.
          expected.candidate = true;
          return;
        }
        if (!this.attached) return;
        this.edit(next);
      }),
      vscode.workspace.onWillSaveTextDocument(event => {
        if (event.document === this.document && this.checkDisk()) {
          this.saving = { text: canonical(event.document.getText()), deadline: Date.now() + 5000 };
        }
      }),
      vscode.workspace.onDidSaveTextDocument(document => {
        if (document !== this.document || this.conflict || this.disposed) return;
        this.checkDisk();
        this.saving = undefined;
        this.refresh();
      }),
      vscode.workspace.onDidCloseTextDocument(document => {
        if (document === this.document) this.dispose();
      }),
    );
  }

  private edit(next: string): void {
    if (this.disposed || this.conflict) return;
    if (Buffer.byteLength(next) > MAX_TEXT_BYTES) {
      this.pause('The local document exceeds the 1 MiB synchronization limit.');
      return;
    }
    try {
      this.model.edit(next);
      this.queueProjection();
    } catch {
      this.pause('The editor change could not be safely synchronized.');
    }
  }

  prepareAiEdit(): void {
    const status = this.status();
    if (status.state !== 'Saved' || !status.localSaved
      || readDisk(this.document.uri.fsPath).digest !== this.disk.digest) {
      throw new Error('等状态栏显示 LSW Saved，并按 Ctrl+S 保存当前文件后再准备 AI 修改。');
    }
    this.aiBase = this.confirmed;
    this.refresh();
  }

  private checkDisk(): boolean {
    if (this.disposed || this.conflict || this.diskImport) return false;
    try {
      const disk = readDisk(this.document.uri.fsPath);
      if (disk.digest === this.disk.digest) return true;
      if (this.saving && Date.now() <= this.saving.deadline && disk.text === this.saving.text) {
        this.disk = disk;
        return true;
      }
      const base = this.confirmed;
      if (!base || this.aiBase !== base || !this.attached || !this.authenticated || !this.provider?.synced || this.expected
        || this.document.isDirty || this.model.current !== this.disk.text || this.model.projected !== this.disk.text) {
        this.pause(DISK_CONFLICT);
        return false;
      }
      const pending = { base, digest: disk.digest, deadline: Date.now() + 3000 };
      this.diskImport = pending;
      this.scheduleDiskImport(pending);
      this.refresh();
    } catch {
      this.pause('The local file was removed or cannot be read as UTF-8.');
    }
    return false;
  }

  private scheduleDiskImport(pending: DiskImport): void {
    pending.timer = setTimeout(() => void this.importDisk(pending), 150);
  }

  private async importDisk(pending: DiskImport): Promise<void> {
    if (this.diskImport !== pending || this.disposed || this.conflict) return;
    try {
      const disk = readDisk(this.document.uri.fsPath);
      const visible = canonical(this.document.getText());
      if (!this.authenticated || !this.provider?.synced || this.document.isDirty
        || this.confirmed !== pending.base || Date.now() > pending.deadline) {
        throw new Error(DISK_CONFLICT);
      }
      // Wait for the write to settle and for VS Code's clean buffer to reload.
      if (disk.digest !== pending.digest || (visible === this.disk.text && visible !== disk.text)) {
        pending.digest = disk.digest;
        this.scheduleDiskImport(pending);
        return;
      }
      if (visible !== disk.text) throw new Error(DISK_CONFLICT);

      if (disk.text !== this.disk.text) {
        const version = this.document.version;
        const response = await fetch(this.endpoint('/disk-edit'), {
          method: 'POST',
          headers: {
            Authorization: 'Bearer ' + this.token,
            'If-Match': '"' + pending.base + '"',
            'Content-Type': 'text/plain; charset=utf-8',
          },
          body: disk.text,
          signal: AbortSignal.timeout(5000),
          redirect: 'error',
        });
        const length = Number(response.headers.get('content-length'));
        if (!response.ok || !Number.isSafeInteger(length) || length < 2 || length > MAX_CACHE_BYTES) {
          await response.body?.cancel();
          throw new Error(DISK_CONFLICT);
        }
        const snapshot = new Uint8Array(await response.arrayBuffer());
        if (this.diskImport !== pending || this.disposed || this.conflict) return;
        if (snapshot.byteLength !== length || sha256(snapshot) !== response.headers.get('x-lsw-sha256')
          || this.document.isDirty || this.document.version !== version
          || readDisk(this.document.uri.fsPath).digest !== disk.digest) {
          throw new Error(DISK_CONFLICT);
        }
        // Use the accepted snapshot as the mirror's baseline. The network may
        // already contain later peer edits, which are projected separately.
        Y.applyUpdate(this.model.network, snapshot, this.provider);
        if (this.conflict) return;
        this.model.project(snapshot);
        if (this.model.projected !== disk.text) throw new Error(DISK_CONFLICT);
        this.aiBase = sha256(snapshot);
      }

      this.disk = disk;
      this.diskImport = undefined;
      this.queueProjection();
      void this.checkPersistence();
    } catch {
      this.pause(DISK_CONFLICT);
    } finally {
      this.refresh();
    }
  }

  private queueProjection(): void {
    if (!this.attached || this.disposed || this.conflict || this.diskImport || this.projectionQueued) return;
    this.projectionQueued = true;
    setTimeout(async () => {
      let retry = false;
      try {
        if (this.disposed || this.conflict || !this.checkDisk()) return;
        const before = this.model.projected;
        const after = this.model.current;
        if (before === after) {
          this.model.project(this.model.snapshot());
          return;
        }
        if (canonical(this.document.getText()) !== before) {
          this.pause('The editor buffer changed outside a tracked transaction.');
          return;
        }
        if (Buffer.byteLength(after) > MAX_TEXT_BYTES) {
          this.pause('The shared document exceeds the 1 MiB synchronization limit.');
          return;
        }
        const version = this.document.version;
        const applied = await this.applyProjection(before, after, this.model.snapshot());
        if (!applied && this.document.version === version) {
          this.pause('VS Code could not apply the remote edit.');
          return;
        }
        retry = true;
      } catch {
        this.pause('The remote edit could not be applied safely.');
      } finally {
        this.projectionQueued = false;
        this.refresh();
        if (retry && this.model.current !== this.model.projected) this.queueProjection();
      }
    }, 0);
  }

  private async applyProjection(before: string, after: string, snapshot: Uint8Array): Promise<boolean> {
    const pending: Projection = {
      snapshot, target: after, version: this.document.version, candidate: false, laterEdits: [],
    };
    this.expected = pending;
    const edit = new vscode.WorkspaceEdit();
    const crlf = this.document.eol === vscode.EndOfLine.CRLF;
    for (const change of patches(before, after)) {
      const start = this.document.positionAt(nativeOffset(before, change.offset, crlf));
      const end = this.document.positionAt(nativeOffset(before, change.offset + change.remove, crlf));
      const value = crlf ? change.insert.replace(/\n/g, '\r\n') : change.insert;
      edit.replace(this.document.uri, new vscode.Range(start, end), value);
    }
    try {
      const applied = await vscode.workspace.applyEdit(edit);
      if (this.disposed || this.conflict) return false;
      if (pending.candidate) {
        if (applied) this.model.project(pending.snapshot);
        else if (this.attached) this.edit(pending.target);
        if (this.attached) {
          for (const next of pending.laterEdits) this.edit(next);
        }
        return applied;
      }
      if (applied && canonical(this.document.getText()) === after) {
        this.model.project(snapshot);
        return true;
      }
      return false;
    } finally {
      this.expected = undefined;
    }
  }

  private endpoint(pathname: string): URL {
    const endpoint = new URL(this.url.href);
    endpoint.protocol = endpoint.protocol === 'wss:' ? 'https:' : 'http:';
    endpoint.pathname = pathname;
    endpoint.searchParams.set('document', this.documentId);
    return endpoint;
  }

  private async checkPersistence(): Promise<void> {
    if (this.polling || !this.authenticated || !this.provider?.synced || this.disposed || this.conflict || this.diskImport) return;
    this.polling = true;
    const revision = this.revision;
    const digest = sha256(this.model.snapshot());
    try {
      const response = await fetch(this.endpoint('/persisted'), {
        headers: { Authorization: 'Bearer ' + this.token },
        signal: AbortSignal.timeout(1500),
        redirect: 'error',
      });
      const proof = response.ok ? await response.json() as { sha256?: string } : undefined;
      if (revision === this.revision && this.authenticated && !this.disposed && !this.conflict && !this.diskImport) {
        this.confirmed = proof?.sha256 === digest ? digest : undefined;
      }
    } catch {
      if (!this.diskImport) this.confirmed = undefined;
    } finally {
      this.polling = false;
      this.refresh();
    }
  }

  private preserve(reason: string): string {
    const directory = path.join(this.storage, 'conflicts', randomUUID());
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(directory, 'editor.tex'), this.document.getText(), { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(path.join(directory, 'shared.tex'), this.model.current, { flag: 'wx', mode: 0o600 });
    fs.writeFileSync(path.join(directory, 'last-known-disk.tex'), this.disk.bytes, { flag: 'wx', mode: 0o600 });
    try {
      if (fs.statSync(this.document.uri.fsPath).size <= MAX_TEXT_BYTES) {
        fs.writeFileSync(path.join(directory, 'disk.tex'), fs.readFileSync(this.document.uri.fsPath), { flag: 'wx', mode: 0o600 });
      }
    } catch {
      // A removed or unreadable file has no new disk version to record.
    }
    fs.writeFileSync(path.join(directory, 'reason.txt'), reason, { flag: 'wx', mode: 0o600 });
    return directory;
  }

  private pause(reason: string): void {
    if (this.conflict || this.disposed) return;
    this.conflict = reason;
    clearTimeout(this.diskImport?.timer);
    this.diskImport = undefined;
    this.authenticated = false;
    this.cancelInitial?.(new Error(reason));
    try {
      this.conflictId = path.basename(this.preserve(reason));
    } catch {
      this.conflict = reason + ' The conflict copies could not be written.';
    }
    this.refresh();
    if (this.conflictId) {
      const id = this.conflictId;
      const detail = reason === DISK_CONFLICT
        ? '外部写入与已保存的共享版本不一致。LSW 已暂停同步，并保留共享版和磁盘版。'
        : 'LSW 已暂停同步。' + reason;
      void vscode.window.showWarningMessage(detail, '对比版本').then(action => {
        if (action === '对比版本') void vscode.commands.executeCommand('lsw.reviewConflict', id);
      });
    } else {
      void vscode.window.showWarningMessage('LSW paused. ' + this.conflict);
    }
    // Do not destroy a provider from inside its own update handler.
    queueMicrotask(() => this.stopTransport());
  }

  private stopTransport(): void {
    this.provider?.destroy();
    this.provider = undefined;
    const connection = this.socket?.webSocket as WebSocket | null | undefined;
    if (connection?.readyState === WebSocket.CONNECTING) {
      // ws emits an error after close() aborts a handshake, after provider
      // teardown has already removed its listeners.
      connection.once('error', () => {});
    }
    this.socket?.destroy();
    this.socket = undefined;
  }

  status() {
    const text = this.document.getText();
    const localSaved = !this.document.isDirty && canonical(text) === this.disk.text;
    const synced = Boolean(this.attached && this.authenticated && this.provider?.synced && !this.conflict);
    let state: Label = 'Syncing';
    if (this.disposed) state = 'Disconnected';
    else if (this.conflict) state = 'Conflict';
    else if (!this.attached) state = 'Connecting';
    else if (!this.authenticated) state = 'Offline';
    else if (synced && !this.diskImport && this.confirmed && this.model.current === this.model.projected) state = 'Saved';
    return {
      connected: this.authenticated && !this.disposed && !this.conflict,
      synced,
      state,
      documentId: this.documentId,
      file: this.document.uri.fsPath,
      text,
      localSaved,
      aiReady: Boolean(localSaved && this.aiBase && this.aiBase === this.confirmed && state === 'Saved'),
      conflict: this.conflict,
    };
  }

  private refresh(): void {
    if (this.disposed) return;
    const { state, localSaved, aiReady } = this.status();
    this.statusBar.text = state === 'Saved'
      ? '$(check) LSW Saved' + (localSaved ? (aiReady ? ' · AI 就绪' : '') : ' · 本地未保存')
      : 'LSW ' + state;
    this.statusBar.command = state === 'Conflict' && this.conflictId ? 'lsw.reviewConflict' : 'lsw.status';
    this.statusBar.tooltip = state === 'Saved'
      ? 'Shared update confirmed on the server. Save the native file separately with Ctrl+S.'
      : state === 'Conflict' ? '点击查看保留的冲突版本' : 'Show LaTeX Sync Workspace status';
    this.statusBar.show();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.authenticated = false;
    this.cancelInitial?.(new Error('The session was disconnected.'));
    clearInterval(this.proofTimer);
    clearTimeout(this.diskImport?.timer);
    this.diskImport = undefined;
    for (const item of this.subscriptions.splice(0)) item.dispose();
    this.stopTransport();
    this.model.destroy();
    showJoinEntry(this.statusBar);
  }
}

export function activate(context: vscode.ExtensionContext) {
  const bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 45);
  showJoinEntry(bar);
  bar.show();
  let active: Session | undefined;
  let connecting = false;
  const storage = context.globalStorageUri.fsPath;
  const getStatus = () => active?.status() ?? { state: 'Disconnected', connected: false, synced: false, localSaved: false };
  const project = registerProjectCommands(context, {
    defaultUrl: DEFAULT_URL,
    defaultId: DEFAULT_ID,
    validateUrl,
    onConnectionChange(joined) {
      if (joined) {
        active?.dispose();
        active = undefined;
        bar.hide();
      } else {
        bar.show();
      }
    },
  });

  context.subscriptions.push(
    bar,
    new vscode.Disposable(() => active?.dispose()),
    vscode.workspace.registerTextDocumentContentProvider(CONFLICT_SCHEME, {
      provideTextDocumentContent(uri) {
        const [id, file, ...rest] = uri.path.slice(1).split('/');
        if (rest.length || !UUID.test(id) || !CONFLICT_COPIES.includes(file)) {
          throw new Error('Invalid LSW conflict copy.');
        }
        return fs.readFileSync(path.join(storage, 'conflicts', id, file), 'utf8');
      },
    }),
    vscode.commands.registerCommand('lsw.connect', async (options?: ConnectOptions) => {
      if (connecting) throw new Error('A connection is already in progress.');
      connecting = true;
      let attempted: Session | undefined;
      try {
        if (project.isJoined()) throw new Error('此文件夹已在自动同步。可使用 LSW: Show Project Status 查看状态。');
        const file = typeof options?.file === 'string' ? vscode.Uri.file(options.file) : options?.file;
        const document = file ? await vscode.workspace.openTextDocument(file) : vscode.window.activeTextEditor?.document;
        if (!document || document.uri.scheme !== 'file' || !document.uri.fsPath.toLowerCase().endsWith('.tex')) {
          throw new Error('Open a saved local .tex file before connecting.');
        }
        const urlText = options
          ? options.url ?? DEFAULT_URL
          : await vscode.window.showInputBox({ title: 'LSW server URL', value: DEFAULT_URL });
        if (urlText === undefined) return;
        const url = validateUrl(urlText.trim());
        const idText = options
          ? options.documentId ?? DEFAULT_ID
          : await vscode.window.showInputBox({ title: 'LSW document ID', value: DEFAULT_ID });
        if (idText === undefined) return;
        const documentId = idText.trim().toLowerCase();
        if (!UUID.test(documentId)) throw new Error('Enter a valid document UUID.');
        const key = 'lsw.token.' + sha256(JSON.stringify([url.href, documentId]));
        const token = options
          ? options.token
          : await vscode.window.showInputBox({ title: 'LSW workspace token', password: true, value: await context.secrets.get(key) });
        if (token === undefined && !options) return;
        if (!token || token.length < 24 || /\s/.test(token)) throw new Error('The token must be at least 24 characters without spaces.');
        if (project.isJoined()) throw new Error('此文件夹已在自动同步。');
        active?.dispose();
        attempted = new Session(document, url, documentId, token, storage, bar);
        active = attempted;
        await attempted.start(options ? options.acceptRemote === true : undefined);
        if (!options) await context.secrets.store(key, token);
        return attempted.status();
      } catch (error) {
        attempted?.dispose();
        if (options) throw error;
        void vscode.window.showErrorMessage(error instanceof Error ? error.message : 'LSW connection failed.');
      } finally {
        connecting = false;
      }
    }),
    vscode.commands.registerCommand('lsw.disconnect', () => {
      active?.dispose();
      active = undefined;
      showJoinEntry(bar);
      return getStatus();
    }),
    vscode.commands.registerCommand('lsw.prepareAiEdit', (options?: { quiet?: boolean }) => {
      try {
        if (!active) throw new Error('请先连接 LSW 共享文档。');
        active.prepareAiEdit();
        if (!options?.quiet) void vscode.window.showInformationMessage('已记录当前共享版本，可以让 AI 修改本地文件。');
        return true;
      } catch (error) {
        if (options?.quiet) throw error;
        void vscode.window.showWarningMessage(error instanceof Error ? error.message : '无法准备 AI 修改。');
        return false;
      }
    }),
    vscode.commands.registerCommand('lsw.reviewConflict', async (requestedId?: string) => {
      try {
        const id = requestedId ?? active?.conflictId ?? await chooseConflict(storage);
        if (id) await showConflictDiff(storage, id);
        else if (!fs.existsSync(path.join(storage, 'conflicts'))) {
          void vscode.window.showInformationMessage('暂无保存的 LSW 冲突记录。');
        }
      } catch (error) {
        void vscode.window.showErrorMessage(error instanceof Error ? error.message : '无法打开 LSW 冲突版本。');
      }
    }),
    vscode.commands.registerCommand('lsw.status', (options?: { quiet?: boolean }) => {
      const status = getStatus();
      if (!options?.quiet) {
        const message = status.state === 'Saved' && !status.localSaved
          ? 'LSW Saved。共享版本已保存，按 Ctrl+S 写入本地文件。'
          : 'LSW ' + status.state;
        void vscode.window.showInformationMessage(message);
      }
      return status;
    }),
  );
  return { getStatus };
}
