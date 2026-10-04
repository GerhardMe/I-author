// PDF compiler (milestone 5): compiles a scope — a chapter or a folder (with
// title page, contents, and every descendant chapter) — into a real PDF via
// LuaLaTeX and the `markdown` package. The preamble ("stylesheet") comes from
// the pdfstyles/ folder; the compiled artifact lives in the works dir beside
// its source, so storage stays readable without the app. Drafts and notes.md
// never leak into compiled output.
//
// Books compile incrementally: every chapter and every Book/Part heading is
// compiled once into a small "fragment" pdf, cached in a scratch dir keyed by
// a content hash (style + title + markdown). The book wrapper assembles the
// fragments with pdfpages and owns the TOC and the continuous page numbering,
// so editing one chapter of a large work recompiles just that fragment.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { WORKS_DIR } from './config.ts';
import { parseName, slugify } from './naming.ts';
import { type Node, listWorks, readChapter, safePath } from './works.ts';
import { visibleNodes } from './visibility.ts';
import { ensureRepo } from './git.ts';

const run = promisify(execFile);
const LUALATEX = process.env.IAUTHOR_LUALATEX ?? 'lualatex';
const TEXBUILD = path.resolve('.texbuild');
const FRAG_DIR = path.join(TEXBUILD, 'frag');
const STYLES_DIR = path.resolve('pdfstyles');
const MD = /\.(md|markdown)$/i;

// ---------- styles ----------
export type PdfStyle = { id: string; label: string; note: string };

// the first line of a style file is `% label: <Label> — <note>`
function styleMeta(file: string): { label: string; note: string } {
  const first = fs.readFileSync(file, 'utf8').split('\n', 1)[0] ?? '';
  const m = /^% label: (.*?)(?: — (.*))?$/.exec(first.trim());
  return { label: m?.[1] ?? path.basename(file), note: m?.[2] ?? '' };
}

export function listPdfStyles(): PdfStyle[] {
  let ids: string[] = [];
  try {
    ids = fs
      .readdirSync(STYLES_DIR)
      .filter((f) => f.endsWith('.tex'))
      .map((f) => f.slice(0, -4));
  } catch {
    return [];
  }
  // the house academic trim first, the rest alphabetical
  ids.sort((a, b) =>
    a === 'academic' ? -1 : b === 'academic' ? 1 : a.localeCompare(b),
  );
  return ids.map((id) => ({ id, ...styleMeta(path.join(STYLES_DIR, `${id}.tex`)) }));
}

function resolveStyle(id: string | null): { id: string; preamble: string } {
  const styles = listPdfStyles();
  const pick = styles.find((s) => s.id === id) ?? styles[0];
  if (!pick) throw new Error('no pdf styles found');
  return { id: pick.id, preamble: fs.readFileSync(path.join(STYLES_DIR, `${pick.id}.tex`), 'utf8') };
}

// ---------- scope tree ----------
// compiled exports mirror the sidebar's drafts toggle: with drafts hidden,
// draft entries, notes.md, and folders left with nothing visible are dropped;
// with drafts visible, draft entries ride along (notes.md is folder material
// and never compiles as a chapter). The rule itself lives in visibility.ts —
// one implementation for sidebar and print.
function clean(nodes: Node[], includeDrafts: boolean): Node[] {
  return visibleNodes(nodes, { drafts: !includeDrafts, notes: true, empty: true });
}

function findNode(nodes: Node[], rel: string): Node | null {
  for (const n of nodes) {
    if (n.path === rel) return n;
    if (n.children !== undefined && rel.startsWith(n.path + '/')) {
      const found = findNode(n.children, rel);
      if (found) return found;
    }
  }
  return null;
}

