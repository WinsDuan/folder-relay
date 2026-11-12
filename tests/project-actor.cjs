const assert = require('node:assert/strict');
const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { promisify } = require('node:util');
const vscode = require('vscode');

const actor = process.env.LSW_PROJECT_TEST_ACTOR;
const phase = process.env.LSW_PROJECT_TEST_PHASE;
const dir = process.env.LSW_PROJECT_TEST_DIR;
const run = promisify(execFile);
const mainFile = 'main.tex';
const modelFile = 'chapters/model.tex';
const imageFile = 'figures/model.png';
const officeFile = 'office/budget.xlsx';
const officeOwnerFile = 'office/~$dget.xlsx';
const officeInitial = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x01]);
const officeUpdated = Buffer.concat([officeInitial, Buffer.from('saved by owner')]);
const officeReturned = Buffer.concat([officeUpdated, Buffer.from('saved by peer')]);
const notesFile = 'chapters/notes.tex';
const renamedFile = 'chapters/notes-final.tex';
const notesText = '% Created while a different file has a conflict.\n';
const source = [
  '\\documentclass{article}',
  '\\begin{document}',
  '\\input{chapters/model}',
  '\\end{document}',
  '',
].join('\n');
const afterNative = source.replace('\\end{document}', 'Native edit without Save.\n\\end{document}');
const soloSentence = 'Committed while the other editor was closed.';
const afterSolo = afterNative.replace('\\end{document}', soloSentence + '\n\\end{document}');
const model = 'Alpha is unchanged.\n\nOmega is unchanged.\n';
const afterExternal = '% External editor updated this chapter.\n' + model;
const modelA = afterExternal.replace('Alpha is unchanged.', 'Alpha was edited by the owner.');
const modelB = afterExternal.replace('Omega is unchanged.', 'Omega was edited offline.');
const merged = modelA.replace('Omega is unchanged.', 'Omega was edited offline.');
const bibliography = '@article{test, title={Workspace sync}, year={2026}}\n';
const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==', 'base64');
const imageA = Buffer.concat([image, Buffer.from('owner revision')]);
const imageB = Buffer.concat([image, Buffer.from('offline peer revision')]);

function marker(name) { return path.join(dir, name + '.json'); }
function publish(name, value = {}) {
  const temporary = marker(name) + '.' + actor + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify(value));
  fs.renameSync(temporary, marker(name));
}
function read(name) {
  if (fs.existsSync(marker(name))) return JSON.parse(fs.readFileSync(marker(name), 'utf8'));
}
function status() { return vscode.commands.executeCommand('lsw.projectStatus', { quiet: true }); }
function normalize(value) { return value.replace(/\r\n/g, '\n'); }
function digest(value) { return createHash('sha256').update(value).digest('hex'); }
async function until(condition, description, timeout = 45_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (read('abort')) throw new Error('Harness aborted: ' + read('abort').error);
    const value = await condition();
    if (value) return value;
    await delay(25);
  }
  const current = await status();
  const detail = current?.error ? ': ' + current.error : '';
  throw new Error(actor + ' (' + phase + ') timed out: ' + description + ' [' + current?.state + detail + ']');
}
async function waitState(...states) {
  await until(async () => {
    const current = await status();
    if (current?.state === 'Error') throw new Error(current.error || 'Workspace sync error');
    return states.includes(current?.state);
  }, 'sync status ' + states.join(' or '));
}

