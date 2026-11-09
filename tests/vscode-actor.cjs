const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { promisify } = require('node:util');
const vscode = require('vscode');

const actor = process.env.LSW_E2E_ACTOR;
const dir = process.env.LSW_E2E_DIR;
const chars = [...'LaTeX逐字同步😀测试数学模型与证明'];
const sent = index => 'sent-' + index;
const observed = index => 'observed-' + index;
const run = promisify(execFile);
const pdfSentence = 'LSW external edit compiled on both clients.';
const editedTex = [
  '\\documentclass{article}',
  '\\begin{document}',
  pdfSentence,
  '\\end{document}',
  '',
].join('\n');

function marker(name) { return path.join(dir, name + '.json'); }
function publish(name, value = {}) {
  const file = marker(name);
  const temp = file + '.' + actor + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(value));
  fs.renameSync(temp, file);
}
function read(name) {
  if (fs.existsSync(marker(name))) return JSON.parse(fs.readFileSync(marker(name), 'utf8'));
}
async function until(condition, description, timeout = 20_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (read('abort')) throw new Error('Harness aborted: ' + read('abort').error);
    const value = await condition();
    if (value) return value;
    await delay(10);
  }
  throw new Error(actor + ' timed out: ' + description);
}
function status() { return vscode.commands.executeCommand('lsw.status', { quiet: true }); }
function canonical(text) { return text.replace(/\r\n/g, '\n'); }

async function verifyLocalPdf(file) {
  if (!process.env.LSW_E2E_COMPILE) return false;
  const options = { cwd: path.dirname(file), windowsHide: true, timeout: 30_000 };
  await run('latexmk', ['-xelatex', '-halt-on-error', '-interaction=nonstopmode', path.basename(file)], options);
  const pdf = path.basename(file, '.tex') + '.pdf';
  const { stdout } = await run('pdftotext', [pdf, '-'], options);
  assert.ok(stdout.includes(pdfSentence), 'PDF contains the external revision');
  return true;
}

