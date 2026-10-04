import './test-setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  naturalCompare,
  safePath,
  listWorks,
  createEntry,
  readChapter,
  writeChapter,
  deleteEntry,
  slugify,
  toRoman,
  renameEntry,
  moveEntry,
} from './works.ts';
import { parseName } from './naming.ts';
import { commit } from './git.ts';
import { TEST_WORKS_DIR } from './test-setup.ts';
import { WORKS_DIR } from './config.ts';

const run = promisify(execFile);

test('natural sort: numeric prefixes order correctly', () => {
  const names = ['10-b.md', '02-poems.md', '01-a', '1-x', '001-z'];
  const sorted = [...names].sort(naturalCompare);
  assert.deepEqual(sorted, ['01-a', '1-x', '001-z', '02-poems.md', '10-b.md']);
});

test('slugify strips dangerous characters', () => {
  assert.equal(slugify('  My Great Chapter! '), 'My_Great_Chapter');
  assert.equal(slugify('../../etc'), 'etc');
  assert.equal(slugify('.hidden'), 'hidden');
  assert.equal(slugify('..'), '');
  assert.equal(slugify('a-b'), 'a-b'); // legacy hyphens still allowed
});

test('roman numerals', () => {
  assert.equal(toRoman(1), 'I');
  assert.equal(toRoman(4), 'IV');
  assert.equal(toRoman(9), 'IX');
  assert.equal(toRoman(14), 'XIV');
  assert.equal(toRoman(42), 'XLII');
  assert.equal(toRoman(1990), 'MCMXC');
  assert.equal(toRoman(0), '0');
  assert.equal(toRoman(4000), '4000');
});

test('safePath rejects traversal and escapes', () => {
  assert.equal(safePath('../x'), null);
  assert.equal(safePath('a/../../b'), null);
  assert.equal(safePath('.hidden'), null);
  assert.equal(safePath('/abs/path'), null);
  assert.equal(safePath(''), null);
  assert.equal(safePath('a//b'), null);
});

test('create + tree + read + write + delete round trip', async () => {
  fs.rmSync(TEST_WORKS_DIR, { recursive: true, force: true });

  const w = createEntry('folder', '', 'My Novel');
  assert.equal(w.path, '01_My_Novel');
  const b = createEntry('folder', w.path, 'Book One');
  assert.equal(b.path, '01_My_Novel/01_Book_One');
  const c = createEntry('file', b.path, 'First Flight');
  assert.equal(c.path, '01_My_Novel/01_Book_One/01_First_Flight.md');
  const poem = createEntry('file', '', 'Poems');
  assert.match(poem.path, /^\d+_Poems\.md$/);
  // legacy hyphenated names keep working
  assert.equal(createEntry('file', w.path, 'old-note').path, '01_My_Novel/02_old-note.md');
});

test('create rejects duplicates and invalid parents', () => {
  assert.throws(() => createEntry('folder', '', 'My Novel'), /already exists/);
  assert.throws(() => createEntry('file', '../x', 'y'), /invalid parent/);
  assert.throws(() => createEntry('file', '', ''), /invalid name/);
});

test('write + read + word boundary of size caps', async () => {
  const tree = listWorks();
  const work = tree.find((n) => n.children);
  assert.ok(work);
  const chapter = work!.children!.flatMap((b) => b.children ?? []).find((n) => !n.children);
  assert.ok(chapter);

  writeChapter(chapter!.path, '# Hello\n\nWorld words here.');
  assert.equal(readChapter(chapter!.path), '# Hello\n\nWorld words here.');

  assert.throws(() => writeChapter('../evil.md', 'x'), /invalid path/);
  assert.throws(() => writeChapter('does-not-exist.md', 'x'), /invalid path|not found/);
  assert.throws(() => readChapter(chapter!.path.replace('.md', '.txt')), /invalid path/);
});

