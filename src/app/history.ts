// The undo ladder's git rung and the history view: branch + master reset,
// the DAG list, and the two restores (fetch file / make master).

import { marked } from 'marked';
import { undo, redo } from '@codemirror/commands';
import { dropDraft } from '../lib/sync.ts';
import { appConfirm } from '../lib/confirm.ts';
import {
  api,
  byPath,
  currentFile,
  esc,
  LAST_KEY,
  narrow,
  pathMapper,
  remapPaths,
  selected,
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
  histBody,
  histEl,
  histFiles,
  histList,
  histMasterBtn,
  histMsg,
  histPreview,
  histRestoreBtn,
  histTime,
  pdfBtn,
  redoBtn,
  undoBtn,
} from './dom.ts';
import { loadTree, refreshRowStatus, renderTree, setSync } from './tree.ts';
import { dirty, destroyEditor, flushDraft, getEditor, leavingFile } from './editor.ts';
import { sync } from './sync.ts';
import { openFile, renderWelcomeIndex, showGroup } from './toc.ts';
import { setNav } from './nav.ts';

// ---------- git undo: the ladder's second rung ----------
// Native stack exhausted = the commit boundary is crossed. Server-side
// (/api/undo): flush the pending burst (it becomes the last commit on the
// soon-stale branch), branch undo-<ts> at HEAD, reset --hard HEAD~1.
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
  // view owns the forward jumps (no /api/redo)
  if (!historyOpen) void openHistory();
}

undoBtn.addEventListener('click', () => {
  const editor = getEditor();
  if (editor && undo(editor)) return;
  void gitUndo();
});

redoBtn.addEventListener('click', () => {
  const editor = getEditor();
  if (editor && redo(editor)) return;
  redoExhausted();
});

// ---------- history view (milestone 5) ----------
// The third view beside #empty/#doc: a DAG list — main spine at indent 0,
// undo-* branch commits one level in, "you are here" on HEAD — and a
// preview panel (message, time, changed files, read-only content via
// /api/git/show) holding the two restores: fetch file (one file, light)
// and make master (whole tree, dangerous, appConfirm'd). Entering leaves
// the file first (flush + push, so the pending burst is in the DAG);
// `selected` survives as the exit pointer — the git button toggles back
// to it, Escape goes home, a tree row click just takes over the view.
type HistCommit = {
  sha: string;
  parents: string[];
  at: number;
  subject: string;
  changed: string[];
};
type HistData = {
  head: string | null;
  branches: { name: string; sha: string }[];
  commits: HistCommit[];
};
export let historyOpen = false;
let histData: HistData | null = null;
let histBySha = new Map<string, HistCommit>();
let histSha: string | null = null; // the selected commit
let histFile: string | null = null; // the selected changed file
let histWorking = false; // one restore at a time

// leaving the history view without rerouting the main view (a tree click
// takes over, going home): the view's state resets, nothing reopens
export function dismissHistory(): void {
  historyOpen = false;
  histEl.hidden = true;
  histData = null;
  histSha = null;
  histFile = null;
}

const histWhen = (at: number): string =>
  new Date(at * 1000).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

function histBusy(b: boolean): void {
  histWorking = b;
  histRestoreBtn.disabled = b || !histFile;
  histMasterBtn.disabled = b;
}

async function openHistory(): Promise<void> {
  if (historyOpen) return;
  await leavingFile();
  historyOpen = true;
  histSha = null;
  histFile = null;
  histPreview.hidden = true;
  empty.hidden = true;
  doc.hidden = true;
  histEl.hidden = false;
  try {
    histData = await api<HistData>('/api/git/history');
    renderHistory();
  } catch (err) {
    histData = null;
    histList.innerHTML = `<li><p class="error">${esc((err as Error).message)}</p></li>`;
  }
  if (narrow()) setNav(false); // the view sits behind the overlay on mobile
}

// leaving the view via the git button: back to where it was entered from
// (selected survived leavingFile), or the welcome screen
async function closeHistory(): Promise<void> {
  historyOpen = false;
  histEl.hidden = true;
  histData = null;
  histSha = null;
  histFile = null;
  const back = selected ? byPath.get(selected) : null;
  if (back && back.children === undefined) await openFile(back.path);
  else if (back) await showGroup(back);
  else {
    empty.hidden = false;
    renderWelcomeIndex();
    renderTree();
  }
}

