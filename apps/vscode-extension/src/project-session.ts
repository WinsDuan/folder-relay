import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import { openConnectionForm } from './connection-form.js';
import { canonical } from './editor-model.js';
import { isProjectPath, ProjectSync, type ProjectConflict, type ProjectStatus } from './project-sync.js';

const ASSOCIATION = 'lsw.projectAssociation';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOKEN = /^[!-~]{24,1024}$/;
const TEXT_LIMIT = 1024 * 1024;
const CONFLICT_SCHEME = 'lsw-project-copy';
const LABELS: Record<ProjectStatus['state'], string> = {
  Starting: '正在打开工作区',
  Syncing: '同步中',
  Saved: '工作区已同步',
  Offline: '离线 · 本地可编辑',
  Conflict: '工作区有冲突',
  Error: '工作区同步遇到问题',
  Disconnected: '工作区未连接',
};

interface Association {
  folder: string;
  url: string;
  workspaceId: string;
}

interface JoinOptions {
  url?: string;
  workspaceId?: string;
  token?: string;
}

interface ProjectCommands {
  defaultUrl: string;
  defaultId: string;
  validateUrl: (url: string) => URL;
  onConnectionChange: (joined: boolean) => void;
}

function httpEndpoint(server: URL): URL {
  const url = new URL(server);
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:';
  return url;
}

function connectionAddress(value: string): string {
  const address = value.trim();
  if (!address) throw new Error('请填写协作服务器地址。');
  if (/^https?:\/\//i.test(address)) return address.replace(/^http/i, 'ws');
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(address)) return address;
  const local = /^(?:127\.0\.0\.1|localhost|\[::1\])(?=[:/]|$)/i.test(address);
  return (local ? 'ws://' : 'wss://') + address;
}

function associationKey(value: Association): string {
  return createHash('sha256').update(JSON.stringify([value.folder, value.url, value.workspaceId])).digest('hex');
}

function tokenKey(value: Association): string {
  const key = createHash('sha256').update(JSON.stringify([value.url, value.workspaceId])).digest('hex');
  return 'lsw.token.' + key;
}

function currentFolder(): vscode.WorkspaceFolder | undefined {
  const folders = vscode.workspace.workspaceFolders;
  return folders?.length === 1 && folders[0].uri.scheme === 'file' ? folders[0] : undefined;
}

class ProjectSession implements vscode.Disposable {
  private readonly sync: ProjectSync;
  private readonly subscriptions: vscode.Disposable[];
  private readonly cleanText = new Map<vscode.TextDocument, string>();
  private readonly saveTimers = new Map<vscode.TextDocument, ReturnType<typeof setTimeout>>();
  private readonly saving = new Set<vscode.TextDocument>();
  private readonly blocked = new Set<vscode.TextDocument>();
  private disposed = false;

  constructor(
    private readonly folder: vscode.WorkspaceFolder,
    association: Association,
    token: string,
    storage: string,
    private readonly refresh: () => void,
  ) {
    this.sync = new ProjectSync({
      root: folder.uri.fsPath,
      storage,
      endpoint: httpEndpoint(new URL(association.url)),
      workspaceId: association.workspaceId,
      token,
      isDirty: relative => vscode.workspace.textDocuments.some(doc =>
        (doc.isDirty || this.saving.has(doc)) && this.projectPath(doc)?.toLowerCase() === relative.toLowerCase()),
      onStatus: () => this.refresh(),
    });
    this.subscriptions = [
      vscode.workspace.onDidOpenTextDocument(doc => this.onEditorChange(doc)),
      vscode.workspace.onDidChangeTextDocument(event => this.onEditorChange(event.document)),
      vscode.workspace.onDidSaveTextDocument(doc => this.onEditorChange(doc)),
      vscode.workspace.onDidCloseTextDocument(doc => {
        this.clearTimer(doc);
        this.cleanText.delete(doc);
        this.blocked.delete(doc);
        this.sync.wake();
      }),
    ];
    for (const document of vscode.workspace.textDocuments) this.onEditorChange(document);
  }

  start(): void {
    this.sync.start();
  }

  listConflicts(): ProjectConflict[] {
    return this.sync.listConflicts();
  }

  acceptResolution(conflict: ProjectConflict): void {
    this.sync.acceptResolution(conflict.path, conflict.id);
  }

