// The undo ladder's git rung, and the history graph in the sidebar:
// a minimal DAG — hollow dots on lines, HEAD the filled blue dot, master
// spine on the leftmost lane, branch lanes to the right in fork order, the
// root commit pinned to the bottom. Hover names a node — its commit
// message with the timestamp underneath (owner decision 2026-10-11: no
// branch names in the UI). Nothing acts on click yet. The git button swaps
// the panel with the file tree.

import { undo, redo } from '@codemirror/commands';
import { dropDraft } from '../lib/sync.ts';
import {
  api,
  byPath,
  currentFile,
  LAST_KEY,
  pathMapper,
  remapPaths,
  setCurrentFile,
  setCurrentGroup,
  setSelected,
} from './state.ts';
import {
  doc,
  docBody,
  docDraft,
  docTitle,
  docWords,
  editorHost,
  empty,
  gitBtn,
  histEl,
  histScroll,
  pdfBtn,
  redoBtn,
  treeEl,
  undoBtn,
} from './dom.ts';
import { loadTree, refreshRowStatus, renderTree, setSync } from './tree.ts';
import { dirty, destroyEditor, flushDraft, getEditor } from './editor.ts';
import { sync } from './sync.ts';
import { openFile, renderWelcomeIndex } from './toc.ts';

// ---------- git undo: the ladder's second rung ----------
// Native stack exhausted = the commit boundary is crossed. Server-side
// (/api/undo): flush the pending burst (it becomes the last commit on the
// soon-stale branch), branch at HEAD under a timestamp name, reset --hard
// HEAD~1.
// Client-side: detach the editor WITHOUT pushing — the doc still holds the
// undone-away text, and a push or a saved draft would resurrect it — drop
// the drafts of changed paths (the reverted "future" must not resurrect
// from sessionStorage), remap all path-keyed state through the inverted
// map, then reopen the file — or home when the undo deleted it.
let undoInFlight = false;

export async function gitUndo(): Promise<void> {
  if (undoInFlight) return; // debounced while in flight
  undoInFlight = true;
  try {
    flushDraft();
    // ε-window guard: never undo text the server has not seen
    if (dirty()) await sync.pushNow();
    setSync('pushing'); // the roundtrip surfaces on the file's own tree row
    const res = await api<{
      changed: string[];
      map: Record<string, string>;
      content: string | null;
      head: string;
    }>('/api/undo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: currentFile }),
    });
    await applyUndo(res);
  } catch (err) {
    setSync('idle'); // the doc never moved: the marker goes back to rest
    alert((err as Error).message); // "nothing to undo" lands here too
  } finally {
    undoInFlight = false;
  }
}

async function applyUndo(res: {
  changed: string[];
  map: Record<string, string>;
  content: string | null;
  head: string;
}): Promise<void> {
  const was = currentFile;
  for (const p of res.changed) dropDraft(p); // by current (pre-undo) paths
  remapPaths(res.map); // expanded, selection, remaining drafts, last-opened
  // detach without pushing or saving a draft (see above)
  sync.cancel();
  destroyEditor();
  setCurrentFile(null);
  setCurrentGroup(null);
  setSync('idle');
  refreshRowStatus(was);
  await loadTree();
  const next = was ? pathMapper(res.map)(was) : null;
  if (next && byPath.has(next)) {
    await openFile(next); // fresh content, fresh baseline, fresh native stack
  } else {
    // the undo deleted the open file (or nothing was open): home
    setSelected(null);
    doc.hidden = true;
    editorHost.hidden = true;
    docBody.hidden = true;
    docTitle.hidden = true;
    docWords.hidden = true;
    docDraft.hidden = true;
    docTitle.classList.remove('draft');
    pdfBtn.hidden = true;
    empty.hidden = false;
    renderWelcomeIndex();
    if (was) {
      try { localStorage.removeItem(LAST_KEY); } catch {}
    }
    renderTree();
  }
}

// no editor open (welcome screen, folder index): Ctrl/Cmd+Z goes straight
// to git undo — the ladder's native rung only exists inside the editor.
// Text fields keep their own native undo; the guard leaves them alone.
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
    if (getEditor()) return; // the editor's keymap owns the ladder
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    e.preventDefault();
    void gitUndo();
  }
});

// the mobile undo/redo buttons: the same ladders as Ctrl+Z / Ctrl+Shift+Z —
// native first, git undo / the history view on exhaustion (gitUndo's
// in-flight guard debounces); no confirmation, the roundtrip surfaces
// through the sync markers
export function redoExhausted(): void {
  // native redo gone = the commit boundary crossed forward: the history
  // graph owns the forward jumps (no /api/redo)
  if (!historyOpen) void openHistory();
}

