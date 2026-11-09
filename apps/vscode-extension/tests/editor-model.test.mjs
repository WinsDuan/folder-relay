import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as Y from 'yjs';
import { canonical, EditorModel, patches } from '../src/editor-model.ts';

test('incremental changes preserve UTF-16 positions and CRLF normalization', () => {
  const before = canonical('甲😀 a\r\n第二行 b\r\n');
  const after = canonical('甲🧪 A\r\n第二行 bb\r\n');
  const changes = patches(before, after);
  assert.ok(changes.length > 1);
  let output = before;
  for (const change of changes.reverse()) {
    output = output.slice(0, change.offset) + change.insert + output.slice(change.offset + change.remove);
  }
  assert.equal(output, after);
});

test('a local edit made before remote projection keeps both concurrent changes', () => {
  const a = new EditorModel();
  const b = new EditorModel();
  try {
    a.edit('abc');
    Y.applyUpdate(b.network, a.snapshot());
    b.project(b.snapshot());
    a.edit('aAbc');
    Y.applyUpdate(b.network, a.snapshot());
    assert.equal(b.projected, 'abc');
    b.edit('aBbc');
    assert.match(b.current, /^a(?:AB|BA)bc$/);
    Y.applyUpdate(a.network, b.snapshot());
    assert.equal(a.current, b.current);
    b.project(b.snapshot());
    assert.equal(b.projected, b.current);
  } finally {
    a.destroy();
    b.destroy();
  }
});

test('a deletion that is still being projected does not erase a concurrent insertion', () => {
  const a = new EditorModel();
  const b = new EditorModel();
  try {
    a.edit('a🧪c');
    Y.applyUpdate(b.network, a.snapshot());
    b.project(b.snapshot());
    a.edit('ac');
    Y.applyUpdate(b.network, a.snapshot());
    b.edit('a🧪Bc');
    assert.equal(b.current, 'aBc');
    Y.applyUpdate(a.network, b.snapshot());
    assert.equal(a.current, 'aBc');
  } finally {
    a.destroy();
    b.destroy();
  }
});