  status(): ProjectStatus {
    const status = this.sync.status();
    if (this.blocked.size && status.state !== 'Offline' && status.state !== 'Error') {
      return {
        ...status,
        state: 'Conflict',
        conflicts: status.conflicts + this.blocked.size,
        error: '同一文件的编辑器和磁盘内容同时改动。请先在 VS Code 中处理这份文件。',
      };
    }
    if (status.state === 'Saved' && (this.saving.size || this.saveTimers.size)) {
      return { ...status, state: 'Syncing' };
    }
    return status;
  }

  private projectPath(doc: vscode.TextDocument): string | undefined {
    if (doc.uri.scheme !== 'file') return;
    const relative = path.relative(this.folder.uri.fsPath, doc.uri.fsPath).split(path.sep).join('/');
    return isProjectPath(relative) ? relative : undefined;
  }

  private clearTimer(doc: vscode.TextDocument): void {
    clearTimeout(this.saveTimers.get(doc));
    this.saveTimers.delete(doc);
  }

  private onEditorChange(doc: vscode.TextDocument): void {
    const relative = this.projectPath(doc);
    if (!relative || this.disposed) return;
    if (!doc.isDirty) {
      this.clearTimer(doc);
      this.blocked.delete(doc);
      const observed = canonical(doc.getText());
      if (observed !== this.cleanText.get(doc)) {
        try {
          // VS Code can deliver the text event before the dirty-state event.
          if (this.diskText(relative) === observed) this.cleanText.set(doc, observed);
        } catch { /* Non-UTF-8 or out-of-scope files can still be saved by VS Code. */ }
      }
      this.sync.wake();
    } else if (!this.saving.has(doc) && !this.saveTimers.has(doc) && !this.blocked.has(doc)) {
      const timer = setTimeout(() => {
        this.saveTimers.delete(doc);
        void this.saveEditor(doc, relative);
      }, 320);
      this.saveTimers.set(doc, timer);
    }
    this.refresh();
  }

  private diskText(relative: string): string {
    let file = this.folder.uri.fsPath;
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error('Linked project root');
    for (const component of relative.split('/')) {
      file = path.join(file, component);
      if (fs.lstatSync(file).isSymbolicLink()) throw new Error('Linked project path');
    }
    const stats = fs.statSync(file);
    if (!stats.isFile() || stats.size > TEXT_LIMIT) throw new Error('Unsupported editor file');
    return canonical(new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file)));
  }

  private async saveEditor(doc: vscode.TextDocument, relative: string): Promise<void> {
    if (this.disposed || doc.isClosed || !doc.isDirty) return;
    this.saving.add(doc);
    this.refresh();
    try {
      const base = this.cleanText.get(doc);
      if (base === undefined || this.diskText(relative) !== base) {
        this.blocked.add(doc);
        return;
      }
      // VS Code's native save also checks the disk version if a writer races
      // the preflight above. The sync core defers this file until save ends.
      const submitted = canonical(doc.getText());
      if (!await doc.save()) {
        this.blocked.add(doc);
      } else if (doc.isDirty && this.diskText(relative) === submitted) {
        this.cleanText.set(doc, submitted);
      }
    } catch {
      this.blocked.add(doc);
    } finally {
      this.saving.delete(doc);
      this.onEditorChange(doc);
      this.sync.wake();
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.saveTimers.values()) clearTimeout(timer);
    this.saveTimers.clear();
    for (const subscription of this.subscriptions) subscription.dispose();
    this.sync.dispose();
  }
}