async function main() {
  const folder = vscode.workspace.workspaceFolders[0].uri;
  const file = name => path.join(folder.fsPath, name);
  const exists = name => fs.existsSync(file(name));
  const content = name => exists(name) ? fs.readFileSync(file(name)) : undefined;
  const text = name => {
    const bytes = content(name);
    return bytes === undefined ? undefined : normalize(bytes.toString('utf8'));
  };
  const write = (name, value) => {
    fs.mkdirSync(path.dirname(file(name)), { recursive: true });
    fs.writeFileSync(file(name), value);
  };
  const open = async name => {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(folder, name));
    return vscode.window.showTextDocument(document);
  };
  const edit = async (editor, next) => {
    const doc = editor.document;
    assert.ok(await editor.edit(builder => {
      builder.replace(new vscode.Range(new vscode.Position(0, 0), doc.positionAt(doc.getText().length)), next);
    }));
  };

  if (phase === 'owner') {
    write(mainFile, source);
    write(modelFile, model);
    write(imageFile, image);
    write(officeFile, officeInitial);
    write('references.bib', bibliography);
    write('main.aux', '% Build output stays local.\n');
  } else if (phase === 'initial') {
    write(mainFile, '');
    assert.equal(content(mainFile).length, 0);
  }
  if (phase === 'reopened') {
    assert.ok(!process.env.LSW_PROJECT_TOKEN && !process.env.LSW_PROJECT_URL);
    await waitState('Offline', 'Reconnecting');
    assert.equal(text(modelFile), afterExternal);
    assert.equal(text(mainFile), afterNative);
  } else {
    await vscode.commands.executeCommand('lsw.joinProject', {
      url: process.env.LSW_PROJECT_URL,
      workspaceId: process.env.LSW_PROJECT_ID,
      token: process.env.LSW_PROJECT_TOKEN,
    });
    await waitState('Saved');
  }

  if (phase === 'owner') {
    publish('seeded-a');
    await until(() => read('hydrated-b'), 'empty checkout hydrated');
    write(officeFile, officeUpdated);
    await waitState('Saved');
    await until(() => content(officeFile)?.equals(officeReturned), 'office save received from peer');
    assert.equal(exists(officeOwnerFile), false);
    const mainEditor = await open(mainFile);
    await edit(mainEditor, afterNative);
    await until(() => text(mainFile) === afterNative && !mainEditor.document.isDirty, 'native autosave');
    await until(() => text(modelFile) === afterExternal, 'external edit received from peer');
    publish('external-seen-a');
    await until(() => read('peer-closed'), 'other Extension Host exited');
    await edit(mainEditor, afterSolo);
    await until(() => text(mainFile) === afterSolo && !mainEditor.document.isDirty, 'solo autosave');
    write(imageFile, imageA);
    await waitState('Saved');

    let compiled = false;
    if (process.env.LSW_PROJECT_TEST_COMPILE === '1') {
      const options = { cwd: folder.fsPath, windowsHide: true, timeout: 30_000 };
      await run('latexmk', ['-xelatex', '-halt-on-error', '-interaction=nonstopmode', mainFile], options);
      const { stdout } = await run('pdftotext', ['main.pdf', '-'], options);
      assert.ok(stdout.replace(/\s+/g, ' ').includes(soloSentence));
      compiled = true;
    }
    publish('solo-committed', { main: afterSolo, imageDigest: digest(imageA), compiled });
    await until(() => read('server-down'), 'server stopped');
    await waitState('Offline', 'Reconnecting');
    write(modelFile, modelA);
    publish('offline-edit-a');
  } else if (phase === 'initial') {
    await until(() => text(mainFile) === source && text(modelFile) === model
      && text('references.bib') === bibliography && content(imageFile)?.equals(image), 'hydrate empty placeholder and missing files');
    assert.equal(exists('main.aux'), false);
    const mainEditor = await open(mainFile);
    assert.deepEqual(content(officeFile), officeInitial);
    write(officeOwnerFile, 'Office owner record');
    publish('hydrated-b', { emptyPlaceholderHydrated: true });
    await waitState('Syncing');
    assert.deepEqual(content(officeFile), officeInitial);
    fs.renameSync(file(officeFile), file(officeFile + '.tmp'));
    await delay(450);
    assert.equal((await status()).state, 'Syncing');
    fs.renameSync(file(officeFile + '.tmp'), file(officeFile));
    fs.unlinkSync(file(officeOwnerFile));
    await until(() => content(officeFile)?.equals(officeUpdated), 'office update applied after editor closed');
    write(officeFile + '.tmp', officeReturned);
    fs.renameSync(file(officeFile + '.tmp'), file(officeFile));
    await until(() => text(mainFile) === afterNative && normalize(mainEditor.document.getText()) === afterNative,
      'native edit updates another open editor and disk');
    write(modelFile, afterExternal);
    await until(() => read('external-seen-a'), 'owner received external edit');
    await waitState('Saved');
    publish('ready-to-close-b');
    return;
  } else {
    const modelEditor = await open(modelFile);
    await edit(modelEditor, modelB);
    await until(() => text(modelFile) === modelB && !modelEditor.document.isDirty, 'offline native autosave');
    write(imageFile, imageB);
    publish('offline-edit-b');
  }

  await until(() => read('server-up'), 'server restarted', 90_000);
  await until(() => text(mainFile) === afterSolo && text(modelFile) === merged, 'reconnected and merged disjoint edits');
  if (actor === 'a') {
    await waitState('Saved');
    assert.deepEqual(content(imageFile), imageA);
    await until(() => text(notesFile) === notesText, 'peer creates file while image is conflicted');
    publish('create-seen-a');
    await until(() => !exists(notesFile) && text(renamedFile) === notesText, 'peer renames file');
    fs.unlinkSync(file(renamedFile));
    await until(() => read('deletion-seen-b'), 'peer receives deletion');
  } else {
    await waitState('Conflict');
    assert.ok((await status()).conflicts >= 1);
    assert.deepEqual(content(imageFile), imageB);
    write(notesFile, notesText);
    await until(() => read('create-seen-a'), 'owner receives new file');
    fs.renameSync(file(notesFile), file(renamedFile));
    await until(() => !exists(renamedFile), 'owner deletion arrives');
    assert.deepEqual(content(imageFile), imageB);
    assert.equal(exists('main.aux'), false);
    publish('deletion-seen-b');
  }
  publish('finished-' + actor, {
    main: text(mainFile),
    model: text(modelFile),
    imageDigest: digest(content(imageFile)),
    vscodeVersion: vscode.version,
    hydrated: actor === 'b',
    nativeEditSynced: actor === 'a',
    externalEditSynced: actor === 'a',
    reopenedOffline: phase === 'reopened',
    offlineSave: phase === 'reopened',
    reconnected: true,
    binaryConflictPreserved: actor === 'b',
    fileTreeSynced: true,
  });
}

exports.run = async function runProjectActor() {
  try {
    await main();
  } catch (error) {
    const token = process.env.LSW_PROJECT_TOKEN;
    const detail = String(error.stack || error);
    publish('failed-' + actor + '-' + phase, { error: token ? detail.replaceAll(token, '[redacted]') : detail });
    throw new Error(token ? detail.replaceAll(token, '[redacted]') : detail);
  }
};