function renderHistory(): void {
  const data = histData;
  if (!data) return;
  histBySha = new Map(data.commits.map((c) => [c.sha, c]));
  // the spine: everything reachable from HEAD; the rest sits on undo
  // branches, one indent level in
  const spine = new Set<string>();
  const walk = (sha: string | null): void => {
    if (!sha || spine.has(sha)) return;
    const c = histBySha.get(sha);
    if (!c) return; // older than the 200-commit cap
    spine.add(sha);
    for (const p of c.parents) walk(p);
  };
  if (data.head) walk(data.head);
  const tips = new Map(data.branches.map((b) => [b.sha, b.name]));
  const frag = document.createDocumentFragment();
  if (!data.commits.length) {
    const li = document.createElement('li');
    const p = document.createElement('p');
    p.className = 'note';
    p.textContent = 'No commits yet.';
    li.append(p);
    frag.append(li);
  }
  for (const c of data.commits) {
    const li = document.createElement('li');
    const row = document.createElement('button');
    row.type = 'button';
    const here = c.sha === data.head;
    row.className =
      'hist-row' +
      (spine.has(c.sha) ? '' : ' branch') +
      (here ? ' here' : '') +
      (c.sha === histSha ? ' sel' : '');
    row.title = here ? 'you are here' : c.subject;
    row.dataset.sha = c.sha;
    row.innerHTML =
      `<span class="hist-dot${here ? ' here' : ''}"></span>` +
      `<span class="hist-subj">${esc(c.subject)}</span>` +
      `<span class="hist-when">${esc(histWhen(c.at))}</span>` +
      (tips.get(c.sha) ? `<span class="hist-tip">${esc(tips.get(c.sha)!)}</span>` : '');
    li.append(row);
    frag.append(li);
  }
  histList.replaceChildren(frag);
}

histList.addEventListener('click', (e) => {
  const row = (e.target as HTMLElement).closest('.hist-row') as HTMLElement | null;
  if (!row || !row.dataset.sha) return;
  selectCommit(row.dataset.sha);
});

function selectCommit(sha: string): void {
  const c = histBySha.get(sha);
  if (!c) return;
  histSha = sha;
  histFile = null;
  renderHistory(); // the sel class moves
  histMsg.textContent = c.subject;
  histTime.textContent = `${histWhen(c.at)} · ${c.sha.slice(0, 7)}`;
  const frag = document.createDocumentFragment();
  if (!c.changed.length) {
    const li = document.createElement('li');
    li.className = 'note';
    li.textContent = 'no files changed';
    frag.append(li);
  }
  for (const p of c.changed) {
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'hist-file';
    b.dataset.path = p;
    b.textContent = p;
    li.append(b);
    frag.append(li);
  }
  histFiles.replaceChildren(frag);
  histBody.hidden = true;
  histBody.replaceChildren();
  histPreview.hidden = false;
  histBusy(false); // restore stays disabled until a file is picked
}

histFiles.addEventListener('click', async (e) => {
  const b = (e.target as HTMLElement).closest('.hist-file') as HTMLElement | null;
  if (!b || !histSha) return;
  const path = b.dataset.path!;
  histFile = path;
  for (const el of histFiles.querySelectorAll('.hist-file'))
    el.classList.toggle('sel', (el as HTMLElement).dataset.path === path);
  histBusy(false);
  histBody.hidden = false;
  histBody.textContent = '…';
  try {
    const { content } = await api<{ content: string }>(
      `/api/git/show?sha=${encodeURIComponent(histSha)}&path=${encodeURIComponent(path)}`,
    );
    if (histFile !== path) return; // the selection moved on while loading
    histBody.innerHTML = marked.parse(content) as string;
  } catch (err) {
    if (histFile !== path) return;
    histBody.innerHTML = `<p class="error">${esc((err as Error).message)}</p>`;
  }
});

// the shared "like undo" epilogue: drop drafts of changed paths (the
// restored "past" must not resurrect from sessionStorage), remap all
// path-keyed state through the map, reload the tree, then land on the
// restored file (fetch file) or the remapped selection (make master) —
// or the welcome screen when it is gone.
async function applyRestore(
  res: { changed: string[]; map: Record<string, string> },
  restored: string | null,
): Promise<void> {
  dismissHistory();
  for (const p of res.changed) dropDraft(p); // by current (pre-jump) paths
  remapPaths(res.map);
  await loadTree();
  const map = pathMapper(res.map);
  const target = restored ?? (selected ? map(selected) : null);
  const node = target ? byPath.get(target) : null;
  if (node && node.children === undefined) {
    setSelected(target!);
    renderTree();
    await openFile(target!);
  } else if (node) {
    setSelected(target!);
    renderTree();
    await showGroup(node);
  } else {
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
    renderTree();
  }
}

histRestoreBtn.addEventListener('click', async () => {
  if (!histSha || !histFile || histWorking) return;
  histBusy(true);
  try {
    const res = await api<{ changed: string[]; map: Record<string, string> }>(
      '/api/git/restore-file',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sha: histSha, path: histFile }),
      },
    );
    await applyRestore(res, histFile);
  } catch (err) {
    histBusy(false);
    alert((err as Error).message);
  }
});

histMasterBtn.addEventListener('click', async () => {
  if (!histSha || histWorking) return;
  const ok = await appConfirm(
    'Make this commit the working state? The current state is branched first — nothing is destroyed.',
    { ok: 'make master', danger: true },
  );
  if (!ok) return;
  histBusy(true);
  try {
    const res = await api<{ changed: string[]; map: Record<string, string> }>(
      '/api/git/make-master',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sha: histSha }),
      },
    );
    await applyRestore(res, null);
  } catch (err) {
    histBusy(false);
    alert((err as Error).message);
  }
});

gitBtn.addEventListener('click', () => {
  if (historyOpen) void closeHistory();
  else void openHistory();
});