test('delete removes entry, tree reflects it', async () => {
  const before = listWorks();
  const poem = before.find((n) => n.children === undefined);
  assert.ok(poem);
  deleteEntry(poem!.path);
  assert.throws(() => readChapter(poem!.path), /invalid path|not found/);
  const after = listWorks();
  assert.ok(!after.some((n) => n.path === poem!.path));
});

test('git auto-commit records history', async () => {
  fs.rmSync(TEST_WORKS_DIR, { recursive: true, force: true });
  await commit('first'); // empty repo -> nothing to commit
  const work = createEntry('folder', '', 'Git Test');
  await commit(`create ${work.path}`); // empty dir -> git does not track it -> no commit
  const chapter = createEntry('file', work.path, 'Chapter');
  writeChapter(chapter.path, '# Hello\n');
  await commit(`save ${chapter.path}`);

  const log = await run('git', ['log', '--oneline'], { cwd: TEST_WORKS_DIR });
  const lines = log.stdout.trim().split('\n');
  // the seeded *.pdf .gitignore lands in the very first commit
  assert.equal(lines.length, 2, `expected 2 commits, got: ${log.stdout}`);
  assert.match(lines[0], /save 01_Git_Test\/01_Chapter\.md/);

  // nothing to commit -> no new commit
  const again = await commit('no-change');
  assert.equal(again, false);
  const count = await run('git', ['rev-list', '--count', 'HEAD'], { cwd: TEST_WORKS_DIR });
  assert.equal(count.stdout.trim(), '2');
  assert.equal(WORKS_DIR, TEST_WORKS_DIR);
});
test('display titles follow nesting depth', () => {
  fs.rmSync(TEST_WORKS_DIR, { recursive: true, force: true });

  const w = createEntry('folder', '', 'Epic');
  const b = createEntry('folder', w.path, 'Book One');
  const p = createEntry('folder', b.path, 'Part One');
  const c = createEntry('file', p.path, 'First Flight');
  const loose = createEntry('file', b.path, 'Loose');
  const poem = createEntry('file', '', 'Poems');

  const titles = new Map<string, string>();
  const walk = (ns: { path: string; title: string; children?: unknown[] }[]) => {
    for (const n of ns) {
      titles.set(n.path, n.title);
      if (n.children) walk(n.children as never);
    }
  };
  walk(listWorks());

  assert.equal(titles.get(w.path), 'Epic');
  assert.equal(titles.get(b.path), 'Book I: Book One');
  assert.equal(titles.get(p.path), 'Part 1: Part One');
  assert.equal(titles.get(c.path), 'Chapter 1: First Flight');
  assert.equal(titles.get(loose.path), 'Chapter 1: Loose'); // only chapter in the book
  assert.equal(titles.get(poem.path), 'Poems');

  // new files start empty: the filename is the title, no duplicate heading
  assert.equal(readChapter(c.path), '');
});

test('print pieces: label and raw split the display title', () => {
  fs.rmSync(TEST_WORKS_DIR, { recursive: true, force: true });

  const w = createEntry('folder', '', 'Epic');
  const b = createEntry('folder', w.path, 'Book One');
  const p = createEntry('folder', b.path, 'Part One');
  const c = createEntry('file', p.path, 'First Flight');
  const poem = createEntry('file', '', 'Poems');
  // notes.md is never auto-prefixed, so it is written directly
  fs.writeFileSync(path.join(TEST_WORKS_DIR, b.path, 'notes.md'), '# Notes\n', 'utf8');

  const pieces = new Map<string, { label: string; raw: string }>();
  const walk = (ns: { path: string; label: string; raw: string; children?: unknown[] }[]) => {
    for (const n of ns) {
      pieces.set(n.path, { label: n.label, raw: n.raw });
      if (n.children) walk(n.children as never);
    }
  };
  walk(listWorks());

  // bare entries carry no label; every other entry splits into label + raw,
  // which is what a division page prints
  assert.deepEqual(pieces.get(w.path), { label: '', raw: 'Epic' });
  assert.deepEqual(pieces.get(b.path), { label: 'Book I', raw: 'Book One' });
  assert.deepEqual(pieces.get(p.path), { label: 'Part 1', raw: 'Part One' });
  assert.deepEqual(pieces.get(c.path), { label: 'Chapter 1', raw: 'First Flight' });
  assert.deepEqual(pieces.get(b.path + '/notes.md'), { label: '', raw: 'notes' });
  assert.deepEqual(pieces.get(poem.path), { label: '', raw: 'Poems' });
});

