// Regression tests for the division-page layout: which fragment pages a book
// compile produces, in what order, and which division each page names above
// itself. The walk that builds this list shipped a bug once (every page got
// its grandparent's line, so a book's parts were handed the work title), and
// nothing caught it — hence the explicit expectations here.
//
// Most trees here are built in memory (collectItems only reads chapter bodies
// through
// a guarded readChapter, so no LaTeX and no disk writes are involved); the last
// test needs a real tree, so it uses the temp works dir.
import './test-setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chapterTitle, collectItems, pdfPlan, type FragItem } from './pdf.ts';
import { createEntry, type Node } from './works.ts';
import { TEST_WORKS_DIR } from './test-setup.ts';

function leaf(path: string, label: string, raw: string): Node {
  return { name: path.split('/').pop()!, path, title: label ? `${label}: ${raw}` : raw, label, raw, draft: false, inDraft: false, words: 0 };
}

function folder(path: string, title: string, label: string, raw: string, children: Node[]): Node {
  return { name: path.split('/').pop()!, path, title, label, raw, draft: false, inDraft: false, words: 0, children };
}

// the Silmarillion shape: a work whose books do not all have parts
const work = folder(
  'The_silmarillion',
  'the silmarillion',
  '',
  'the silmarillion',
  [
    folder(
      'The_silmarillion/01_the_ages',
      'Book I: the ages',
      'Book I',
      'the ages',
      [
        folder('The_silmarillion/01_the_ages/01_the_dawn', 'Part 1: the dawn', 'Part 1', 'the dawn', [
          leaf('The_silmarillion/01_the_ages/01_the_dawn/01_first.md', 'Chapter 1', 'first'),
        ]),
      ],
    ),
    folder('The_silmarillion/02_loose_sketches', 'Book II: loose sketches', 'Book II', 'loose sketches', [
      leaf('The_silmarillion/02_loose_sketches/01_map.md', 'Chapter 1', 'map'),
    ]),
  ],
);

function plan(node: Node): FragItem[] {
  const out: FragItem[] = [];
  collectItems(node, 'stylehash', out);
  return out;
}

test('compiling a work: every division page names its immediate container', () => {
  const items = plan(work);

  // order: the book's own page, then what is under it
  assert.deepEqual(
    items.map((i) => [i.kind, i.label, i.raw]),
    [
      ['part', 'Book I', 'the ages'],
      ['part', 'Part 1', 'the dawn'],
      ['chapter', 'Chapter 1', 'first'],
      ['part', 'Book II', 'loose sketches'],
      ['chapter', 'Chapter 1', 'map'],
    ],
  );

  // a book's page is named by the work; its parts are named by the book —
  // not by the work, which is what the buggy walk produced
  assert.equal(items[0]!.above, 'the silmarillion');
  assert.equal(items[1]!.above, 'Book I: the ages');
  assert.equal(items[3]!.above, 'the silmarillion');
});

test('compiling a book: its parts name the book, and it prints no page itself', () => {
  const items = plan(work.children![0]!);

  assert.deepEqual(
    items.map((i) => [i.kind, i.label, i.raw, i.above]),
    [
      ['part', 'Part 1', 'the dawn', 'Book I: the ages'],
      // a chapter's `above` is its immediate division too; chapter pages never
      // print a container line, so nothing reaches paper here
      ['chapter', 'Chapter 1', 'first', 'Part 1: the dawn'],
    ],
  );
});

test('the fragment key covers the printed lines, so a rename rebuilds', () => {
  const before = plan(work)[1]!.key;
  const renamed = folder(
    'The_silmarillion',
    'the silmarillion',
    '',
    'the silmarillion',
    [
      folder('The_silmarillion/01_the_ages', 'Book I: the ages', 'Book I', 'the ages', [
        folder('The_silmarillion/01_the_ages/01_the_dawn', 'Part 1: the dawn renamed', 'Part 1', 'the dawn renamed', [
          leaf('The_silmarillion/01_the_ages/01_the_dawn/01_first.md', 'Chapter 1', 'first'),
        ]),
      ]),
    ],
  );
  assert.notEqual(plan(renamed)[1]!.key, before);
});
test('the scope title is the entry title, never the disk prefix', () => {
  // what reaches paper — title page, artifact name, loader heading — comes
  // from the tree's raw title, so a prefixed work prints as itself
  fs.rmSync(TEST_WORKS_DIR, { recursive: true, force: true });
  const w = createEntry('folder', '', 'The Silmarillion');
  const p = createEntry('file', w.path, 'Front Light'); // an empty folder is not compilable

  assert.equal(pdfPlan(w.path, 'academic').scope, 'The Silmarillion');
  assert.equal(pdfPlan(p.path, 'academic').scope, 'Front Light');
});

test('a tree-stale chapter path falls back to its bare raw title', () => {
  // the disk prefix is order only — the fallback must not resurrect the old
  // "Chapter N: title" grammar or print a ? placeholder
  assert.equal(chapterTitle('01_work/01_part/01_first_flight.md'), 'first flight');
  assert.equal(chapterTitle('02_poems.md'), 'poems');
  assert.equal(chapterTitle('01_work/01_part/03_no_prefix_yet.md'), 'no prefix yet');
});
