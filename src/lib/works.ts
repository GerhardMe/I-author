import fs from 'node:fs';
import path from 'node:path';
import { WORKS_DIR } from './config.ts';
import { MATTER, isReserved, naturalCompare, NOTES, parseName, slugify } from './naming.ts';
import { countWords } from './words.ts';

// re-exported for a single import surface (API routes, tests)
export { naturalCompare, slugify, NOTES } from './naming.ts';

const MAX_FILE = 512 * 1024;
// word counting is allowed a much bigger read than the editor (writeChapter
// caps content at MAX_FILE, so only externally written files exceed it) —
// the tree chip must not lie about words a real file contains
const MAX_COUNT = 4 * MAX_FILE;
const MD = /\.(md|markdown)$/i;

export type Node = {
  name: string;
  path: string;
  title: string;
  // title in print pieces: label is the division ("Part 1", "Book I"), empty
  // for bare entries (top level, notes.md); raw is the filename's own title
  label: string;
  raw: string;
  draft: boolean; // self: carries the draft_ token (owns the (draft) chip)
  inDraft: boolean; // self or any ancestor is a draft (grays titles, no chip)
  words: number; // self (md) or recursive total of all descendant mds
  children?: Node[];
};

export function safePath(rel: string): string | null {
  if (typeof rel !== 'string' || !rel) return null;
  const parts = rel.split('/');
  if (parts.some((p) => !p || p === '.' || p === '..' || p.startsWith('.'))) return null;
  try {
    const root = fs.realpathSync(WORKS_DIR);
    const abs = fs.realpathSync(path.join(root, ...parts));
    if (abs === root || abs.startsWith(root + path.sep)) return abs;
  } catch {
    return null;
  }
  return null;
}

// word count for one md; unreadable files count as 0
function countFile(abs: string): number {
  try {
    if (fs.statSync(abs).size > MAX_COUNT) return 0;
    return countWords(fs.readFileSync(abs, 'utf8'));
  } catch {
    return 0;
  }
}

function scan(absDir: string, relPrefix: string, inDraft: boolean): Node[] {
  // an unreadable directory (EACCES, EBUSY on a mounted volume) must not kill
  // the whole tree — it shows as empty, exactly like an unreadable file in
  // countFile below counts as 0 words
  let entries: fs.Dirent[];
  try {
    entries = fs
      .readdirSync(absDir, { withFileTypes: true })
      .filter((e) => !e.name.startsWith('.') && (e.isDirectory() || MD.test(e.name)))
      .sort((a, b) => naturalCompare(a.name, b.name));
  } catch {
    return [];
  }
  const out: Node[] = [];
  for (const e of entries) {
    const rel = relPrefix + e.name;
    const draft = parseName(e.name).draft;
    if (e.isDirectory()) {
      const children = scan(path.join(absDir, e.name), `${rel}/`, inDraft || draft);
      out.push({
        name: e.name,
        path: rel,
        title: '',
        label: '',
        raw: '',
        draft,
        inDraft: inDraft || draft,
        words: children.reduce((sum, c) => sum + c.words, 0),
        children,
      });
    } else {
      out.push({
        name: e.name,
        path: rel,
        title: '',
        label: '',
        raw: '',
        draft,
        inDraft: inDraft || draft,
        words: countFile(path.join(absDir, e.name)),
      });
    }
  }
  return out;
}

export function listWorks(): Node[] {
  // no mkdirSync here: a GET must not create anything; scan() returns [] on
  // ENOENT and ensureRepo (commit time) owns creating the works dir
  const tree = scan(WORKS_DIR, '', false);
  assignTitles(tree, 0);
  return tree;
}

function nextName(parentAbs: string, slug: string): string {
  if (parseName(slug).prefix !== null) return slug;
  let max = 0;
  for (const e of fs.readdirSync(parentAbs)) {
    const n = parseName(e).prefix;
    if (n !== null && n > max) max = n;
  }
  return `${String(max + 1).padStart(2, '0')}_${slug}`;
}

// ---------- display titles ----------
// Depth decides what a folder is, because depth is the schema: a folder
// directly under a top-level work is a Book whether or not it happens to
// contain Parts (a book with none is still a book), anything deeper is a
// Part, level 4 and below clamps to Part. Every md below the top level is a
// chapter; top-level entries are presented bare, as are notes.md and the
// reserved matter names.
type Kind = 'book' | 'part' | 'chapter';