test('a book without parts is still a Book (the Silmarillion shape)', () => {
  fs.rmSync(TEST_WORKS_DIR, { recursive: true, force: true });

  // one book that has parts, two that have none, all three directly in the work
  const w = createEntry('folder', '', 'Epic');
  const b1 = createEntry('folder', w.path, 'The Ages');
  const p1 = createEntry('folder', b1.path, 'The Dawn');
  const q1 = createEntry('file', p1.path, 'First Light');
  const b2 = createEntry('folder', w.path, 'Loose Sketches');
  createEntry('file', b2.path, 'Map Notes');
  const b3 = createEntry('folder', w.path, 'Draft Rewrites');
  createEntry('file', b3.path, 'New Opening');

  const titles = new Map<string, string>();
  const walk = (ns: { path: string; title: string; children?: unknown[] }[]) => {
    for (const n of ns) {
      titles.set(n.path, n.title);
      if (n.children) walk(n.children as never);
    }
  };
  walk(listWorks());

  assert.equal(titles.get(b1.path), 'Book I: The Ages'); // numbers come from own prefixes
  assert.equal(titles.get(p1.path), 'Part 1: The Dawn');
  assert.equal(titles.get(q1.path), 'Chapter 1: First Light');
  assert.equal(titles.get(b2.path), 'Book II: Loose Sketches'); // no parts, still a Book
  assert.equal(titles.get(b3.path), 'Book III: Draft Rewrites');
});

test('reserved matter names print bare, prefixed or not, and consume no number', () => {
  fs.rmSync(TEST_WORKS_DIR, { recursive: true, force: true });

  const w = createEntry('folder', '', 'Epic');
  // matter is recognized by its NAME, so these are written directly
  for (const name of ['front_matter.md', 'appendix.md', 'afterword.md']) {
    fs.writeFileSync(path.join(TEST_WORKS_DIR, w.path, name), 'x', 'utf8');
  }
  // a prefix orders matter without giving it a number: place it first
  const prefixed = createEntry('file', w.path, 'Preface');
  const chapter = createEntry('file', w.path, 'Chapter One');

  const titles = new Map<string, string>();
  const walk = (ns: { path: string; title: string; children?: unknown[] }[]) => {
    for (const n of ns) {
      titles.set(n.path, n.title);
      if (n.children) walk(n.children as never);
    }
  };
  walk(listWorks());

  assert.equal(titles.get(w.path + '/front_matter.md'), 'front matter');
  assert.equal(titles.get(w.path + '/appendix.md'), 'appendix');
  assert.equal(titles.get(w.path + '/afterword.md'), 'afterword');
  assert.equal(titles.get(prefixed.path), 'Preface'); // 01_ prefix, still bare
  assert.equal(titles.get(chapter.path), 'Chapter 1: Chapter One'); // matter took no number
});

