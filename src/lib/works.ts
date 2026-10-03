import fs from 'node:fs';
import path from 'node:path';
import { WORKS_DIR } from './config.ts';
import { naturalCompare, NOTES, parseName, slugify } from './naming.ts';
import { countWords } from './words.ts';

// re-exported for a single import surface (API routes, tests)
export { naturalCompare, slugify, NOTES } from './naming.ts';
import type { ParsedName } from './naming.ts';

const MAX_FILE = 512 * 1024;
const MD = /\.(md|markdown)$/i;

export type Node = {
  name: string;
  path: string;
  title: string;
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

// word count for one md; unreadable or oversized files count as 0
function countFile(abs: string): number {
  try {
    if (fs.statSync(abs).size > MAX_FILE) return 0;
    return countWords(fs.readFileSync(abs, 'utf8'));
  } catch {
    return 0;
  }
}

function scan(absDir: string, relPrefix: string, depth: number, inDraft: boolean): Node[] {
  const entries = fs
    .readdirSync(absDir, { withFileTypes: true })
    .filter((e) => !e.name.startsWith('.') && (e.isDirectory() || MD.test(e.name)))
    .sort((a, b) => naturalCompare(a.name, b.name));
  const out: Node[] = [];
  for (const e of entries) {
    const rel = relPrefix + e.name;
    const draft = parseName(e.name).draft;
    if (e.isDirectory()) {
      const children = scan(path.join(absDir, e.name), `${rel}/`, depth + 1, inDraft || draft);
      out.push({
        name: e.name,
        path: rel,
        title: '',
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
        draft,
        inDraft: inDraft || draft,
        words: countFile(path.join(absDir, e.name)),
      });
    }
  }
  return out;
}

export function listWorks(): Node[] {
  fs.mkdirSync(WORKS_DIR, { recursive: true });
  const tree = scan(WORKS_DIR, '', 0, false);
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
// Labels are anchored to the top of the deepest folder chain through a node:
// Work / Book / Part / (Part, Part, ...). Folders on shallower side branches
// keep the label their own depth implies, and the deepest chain wins. Every
// md below the top level is a chapter; top-level entries are presented bare.
type Kind = 'work' | 'book' | 'part' | 'chapter';

const LABEL: Record<Kind, string> = {
  work: 'Work',
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
  return kind === 'book' || kind === 'part' ? toRoman(num) : String(num);
}

function folderKind(depth: number, maxSub: number): Kind {
  const chain = depth + 1 + maxSub;
  if (chain <= 1) return 'book';
  if (chain === 2) return depth === 0 ? 'book' : 'part';
  if (depth === 0) return 'work';
  return depth === 1 ? 'book' : 'part';
}

function rawTitle({ raw }: ParsedName): string {
  return raw;
}

function maxSubOf(node: Node): number {
  if (node.children === undefined) return 0;
  const folders = node.children.filter((c) => c.children !== undefined);
  return folders.length ? 1 + Math.max(...folders.map(maxSubOf)) : 0;
}

function assignTitles(nodes: Node[], depth: number): void {
  for (const n of nodes) {
    const parsed = parseName(n.name);
    if (depth === 0) {
      // top-level entries are presented bare, without label or number
      n.title = rawTitle(parsed);
    } else if (n.children === undefined && NOTES.test(n.name)) {
      n.title = rawTitle(parsed);
    } else {
      const kind: Kind = n.children !== undefined ? folderKind(depth, maxSubOf(n)) : 'chapter';
      // the display number is the entry's own disk prefix; unprefixed -> ?
      const num = parsed.prefix ?? '?';
      n.title = `${LABEL[kind]} ${kindNumber(kind, num)}: ${rawTitle(parsed)}`;
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
  return { path: rel };
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

export function deleteEntry(rel: string): void {
  const abs = safePath(rel);
  if (!abs || abs === fs.realpathSync(WORKS_DIR)) throw new Error('invalid path');
  fs.rmSync(abs, { recursive: true });
  // the compiled pdf is a sibling artifact, not tracked data: remove it too
  const pdf = pdfSibling(rel, abs);
  if (fs.existsSync(pdf)) fs.rmSync(pdf);
}

// compiled pdfs live beside their source (chapter or folder)
function pdfSibling(rel: string, abs: string): string {
  return MD.test(rel) ? abs.replace(MD, '.pdf') : `${abs}.pdf`;
}

export function renameEntry(rel: string, name: string): { path: string } {
  const abs = safePath(rel);
  if (!abs || rel === '') throw new Error('invalid path');
  const slug = slugify(name);
  if (!slug) throw new Error('invalid name');
  const isFile = MD.test(rel);
  const parentAbs = path.dirname(abs);
  // what you type is the name: numeric prefixes exist only when typed
  const base = isFile ? slug.replace(/\.(md|markdown)$/i, '') : slug;
  const target = `${base}${isFile ? '.md' : ''}`;
  const targetAbs = path.join(parentAbs, target);
  if (targetAbs === abs) return { path: rel };
  if (fs.existsSync(targetAbs)) throw new Error('already exists');
  fs.renameSync(abs, targetAbs);
  // carry the compiled pdf to the new name, if one was built
  const parentRel = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/') + 1) : '';
  const newRel = `${parentRel}${target}`;
  const oldPdf = pdfSibling(rel, abs);
  if (fs.existsSync(oldPdf)) {
    fs.renameSync(oldPdf, pdfSibling(newRel, targetAbs));
  }
  return { path: newRel };
}