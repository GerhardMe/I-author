// The reading views: the folder index (TOC with dotted leaders), the
// welcome screen's works index, and openFile — the one way an md is opened.

import { NOTES } from '../lib/naming.ts';
import { marked } from 'marked';
import { countWords } from '../lib/words.ts';
import { loadDraft, dropDraft } from '../lib/sync.ts';
import {
  api,
  byPath,
  currentGroup,
  esc,
  expanded,
  hideDrafts,
  LAST_KEY,
  narrow,
  saveExpanded,
  setCurrentFile,
  setCurrentGroup,
  setSelected,
  showCounter,
  toggleExpanded,
  tree,
  type Node,
} from './state.ts';
import {
  doc,
  docBody,
  docDraft,
  docTitle,
  docWords,
  editorHost,
  empty,
  emptyBody,
  pdfBtn,
  treeEl,
  welcomeNotes,
} from './dom.ts';
import { loadTree, renderTree, revealPath, visible } from './tree.ts';
import { destroyEditor, leavingFile, makeEditor } from './editor.ts';
import { setSync, syncStateFromDoc } from './tree.ts';
import { sync } from './sync.ts';
import { applyMeasure } from './measure.ts';
import { lastLongPressAt } from './gestures.ts';
import { setNav } from './nav.ts';

function buildToc(ul: HTMLUListElement, nodes: Node[]): void {
  for (const n of nodes) {
    if (n.children === undefined && NOTES.test(n.name)) continue;
    const li = document.createElement('li');
    const row = document.createElement('div');
    const isFolder = n.children !== undefined;
    row.className =
      'toc-row ' +
      (isFolder ? 'toc-folder' : 'toc-chapter') +
      (n.inDraft ? ' toc-draft' : '');
    row.dataset.path = n.path;
    if (isFolder) {
      row.innerHTML = `<span class="toc-title">${esc(n.title)}</span>`;
    } else {
      // the server's split: bare name left, "Chapter 2" right, dots between
      const name = n.raw;
      const label = n.label;
      row.innerHTML = `<span class="toc-name">${esc(name)}</span>${
        label ? '<span class="toc-leader"></span>' : ''
      }<span class="toc-num">${esc(label)}</span>`;
    }
    li.append(row);
    if (isFolder && n.children!.length) {
      const sub = document.createElement('ul');
      sub.className = 'toc-sub';
      buildToc(sub, n.children!);
      li.append(sub);
    }
    ul.append(li);
  }
}

export async function showGroup(node: Node): Promise<void> {
  await leavingFile(); // race fix: fully detach the old editor first
  // fresh tree: word totals would otherwise miss saves since the last load
  await loadTree();
  const cur = byPath.get(node.path) ?? node;
  empty.hidden = true;
  doc.hidden = false;
  docTitle.hidden = false;
  docTitle.classList.toggle('draft', !!cur.inDraft);
  docDraft.hidden = !cur.draft;
  docTitle.textContent = cur.title;
  docWords.hidden = false;
  showCounter({ words: cur.words ?? 0 });
  editorHost.hidden = true;
  docBody.hidden = false;
  setCurrentGroup(node.path);
  pdfBtn.hidden = false; // folder scope: pdf compiles the folder
  applyMeasure(); // the doc just became visible — the clamps need real width

  const frag = document.createDocumentFragment();
  const kids = visible(cur.children!);
  if (kids.length) {
    const ul = document.createElement('ul');
    ul.className = 'toc';
    buildToc(ul, kids);
    frag.append(ul);
  } else {
    const p = document.createElement('p');
    p.className = 'note';
    p.textContent = 'Empty folder.';
    frag.append(p);
  }

  // a notes.md in this folder is appended verbatim under the index
  const notes = cur.children!.find(
    (c) => c.children === undefined && NOTES.test(c.name),
  );
  if (notes && !hideDrafts) {
    try {
      const { content } = await api('/api/file?path=' + encodeURIComponent(notes.path));
      const body = document.createElement('div');
      body.className = 'md-body toc-notes';
      body.innerHTML = marked.parse(content) as string;
      frag.append(body);
    } catch {
      // unreadable notes: skip silently
    }
  }
  docBody.replaceChildren(frag);
}