test('titles clamp: 4-level chain and mixed sibling kinds', () => {
  fs.rmSync(TEST_WORKS_DIR, { recursive: true, force: true });

  const w = createEntry('folder', '', 'Epic');
  const b = createEntry('folder', w.path, 'Book One');
  const p = createEntry('folder', b.path, 'Part One');
  const sub = createEntry('folder', p.path, 'Deeper');
  const deep = createEntry('file', sub.path, 'Buried');
  createEntry('file', w.path, 'Loose Top'); // direct md inside the work folder

  const titles = new Map<string, string>();
  const walk = (ns: { path: string; title: string; children?: unknown[] }[]) => {
    for (const n of ns) {
      titles.set(n.path, n.title);
      if (n.children) walk(n.children as never);
    }
  };
  walk(listWorks());

  assert.equal(titles.get(w.path), 'Epic');
  assert.equal(titles.get(b.path), 'Book I: Book One');
  assert.equal(titles.get(p.path), 'Part 1: Part One');
  assert.equal(titles.get(sub.path), 'Part 1: Deeper'); // level 4 clamps to Part
  assert.equal(titles.get(deep.path), 'Chapter 1: Buried');
  assert.equal(titles.get(w.path + '/02_Loose_Top.md'), 'Chapter 1: Loose Top'); // only chapter in the work
});

test('titles: depth decides, a book needs no parts; legacy hyphen slugs resolve', () => {
  fs.rmSync(TEST_WORKS_DIR, { recursive: true, force: true });

  const w = createEntry('folder', '', 'Epic');
  const b = createEntry('folder', w.path, 'Book One');
  const c = createEntry('file', b.path, 'First Flight');
  const shallow = createEntry('folder', '', 'Just Chapters');
  const c2 = createEntry('file', shallow.path, 'Solo');

  const titles = new Map<string, string>();
  const walk = (ns: { path: string; title: string; children?: unknown[] }[]) => {
    for (const n of ns) {
      titles.set(n.path, n.title);
      if (n.children) walk(n.children as never);
    }
  };
  walk(listWorks());

  assert.equal(titles.get(w.path), 'Epic'); // top level: bare, no label at all
  assert.equal(titles.get(b.path), 'Book I: Book One'); // no parts, still a Book
  assert.equal(titles.get(c.path), 'Chapter 1: First Flight');
  assert.equal(titles.get(shallow.path), 'Just Chapters');
  assert.equal(titles.get(c2.path), 'Chapter 1: Solo');

  // legacy hyphenated file created out-of-band still gets a title
  fs.writeFileSync(`${TEST_WORKS_DIR}/${w.path}/01-old-note.md`, '# hi\n', 'utf8');
  const again = new Map(listWorks().flatMap((n) => n.children ?? []).map((n) => [n.path, n.title]));
  assert.equal(again.get(w.path + '/01-old-note.md'), 'Chapter 1: old note');
});

test('notes.md is folder material, unprefixed mds still number as chapters', () => {
  fs.rmSync(TEST_WORKS_DIR, { recursive: true, force: true });

  const w = createEntry('folder', '', 'Epic');
  const b = createEntry('folder', w.path, 'Book One');
  const a = createEntry('file', b.path, 'Alpha');
  fs.writeFileSync(path.join(TEST_WORKS_DIR, b.path, 'notes.md'), '# Notes\n', 'utf8');
  const beta = createEntry('file', b.path, 'Beta');
  fs.writeFileSync(path.join(TEST_WORKS_DIR, b.path, 'title.md'), 'wip\n', 'utf8');

  const titles = new Map<string, string>();
  const walk = (ns: { path: string; title: string; children?: unknown[] }[]) => {
    for (const n of ns) {
      titles.set(n.path, n.title);
      if (n.children) walk(n.children as never);
    }
  };
  walk(listWorks());

  assert.equal(titles.get(a.path), 'Chapter 1: Alpha');
  assert.equal(titles.get(beta.path), 'Chapter 2: Beta'); // notes.md consumed no number
  assert.equal(titles.get(b.path + '/notes.md'), 'notes');
  assert.equal(titles.get(b.path + '/title.md'), 'Chapter 3: title'); // unprefixed, numbered by position
});