undoBtn.addEventListener('click', () => {
  redoBtn.hidden = false; // redo only exists once something was undone
  const editor = getEditor();
  if (editor && undo(editor)) return;
  void gitUndo();
});

redoBtn.addEventListener('click', () => {
  const editor = getEditor();
  if (editor && redo(editor)) return;
  redoExhausted();
});

// ---------- history graph (sidebar) ----------
// Pure display: the DAG as dots on lines. Main spine (reachable from HEAD)
// is lane 0, leftmost; every branch tip opens its own lane to the right, in
// fork order — the topo order its tip first appears in. Rows are the topo
// index, so the graph reads newest-first and HEAD sits at the top. Nothing
// acts on click in this milestone; hover names a node.
type HistCommit = {
  sha: string;
  parents: string[];
  at: number;
  subject: string;
  changed: string[];
};
type HistData = {
  head: string | null;
  commits: HistCommit[];
  root: { sha: string; at: number; subject: string } | null;
};
export let historyOpen = false;
let histData: HistData | null = null;

const SVG_NS = 'http://www.w3.org/2000/svg';
const LANE_W = 22;
const ROW_H = 26;
const PAD_X = 14;
const PAD_Y = 12;
const NODE_R = 4; // circle radius — half the HEAD square's side

const svgEl = (name: string): SVGElement => document.createElementNS(SVG_NS, name);

const histWhen = (at: number): string =>
  new Date(at * 1000).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

// leaving the graph: the file tree comes back and the button shows the fork again
export function dismissHistory(): void {
  if (!historyOpen) return;
  historyOpen = false;
  histEl.hidden = true;
  treeEl.hidden = false;
  gitBtn.innerHTML = '<span class="icon">&#xf126;</span>';
  gitBtn.title = 'git history';
  gitBtn.setAttribute('aria-pressed', 'false');
  histData = null;
  hideHistTip();
}

async function openHistory(): Promise<void> {
  if (historyOpen) return;
  historyOpen = true;
  treeEl.hidden = true;
  histEl.hidden = false;
  gitBtn.innerHTML = '<span class="icon">&#xf07b;</span>';
  gitBtn.title = 'file explorer';
  gitBtn.setAttribute('aria-pressed', 'true');
  await refetchHistory();
}

async function refetchHistory(): Promise<void> {
  try {
    histData = await api<HistData>('/api/git/history');
  } catch (err) {
    histData = null;
    histScroll.replaceChildren(histNote((err as Error).message, 'error'));
    return;
  }
  // the 200-commit cap can cut the chain short of the root: pin the INIT
  // commit to the bottom of the graph, so the very first commit is always
  // reachable by scrolling (a lone dot below the truncated chain)
  const d = histData;
  if (d.root && !d.commits.some((c) => c.sha === d.root!.sha)) {
    d.commits.push({
      sha: d.root.sha,
      parents: [],
      at: d.root.at,
      subject: d.root.subject,
      changed: [],
    });
  }
  renderGraph();
}

// a burst of commits lands as several SSE events seconds apart: coalesce
// the refetches into one
let refetchTimer: ReturnType<typeof setTimeout> | null = null;

// the history view is live (owner decision 2026-10-11): the SSE commit
// stream calls this on every commit — while the view is open the DAG
// refetches and the new node slides in; closed, it does nothing (the view
// refetches on every open anyway)
export function refreshHistory(): void {
  if (!historyOpen) return;
  if (refetchTimer) return;
  refetchTimer = setTimeout(() => {
    refetchTimer = null;
    if (!historyOpen) return; // closed while the coalescer waited
    void refetchHistory();
  }, 300);
}

gitBtn.addEventListener('click', () => {
  if (historyOpen) dismissHistory();
  else void openHistory();
});

const histNote = (text: string, cls: string): HTMLElement => {
  const p = document.createElement('p');
  p.className = cls;
  p.textContent = text;
  return p;
};

// the lanes: master spine (everything reachable from HEAD) at lane 0; each
// remaining commit starts a new lane in topo order (fork order) and claims
// its whole parent chain until the walk reaches an already-placed commit —
// the fork point on the spine or in another branch's lane
function layoutDag(data: HistData): { lanes: number; pos: Map<string, { lane: number; row: number }> } {
  const bySha = new Map(data.commits.map((c) => [c.sha, c]));
  const pos = new Map<string, { lane: number; row: number }>();
  const spine = new Set<string>();
  const walk = (sha: string | null): void => {
    if (!sha || spine.has(sha) || !bySha.has(sha)) return;
    spine.add(sha);
    walk(bySha.get(sha)!.parents[0] ?? null);
  };
  walk(data.head);
  for (const sha of spine) pos.set(sha, { lane: 0, row: 0 });
  let lanes = 1;
  for (const c of data.commits) {
    if (pos.has(c.sha)) continue;
    const lane = lanes++;
    let cur: string | undefined = c.sha;
    while (cur && !pos.has(cur)) {
      pos.set(cur, { lane, row: 0 });
      cur = bySha.get(cur)?.parents[0];
    }
  }
  // rows: the topo index — newest first, so HEAD tops the graph
  data.commits.forEach((c, i) => {
    const p = pos.get(c.sha);
    if (p) p.row = i;
  });
  return { lanes, pos };
}

