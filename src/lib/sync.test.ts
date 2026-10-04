// Client-side rules that must hold on both sides of the wire. sync.ts imports
// CodeMirror, which needs a DOM shim at import time — provide the minimum.
import './test-setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';

// --- sessionStorage shim (the draft store lives in sessionStorage) ---
const store = new Map<string, string>();
const sessionStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() {
    return store.size;
  },
  clear: () => store.clear(),
};
Object.defineProperty(globalThis, 'sessionStorage', { value: sessionStorage });

const { saveDraft, dropDraft, lastDraftPath, moveDraft, remapDrafts } = await import('./sync.ts');

test('dropDraft clears the pointer only when it names this draft', () => {
  saveDraft('a.md', { content: 'aa', synced: 2, at: 1 });
  saveDraft('b.md', { content: 'bb', synced: 2, at: 2 });

  dropDraft('a.md'); // b's draft survives, and the pointer must not die with it
  assert.equal(lastDraftPath(), 'b.md');
  assert.notEqual(lastDraftPath(), null);

  dropDraft('b.md');
  assert.equal(lastDraftPath(), null);
});

test('moveDraft carries the pointer to the new path', () => {
  saveDraft('a.md', { content: 'aa', synced: 2, at: 1 });
  moveDraft('a.md', '01_x/a.md');
  assert.equal(lastDraftPath(), '01_x/a.md');
  assert.equal(
    sessionStorage.getItem('iauthor.draft.01_x/a.md'),
    JSON.stringify({ content: 'aa', synced: 2, at: 1 }),
  );
  assert.equal(sessionStorage.getItem('iauthor.draft.a.md'), null);
});

test('remapDrafts walks the store and moves the pointer along', () => {
  saveDraft('old/01_a.md', { content: 'aa', synced: 2, at: 1 });
  saveDraft('old/01_b.md', { content: 'bb', synced: 0, at: 2 });
  remapDrafts((p) => (p.startsWith('old/') ? `new/${p.slice(4)}` : p));
  assert.equal(lastDraftPath(), 'new/01_b.md'); // the pointer rides the remap
  assert.equal(
    sessionStorage.getItem('iauthor.draft.new/01_a.md'),
    JSON.stringify({ content: 'aa', synced: 2, at: 1 }),
  );
  assert.equal(sessionStorage.getItem('iauthor.draft.old/01_b.md'), null);
});