const LABEL: Record<Kind, string> = {
  book: 'Book',
  part: 'Part',
  chapter: 'Chapter',
};

export function toRoman(n: number): string {
  if (n < 1 || n > 3999) return String(n);
  const pairs: [number, string][] = [
    [1000, 'M'],
    [900, 'CM'],
    [500, 'D'],
    [400, 'CD'],
    [100, 'C'],
    [90, 'XC'],
    [50, 'L'],
    [40, 'XL'],
    [10, 'X'],
    [9, 'IX'],
    [5, 'V'],
    [4, 'IV'],
    [1, 'I'],
  ];
  let out = '';
  for (const [v, s] of pairs) while (n >= v) (out += s), (n -= v);
  return out;
}

function kindNumber(kind: Kind, num: number | '?'): string {
  if (num === '?') return '?';
  // books get Roman numerals; parts and chapters are Arabic
  return kind === 'book' ? toRoman(num) : String(num);
}

function assignTitles(nodes: Node[], depth: number): void {
  // The disk prefix is ORDER ONLY; the printed number is the entry's position
  // among same-kind siblings, so a book's label is "Book II" whenever it is
  // the second book, whatever its prefix says. Counted over the whole sibling
  // list, drafts included, so hiding drafts never renumbers anything — and
  // notes.md and matter, which print bare, consume no number.
  const pos: Record<Kind, number> = { book: 0, part: 0, chapter: 0 };
  for (const n of nodes) {
    const parsed = parseName(n.name);
    n.raw = parsed.raw;
    if (depth === 0) {
      // top-level entries are presented bare, without label or number
      n.label = '';
      n.title = n.raw;
    } else if (n.children === undefined && (NOTES.test(n.name) || MATTER.test(n.name))) {
      // folder material and front/back matter: ordered by prefix, never numbered
      n.label = '';
      n.title = n.raw;
    } else {
      const kind: Kind =
        n.children !== undefined ? (depth === 1 ? 'book' : 'part') : 'chapter';
      pos[kind] += 1;
      n.label = `${LABEL[kind]} ${kindNumber(kind, pos[kind])}`;
      n.title = `${n.label}: ${n.raw}`;
    }
    if (n.children !== undefined) assignTitles(n.children, depth + 1);
  }
}

function findExisting(parentAbs: string, slug: string): boolean {
  return fs
    .readdirSync(parentAbs)
    .some((e) => parseName(e).stem.toLowerCase() === slug.toLowerCase());
}

export function createEntry(kind: 'folder' | 'file', parent: string, name: string): { path: string } {
  const slug = slugify(name);
  if (!slug) throw new Error('invalid name');
  let parentAbs: string;
  if (parent === '') {
    fs.mkdirSync(WORKS_DIR, { recursive: true });
    parentAbs = fs.realpathSync(WORKS_DIR);
  } else {
    const p = safePath(parent);
    if (!p || !fs.statSync(p).isDirectory()) throw new Error('invalid parent');
    parentAbs = p;
  }
  if (findExisting(parentAbs, slug)) throw new Error('already exists');
  const base = nextName(parentAbs, slug);
  const rel = `${parent === '' ? '' : `${parent}/`}${base}${kind === 'file' ? '.md' : ''}`;
  const abs = path.join(WORKS_DIR, rel);
  if (fs.existsSync(abs)) throw new Error('already exists');
  if (kind === 'folder') {
    fs.mkdirSync(abs);
  } else {
    // the filename is the title; files start empty (no duplicate heading)
    fs.writeFileSync(abs, '', 'utf8');
  }
  // close any gaps the directory carried, then report where the entry ended up
  const renumbered = renumberDir(parent);
  return { path: renumbered[rel] ?? rel, renumbered };
}

export function readChapter(rel: string): string {
  const abs = safePath(rel);
  if (!abs || !MD.test(rel)) throw new Error('invalid path');
  if (!fs.statSync(abs).isFile()) throw new Error('not found');
  if (fs.statSync(abs).size > MAX_FILE) throw new Error('too large');
  return fs.readFileSync(abs, 'utf8');
}