test('display numbers are positional; the disk prefix only orders', () => {
  fs.rmSync(TEST_WORKS_DIR, { recursive: true, force: true });

  const w = createEntry('folder', '', 'Epic');
  const b = createEntry('folder', w.path, 'Book One');
  const a = createEntry('file', b.path, 'Alpha');
  fs.writeFileSync(path.join(TEST_WORKS_DIR, b.path, '07_gap.md'), 'x\n', 'utf8');

  const titles = new Map<string, string>();
  const walk = (ns: { path: string; title: string; children?: unknown[] }[]) => {
    for (const n of ns) {
      titles.set(n.path, n.title);
      if (n.children) walk(n.children as never);
    }
  };
  walk(listWorks());

  assert.equal(titles.get(a.path), 'Chapter 1: Alpha');
  // 07_ sorts it second, so it prints Chapter 2 — the prefix is not the number
  assert.equal(titles.get(b.path + '/07_gap.md'), 'Chapter 2: gap');
});

test('draft_ prefix marks entries, is stripped from titles, still numbers', () => {
  fs.rmSync(TEST_WORKS_DIR, { recursive: true, force: true });

  const w = createEntry('folder', '', 'Epic');
  const b = createEntry('folder', w.path, 'draft rewrites');
  const c = createEntry('file', b.path, 'draft idea2');
  const n = createEntry('file', b.path, 'final');
  const top = createEntry('file', '', 'draft scratchpad');

  const nodes = new Map<string, { title: string; draft: boolean; inDraft: boolean }>();
  const walk = (ns: {
    path: string;
    title: string;
    draft: boolean;
    inDraft: boolean;
    children?: unknown[];
  }[]) => {
    for (const x of ns) {
      nodes.set(x.path, { title: x.title, draft: x.draft, inDraft: x.inDraft });
      if (x.children) walk(x.children as never);
    }
  };
  walk(listWorks());

  assert.equal(nodes.get(b.path)!.draft, true);
  assert.equal(nodes.get(b.path)!.inDraft, true);
  assert.equal(nodes.get(b.path)!.title, 'Book I: rewrites');
  assert.equal(nodes.get(c.path)!.draft, true);
  assert.equal(nodes.get(c.path)!.inDraft, true);
  assert.equal(nodes.get(c.path)!.title, 'Chapter 1: idea2'); // drafts consume chapter numbers
  assert.equal(nodes.get(n.path)!.draft, false);
  assert.equal(nodes.get(n.path)!.inDraft, true); // inherits from the draft folder, no chip
  assert.equal(nodes.get(n.path)!.title, 'Chapter 2: final');
  assert.equal(nodes.get(top.path)!.draft, true);
  assert.equal(nodes.get(top.path)!.inDraft, true);
  assert.equal(nodes.get(top.path)!.title, 'scratchpad'); // top level is bare, draft token stripped

  assert.equal(parseName('01_draft_x.md').draft, true);
  assert.equal(parseName('draft_x').draft, true);
  assert.equal(parseName('01_xdraft_y.md').draft, false);
  assert.equal(parseName('01_draft.md').draft, false); // needs the underscore token
});

test('tree word counts: folders sum every nested md', () => {
  fs.rmSync(TEST_WORKS_DIR, { recursive: true, force: true });

  const w = createEntry('folder', '', 'Epic');
  const b = createEntry('folder', w.path, 'Book One');
  const p = createEntry('folder', b.path, 'Part One');
  const c1 = createEntry('file', p.path, 'One');
  writeChapter(c1.path, 'alpha beta gamma'); // 3 words
  const c2 = createEntry('file', b.path, 'Two');
  writeChapter(c2.path, 'delta\n\nepsilon 123'); // 3 words (code-free counting)
  fs.writeFileSync(path.join(TEST_WORKS_DIR, w.path, 'notes.md'), 'zeta', 'utf8'); // 1 word
  const empty = createEntry('folder', w.path, 'Empty');
  const code = createEntry('file', w.path, 'Coder');
  writeChapter(code.path, 'keep ```a b``` word'); // fenced code is stripped: 2 words

  const words = new Map<string, number>();
  const walk = (ns: { path: string; words: number; children?: unknown[] }[]) => {
    for (const n of ns) {
      words.set(n.path, n.words);
      if (n.children) walk(n.children as never);
    }
  };
  walk(listWorks());

  assert.equal(words.get(c1.path), 3);
  assert.equal(words.get(c2.path), 3);
  assert.equal(words.get(code.path), 2);
  assert.equal(words.get(b.path), 6); // chapter + nested part + notes... 3 + 3 = 6? no: part 3 + Two 3
  assert.equal(words.get(empty.path), 0);
  assert.equal(words.get(w.path), 9); // 3 (part) + 3 (Two) + 1 (notes) + 2 (Coder)
});

