import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { downloadAndUnzipVSCode } from '@vscode/test-electron';
import { artifactDir, documentId, root, TestServer, waitFor } from './helpers.mjs';

const dir = artifactDir('project-vscode');
const server = new TestServer(dir);
const extension = process.env.LSW_E2E_EXTENSION_PATH || join(root, 'apps/vscode-extension');
const installedCode = process.platform === 'win32' && [
  join(process.env.LOCALAPPDATA || '', 'Programs/Microsoft VS Code/Code.exe'),
  join(process.env.ProgramFiles || '', 'Microsoft VS Code/Code.exe'),
].find(path => existsSync(path));
const executable = process.env.LSW_VSCODE_EXECUTABLE || installedCode || await downloadAndUnzipVSCode('1.106.1');
const actors = [];
const failures = [];
const children = new Set();
const driver = join(dir, 'test-driver');

// VS Code replaces persisted profile/workspace storage with in-memory storage
// under --extensionTestsPath. A small dev extension drives an ordinary window
// so the cold-start test exercises actual SecretStorage and workspaceState.
mkdirSync(driver);
writeFileSync(join(driver, 'package.json'), JSON.stringify({
  name: 'project-test-driver',
  publisher: 'lsw-test',
  version: '0.0.1',
  engines: { vscode: '^1.96.0' },
  main: './driver.cjs',
  extensionDependencies: ['lsw-local.latex-sync-workspace'],
  activationEvents: ['onStartupFinished'],
}));
writeFileSync(join(driver, 'driver.cjs'), [
  "const vscode = require('vscode');",
  'const actor = require(' + JSON.stringify(join(root, 'tests/project-actor.cjs')) + ');',
  "exports.activate = () => {",
  "  void actor.run().catch(error => console.error(error.message))",
  "    .finally(() => vscode.commands.executeCommand('workbench.action.closeWindow'));",
  "};",
].join('\n'));

function workspace(actor) { return join(dir, 'workspace-' + actor); }
function marker(name) { return join(dir, name + '.json'); }
function redact(error) { return String(error).replaceAll(server.token, '[redacted]'); }
function publish(name, value = {}) {
  writeFileSync(marker(name) + '.tmp', JSON.stringify(value));
  renameSync(marker(name) + '.tmp', marker(name));
}
function read(name) {
  if (existsSync(marker(name))) return JSON.parse(readFileSync(marker(name), 'utf8'));
}
function wait(name) {
  return waitFor(() => {
    if (failures.length) throw failures[0];
    return read(name);
  }, name, 75_000);
}

function launch(actor, phase) {
  const profile = join(dir, 'profile-' + actor);
  mkdirSync(join(profile, 'User'), { recursive: true });
  mkdirSync(workspace(actor), { recursive: true });
  writeFileSync(join(profile, 'User/settings.json'), JSON.stringify({
    'files.autoSave': 'off',
    'telemetry.telemetryLevel': 'off',
    'update.mode': 'none',
    'workbench.startupEditor': 'none',
  }));
  const credentials = {
    LSW_PROJECT_URL: phase === 'reopened' ? '' : server.ws,
    LSW_PROJECT_ID: phase === 'reopened' ? '' : documentId,
    LSW_PROJECT_TOKEN: phase === 'reopened' ? '' : server.token,
  };
  const child = spawn(executable, [
    workspace(actor),
    '--extensionDevelopmentPath=' + extension,
    '--extensionDevelopmentPath=' + driver,
    '--user-data-dir', profile,
    '--shared-data-dir', join(dir, 'shared-' + actor),
    '--extensions-dir', join(dir, 'extensions-' + actor),
    '--disable-extensions',
    '--disable-workspace-trust',
    '--disable-gpu',
    '--skip-welcome',
    '--skip-release-notes',
    '--disable-telemetry',
  ], {
    windowsHide: true,
    stdio: 'inherit',
    env: {
      ...process.env,
      LSW_PROJECT_TEST_DIR: dir,
      LSW_PROJECT_TEST_ACTOR: actor,
      LSW_PROJECT_TEST_PHASE: phase,
      LSW_PROJECT_TEST_COMPILE: process.env.LSW_E2E_COMPILE || '',
      ...credentials,
    },
  });
  children.add(child);
  const task = new Promise(resolve => {
    const failed = error => failures.push(new Error(actor + ' (' + phase + '): ' + redact(error)));
    child.on('error', failed);
    child.on('close', code => {
      children.delete(child);
      const report = read('failed-' + actor + '-' + phase);
      const expected = phase === 'initial' ? 'ready-to-close-b' : 'finished-' + actor;
      if (report) failed(report.error);
      else if (code !== 0 || !read(expected)) failed('VS Code exited before ' + expected + ' with code ' + code);
      resolve();
    });
  });
  actors.push(task);
  return task;
}