function renderGraph(): void {
  const data = histData;
  if (!data) return;
  if (!data.commits.length) {
    histScroll.replaceChildren(histNote('no commits yet.', 'note'));
    return;
  }
  const { lanes, pos } = layoutDag(data);
  const width = PAD_X * 2 + lanes * LANE_W;
  const height = PAD_Y * 2 + data.commits.length * ROW_H;
  const x = (lane: number): number => PAD_X + lane * LANE_W + LANE_W / 2;
  const y = (row: number): number => PAD_Y + row * ROW_H + ROW_H / 2;

  const svg = svgEl('svg');
  svg.classList.add('hist-svg');
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);

  // edges first — the nodes paint over their ends
  for (const c of data.commits) {
    const a = pos.get(c.sha)!;
    for (const p of c.parents) {
      const b = pos.get(p);
      if (!b) continue; // older than the 200-commit cap
      if (a.lane === b.lane) {
        const line = svgEl('line');
        line.setAttribute('x1', String(x(a.lane)));
        line.setAttribute('y1', String(y(a.row) - NODE_R - 1));
        line.setAttribute('x2', String(x(a.lane)));
        line.setAttribute('y2', String(y(b.row) + NODE_R + 1));
        line.classList.add('hist-edge');
        svg.append(line);
      } else {
        // the fork: down the child's lane, jog across, down to the parent
        const path = svgEl('path');
        const fromY = y(a.row) - NODE_R - 1;
        const toY = y(b.row) + NODE_R + 1;
        const midY = (fromY + toY) / 2;
        path.setAttribute(
          'd',
          `M ${x(a.lane)} ${fromY} L ${x(a.lane)} ${midY} L ${x(b.lane)} ${midY} L ${x(b.lane)} ${toY}`,
        );
        path.classList.add('hist-edge');
        svg.append(path);
      }
    }
  }

  for (const c of data.commits) {
    const p = pos.get(c.sha)!;
    const nx = x(p.lane);
    const ny = y(p.row);
    // every node is a dot; HEAD (you are here) is the filled blue one,
    // a step larger so the fill reads at a glance
    const dot = svgEl('circle');
    dot.setAttribute('cx', String(nx));
    dot.setAttribute('cy', String(ny));
    dot.setAttribute('r', String(c.sha === data.head ? NODE_R + 1 : NODE_R));
    dot.classList.add('hist-node');
    if (c.sha === data.head) dot.classList.add('here');
    svg.append(dot);
    // nothing is written into the graph itself — the hover tooltip names
    // the node. The fat hit area hover speaks through (touch gets
    // nothing yet — hover does not exist and no node acts on tap here)
    const hit = svgEl('circle');
    hit.setAttribute('cx', String(nx));
    hit.setAttribute('cy', String(ny));
    hit.setAttribute('r', '12');
    hit.classList.add('hist-hit');
    hit.addEventListener('mouseenter', () => showHistTip(c));
    hit.addEventListener('mousemove', (e) => placeHistTip(e.clientX, e.clientY));
    hit.addEventListener('mouseleave', hideHistTip);
    svg.append(hit);
  }
  histScroll.replaceChildren(svg);
}

// ---------- the tooltip ----------
const histTipCard = document.createElement('div');
histTipCard.className = 'hist-tipcard';
histTipCard.hidden = true;
document.body.append(histTipCard);

const tipLine = (cls: string, text: string): HTMLElement => {
  const d = document.createElement('div');
  d.className = cls;
  d.textContent = text;
  return d;
};

function showHistTip(c: HistCommit): void {
  histTipCard.replaceChildren(
    tipLine('t-subj', c.subject),
    tipLine('t-when', histWhen(c.at)),
  );
  histTipCard.hidden = false;
}

function placeHistTip(px: number, py: number): void {
  const w = histTipCard.offsetWidth;
  const h = histTipCard.offsetHeight;
  let left = px + 14;
  let top = py + 16;
  if (left + w > window.innerWidth - 8) left = px - w - 14;
  if (top + h > window.innerHeight - 8) top = py - h - 12;
  histTipCard.style.left = `${Math.max(8, left)}px`;
  histTipCard.style.top = `${Math.max(8, top)}px`;
}

function hideHistTip(): void {
  histTipCard.hidden = true;
}
