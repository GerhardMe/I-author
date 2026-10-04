// Regression tests for the division-page layout: which fragment pages a book
// compile produces, in what order, and which division each page names above
// itself. The walk that builds this list shipped a bug once (every page got
// its grandparent's line, so a book's parts were handed the work title), and
// nothing caught it — hence the explicit expectations here.
//
// The tree is built in memory: collectItems only reads chapter bodies through
// a guarded readChapter, so no LaTeX and no disk writes are involved.
import './test-setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectItems, type FragItem } from './pdf.ts';
import type { Node } from './works.ts';

function leaf(path: string, title: string, label = ''): Node {
  return { name: path.split('/').pop()!, path, title, label, raw: title, draft: false, inDraft: false, words: 0 };
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
          leaf('The_silmarillion/01_the_ages/01_the_dawn/01_first.md', 'Chapter 1: first'),
        ]),
      ],
    ),
    folder('The_silmarillion/02_loose_sketches', 'Book II: loose sketches', 'Book II', 'loose sketches', [
      leaf('The_silmarillion/02_loose_sketches/01_map.md', 'Chapter 1: map'),
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
      ['chapter', 'Chapter 1', 'first', 'Book I: the ages'],
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
          leaf('The_silmarillion/01_the_ages/01_the_dawn/01_first.md', 'Chapter 1: first'),
        ]),
      ]),
    ],
  );
  assert.notEqual(plan(renamed)[1]!.key, before);
});