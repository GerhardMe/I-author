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

const { saveDraft, loadDraft, dropDraft, moveDraft, remapDrafts } = await import('./sync.ts');

test('dropDraft clears only the named draft', () => {
  saveDraft('a.md', { content: 'aa', synced: 2, at: 1 });
  saveDraft('b.md', { content: 'bb', synced: 2, at: 2 });

  dropDraft('a.md'); // b's draft survives
  assert.equal(loadDraft('a.md'), null);
  assert.equal(loadDraft('b.md')?.content, 'bb');

  dropDraft('b.md');
  assert.equal(loadDraft('b.md'), null);
});

test('moveDraft carries the draft to the new path', () => {
  saveDraft('a.md', { content: 'aa', synced: 2, at: 1 });
  moveDraft('a.md', '01_x/a.md');
  assert.equal(
    sessionStorage.getItem('iauthor.draft.01_x/a.md'),
    JSON.stringify({ content: 'aa', synced: 2, at: 1 }),
  );
  assert.equal(sessionStorage.getItem('iauthor.draft.a.md'), null);
});

test('remapDrafts walks the store and remaps every draft path', () => {
  saveDraft('old/01_a.md', { content: 'aa', synced: 2, at: 1 });
  saveDraft('old/01_b.md', { content: 'bb', synced: 0, at: 2 });
  remapDrafts((p) => (p.startsWith('old/') ? `new/${p.slice(4)}` : p));
  assert.equal(
    sessionStorage.getItem('iauthor.draft.new/01_a.md'),
    JSON.stringify({ content: 'aa', synced: 2, at: 1 }),
  );
  assert.equal(sessionStorage.getItem('iauthor.draft.old/01_b.md'), null);
  assert.equal(loadDraft('new/01_b.md')?.content, 'bb');
});
