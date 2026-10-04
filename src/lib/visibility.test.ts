import { test } from 'node:test';
import assert from 'node:assert/strict';
import { visibleNodes } from './visibility.ts';

type N = { path: string; draft: boolean; children?: N[] };

const tree: N[] = [
  { path: '01_work', draft: false, children: [
    { path: '01_work/01_book', draft: false, children: [
      { path: '01_work/01_book/01_intro.md', draft: false },
      { path: '01_work/01_book/notes.md', draft: false },
    ] },
    { path: '01_work/draft_sketch.md', draft: true },
    { path: '01_work/02_empty', draft: false, children: [] },
  ] },
  { path: '02_poems.md', draft: false },
];

const ALL = { drafts: true, notes: true, empty: true };

test('visible: drafts, notes and empty directories drop together', () => {
  assert.deepEqual(visibleNodes(tree, ALL).map((n) => n.path), ['01_work', '02_poems.md']);
  assert.deepEqual(visibleNodes(tree, ALL)[0]!.children!.map((n) => n.path), [
    '01_work/01_book',
  ]);
});

test('visible: a folder whose children all vanish is dropped', () => {
  const t: N[] = [{ path: 'w', draft: false, children: [{ path: 'w/d.md', draft: true }] }];
  assert.deepEqual(visibleNodes(t, ALL).map((n) => n.path), []);
});

test('visible: drafts visible means everything stays', () => {
  assert.deepEqual(visibleNodes(tree, {}), tree);
});

test('visible: keepEmpty keeps an empty folder the drag aims into', () => {
  const out = visibleNodes(tree, { ...ALL, keepEmpty: (n) => n.path === '01_work/02_empty' });
  assert.deepEqual(out[0]!.children!.map((n) => n.path), ['01_work/01_book', '01_work/02_empty']);
});

test('pdf aggregates: notes and empties drop even with drafts included', () => {
  // the pdf rule: drafts ride along when included, but notes never compile
  const out = visibleNodes(tree, { notes: true, empty: true });
  assert.deepEqual(out[0]!.children!.map((n) => n.path), ['01_work/01_book', '01_work/draft_sketch.md']);
});