// one handler for both index views: folder indexes (#doc) and the welcome
// screen's works index (#empty) share the same row markup and behaviour
async function tocClick(e: MouseEvent): Promise<void> {
  const row = (e.target as HTMLElement).closest('.toc-row') as HTMLElement | null;
  if (!row) return;
  const node = byPath.get(row.dataset.path!);
  if (!node) return;
  if (node.children !== undefined) {
    setSelected(node.path);
    expanded.add(node.path);
    saveExpanded();
    renderTree();
    await showGroup(node);
  } else {
    await openFile(node.path); // revealPath selects + renders
  }
}
docBody.addEventListener('click', tocClick);
emptyBody.addEventListener('click', tocClick);

// the welcome screen's body: the index of all works (the root TOC — what a
// work's index is for its books, one level up), with the read-only app
// notes appended under it, hidden together with the notes by the drafts toggle
export function renderWelcomeIndex(): void {
  const frag = document.createDocumentFragment();
  const kids = visible(tree);
  if (kids.length) {
    const ul = document.createElement('ul');
    ul.className = 'toc';
    buildToc(ul, kids);
    frag.append(ul);
  } else {
    const p = document.createElement('p');
    p.className = 'note';
    p.textContent = 'No works yet — right-click the tree to start one.';
    frag.append(p);
  }
  if (!hideDrafts) frag.append(welcomeNotes.content.cloneNode(true));
  emptyBody.replaceChildren(frag);
}

export async function openFile(p: string) {
  revealPath(p);
  await leavingFile();
  try {
    const { content } = await api('/api/file?path=' + encodeURIComponent(p));
    const node = byPath.get(p)!;
    empty.hidden = true;
    doc.hidden = false;
    docTitle.hidden = false;
    docTitle.classList.toggle('draft', !!node.inDraft);
    docDraft.hidden = !node.draft;
    docTitle.textContent = node.title;
    docWords.hidden = false;
    showCounter({ words: countWords(content), chars: content.length });
    pdfBtn.hidden = false;
    setCurrentFile(p);
    try { localStorage.setItem(LAST_KEY, p); } catch {}
    sync.setBaseline(content, content.length);
    destroyEditor();

    const draft = loadDraft(p);
    if (draft && draft.content !== content) {
      makeEditor(draft.content);
      setSync(syncStateFromDoc(draft.content));
      sync.schedule();
    } else {
      if (draft) dropDraft(p);
      makeEditor(content);
      setSync('idle');
    }
    editorHost.hidden = false;
    docBody.hidden = true;
    applyMeasure(); // the doc just became visible — the clamps need real width
    window.scrollTo(0, 0);
  } catch (err) {
    void leavingFile();
    empty.hidden = true;
    doc.hidden = false;
    docWords.hidden = true;
    docDraft.hidden = true;
    docTitle.classList.remove('draft');
    editorHost.hidden = true;
    docBody.hidden = false;
    pdfBtn.hidden = true;
    applyMeasure(); // the doc just became visible — the clamps need real width
    docBody.innerHTML = `<p class="error">${esc((err as Error).message)}</p>`;
  }
}

treeEl.addEventListener('click', async (e) => {
  // the synthetic tap a long-press leaves behind must not open the row
  if (Date.now() - lastLongPressAt < 700) return;
  const caret = (e.target as HTMLElement).closest('[data-caret]');
  if (caret) {
    const crow = caret.closest('.tree-row') as HTMLElement;
    const cnode = byPath.get(crow.dataset.path!);
    if (!cnode) return;
    toggleExpanded(cnode.path);
    renderTree();
    return;
  }
  const row = (e.target as HTMLElement).closest('.tree-row') as HTMLElement | null;
  if (!row) return;
  const node = byPath.get(row.dataset.path!);
  if (!node) return;
  if (node.children !== undefined) {
    // a plain view-click never collapses: it opens the folder's index and,
    // if the row is still folded, unfolds it — only the caret (or a repeat
    // click on a folder already being viewed) flips the tree state
    if (currentGroup === node.path) toggleExpanded(node.path);
    else if (!expanded.has(node.path)) expanded.add(node.path);
    setSelected(node.path);
    renderTree();
    await showGroup(node);
  } else {
    setSelected(node.path);
    renderTree();
    await openFile(node.path);
  }
  if (narrow()) setNav(false); // mobile: picking a chapter closes the panel
});