export function writeChapter(rel: string, content: string): void {
  const abs = safePath(rel);
  if (!abs || !MD.test(rel)) throw new Error('invalid path');
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new Error('not found');
  if (Buffer.byteLength(content, 'utf8') > MAX_FILE) throw new Error('too large');
  const tmp = `${abs}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, abs);
}

export function deleteEntry(rel: string): Record<string, string> {
  const abs = safePath(rel);
  if (!abs || abs === fs.realpathSync(WORKS_DIR)) throw new Error('invalid path');
  const parent = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
  fs.rmSync(abs, { recursive: true });
  // the compiled pdf is a sibling artifact, not tracked data: remove it too
  const pdf = pdfSibling(rel, abs);
  if (fs.existsSync(pdf)) fs.rmSync(pdf);
  return renumberDir(parent);
}

// compiled pdfs live beside their source (chapter or folder)
function pdfSibling(rel: string, abs: string): string {
  return MD.test(rel) ? abs.replace(MD, '.pdf') : `${abs}.pdf`;
}

// ---------- ordering ----------
// The NN_ prefix is order only, so it is kept contiguous per directory and
// never printed. Everything below renames on disk and git-records the result.

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function dirFor(rel: string): string {
  if (rel === '') {
    fs.mkdirSync(WORKS_DIR, { recursive: true });
    return fs.realpathSync(WORKS_DIR);
  }
  const abs = safePath(rel);
  if (!abs || !fs.statSync(abs).isDirectory()) throw new Error('invalid parent');
  return abs;
}

// entries that take part in ordering (reserved bare names do not)
function movableNames(parentAbs: string): string[] {
  return fs
    .readdirSync(parentAbs, { withFileTypes: true })
    .filter((e) => !e.name.startsWith('.') && (e.isDirectory() || MD.test(e.name)))
    .map((e) => e.name)
    .filter((n) => !isReserved(n))
    .sort(naturalCompare);
}

// Rewrite a directory to the given order, one contiguous NN_ prefix per entry
// (stem and draft_ token preserved). Two-phase: everything that has to move is
// parked under a dot-prefixed temp name first, so a change that swaps 01 and 02
// cannot clobber a file. Compiled pdfs follow their entry. Returns the
// old -> new rel map for everything that moved.
function applyOrder(parentAbs: string, parentRel: string, ordered: string[]): Record<string, string> {
  const base = parentRel === '' ? '' : `${parentRel}/`;
  const target = ordered.map((name, i) => {
    const ext = MD.test(name) ? '.md' : '';
    return `${pad2(i + 1)}_${parseName(name).stem}${ext}`;
  });
  const moved = ordered.map((name, i) => name !== target[i]);
  if (!moved.some(Boolean)) return {};

  const temp = ordered.map((name, i) => (moved[i] ? `.__ord${i}__${MD.test(name) ? '.md' : ''}` : name));
  ordered.forEach((name, i) => {
    if (!moved[i]) return;
    const from = path.join(parentAbs, name);
    const to = path.join(parentAbs, temp[i]!);
    fs.renameSync(from, to);
    const pdf = `${from}.pdf`;
    if (fs.existsSync(pdf)) fs.renameSync(pdf, `${to}.pdf`);
  });

  const map: Record<string, string> = {};
  ordered.forEach((name, i) => {
    if (!moved[i]) return;
    const from = path.join(parentAbs, temp[i]!);
    const to = path.join(parentAbs, target[i]!);
    fs.renameSync(from, to);
    const pdf = `${from}.pdf`;
    if (fs.existsSync(pdf)) fs.renameSync(pdf, `${to}.pdf`);
    map[base + name] = base + target[i]!;
  });
  return map;
}

const relIn = (parent: string, name: string): string => (parent === '' ? name : `${parent}/${name}`);

// Apply an old->new path map to ONE path, matching the LONGEST prefix: a
// directory rename renames everything inside it, so the map carries the ancestor
// while the path being fixed is some descendant of it. Exact-key lookup finds
// nothing there and returns a path that no longer exists.
function remapPath(map: Record<string, string>, p: string): string {
  let best = '';
  let to = '';
  for (const [from, dest] of Object.entries(map)) {
    if ((p === from || p.startsWith(from + '/')) && from.length > best.length) {
      best = from;
      to = dest;
    }
  }
  return to ? to + p.slice(best.length) : p;
}

// close the gaps in a directory (prefix top-level works, tidy what is inside)
export function renumberDir(parent: string): Record<string, string> {
  const parentAbs = dirFor(parent);
  return applyOrder(parentAbs, parent, movableNames(parentAbs));
}

// Move an entry to `parent`, directly before the sibling named `before`
// (null = last), then renumber both directories. A folder cannot move into
// its own subtree.
export function moveEntry(
  rel: string,
  parent: string,
  before: string | null,
): { moved: { from: string; to: string }; renumbered: Record<string, string> } {
  const abs = safePath(rel);
  if (!abs || rel === '') throw new Error('invalid path');
  if (parent === rel || parent.startsWith(rel + '/')) throw new Error('invalid move');
  const src = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
  const name = path.basename(rel);

  const dstAbs = dirFor(parent);
  const renumbered: Record<string, string> = {};
  // Move the entry out FIRST. Renumbering the destination afterwards can rename
  // the source's own ancestors — the source directory included — because the
  // destination may be an ancestor of it (dropping an entry above the folder it
  // came from lands it in that folder's parent, and the incoming entry then
  // takes a slot that shifts every sibling). Renumbering first left the source
  // path dangling and the drop failed with "invalid parent".
  if (src !== parent) {
    const into = path.join(dstAbs, name);
    if (fs.existsSync(into)) throw new Error('already exists');
    fs.renameSync(abs, into);
    const pdf = pdfSibling(rel, abs);
    if (fs.existsSync(pdf)) fs.renameSync(pdf, path.join(dstAbs, path.basename(pdf)));
  }

  const siblings = movableNames(dstAbs).filter((n) => n !== name);
  const at = before && siblings.includes(before) ? siblings.indexOf(before) : siblings.length;
  siblings.splice(at, 0, name);
  Object.assign(renumbered, applyOrder(dstAbs, parent, siblings));

  if (src !== parent) {
    // resolve the source through the destination's map: it may have been
    // renamed by that renumber, and the map is what the client remaps with too,
    // so the source's entries must be reported under their new ancestor
    const srcNow = remapPath(renumbered, src);
    const srcAbs = dirFor(srcNow);
    Object.assign(renumbered, applyOrder(srcAbs, srcNow, movableNames(srcAbs)));
  }
  const to = remapPath(renumbered, relIn(parent, name));
  return { moved: { from: rel, to }, renumbered };
}

// The typed name is the TITLE, not the whole disk name: the entry keeps its
// numeric prefix (which is order only, and app-managed) unless the typed name
// carries one explicitly — un-numbering is impossible by design. The draft_
// token follows the typed name instead: the rename editor prefills the full
// disk name, so keeping it keeps the draft and deleting it un-drafts.
// Without the prefix preservation, editing a title in a tree that hides
// prefixes would silently drop the prefix and send the file to the end of
// its folder.
function composeName(oldName: string, typed: string, isFile: boolean): string {
  const old = parseName(oldName);
  const t = parseName(typed);
  const prefix = t.prefix !== null ? t.prefix : old.prefix;
  const draft = t.draft;
  const titleStem = t.stem.replace(/^draft_/, '');
  return (
    `${prefix !== null ? `${String(prefix).padStart(2, '0')}_` : ''}` +
    `${draft ? 'draft_' : ''}${titleStem}${isFile ? '.md' : ''}`
  );
}

export function renameEntry(rel: string, name: string): { path: string; renumbered: Record<string, string> } {
  const abs = safePath(rel);
  if (!abs || rel === '') throw new Error('invalid path');
  const slug = slugify(name);
  if (!slug) throw new Error('invalid name');
  const isFile = MD.test(rel);
  const parentAbs = path.dirname(abs);
  const target = composeName(path.basename(rel), slug, isFile);
  const targetAbs = path.join(parentAbs, target);
  if (targetAbs === abs) return { path: rel, renumbered: renumberDir(parentOf(rel)) };
  // same collision rule create uses: case-insensitive, prefix-stripped — an
  // exact-name check would let a case-variant through (and then renumberDir
  // would happily sit two same-stem siblings next to each other)
  if (fs.existsSync(targetAbs) || findExisting(parentAbs, slug))
    throw new Error('already exists');
  fs.renameSync(abs, targetAbs);
  // carry the compiled pdf to the new name, if one was built
  const parentRel = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/') + 1) : '';
  const newRel = `${parentRel}${target}`;
  const oldPdf = pdfSibling(rel, abs);
  if (fs.existsSync(oldPdf)) {
    fs.renameSync(oldPdf, pdfSibling(newRel, targetAbs));
  }
  const renumbered = renumberDir(parentOf(rel));
  return { path: renumbered[newRel] ?? newRel, renumbered };
}

function parentOf(rel: string): string {
  return rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
}