// ---------- latex helpers ----------
function texEsc(s: string): string {
  return s.replace(/[\\&%$#_{}~^]/g, (c) => `\\${c}`);
}

// display name for print: underscores become spaces ("First_Flight" reads)
function pretty(s: string): string {
  return texEsc(s.replace(/_/g, ' '));
}

function titlePage(title: string): string {
  const date = new Date().toLocaleDateString('en-GB', { year: 'numeric', month: 'long' });
  return [
    '\\begin{titlepage}',
    '  \\centering',
    '  \\vspace*{4cm}',
    `  {\\Huge\\bfseries ${pretty(title)}\\par}`,
    '  \\vspace{2.5cm}',
    `  {\\small ${texEsc(date)}\\par}`,
    '  \\vfill',
    '\\end{titlepage}',
  ].join('\n');
}

// ---------- fragments ----------
function sha(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 20);
}

export type FragItem = {
  kind: 'part' | 'chapter';
  title: string; // fused display title — the toc entry
  label: string; // division label ("Part 1"), '' for a bare container
  raw: string; // the folder's own title
  above: string; // enclosing division line ("Book I: Book One"), '' if none
  key: string; // content hash: style + the printed lines (+ md content)
  file: string; // cached fragment pdf path
  abs?: string; // chapter md path
};

function fragFile(key: string): string {
  return path.join(FRAG_DIR, `f${key}.pdf`);
}

// the line naming a division as a container of another: "Book I: Book One",
// or just the title when the division is presented bare (a top-level work)
function containerLine(n: { label: string; raw: string }): string {
  return n.label ? `${n.label}: ${n.raw}` : n.raw;
}

// book layout in order: a division page for every non-root folder, chapter
// pages under them. The walk carries the enclosing division down, so every
// page knows the line to print above itself — a book's parts name the book,
// a work's books name the work. A fragment file that exists is current (the
// hash covers the style and every printed line), so freshness needs no state
export function collectItems(node: Node, styleHash: string, out: FragItem[]): void {
  const walk = (n: Node, above: string): void => {
    if (n.children === undefined) return;
    for (const c of n.children) {
      if (c.children !== undefined) {
        // this folder's page first, then everything under it
        const key = sha(`${styleHash}\n${above}\n${c.label}\n${c.raw}`);
        out.push({
          kind: 'part',
          title: c.title,
          label: c.label,
          raw: c.raw,
          above,
          key,
          file: fragFile(key),
        });
        // the container line of this folder's children is its own
        walk(c, containerLine(c));
        continue;
      }
      let content = '';
      try {
        content = readChapter(c.path);
      } catch {}
      const key = sha(`${styleHash}\n${c.title}\n${content}`);
      out.push({
        kind: 'chapter',
        title: c.title,
        label: c.label,
        raw: c.raw,
        above,
        key,
        file: fragFile(key),
        abs: safePath(c.path) ?? undefined,
      });
    }
  };
  // the scope itself never prints a page, but it is the container of its
  // children — compiling a book gives its parts the book's line
  walk(node, containerLine(node));
}

// a chapter fragment is the exact pages the chapter occupies inside a book —
// same heading, same style — with pagestyle empty so the wrapper's footer
// numbering is the only one. One pass: fragments carry no TOC.
function chapterFragTex(title: string, abs: string, preamble: string): string {
  return [
    preamble,
    '\\markdownSetup{shiftHeadings=1}',
    '\\pagestyle{empty}',
    '\\begin{document}',
    `\\section*{${texEsc(title)}}`,
    `\\markdownInput{${abs}}`,
    '\\end{document}',
    '',
  ].join('\n');
}

// a division page (Book/Part folder) stacks the way the printed convention
// does — the more senior the division, the smaller its type: the enclosing
// division in small caps, this division's label below it, then the title
// large. Both upper lines are always present; a bare container (a top-level
// work) simply contributes its title without a label. The title itself still
// goes through \part*, so the style's titlesec block owns its size and the
// air above it.
function partFragTex(it: FragItem, preamble: string): string {
  return [
    preamble,
    '\\pagestyle{empty}',
    '\\begin{document}',
    '{',
    '  \\centering',
    '  \\vspace*{3.5cm}',
    `  {\\small\\MakeUppercase{${texEsc(it.above)}}\\par}`,
    '  \\vspace{2.5em}',
    `  {\\normalsize ${texEsc(it.label)}\\par}`,
    '}',
    `\\part*{${pretty(it.raw)}}`,
    '\\end{document}',
    '',
  ].join('\n');
}

// the book wrapper: title page, table of contents, then one \includepdf per
// fragment. addtotoc puts the TOC entry (and with it the bookmark anchor) on
// the fragment's first page, so printed numbers and toc links stay correct.
// Chapter pages carry the wrapper's continuous footer; part pages stay
// footerless, like LaTeX parts.
function bookTex(scopeTitle: string, items: FragItem[], preamble: string): string {
  const includes = items.map((it) => {
    const sec = it.kind === 'part' ? 'part' : 'section';
    const pageStyle = it.kind === 'part' ? 'empty' : 'plain';
    return `\\includepdf[pages=1-,pagecommand={\\thispagestyle{${pageStyle}}},addtotoc={1,${sec},0,${texEsc(it.title)},l${it.key}}]{${it.file}}`;
  });
  return [
    preamble,
    // pdfpages loads after the preamble (and after hyperref, per its docs)
    '\\usepackage{pdfpages}',
    '\\begin{document}',
    titlePage(scopeTitle),
    '\\tableofcontents',
    '\\clearpage',
    ...includes,
    '\\end{document}',
    '',
  ].join('\n');
}

// ---------- compile ----------
async function runLatex(tex: string, jobname: string, passes: number): Promise<Buffer> {
  fs.mkdirSync(TEXBUILD, { recursive: true });
  const dir = fs.mkdtempSync(path.join(TEXBUILD, 'j-'));
  try {
    fs.writeFileSync(path.join(dir, `${jobname}.tex`), tex);
    // no --shell-escape: nothing in pdfstyles/ needs it, and it hands a
    // compiled document \write18 — pure attack surface on a server
    const args = ['-interaction=nonstopmode', `-jobname=${jobname}`, `${jobname}.tex`];
    // non-stop mode still exits nonzero on recoverable errors; only a missing
    // pdf is fatal. Multiple passes: the TOC needs the first pass's .toc file.
    for (let i = 0; i < passes; i++) {
      await run(LUALATEX, args, { cwd: dir, timeout: 180_000 }).catch(() => {});
    }
    const pdf = path.join(dir, `${jobname}.pdf`);
    if (!fs.existsSync(pdf)) throw latexError(dir, jobname);
    return fs.readFileSync(pdf);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function latexError(dir: string, jobname: string): Error {
  let log = '';
  try {
    log = fs.readFileSync(path.join(dir, `${jobname}.log`), 'utf8');
  } catch {}
  const tail = log.split('\n').slice(-20).join('\n');
  return new Error(`latex compile failed\n${tail}`);
}

// ---------- compile state ----------
// two flat maps, nothing more: chapters remember which style+source the
// artifact beside them was built from (one file serves several style
// variants, so mtime alone can't tell), books remember the fragment
// signature of their last assembly. Everything else (fragments) is fresh
// purely by file existence.
type Store = {
  chapters: Record<string, { style: string; src: number }>;
  books: Record<string, string>;
};

const STATE_FILE = path.join(TEXBUILD, 'state.json');

function readStore(): Store {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as Partial<Store>;
    return { chapters: raw.chapters ?? {}, books: raw.books ?? {} };
  } catch {
    return { chapters: {}, books: {} };
  }
}

function writeStore(store: Store): void {
  try {
    fs.mkdirSync(TEXBUILD, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(store));
  } catch {}
}

// ---------- ensure ----------
export type EnsureResult = { abs: string; name: string };

// rel: a chapter (.md) or folder path. The artifact lands beside the source:
//   01_work/01_part/01_flight.md -> 01_work/01_part/01_flight.pdf
//   01_work                      -> 01_work.pdf
// A directly requested draft chapter always compiles; folder aggregates
// follow the drafts toggle (includeDrafts). Books assemble cached fragments;
// force = rebuild every fragment first.
export async function ensurePdf(
  rel: string,
  styleId: string | null,
  force = false,
  includeDrafts = false,
): Promise<EnsureResult> {
  const isFile = MD.test(rel);
  const abs = safePath(rel);
  if (!abs) throw new Error('not found');
  if (!fs.existsSync(abs)) throw new Error('not found');
  if (isFile) {
    if (!fs.statSync(abs).isFile()) throw new Error('not found');
  } else if (!fs.statSync(abs).isDirectory()) {
    throw new Error('not found');
  }

  const targetAbs = isFile ? abs.replace(MD, '.pdf') : `${abs}.pdf`;
  // the artifact keeps its place beside the source, but the name it presents
  // (download filename, title page, loader heading) is the entry's own title:
  // disk prefixes are order only and must never reach paper
  const name = `${slugify(scopeTitle(rel))}.pdf`;
  const style = resolveStyle(styleId);
  const styleHash = sha(style.preamble);

  if (isFile) {
    // single chapter artifact: footer numbering starts at 1, one pass
    const srcMtime = fs.statSync(abs).mtimeMs;
    const store = readStore();
    const art = store.chapters[rel];
    if (
      !force &&
      art &&
      art.style === style.id &&
      art.src === srcMtime &&
      fs.existsSync(targetAbs)
    ) {
      return { abs: targetAbs, name };
    }
    const tex = [
      style.preamble,
      '\\markdownSetup{shiftHeadings=1}',
      '\\begin{document}',
      `\\section*{${texEsc(chapterTitle(rel))}}`,
      `\\markdownInput{${abs}}`,
      '\\end{document}',
      '',
    ].join('\n');
    const data = await runLatex(tex, path.basename(abs, path.extname(abs)), 1);
    await writeArtifact(targetAbs, data);
    const fresh = readStore();
    fresh.chapters[rel] = { style: style.id, src: srcMtime };
    writeStore(fresh);
    return { abs: targetAbs, name };
  }

  // ---- book: fragment assembly ----
  const node = findNode(clean(listWorks(), includeDrafts), rel);
  if (!node) throw new Error('not found');
  const items: FragItem[] = [];
  collectItems(node, styleHash, items);
  if (!items.length) throw new Error('not found');

  const keys = items.map((i) => i.key).join('\n');
  const sig = sha(`${style.id}\n${includeDrafts}\n${keys}`);
  const store = readStore();
  if (!force && store.books[rel] === sig && fs.existsSync(targetAbs)) {
    return { abs: targetAbs, name };
  }

  // compile only the fragments whose cached pdf is missing (force: all)
  fs.mkdirSync(FRAG_DIR, { recursive: true });
  for (const it of items) {
    if (!force && fs.existsSync(it.file)) continue;
    const tex =
      it.kind === 'part'
        ? partFragTex(it, style.preamble)
        : chapterFragTex(it.title, it.abs!, style.preamble);
    fs.writeFileSync(it.file, await runLatex(tex, `f${it.key}`, 1));
  }

  // assemble: 2 passes so the toc settles around the fragments it fronts
  const data = await runLatex(
    bookTex(scopeTitle(rel), items, style.preamble),
    'book',
    2,
  );
  await writeArtifact(targetAbs, data);

  const fresh = readStore();
  fresh.books[rel] = sig;
  writeStore(fresh);
  return { abs: targetAbs, name };
}

async function writeArtifact(targetAbs: string, data: Buffer): Promise<void> {
  // the works repo ignores compiled pdfs; seed that before the artifact lands
  await ensureRepo();
  const tmp = `${targetAbs}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, targetAbs);
}

// the print title of a scope: its own raw title, prefixes and draft token
// stripped. Looked up in the UNCLEANED tree (a directly requested draft still
// compiles), with a filename fallback for a tree-stale path.
function scopeTitle(rel: string): string {
  const node = findNode(listWorks(), rel);
  if (node) return node.raw;
  return parseName(path.basename(rel).replace(MD, '')).raw;
}

// display title of a single chapter. Looked up in the UNCLEANED tree: a
// directly requested draft chapter compiles intentionally — the no-drafts
// rule only governs folder aggregates. Fallback for a tree-stale path (the
// file moved or sits under a symlink the scanner can't follow): print the raw
// title unnumbered. A number here would come from the disk prefix, which is
// order-only, so it could contradict the number the sidebar shows.
// (exported for tests)
export function chapterTitle(rel: string): string {
  const node = findNode(listWorks(), rel);
  if (node) return node.title;
  return parseName(path.basename(rel).replace(MD, '')).raw;
}

// ---------- plan ----------
// What a compile would do right now: the fragment list with a cached flag on
// each, from exactly the cache rule ensurePdf uses. The client's "compiling…"
// placeholder polls this, so the split between ready and pending comes from
// the server instead of being guessed in the browser. Hashing only — no
// LaTeX, so it is cheap enough to poll.
export type PlanItem = { kind: 'part' | 'chapter'; title: string; cached: boolean };
export type PdfPlan = {
  scope: string;
  style: string;
  fragments: boolean;
  items: PlanItem[];
};

export function pdfPlan(
  rel: string,
  styleId: string | null,
  includeDrafts = false,
): PdfPlan {
  const style = resolveStyle(styleId);
  const styleHash = sha(style.preamble);
  const isFile = MD.test(rel);
  const abs = safePath(rel);
  if (!abs || !fs.existsSync(abs)) throw new Error('not found');

  if (isFile) {
    const store = readStore();
    const art = store.chapters[rel];
    const cached =
      !!art &&
      art.style === style.id &&
      art.src === fs.statSync(abs).mtimeMs &&
      fs.existsSync(abs.replace(MD, '.pdf'));
    return {
      scope: scopeTitle(rel),
      style: style.id,
      fragments: false,
      items: [{ kind: 'chapter', title: chapterTitle(rel), cached }],
    };
  }

  const node = findNode(clean(listWorks(), includeDrafts), rel);
  if (!node) throw new Error('not found');
  const items: FragItem[] = [];
  collectItems(node, styleHash, items);
  if (!items.length) throw new Error('not found');
  return {
    scope: scopeTitle(rel),
    style: style.id,
    fragments: true,
    items: items.map((i) => ({ kind: i.kind, title: i.title, cached: fs.existsSync(i.file) })),
  };
}
