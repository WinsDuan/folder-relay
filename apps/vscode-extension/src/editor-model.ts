import diff from 'fast-diff';
import * as Y from 'yjs';

export const LOCAL_EDIT = Symbol('editor edit');

export function canonical(text: string): string {
  return text.replace(/\r\n/g, '\n');
}

export interface TextPatch {
  offset: number;
  remove: number;
  insert: string;
}

export function patches(before: string, after: string): TextPatch[] {
  const changes: TextPatch[] = [];
  let offset = 0;
  let current: TextPatch | undefined;
  for (const [kind, text] of diff(before, after)) {
    if (kind === diff.EQUAL) {
      current = undefined;
      offset += text.length;
      continue;
    }
    if (!current) {
      current = { offset, remove: 0, insert: '' };
      changes.push(current);
    }
    if (kind === diff.DELETE) {
      current.remove += text.length;
      offset += text.length;
    } else {
      current.insert += text;
    }
  }
  return changes;
}

/** Mirror CRDT keeps the causal state represented by the visible editor buffer. */
export class EditorModel {
  readonly network = new Y.Doc();
  private readonly mirror = new Y.Doc();
  readonly text = this.network.getText('content');
  private readonly projectedText = this.mirror.getText('content');

  get projected(): string {
    return this.projectedText.toString();
  }

  get current(): string {
    return this.text.toString();
  }

  snapshot(): Uint8Array {
    return Y.encodeStateAsUpdate(this.network);
  }

  project(snapshot: Uint8Array): void {
    Y.applyUpdate(this.mirror, snapshot);
  }

  edit(next: string): void {
    const changes = patches(this.projected, next);
    if (!changes.length) return;
    const merge = (update: Uint8Array) => Y.applyUpdate(this.network, update, LOCAL_EDIT);
    this.mirror.on('update', merge);
    try {
      this.mirror.transact(() => {
        // Offsets refer to the original buffer. Right-to-left edits keep them stable.
        for (const change of changes.reverse()) {
          if (change.remove) this.projectedText.delete(change.offset, change.remove);
          if (change.insert) this.projectedText.insert(change.offset, change.insert);
        }
      }, LOCAL_EDIT);
    } finally {
      this.mirror.off('update', merge);
    }
  }

  destroy(): void {
    this.mirror.destroy();
    this.network.destroy();
  }
}