export function registerProjectCommands(context: vscode.ExtensionContext, commands: ProjectCommands) {
  const bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 46);
  bar.command = 'lsw.projectStatus';
  let active: ProjectSession | undefined;
  let connectionForm: vscode.WebviewPanel | undefined;
  let joining = false;
  let generation = 0;
  const disconnected: ProjectStatus = { state: 'Disconnected', files: 0, conflicts: 0 };
  const getStatus = () => active?.status() ?? disconnected;
  const chooseConflict = async (placeHolder: string) => {
    const session = active;
    const choices = session?.listConflicts().map(conflict => ({ label: conflict.path, conflict })) ?? [];
    if (!choices.length) {
      void vscode.window.showInformationMessage(getStatus().error ?? '当前没有工作区文件冲突。');
      return;
    }
    const selected = await vscode.window.showQuickPick(choices, { placeHolder });
    if (selected && session === active) return { session, conflict: selected.conflict };
  };
  const refresh = () => {
    if (!active) {
      bar.hide();
      return;
    }
    const { state, files, conflicts, error } = getStatus();
    const icon = state === 'Saved' ? 'check' : state === 'Conflict' || state === 'Error' ? 'warning' : 'sync';
    bar.text = '$(' + icon + ') LSW ' + LABELS[state];
    const count = conflicts ? ' · ' + conflicts + ' 个冲突' : '';
    bar.tooltip = files + ' 个文件' + count + (error ? '\n' + error : '');
    bar.command = state === 'Conflict' ? 'lsw.reviewProjectConflict' : 'lsw.projectStatus';
    bar.show();
  };

  const stop = () => {
    generation++;
    active?.dispose();
    active = undefined;
    commands.onConnectionChange(false);
    refresh();
  };

  const start = (folder: vscode.WorkspaceFolder, association: Association, token: string) => {
    active?.dispose();
    active = new ProjectSession(
      folder, association, token, path.join(context.globalStorageUri.fsPath, 'projects', associationKey(association)), refresh,
    );
    commands.onConnectionChange(true);
    active.start();
    refresh();
    return getStatus();
  };

  const restore = async () => {
    const attempt = generation;
    const folder = currentFolder();
    const association = context.workspaceState.get<Association>(ASSOCIATION);
    if (!folder || !vscode.workspace.isTrusted || !association || association.folder !== folder.uri.toString()) return;
    try {
      const token = await context.secrets.get(tokenKey(association));
      if (attempt !== generation || active || joining) return;
      if (!token || !TOKEN.test(token)) throw new Error('请用 LSW: Join Shared Project 重新填写连接令牌。');
      commands.validateUrl(association.url);
      start(folder, association, token);
    } catch (error) {
      void vscode.window.showWarningMessage(error instanceof Error ? error.message : '无法恢复 LSW 工作区。');
    }
  };

  const joinProject = async (options: JoinOptions) => {
    if (joining) throw new Error('正在处理连接请求，请稍候。');
    joining = true;
    const attempt = ++generation;
    try {
      const folder = currentFolder();
      if (!folder || !vscode.workspace.isTrusted) {
        throw new Error('请在 VS Code 打开一个本地工作区文件夹并信任它。');
      }
      const address = connectionAddress(options.url ?? commands.defaultUrl);
      let url: URL;
      try {
        url = commands.validateUrl(address);
      } catch {
        throw new Error('请填写有效的服务器地址。本机可以用 ws://127.0.0.1:1234，跨电脑请用部署好的加密地址。');
      }
      const workspaceId = (options.workspaceId ?? commands.defaultId).trim().toLowerCase();
      if (!UUID.test(workspaceId)) throw new Error('工作区 ID 格式有误，请复制发起人提供的完整 ID。');
      const association = { folder: folder.uri.toString(), url: url.href, workspaceId };
      const existing = context.workspaceState.get<Association>(ASSOCIATION);
      if (active && existing && associationKey(existing) !== associationKey(association)) {
        throw new Error('当前文件夹已连接另一个工作区。请用新文件夹加入。');
      }
      const key = tokenKey(association);
      const token = options.token;
      if (!token || !TOKEN.test(token)) throw new Error('请粘贴完整令牌，长度为 24 至 1024 个字符，不含空格。');
      const manifest = new URL('/workspace/manifest', httpEndpoint(url));
      manifest.searchParams.set('workspace', workspaceId);
      let response: Response;
      try {
        response = await fetch(manifest, {
          headers: { Authorization: 'Bearer ' + token },
          signal: AbortSignal.timeout(4500),
          redirect: 'error',
        });
      } catch {
        throw new Error('连不上协作服务器。请检查地址、网络和服务是否启动。远程地址还需有效的 HTTPS 证书。');
      }
      await response.body?.cancel();
      if (response.status === 401 || response.status === 403) {
        throw new Error('服务器未接受令牌。请核对是否粘贴了这个工作区的完整令牌。');
      }
      if (!response.ok) {
        throw new Error('无法加入共享工作区（HTTP ' + response.status + '）。请核对工作区 ID、服务器地址和服务版本。');
      }
      if (attempt !== generation) return;
      await context.secrets.store(key, token);
      if (attempt !== generation) return;
      await context.workspaceState.update(ASSOCIATION, association);
      if (attempt === generation) return start(folder, association, token);
    } finally {
      joining = false;
    }
  };

  const showConnectionForm = () => {
    const folder = currentFolder();
    if (!folder || !vscode.workspace.isTrusted) {
      void vscode.window.showInformationMessage('请先用「文件 → 打开文件夹」打开并信任一个本地工作区，再连接共享工作区。');
      return;
    }
    if (connectionForm) {
      connectionForm.reveal();
      return;
    }
    const saved = context.workspaceState.get<Association>(ASSOCIATION);
    const existing = saved?.folder === folder.uri.toString() ? saved : undefined;
    const panel = openConnectionForm({
      folder: folder.uri.fsPath,
      url: existing?.url ?? commands.defaultUrl,
      workspaceId: existing?.workspaceId ?? commands.defaultId,
    }, async input => {
      if (!await joinProject(input)) throw new Error('工作区已切换，请在新的文件夹中重新连接。');
    });
    connectionForm = panel;
    panel.onDidDispose(() => {
      if (connectionForm === panel) connectionForm = undefined;
    });
  };

  context.subscriptions.push(
    bar,
    new vscode.Disposable(stop),
    new vscode.Disposable(() => connectionForm?.dispose()),
    vscode.workspace.registerTextDocumentContentProvider(CONFLICT_SCHEME, {
      provideTextDocumentContent(uri) {
        const conflict = active?.listConflicts().find(copy => copy.id === uri.authority);
        if (!conflict || (uri.query !== 'shared' && uri.query !== 'local')) {
          throw new Error('找不到当前冲突副本。');
        }
        const file = conflict[uri.query];
        return file ? new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file)) : '';
      },
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => void restore()),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      connectionForm?.dispose();
      stop();
      void restore();
    }),
    vscode.commands.registerCommand('lsw.joinProject', (options?: JoinOptions) =>
      options ? joinProject(options) : showConnectionForm()),
    vscode.commands.registerCommand('lsw.leaveProject', async () => {
      connectionForm?.dispose();
      stop();
      await context.workspaceState.update(ASSOCIATION, undefined);
      return getStatus();
    }),
    vscode.commands.registerCommand('lsw.reviewProjectConflict', async () => {
      const selected = await chooseConflict('查看共享版和本机版');
      if (!selected) return;
      const { conflict } = selected;
      try {
        for (const file of [conflict.shared, conflict.local]) {
          if (!file) continue;
          if (fs.statSync(file).size > TEXT_LIMIT) throw new Error('Large file');
          const bytes = fs.readFileSync(file);
          if (bytes.includes(0)) throw new Error('Binary file');
          new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        }
        const copy = (query: string) => vscode.Uri.from({
          scheme: CONFLICT_SCHEME, authority: conflict.id, path: '/' + path.basename(conflict.path), query,
        });
        await vscode.commands.executeCommand('vscode.diff', copy('shared'), copy('local'),
          'LSW ' + conflict.path + ' · 左侧共享版，右侧本机版');
      } catch {
        await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(path.join(conflict.directory, 'versions.json')));
      }
    }),
    vscode.commands.registerCommand('lsw.publishResolvedProjectFile', async () => {
      const selected = await chooseConflict('选择已整理并保存到磁盘的文件，提交当前本机版作为解决稿');
      if (!selected?.session) return;
      try {
        selected.session.acceptResolution(selected.conflict);
        void vscode.window.showInformationMessage('已提交处理请求。LSW 会重新核对共享版本后同步。');
      } catch (error) {
        void vscode.window.showWarningMessage(error instanceof Error ? error.message : '无法提交冲突解决稿。');
      }
    }),
    vscode.commands.registerCommand('lsw.projectStatus', (options?: { quiet?: boolean }) => {
      const status = getStatus();
      if (!options?.quiet) {
        void vscode.window.showInformationMessage('LSW ' + LABELS[status.state]
          + (status.error ? '。' + status.error : '。共 ' + status.files + ' 个文件。'));
      }
      return status;
    }),
  );
  void restore();
  return { isJoined: () => Boolean(active) };
}