test('renameEntry edits the title: prefix and draft token are kept', () => {
  fs.rmSync(TEST_WORKS_DIR, { recursive: true, force: true });

  const w = createEntry('folder', '', 'Epic');
  const b = createEntry('folder', w.path, 'Book One');
  const c = createEntry('file', b.path, 'First Flight');

  // no prefix typed -> the entry keeps its place (the prefix is order only)
  const r1 = renameEntry(c.path, 'Second Flight');
  assert.equal(r1.path, '01_Epic/01_Book_One/01_Second_Flight.md');
  assert.equal(readChapter(r1.path), '');

  // a typed prefix wins
  const r2 = renameEntry(r1.path, '03_Third');
  assert.equal(r2.path, '01_Epic/01_Book_One/01_Third.md'); // renumbered into place

  // a title edit does not drop the draft token
  const dr = createEntry('file', '', 'draft thing');
  const r4 = renameEntry(dr.path, 'draft thing');
  assert.equal(r4.path, '02_draft_thing.md');
  const top = listWorks().find((n) => n.path === '02_draft_thing.md');
  assert.ok(top);
  assert.equal(top!.draft, true);

  // duplicates rejected — against the name the sibling actually has now, since
  // creating an entry renumbers the directory
  const d = createEntry('file', b.path, 'Alpha');
  const third = listWorks()
    .find((n) => n.path === w.path)!
    .children!.find((n) => n.path === b.path)!
    .children!.map((n) => n.path)
    .find((p) => parseName(p.split('/').pop()!).stem === 'Third')!;
  assert.throws(() => renameEntry(d.path, third.split('/').pop()!), /already exists/);

  // a case-variant collides too, same rule create uses (findExisting, not existsSync)
  assert.throws(() => renameEntry(d.path, 'ALPHA'), /already exists/);

  // folder rename cascades to children
  const r3 = renameEntry(w.path, 'Legend');
  assert.equal(r3.path, '01_Legend');
  assert.equal(readChapter(third.replace(w.path, r3.path)), '');

  // no-op rename and invalid names
  assert.equal(renameEntry(r3.path, 'Legend').path, r3.path);
  assert.throws(() => renameEntry(r3.path, ''), /invalid name/);
  assert.throws(() => renameEntry('../evil', 'x'), /invalid path/);
});

test('parseName defines the filename grammar in one place', () => {
  // numeric prefixes: _ and - separators, 1-4 digits
  assert.deepEqual(parseName('01_First_Flight.md'), {
    prefix: 1,
    draft: false,
    stem: 'First_Flight',
    raw: 'First Flight',
  });
  assert.deepEqual(parseName('03-old-note.markdown'), {
    prefix: 3,
    draft: false,
    stem: 'old-note',
    raw: 'old note',
  });
  assert.deepEqual(parseName('0123_x'), { prefix: 123, draft: false, stem: 'x', raw: 'x' });

  // draft token directly after the prefix
  assert.deepEqual(parseName('02_draft_idea.md').draft, true);
  assert.equal(parseName('02_draft_idea.md').raw, 'idea');
  assert.equal(parseName('draft_thing').draft, true); // unprefixed drafts
  assert.equal(parseName('draft').draft, false); // needs the underscore token
  assert.equal(parseName('02_draft.md').draft, false);

  // unprefixed entries
  assert.deepEqual(parseName('title.md'), {
    prefix: null,
    draft: false,
    stem: 'title',
    raw: 'title',
  });
  assert.deepEqual(parseName('notes.md'), {
    prefix: null,
    draft: false,
    stem: 'notes',
    raw: 'notes',
  });

  // no separator after digits -> not a prefix; empty title falls back to the base
  assert.equal(parseName('0123').prefix, null);
  assert.equal(parseName('01').raw, '01');
  assert.equal(parseName('01_').raw, '01_'); // prefix only: raw falls back to the base
  assert.equal(parseName('01_').stem, '');
});

