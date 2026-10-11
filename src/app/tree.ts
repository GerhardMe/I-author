// The sidebar tree: visibility filtering, row rendering, the per-row sync
// status markers, and the tree reload.

import { visibleNodes } from '../lib/visibility.ts';
import { loadDraft } from '../lib/sync.ts';
import {
  api,
  byPath,
  currentFile,
  esc,
  expanded,
  hideDrafts,
  saveExpanded,
  selected,
  setSelected,
  setTree,
  narrow,
  tree,
  type Node,
} from './state.ts';
import { treeEl } from './dom.ts';
import { dragCard, dragPreview, lineEl } from './gestures.ts';
import { showInsertLine } from './files.ts';
import { getEditor } from './editor.ts';
import { sync } from './sync.ts';

// hide drafts and notes, plus empty directories; folders whose children
// all vanish are dropped too. The rule itself lives in visibility.ts —
// one implementation for the sidebar and the pdf aggregates.
export function visible(nodes: Node[]): Node[] {
  return visibleNodes(nodes, {
    drafts: hideDrafts,
    notes: hideDrafts,
    empty: hideDrafts,
    // an empty directory stays on screen while a drag aims a drop INTO it
    keepEmpty: (n) => !!(dragPreview && expanded.has(n.path)),
  });
}

// same rule as visible(), walked — one implementation, so "is this on screen?"
// can never drift from what the tree actually rendered
export function isVisibleNode(path: string): boolean {
  const walk = (ns: Node[]): boolean =>
    ns.some((n) => {
      if (n.path === path) return true;
      if (n.children === undefined) return false;
      const leaf = n.children.length === 0;
      if (leaf) return dragPreview && expanded.has(n.path);
      const kids = visible(n.children);
      return kids.length > 0 && walk(kids);
    });
  return walk(hideDrafts ? visible(tree) : tree);
}

// opening an md from anywhere (toc, link, boot restore): expand its
// ancestors so the row is visible in the tree, then select it
export function revealPath(p: string): void {
  const segs = p.split('/');
  for (let i = 1; i < segs.length; i++) expanded.add(segs.slice(0, i).join('/'));
  setSelected(p);
  saveExpanded();
  renderTree();
}

// ---------- sync status markers (tree rows) ----------
// The status of the open file lives on ITS tree row, at the right edge
// after the filename (VS Code style); files that are not open show a dot
// when a sessionStorage draft exists — drafts are dropped exactly when a
// push confirms, so a dot always means "unsynced text". States:
// dirty = dot (doc ahead of the server), pushing = spinner (update
// awaiting the reply), error = red ! (a push has failed or is stuck —
// unsynced text at risk; stays until a push confirms). The spinner waits
// half a second before appearing (no flash on quick replies) and, once
// shown, stays up at least a tenth of a second. With the tree hidden the
// markers are invisible — they are tree chrome.
const SPINNER_DELAY_MS = 500;
const SPINNER_MIN_MS = 100;
let spinnerDelay: ReturnType<typeof setTimeout> | null = null; // before showing
let spinnerHold: ReturnType<typeof setTimeout> | null = null; // min display
let spinnerShownAt = 0;
export let syncState: 'idle' | 'dirty' | 'pushing' | 'error' = 'idle';

function rowStatus(path: string): 'dirty' | 'pushing' | 'error' | null {
  if (path === currentFile) return syncState === 'idle' ? null : syncState;
  return loadDraft(path) ? 'dirty' : null;
}

// targeted row update — never a full renderTree(): a push timer can fire
// mid-drag, and a tree rebuild would detach the dragged source row.
// The marker span always exists (buildList appends it to file rows), so
// a state change is a dataset flip and the CSS opacity transition fades it
export function refreshRowStatus(path: string | null): void {
  if (!path) return;
  const row = treeEl.querySelector(
    `.tree-row[data-path="${CSS.escape(path)}"]`,
  ) as HTMLElement | null;
  if (!row || row.dataset.folder) return;
  const st = rowStatus(path);
  const ts = row.querySelector<HTMLElement>('.ts');
  if (!ts) return;
  ts.dataset.state = st ?? 'idle';
  ts.textContent = st === 'error' ? '!' : '';
}