async function request(path, params = {}) {
  const url = new URL('/workspace/' + path, server.http);
  url.search = new URLSearchParams({ workspace: documentId, ...params }).toString();
  const result = await fetch(url, { headers: { Authorization: 'Bearer ' + server.token } });
  assert.equal(result.status, 200, url.pathname);
  return result;
}

try {
  console.log('VS Code: ' + executable);
  console.log('Evidence: ' + dir);
  await server.start();
  launch('a', 'owner');
  await wait('seeded-a');
  const manifest = await (await request('manifest')).json();
  assert.deepEqual(manifest.files.filter(file => file.sha256 !== null).map(file => file.path).sort(), [
    'chapters/model.tex', 'figures/model.png', 'main.tex', 'references.bib',
  ]);

  const firstPeer = launch('b', 'initial');
  await wait('ready-to-close-b');
  await firstPeer;
  if (failures.length) throw failures[0];
  publish('peer-closed');
  const solo = await wait('solo-committed');
  await waitFor(async () => {
    if (failures.length) throw failures[0];
    const { files } = await (await request('manifest')).json();
    if (files.find(file => file.path === 'figures/model.png')?.sha256 !== solo.imageDigest) return false;
    const current = files.find(file => file.path === 'main.tex');
    const committed = await request('file', { path: 'main.tex', revision: String(current.revision) });
    return (await committed.text()).replace(/\r\n/g, '\n') === solo.main;
  }, 'server committed changes while peer was closed');
  assert.notEqual(readFileSync(join(workspace('b'), 'main.tex'), 'utf8').replace(/\r\n/g, '\n'), solo.main);

  await server.stop();
  publish('server-down');
  launch('b', 'reopened');
  await Promise.all([wait('offline-edit-a'), wait('offline-edit-b')]);
  await server.start();
  publish('server-up');
  const [owner, peer] = await Promise.all([wait('finished-a'), wait('finished-b')]);
  await Promise.all(actors);
  if (failures.length) throw failures[0];
  assert.equal(owner.main, peer.main);
  assert.equal(owner.model, peer.model);
  assert.notEqual(owner.imageDigest, peer.imageDigest);
  const finalRows = new Map((await (await request('manifest')).json()).files.map(file => [file.path, file]));
  assert.equal(finalRows.get('figures/model.png')?.sha256, owner.imageDigest);
  assert.equal(finalRows.get('chapters/notes.tex')?.sha256, null);
  assert.equal(finalRows.get('chapters/notes-final.tex')?.sha256, null);
  const sharedModel = await request('file', { path: 'chapters/model.tex', revision: String(finalRows.get('chapters/model.tex').revision) });
  assert.equal((await sharedModel.text()).replace(/\r\n/g, '\n'), owner.model);

  const evidence = {
    executable,
    extension,
    editorHostVersion: owner.vscodeVersion,
    workspaceHydrated: peer.hydrated,
    emptyPlaceholderHydrated: read('hydrated-b').emptyPlaceholderHydrated,
    editorChangesAutoSavedAndSynced: owner.nativeEditSynced,
    externalEditSyncedWithoutPrepare: owner.externalEditSynced,
    committedWhileOtherPeerClosed: true,
    localCompilationWhileOtherPeerClosed: solo.compiled,
    serverRestarted: true,
    reopenedOfflineWithoutCredentials: peer.reopenedOffline,
    offlineEditorChangeSaved: peer.offlineSave,
    automaticReconnection: owner.reconnected && peer.reconnected,
    nonOverlappingEditsMerged: true,
    binaryConflictPreserved: peer.binaryConflictPreserved,
    createRenameDeleteWhileConflict: owner.fileTreeSynced && peer.fileTreeSynced,
  };
  const json = JSON.stringify(evidence, null, 2) + '\n';
  assert.ok(!json.includes(server.token));
  assert.ok(!readFileSync(join(dir, 'server.log'), 'utf8').includes(server.token));
  writeFileSync(join(dir, 'results.json'), json);
  console.log(json);
} catch (error) {
  publish('abort', { error: redact(error) });
  for (const child of children) child.kill();
  throw error;
} finally {
  await server.stop();
  await Promise.all(actors);
}