test('moveEntry reorders and crosses folders, renumbering both', () => {
  fs.rmSync(TEST_WORKS_DIR, { recursive: true, force: true });

  const w = createEntry('folder', '', 'Epic');
  const a = createEntry('file', w.path, 'Alpha');
  const b = createEntry('file', w.path, 'Beta');
  const c = createEntry('file', w.path, 'Gamma');
  assert.deepEqual([a.path, b.path, c.path].map((p) => p.split('/').pop()), [
    '01_Alpha.md',
    '02_Beta.md',
    '03_Gamma.md',
  ]);

  const namesIn = (dir: string) =>
    listWorks()
      .find((n) => n.path === dir)!
      .children!.map((n) => n.name);

  // put the last one first: the others shift down, contiguously
  const r1 = moveEntry(c.path, w.path, a.path.split('/').pop());
  assert.equal(r1.moved.to, w.path + '/01_Gamma.md');
  assert.equal(r1.renumbered[b.path], w.path + '/03_Beta.md'); // reported with the fix
  assert.deepEqual(namesIn(w.path), ['01_Gamma.md', '02_Alpha.md', '03_Beta.md']);

  // across folders: the source closes its gap, the target numbers from 01
  const sub = createEntry('folder', '', 'Other').path;
  const r2 = moveEntry(r1.renumbered[b.path] ?? b.path, sub, null);
  assert.equal(r2.moved.to, sub + '/01_Beta.md');
  assert.deepEqual(namesIn(sub), ['01_Beta.md']);
  assert.deepEqual(namesIn(w.path), ['01_Gamma.md', '02_Alpha.md']);

  // a folder cannot move inside itself
  assert.throws(() => moveEntry(w.path, w.path + '/x', null), /invalid move/);
});

test('moveEntry out of a folder that the destination renumber renames', () => {
  // the reported failure: dropping a chapter on the top half of its own
  // work folder sends it to the works root, where renumbering gives the
  // incoming entry slot 01 and shifts the work folder itself. Renumbering the
  // source before/after with a stale path threw "invalid parent".
  fs.rmSync(TEST_WORKS_DIR, { recursive: true, force: true });

  const work = createEntry('folder', '', 'Epic');
  const book = createEntry('folder', work.path, 'Book One');
  const c1 = createEntry('file', book.path, 'Alpha');
  createEntry('file', book.path, 'Beta');

  // the gesture: top half of the work folder row = its own level, above it
  const r = moveEntry(c1.path, '', work.path.split('/').pop());
  assert.equal(r.moved.to, '01_Alpha.md');
  // the work folder moved down a slot because the incoming entry took 01, and
  // the source's remaining chapter must be reported under its NEW path
  assert.equal(r.renumbered[work.path], '02_Epic');
  assert.equal(r.renumbered['02_Epic/01_Book_One/02_Beta.md'], '02_Epic/01_Book_One/01_Beta.md');

  // and the tree agrees with the map
  assert.deepEqual(listWorks().map((n) => n.name), ['01_Alpha.md', '02_Epic']);
  assert.deepEqual(
    listWorks().find((n) => n.name === '02_Epic')!.children!.map((n) => n.name),
    ['01_Book_One'],
  );
});
