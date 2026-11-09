import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { connect, createServer } from 'node:net';
import { join } from 'node:path';
import { downloadAndUnzipVSCode, runTests } from '@vscode/test-electron';
import { artifactDir, documentId, root, TestServer, waitFor } from './helpers.mjs';

const dir = artifactDir('vscode');
const server = new TestServer(dir);
const relay = createServer(incoming => {
  const upstream = connect(server.port, '127.0.0.1');
  incoming.on('error', () => upstream.destroy());
  upstream.on('error', () => incoming.destroy());
  incoming.once('close', () => upstream.destroy());
  upstream.once('close', () => incoming.destroy());
  incoming.pipe(upstream).pipe(incoming);
});
const extension = process.env.LSW_E2E_EXTENSION_PATH || join(root, 'apps/vscode-extension');
const configuredCode = process.env.LSW_VSCODE_EXECUTABLE;
const installedCode = process.platform === 'win32'
  ? [
      join(process.env.LOCALAPPDATA || '', 'Programs/Microsoft VS Code/Code.exe'),
      join(process.env.ProgramFiles || '', 'Microsoft VS Code/Code.exe'),
    ].find(path => existsSync(path))
  : undefined;
const executable = configuredCode || installedCode || await downloadAndUnzipVSCode('1.106.1');
console.log('VS Code: ' + executable);
console.log('Evidence: ' + dir);

const env = actor => ({
  LSW_E2E_ACTOR: actor,
  LSW_E2E_DIR: dir,
  LSW_E2E_URL: actor === 'a' ? 'ws://127.0.0.1:' + relay.address().port : server.ws,
  LSW_E2E_TOKEN: server.token,
  LSW_E2E_DOCUMENT: documentId,
});

function launch(actor) {
  const workspace = join(dir, 'workspace-' + actor);
  const profile = join(dir, 'profile-' + actor);
  mkdirSync(join(profile, 'User'), { recursive: true });
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, 'main.tex'), '');
  writeFileSync(join(profile, 'User/settings.json'), JSON.stringify({
    'files.autoSave': 'off',
    'telemetry.telemetryLevel': 'off',
    'update.mode': 'none',
    'workbench.startupEditor': 'none',
  }));
  return runTests({
    vscodeExecutablePath: executable,
    extensionDevelopmentPath: extension,
    extensionTestsPath: join(root, 'tests/vscode-actor.cjs'),
    extensionTestsEnv: env(actor),
    launchArgs: [
      workspace,
      '--user-data-dir', profile,
      '--extensions-dir', join(dir, 'extensions-' + actor),
      '--disable-extensions',
      '--disable-workspace-trust',
      '--disable-gpu',
      '--skip-welcome',
      '--skip-release-notes',
      '--disable-telemetry',
    ],
  });
}

function marker(name) {
  return join(dir, name + '.json');
}

let actorsFinished = false;
function waitForMarker(name, timeout) {
  return waitFor(() => {
    if (actorsFinished && !existsSync(marker(name))) {
      throw new Error('VS Code exited before ' + name);
    }
    return existsSync(marker(name));
  }, name, timeout);
}

try {
  await server.start();
  await new Promise((resolve, reject) => {
    relay.once('error', reject);
    relay.listen(0, '127.0.0.1', resolve);
  });
  const actors = Promise.allSettled([launch('a'), launch('b')]);
  actors.then(() => { actorsFinished = true; });
  try {
    await waitForMarker('restart-request', 100_000);
    await server.stop();
    writeFileSync(marker('server-down'), '{}');
    await Promise.all([waitForMarker('offline-a'), waitForMarker('offline-b')]);
    await server.start();
    writeFileSync(marker('server-up'), '{}');
  } catch (error) {
    writeFileSync(marker('abort'), JSON.stringify({ error: error.message }));
    throw error;
  } finally {
    const results = await actors;
    const failed = results.filter(result => result.status === 'rejected');
    if (failed.length) throw new AggregateError(failed.map(result => result.reason), 'Extension Hosts failed. See ' + dir);
  }
  const a = JSON.parse(readFileSync(marker('finished-a'), 'utf8'));
  const b = JSON.parse(readFileSync(marker('finished-b'), 'utf8'));
  assert.equal(a.text, b.text);
  const values = [...b.latencies].sort((x, y) => x - y);
  const quantile = p => values[Math.ceil(p * values.length) - 1];
  const evidence = {
    executable,
    extension,
    editorHostVersion: a.vscodeVersion,
    latency: {
      samples: values.length,
      unit: 'ms',
      method: 'same machine, immediately before TextEditor.edit on A until matching text in B',
      median: quantile(0.5),
      p95: quantile(0.95),
      max: values.at(-1),
      observations: b.latencies,
    },
    savedAfterReconnect: a.saved && b.saved,
    convergence: a.text === b.text,
    onlineOperationsPreserved: a.onlineOperationsPreserved && b.onlineOperationsPreserved,
    offlineOperationsPreserved: a.offlineOperationsPreserved && b.offlineOperationsPreserved,
    externalWritePreserved: b.externalWritePreserved,
    conflictDiffVerified: b.conflictDiffVerified,
    recoveredAfterConflict: a.recoveredAfterConflict && b.recoveredAfterConflict,
    editorFilesMatch: a.editorFileMatches && b.editorFileMatches,
    cleanDiskEditSynced: a.cleanDiskEditSynced && b.cleanDiskEditSynced,
    reverseDiskEditSynced: a.reverseDiskEditSynced && b.reverseDiskEditSynced,
    localPdfsVerified: a.localPdfVerified && b.localPdfVerified,
    staleAiBasePreserved: b.staleAiBasePreserved,
    aiWriterConnection: 'Separate loopback port through a TCP relay',
  };
  writeFileSync(join(dir, 'results.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  await server.stop();
  if (relay.listening) await new Promise(resolve => relay.close(resolve));
}
