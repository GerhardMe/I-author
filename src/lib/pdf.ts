// PDF compiler (milestone 5): compiles a scope — a chapter or a folder (with
// title page, contents, and every descendant chapter) — into a real PDF via
// LuaLaTeX and the `markdown` package. The preamble ("stylesheet") comes from
// the pdfstyles/ folder; the compiled artifact lives in the works dir beside
// its source, so storage stays readable without the app. Drafts and notes.md
// never leak into compiled output.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { WORKS_DIR } from './config.ts';
import { parseName } from './naming.ts';
import { NOTES, type Node, listWorks, safePath } from './works.ts';
import { ensureRepo } from './git.ts';

const run = promisify(execFile);
const LUALATEX = process.env.IAUTHOR_LUALATEX ?? 'lualatex';
const TEXBUILD = path.resolve('.texbuild');
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
    a === 'bicameral' ? -1 : b === 'bicameral' ? 1 : a.localeCompare(b),
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
// and never compiles as a chapter)
function clean(nodes: Node[], includeDrafts: boolean): Node[] {
  const out: Node[] = [];
  for (const n of nodes) {
    if (!includeDrafts && n.draft) continue;
    if (n.children === undefined && NOTES.test(n.name)) continue;
    if (n.children !== undefined) {
      const kids = clean(n.children, includeDrafts);
      if (!kids.length) continue;
      out.push({ ...n, children: kids });
    } else {
      out.push(n);
    }
  }
  return out;
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

// chapters: fresh page, ruled unnumbered section + toc entry; markdown
// content headings shift down one level so the chapter title leads
function chapterTex(node: Node): string {
  const abs = safePath(node.path)!;
  return [
    `\\clearpage`,
    `\\section*{${texEsc(node.title)}}`,
    `\\addcontentsline{toc}{section}{${texEsc(node.title)}}`,
    `\\markdownInput{${abs}}`,
  ].join('\n');
}

function folderTex(node: Node): string {
  return [
    `\\part*{${texEsc(node.title)}}`,
    `\\addcontentsline{toc}{part}{${texEsc(node.title)}}`,
  ].join('\n');
}

function scopeTex(nodes: Node[]): string {
  let out = '';
  for (const n of nodes) {
    if (n.children !== undefined) {
      out += `\n${folderTex(n)}\n${scopeTex(n.children!)}`;
    } else {
      out += `\n${chapterTex(n)}`;
    }
  }
  return out;
}

// ---------- compile ----------
async function lualatex(tex: string, jobname: string): Promise<Buffer> {
  fs.mkdirSync(TEXBUILD, { recursive: true });
  const dir = fs.mkdtempSync(path.join(TEXBUILD, `${jobname}-`));
  try {
    fs.writeFileSync(path.join(dir, `${jobname}.tex`), tex);
    const args = [
      '-interaction=nonstopmode',
      '--shell-escape',
      `-jobname=${jobname}`,
      `${jobname}.tex`,
    ];
    // two passes: the first builds the .toc, the second resolves page numbers
    for (let i = 0; i < 2; i++) {
      try {
        await run(LUALATEX, args, { cwd: dir, timeout: 120_000 });
      } catch {
        // non-stop mode still exits nonzero on recoverable errors; only a
        // missing pdf is fatal
      }
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

// ---------- staleness ----------
// newest mtime of everything the compiled pdf depends on: the scope itself
// (folder mtime moves when children are added/removed) and each chapter file
function scopeMtime(node: Node): number {
  const abs = path.join(WORKS_DIR, node.path);
  let max: number;
  try {
    max = fs.statSync(abs).mtimeMs;
  } catch {
    return 0;
  }
  if (node.children !== undefined) {
    for (const c of node.children) {
      const m = scopeMtime(c);
      if (m > max) max = m;
    }
  }
  return max;
}

// ---------- compile state ----------
// the artifact beside the source is one file serving several compile variants
// (style, drafts toggle), so freshness is keyed in a state file in the app's
// scratch dir — the works dir stays clean
type CompileState = Record<string, { style: string; drafts: boolean; src: number }>;

const STATE_FILE = path.join(TEXBUILD, 'state.json');

function readState(): CompileState {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as CompileState;
  } catch {
    return {};
  }
}

function writeState(state: CompileState): void {
  try {
    fs.mkdirSync(TEXBUILD, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state));
  } catch {}
}

// ---------- ensure ----------
export type EnsureResult = { abs: string; name: string };

// rel: a chapter (.md) or folder path. The artifact lands beside the source:
//   01_work/01_part/01_flight.md -> 01_work/01_part/01_flight.pdf
//   01_work                      -> 01_work.pdf
// A directly requested draft chapter always compiles; folder aggregates
// follow the drafts toggle (includeDrafts).
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
  const name = path.basename(targetAbs);

  let srcMtime = fs.statSync(abs).mtimeMs;
  let node: Node | null = null;
  if (!isFile) {
    node = findNode(clean(listWorks(), includeDrafts), rel);
    if (!node) throw new Error('not found');
    srcMtime = scopeMtime(node);
  }

  const style = resolveStyle(styleId);
  const state = readState()[rel];
  if (
    !force &&
    state &&
    state.style === style.id &&
    state.drafts === includeDrafts &&
    state.src === srcMtime &&
    fs.existsSync(targetAbs)
  ) {
    return { abs: targetAbs, name };
  }

  const tex = await buildTex(rel, isFile, node, abs, style.preamble);
  const jobname = isFile ? path.basename(abs, path.extname(abs)) : path.basename(abs);
  const data = await lualatex(tex, jobname);

  // the works repo ignores compiled pdfs; seed that before the artifact lands
  await ensureRepo();
  const tmp = `${targetAbs}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, targetAbs);

  const all = readState();
  all[rel] = { style: style.id, drafts: includeDrafts, src: srcMtime };
  writeState(all);
  return { abs: targetAbs, name };
}

// display title of a single chapter. Looked up in the UNCLENED tree: a
// directly requested draft chapter compiles intentionally — the no-drafts
// rule only governs folder aggregates. Fallback for a tree-stale path:
// synthesize the chapter title from the filename grammar.
function chapterTitle(rel: string): string {
  const node = findNode(listWorks(), rel);
  if (node) return node.title;
  const parsed = parseName(path.basename(rel).replace(MD, ''));
  const label = parsed.prefix !== null ? String(parsed.prefix) : '?';
  return rel.includes('/') ? `Chapter ${label}: ${parsed.raw}` : parsed.raw;
}

async function buildTex(
  rel: string,
  isFile: boolean,
  node: Node | null,
  abs: string,
  preamble: string,
): Promise<string> {
  // content headings (#, ##, …) shift down one level so the inserted
  // chapter/folder titles lead the hierarchy
  const setup = '\\markdownSetup{shiftHeadings=1}';
  if (isFile) {
    return [
      preamble,
      setup,
      '\\begin{document}',
      `\\section*{${texEsc(chapterTitle(rel))}}`,
      `\\markdownInput{${abs}}`,
      '\\end{document}',
      '',
    ].join('\n');
  }
  if (!node) throw new Error('not found');
  return [
    preamble,
    setup,
    '\\begin{document}',
    titlePage(path.basename(rel)),
    '\\tableofcontents',
    '\\clearpage',
    scopeTex(node.children ?? []),
    '\\end{document}',
    '',
  ].join('\n');
}