async function main() {
  const workspace = vscode.workspace.workspaceFolders[0].uri;
  const uri = vscode.Uri.joinPath(workspace, 'main.tex');
  const document = await vscode.workspace.openTextDocument(uri);
  const editor = await vscode.window.showTextDocument(document);
  const connect = await vscode.commands.executeCommand('lsw.connect', {
    url: process.env.LSW_E2E_URL,
    documentId: process.env.LSW_E2E_DOCUMENT,
    token: process.env.LSW_E2E_TOKEN,
    file: uri,
  });
  assert.ok(connect.connected && connect.synced, 'extension connected');
  assert.equal(document.getText(), '');
  publish('ready-' + actor);
  await until(() => read('ready-a') && read('ready-b'), 'both hosts ready');

  const latencies = [];
  let expected = '';
  for (const [index, char] of chars.entries()) {
    expected += char;
    if (actor === 'a') {
      publish(sent(index), { at: Date.now() });
      assert.ok(await editor.edit(edit => edit.insert(document.positionAt(document.getText().length), char)));
      await until(() => read(observed(index)), 'remote edit ' + index);
    } else {
      const start = await until(() => read(sent(index)), 'send ' + index);
      await until(() => document.getText() === expected, 'expected text ' + index);
      latencies.push(Date.now() - start.at);
      publish(observed(index));
    }
  }

  // B edits the same document. A's buffer remains dirty during the remote projection.
  assert.ok(document.isDirty, 'local editor buffer remains unsaved');
  if (actor === 'b') {
    assert.ok(await editor.edit(edit => edit.insert(new vscode.Position(0, 0), '乙在线\n')));
  }
  await until(() => canonical(document.getText()) === '乙在线\n' + expected, 'B-to-A edit');
  await until(async () => (await status()).state.toLowerCase() === 'saved', 'durable acknowledgement');
  publish('reverse-' + actor);
  await until(() => read('reverse-a') && read('reverse-b'), 'both buffers received reverse edit');
  if (actor === 'a') publish('parallel-start', { at: Date.now() + 200 });
  const parallel = await until(() => read('parallel-start'), 'parallel edit barrier');
  await delay(Math.max(0, parallel.at - Date.now()));
  const onlineLine = actor === 'a' ? '甲并发\n' : '乙并发\n';
  assert.ok(await editor.edit(edit => edit.insert(new vscode.Position(0, 0), onlineLine)));
  await until(() => canonical(document.getText()).includes('甲并发\n') && canonical(document.getText()).includes('乙并发\n'), 'both online edits');
  await until(async () => (await status()).state.toLowerCase() === 'saved', 'parallel edit durable acknowledgement');
  const beforeOffline = canonical(document.getText());
  assert.ok(beforeOffline.endsWith('乙在线\n' + expected));
  publish('online-' + actor);
  await until(() => read('online-a') && read('online-b'), 'both buffers online');

  if (actor === 'b') publish('restart-request');
  await until(() => read('server-down'), 'server killed');
  await until(async () => !(await status()).connected, 'disconnection');
  const offlineLine = actor === 'a' ? '甲离线\n' : '乙离线\n';
  assert.ok(await editor.edit(edit => edit.insert(new vscode.Position(0, 0), offlineLine)));
  assert.ok(canonical(document.getText()).startsWith(offlineLine));
  publish('offline-' + actor);
  await until(() => read('server-up'), 'server restarted');
  await until(() => canonical(document.getText()).includes('甲离线\n') && canonical(document.getText()).includes('乙离线\n'), 'offline CRDT merge', 30_000);
  await until(async () => (await status()).state.toLowerCase() === 'saved', 'post-restart durable acknowledgement');
  const merged = canonical(document.getText());
  assert.ok(merged.endsWith(beforeOffline));
  assert.ok(await document.save());
  const editorFileMatches = canonical(fs.readFileSync(uri.fsPath, 'utf8')) === merged;
  assert.ok(editorFileMatches);
  publish('merged-' + actor);
  await until(() => read('merged-a') && read('merged-b'), 'both hosts saved the local file');

  const files = vscode.workspace.getConfiguration('files', uri);
  if (actor === 'b') {
    await files.update('autoSave', 'afterDelay', vscode.ConfigurationTarget.Workspace);
    publish('auto-save-ready');
  } else {
    await until(() => read('auto-save-ready'), 'peer auto save enabled');
  }
  let localPdfVerified;
  if (actor === 'a') {
    assert.ok(await vscode.commands.executeCommand('lsw.prepareAiEdit', { quiet: true }));
    assert.equal((await status()).aiReady, true);
    const temporary = uri.fsPath + '.tmp';
    fs.writeFileSync(temporary, editedTex, 'utf8');
    fs.renameSync(temporary, uri.fsPath);
    localPdfVerified = await verifyLocalPdf(uri.fsPath);
  }
  await until(async () => {
    const value = await status();
    if (value.conflict) throw new Error('Clean disk edit paused: ' + value.conflict);
    return value.state === 'Saved' && value.localSaved && canonical(document.getText()) === editedTex;
  }, 'external disk edit shared and on disk');
  assert.equal(canonical(fs.readFileSync(uri.fsPath, 'utf8')), editedTex);
  if (actor === 'b') {
    localPdfVerified = await verifyLocalPdf(uri.fsPath);
    await files.update('autoSave', undefined, vscode.ConfigurationTarget.Workspace);
  }
  publish('disk-synced-' + actor);
  await until(() => read('disk-synced-a') && read('disk-synced-b'), 'both hosts received external edit');

  const reverseTex = editedTex.replace('\\end{document}', 'Reply from the second client.\n\\end{document}');
  if (actor === 'b') {
    assert.equal((await status()).aiReady, false);
    assert.ok(await vscode.commands.executeCommand('lsw.prepareAiEdit', { quiet: true }));
    fs.writeFileSync(uri.fsPath, reverseTex, 'utf8');
  }
  await until(async () => {
    const value = await status();
    if (value.conflict) throw new Error('Reverse disk edit paused: ' + value.conflict);
    return value.state === 'Saved' && canonical(document.getText()) === reverseTex;
  }, 'second client external edit shared');
  assert.ok(await document.save());
  assert.equal(canonical(fs.readFileSync(uri.fsPath, 'utf8')), reverseTex);
  publish('reverse-disk-synced-' + actor);
  await until(() => read('reverse-disk-synced-a') && read('reverse-disk-synced-b'), 'both hosts saved the reverse edit');

  const sharedBeforeConflict = reverseTex + '已同步但未保存到磁盘的编辑\n';
  const external = '外部程序直接覆盖磁盘\n';
  if (actor === 'b') {
    assert.ok(await editor.edit(edit => edit.insert(document.positionAt(document.getText().length), '已同步但未保存到磁盘的编辑\n')));
  }
  await until(() => canonical(document.getText()) === sharedBeforeConflict, 'unsaved editor changes shared');
  await until(async () => (await status()).state.toLowerCase() === 'saved', 'unsaved editor changes committed');
  assert.ok(document.isDirty);
  assert.equal((await status()).localSaved, false);
  assert.equal(canonical(fs.readFileSync(uri.fsPath, 'utf8')), reverseTex);
  publish('draft-' + actor);
  await until(() => read('draft-a') && read('draft-b'), 'both hosts see the unsaved shared draft');

  let externalWritePreserved = false;
  let conflictDiffVerified = false;
  if (actor === 'b') {
    fs.writeFileSync(uri.fsPath, external, 'utf8');
    await until(async () => Boolean((await status()).conflict), 'external write conflict');
    assert.equal(fs.readFileSync(uri.fsPath, 'utf8'), external);
    const conflicts = path.join(dir, 'profile-b/User/globalStorage/lsw-local.latex-sync-workspace/conflicts');
    const preserved = fs.readdirSync(conflicts).some(id => {
      const copy = path.join(conflicts, id);
      return fs.readFileSync(path.join(copy, 'disk.tex'), 'utf8') === external
        && canonical(fs.readFileSync(path.join(copy, 'shared.tex'), 'utf8')) === sharedBeforeConflict
        && canonical(fs.readFileSync(path.join(copy, 'last-known-disk.tex'), 'utf8')) === reverseTex;
    });
    assert.ok(preserved, 'disk, shared and previously saved versions preserved');
    externalWritePreserved = true;
    await vscode.commands.executeCommand('lsw.reviewConflict');
    const input = await until(() => vscode.window.tabGroups.all.flatMap(group => group.tabs).map(tab => tab.input)
      .find(input => input instanceof vscode.TabInputTextDiff && input.original.scheme === 'lsw-conflict'), 'conflict comparison');
    assert.equal(input.modified.scheme, 'lsw-conflict');
    assert.equal(canonical((await vscode.workspace.openTextDocument(input.original)).getText()), sharedBeforeConflict);
    assert.equal(canonical((await vscode.workspace.openTextDocument(input.modified)).getText()), external);
    conflictDiffVerified = true;
    publish('external-checked');
  }
  await until(() => read('external-checked'), 'external write isolation');
  const recovered = sharedBeforeConflict + external;
  if (actor === 'a') {
    assert.equal(canonical(document.getText()), sharedBeforeConflict);
    assert.ok(await editor.edit(edit => edit.insert(document.positionAt(document.getText().length), external)));
    await until(async () => (await status()).state.toLowerCase() === 'saved', 'manually merged edit committed');
    publish('recovery-ready');
  } else {
    await until(() => read('recovery-ready'), 'manually merged version available');
    // Revert the native buffer to clear the VS Code file-modified-since guard.
    await vscode.commands.executeCommand('lsw.disconnect');
    await vscode.window.showTextDocument(document);
    await vscode.commands.executeCommand('workbench.action.files.revert');
    await until(() => !document.isDirty && canonical(document.getText()) === external, 'reload external disk version');
    const connection = await vscode.commands.executeCommand('lsw.connect', {
      url: process.env.LSW_E2E_URL, documentId: process.env.LSW_E2E_DOCUMENT,
      token: process.env.LSW_E2E_TOKEN, file: uri, acceptRemote: true,
    });
    assert.ok(connection.connected && connection.synced);
  }
  await until(() => canonical(document.getText()) === recovered, 'both versions recovered into the shared document');
  assert.ok(await document.save());
  assert.equal(canonical(fs.readFileSync(uri.fsPath, 'utf8')), recovered);
  assert.equal((await status()).localSaved, true);
  const laterLine = '同学在 AI 编辑开始后补充的内容\n';
  const laterShared = recovered + laterLine;
  let staleAiBasePreserved = false;
  if (actor === 'b') {
    await until(async () => (await status()).state === 'Saved', 'recovery committed before AI preparation');
    assert.ok(await vscode.commands.executeCommand('lsw.prepareAiEdit', { quiet: true }));
    await files.update('autoSave', 'afterDelay', vscode.ConfigurationTarget.Workspace);
    publish('stale-base-armed');
    await until(async () => {
      const value = await status();
      return value.state === 'Saved' && value.localSaved && canonical(document.getText()) === laterShared;
    }, 'new peer edit was saved to disk');
    assert.equal((await status()).aiReady, false);
    assert.equal(canonical(fs.readFileSync(uri.fsPath, 'utf8')), laterShared);
    fs.writeFileSync(uri.fsPath, recovered + 'AI used the old base.\n', 'utf8');
    await until(async () => (await status()).state === 'Conflict', 'stale AI edit conflict');
    assert.equal(canonical(fs.readFileSync(uri.fsPath, 'utf8')), recovered + 'AI used the old base.\n');
    staleAiBasePreserved = true;
    publish('stale-base-checked');
  } else {
    await until(() => read('stale-base-armed'), 'peer prepared AI edit');
    assert.ok(await editor.edit(edit => edit.insert(document.positionAt(document.getText().length), laterLine)));
    await until(() => read('stale-base-checked'), 'stale AI edit rejected');
    assert.equal(canonical(document.getText()), laterShared);
    assert.equal((await status()).state, 'Saved');
  }
  publish('finished-' + actor, {
    text: recovered, latencies, saved: true, editorFileMatches, externalWritePreserved,
    conflictDiffVerified, recoveredAfterConflict: true,
    onlineOperationsPreserved: true, offlineOperationsPreserved: true,
    cleanDiskEditSynced: true, reverseDiskEditSynced: true, localPdfVerified, staleAiBasePreserved,
    vscodeVersion: vscode.version,
  });
}

exports.run = async function run() {
  try {
    await main();
  } catch (error) {
    publish('failed-' + actor, { error: String(error.stack || error) });
    publish('abort', { error: String(error.message) });
    throw error;
  } finally {
    await vscode.commands.executeCommand('lsw.disconnect');
  }
};