export function setSync(state: 'idle' | 'dirty' | 'pushing' | 'error'): void {
  syncState = state;
  refreshRowStatus(currentFile);
}

export function syncStateFromDoc(content: string): 'idle' | 'dirty' {
  return sync.ahead(content) ? 'dirty' : 'idle';
}

// recomputed at every transition point, so typing during a spinner hold
// still lands on the right end state
export function pushEndState(): 'idle' | 'dirty' {
  const editor = getEditor();
  return editor ? syncStateFromDoc(editor.state.doc.toString()) : 'idle';
}

// the push machine's status callbacks (the hooks handed to createSync in
// sync.ts) — the spinner bookkeeping lives here, next to the markers it drives
export function pushStart(): void {
  if (spinnerHold) {
    clearTimeout(spinnerHold); // a new push supersedes the old hold
    spinnerHold = null;
  }
  if (syncState === 'pushing') return; // already shown
  spinnerDelay = setTimeout(() => {
    spinnerDelay = null;
    setSync('pushing');
    spinnerShownAt = performance.now();
  }, SPINNER_DELAY_MS);
}

export function pushEnd(ok: boolean): void {
  if (spinnerDelay) {
    clearTimeout(spinnerDelay); // the reply beat the delay: never shown
    spinnerDelay = null;
    setSync(ok ? pushEndState() : 'error');
    return;
  }
  if (syncState !== 'pushing') {
    if (!ok) setSync('error'); // retry failed while the ! was up: keep it
    return;
  }
  const left = SPINNER_MIN_MS - (performance.now() - spinnerShownAt);
  if (left <= 0) {
    setSync(ok ? pushEndState() : 'error');
  } else {
    spinnerHold = setTimeout(() => {
      spinnerHold = null;
      setSync(ok ? pushEndState() : 'error');
    }, left);
  }
}

export async function loadTree() {
  setTree((await api('/api/tree')).works);
  byPath.clear();
  const walk = (ns: Node[]) => {
    for (const n of ns) {
      byPath.set(n.path, n);
      if (n.children) walk(n.children);
    }
  };
  walk(tree);
  renderTree();
}

function buildList(nodes: Node[]): HTMLUListElement {
  const ul = document.createElement('ul');
  for (const n of nodes) {
    const li = document.createElement('li');
    const row = document.createElement('div');
    const isFolder = n.children !== undefined;
    row.className =
      'tree-row' +
      (n.path === selected ? ' sel' : '') +
      (n.inDraft ? ' draft' : '');
    row.dataset.path = n.path;
    if (isFolder) row.dataset.folder = '1';
    // the whole row is the drag handle on desktop (native drag has its own
    // movement threshold, so a plain click still opens the entry). NOT on
    // touch: a phone's browser starts its own long-press drag on a
    // draggable element and co-opts the gesture — the touch state machine
    // below must own the hold (armed -> drag or menu), so touch rows are
    // never advertised as draggable.
    row.draggable = !narrow();
    row.innerHTML = `<span class="tw"${
      isFolder ? ' data-caret="1"' : ''
    }>${isFolder ? (expanded.has(n.path) ? '▾' : '▸') : '·'}</span><span class="tn">${esc(
      n.raw,
    )}</span>`;
    if (!isFolder) {
      const st = rowStatus(n.path);
      const ts = document.createElement('span');
      ts.className = 'ts';
      ts.dataset.state = st ?? 'idle';
      ts.textContent = st === 'error' ? '!' : '';
      row.append(ts); // always present: opacity fades the state changes
    }
    li.append(row);
    if (isFolder && expanded.has(n.path) && n.children!.length) li.append(buildList(n.children!));
    ul.append(li);
  }
  return ul;
}

export function renderTree() {
  treeEl.replaceChildren(buildList(visible(tree)));
  treeEl.append(lineEl); // the insertion line lives here; re-append after rebuild
  if (!lineEl.hidden && !dragCard) showInsertLine(); // a mid-drag rebuild must not steal the drop line
}
