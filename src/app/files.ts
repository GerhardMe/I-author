// Tree mutations from the sidebar: the context menu (new / delete), the
// create dialog, and rename via the header title click.

import { parseName } from '../lib/naming.ts';
import { moveDraft, dropDraft } from '../lib/sync.ts';
import { appConfirm } from '../lib/confirm.ts';
import {
  api,
  byPath,
  currentFile,
  expanded,
  navOpen,
  remapExpanded,
  remapPaths,
  saveExpanded,
  selected,
  setSelected,
  tree,
  type Node,
} from './state.ts';
import {
  doc,
  docHead,
  docTitle,
  empty,
  newDialog,
  newCard,
  newErr,
  newIn,
  newName,
  pdfBtn,
  renameInput,
  treeEl,
} from './dom.ts';
import { loadTree, renderTree } from './tree.ts';
import { leavingFile } from './editor.ts';
import { openFile, renderWelcomeIndex, showGroup } from './toc.ts';
import { lineEl, placeLine, placeLineInFolder } from './gestures.ts';
import { setNav } from './nav.ts';

// ---------- context menu on the tree: new / delete ----------
export const ctxMenu = document.createElement('div');
ctxMenu.id = 'ctx-menu';
ctxMenu.hidden = true;
const itemNew = document.createElement('button');
itemNew.type = 'button';
itemNew.className = 'ctx-item';
itemNew.textContent = 'new';
const itemDel = document.createElement('button');
itemDel.type = 'button';
itemDel.className = 'ctx-item danger';
itemDel.textContent = 'delete';
ctxMenu.append(itemNew, itemDel);
document.body.append(ctxMenu);

let ctxTarget: Node | null = null; // right-clicked node, null = works root
let ctxLi: HTMLElement | null = null; // <li> of the target, for the delete flash
let pendingKind: 'folder' | 'file' = 'file';
let pendingParent = ''; // parent path the new entry goes into ('' = top level)
let pendingAnchorPath = ''; // row the insertion line sits under ('' = top level)
export let newOpen = false;
let previewExpandedPath: string | null = null; // folder opened just for the preview
let previewDelExpanded: string[] | null = null; // folders opened for the delete preview

function revertPreviewExpand(): void {
  if (!previewExpandedPath) return;
  expanded.delete(previewExpandedPath);
  saveExpanded();
  previewExpandedPath = null;
  renderTree();
}

// open every folder in the target's subtree so the full deletion is visible
function expandDeletePreview(target: Node): void {
  const added: string[] = [];
  const walk = (n: Node): void => {
    if (n.children === undefined) return;
    if (!expanded.has(n.path)) {
      expanded.add(n.path);
      added.push(n.path);
    }
    for (const c of n.children!) walk(c);
  };
  walk(target);
  if (!added.length) return;
  previewDelExpanded = added;
  saveExpanded();
  renderTree();
}

function revertDeletePreview(): void {
  ctxLi?.classList.remove('del-flash');
  ctxLi = null;
  if (!previewDelExpanded) return;
  for (const p of previewDelExpanded) expanded.delete(p);
  saveExpanded();
  previewDelExpanded = null;
  renderTree();
}

// file -> sibling in its folder; folder -> inside it; nothing -> works root
function newParentOf(target: Node | null): string {
  if (!target) return '';
  if (target.children !== undefined) return target.path;
  const i = target.path.lastIndexOf('/');
  return i === -1 ? '' : target.path.slice(0, i);
}

// same rule as nextName() on the server: max sibling prefix + 1, zero-padded
function nextPrefix(parent: string): string {
  const siblings = parent ? byPath.get(parent)!.children! : tree;
  let max = 0;
  for (const c of siblings) {
    const p = parseName(c.name).prefix;
    if (p !== null && p > max) max = p;
  }
  return `${String(max + 1).padStart(2, '0')}_`;
}

export function showInsertLine(): void {
  let row: HTMLElement | null = null;
  if (pendingAnchorPath) {
    const node = byPath.get(pendingAnchorPath);
    const li = treeEl
      .querySelector(`.tree-row[data-path="${pendingAnchorPath}"]`)
      ?.closest('li') as HTMLElement | null;
    const head = li?.querySelector(':scope > .tree-row') as HTMLElement | null;
    // folder target: the entry lands inside it — the line sits directly
    // under the folder row, at the same indent as its children
    if (node && node.children !== undefined && head) {
      placeLineInFolder(head);
      return;
    } else if (head) {
      row = head;
    }
  }
  if (!row) {
    const tops = treeEl.querySelectorAll<HTMLElement>(':scope > ul > li > .tree-row');
    row = tops.length ? tops[tops.length - 1]! : null;
  }
  if (row) {
    placeLine(row.offsetTop + row.offsetHeight, row.offsetLeft, row.offsetWidth);
  } else {
    lineEl.style.top = '0.35rem';
    lineEl.style.left = '0.5rem';
    lineEl.style.right = '0.5rem';
    lineEl.style.width = 'auto';
    lineEl.hidden = false;
  }
}

export function closeMenu(): void {
  ctxMenu.hidden = true;
  ctxTarget = null;
  revertDeletePreview();
  if (!newOpen) {
    lineEl.hidden = true;
    pendingAnchorPath = '';
    revertPreviewExpand();
  }
}

export function openCtxMenuAt(x: number, y: number, row: HTMLElement | null): void {
  if (!navOpen()) setNav(true); // no control behind a closed panel
  ctxTarget = row ? (byPath.get(row.dataset.path!) ?? null) : null;
  ctxLi = row ? (row.closest('li') as HTMLElement | null) : null;
  itemDel.hidden = !ctxTarget;
  ctxMenu.hidden = false;
  const r = ctxMenu.getBoundingClientRect();
  ctxMenu.style.left = `${Math.min(x, window.innerWidth - r.width - 8)}px`;
  ctxMenu.style.top = `${Math.min(y, window.innerHeight - r.height - 8)}px`;
}

itemNew.addEventListener('mouseenter', () => {
  const target = ctxTarget;
  // open a closed target folder so the line can sit inside it, at child indent
  if (target && target.children !== undefined && !expanded.has(target.path)) {
    expanded.add(target.path);
    saveExpanded();
    previewExpandedPath = target.path;
    renderTree();
  }
  pendingAnchorPath = target ? target.path : '';
  showInsertLine();
});
itemNew.addEventListener('mouseleave', () => {
  if (!newOpen) {
    lineEl.hidden = true;
    pendingAnchorPath = '';
    revertPreviewExpand();
  }
});
itemNew.addEventListener('click', () => {
  if (!navOpen()) setNav(true); // no control behind a closed panel
  previewExpandedPath = null; // the folder stays open once creation begins
  pendingParent = newParentOf(ctxTarget);
  pendingKind = 'file';
  syncKindUI();
  newName.value = nextPrefix(pendingParent);
  newOpen = true;
  pendingAnchorPath = ctxTarget ? ctxTarget.path : '';
  showInsertLine(); // the line stays up while the dialog is open (touch has no hover)
  ctxTarget = null;
  ctxMenu.hidden = true;
  newIn.textContent = 'in ' + (pendingParent ? byPath.get(pendingParent)!.title : 'works/');
  newErr.hidden = true;
  newDialog.hidden = false;
  newName.focus();
  newName.setSelectionRange(newName.value.length, newName.value.length);
});

itemDel.addEventListener('mouseenter', () => {
  const target = ctxTarget;
  if (!target) return;
  if (target.children !== undefined) expandDeletePreview(target);
  // resolve the flash row after any re-render from the subtree expansion
  ctxLi = treeEl
    .querySelector(`.tree-row[data-path="${target.path}"]`)
    ?.closest('li') as HTMLElement | null;
  ctxLi?.classList.add('del-flash');
});
itemDel.addEventListener('mouseleave', () => revertDeletePreview());
itemDel.addEventListener('click', () => {
  const target = ctxTarget;
  previewDelExpanded = null; // the subtree stays open; deleteNode prunes it
  closeMenu();
  if (target) void deleteNode(target);
});

function syncKindUI(): void {
  for (const b of newCard.querySelectorAll<HTMLButtonElement>('.kind-btn'))
    b.classList.toggle('is-on', b.dataset.kind === pendingKind);
}
for (const b of newCard.querySelectorAll<HTMLButtonElement>('.kind-btn')) {
  b.addEventListener('click', () => {
    pendingKind = b.dataset.kind === 'folder' ? 'folder' : 'file';
    syncKindUI();
    newName.focus();
  });
}

export function closeNewDialog(): void {
  newDialog.hidden = true;
  newName.value = '';
  newErr.hidden = true;
  newOpen = false;
  pendingAnchorPath = '';
  lineEl.hidden = true;
}

// a click outside the card cancels — captured so nothing behind the dialog
// acts on it (a tree row must not open), the same contract as appConfirm
document.addEventListener(
  'click',
  (e) => {
    if (!newOpen || newCard.contains(e.target as Node)) return;
    e.preventDefault();
    e.stopPropagation();
    closeNewDialog();
  },
  true,
);

async function createNow(): Promise<void> {
  const name = newName.value.trim();
  if (!name) return;
  try {
    const { path, renumbered } = await api('/api/new', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: pendingKind, parent: pendingParent, name }),
    });
    remapPaths(renumbered);
    closeNewDialog();
    if (pendingParent) expanded.add(pendingParent);
    saveExpanded();
    await loadTree();
    setSelected(path);
    const node = byPath.get(path)!;
    if (node.children !== undefined) {
      expanded.add(path);
      saveExpanded();
      renderTree();
      await showGroup(node);
    } else {
      renderTree();
      await openFile(path);
    }
  } catch (err) {
    // the dialog stays up; the reason shows inside it
    newErr.textContent = (err as Error).message;
    newErr.hidden = false;
  }
}

document.getElementById('new-cancel')!.addEventListener('click', closeNewDialog);

document.getElementById('new-ok')!.addEventListener('click', () => void createNow());

newName.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    void createNow();
  }
});

// ---------- delete (header button + context menu share this) ----------
async function deleteNode(target: Node): Promise<void> {
  const what =
    target.children !== undefined ? `"${target.title}" and everything in it` : `"${target.title}"`;
  // the deletion preview rides the confirm window: the doomed subtree is
  // expanded and flashed while the dialog asks (touch has no hover, so a
  // phone would otherwise confirm blind). The dialog does not block the
  // event loop — the pulse keeps animating while it is up.
  expandDeletePreview(target);
  ctxLi = treeEl
    .querySelector(`.tree-row[data-path="${target.path}"]`)
    ?.closest('li') as HTMLElement | null;
  ctxLi?.classList.add('del-flash');
  const ok = await appConfirm(`Delete ${what}? Git history keeps a copy on the server.`, {
    ok: 'delete',
    danger: true,
  });
  revertDeletePreview();
  if (!ok) return;
  try {
    const open = currentFile;
    if (open && (open === target.path || open.startsWith(target.path + '/'))) {
      await leavingFile(); // flush + push the open file's last content first
      dropDraft(open);
    }
    const res = await api('/api/delete', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: target.path }),
    });
    remapPaths(res.renumbered);
    const wentHome =
      selected === target.path || !!selected?.startsWith(target.path + '/');
    if (wentHome) {
      setSelected(null);
      doc.hidden = true;
      empty.hidden = false;
      pdfBtn.hidden = true;
    }
    for (const p of [...expanded]) {
      if (p === target.path || p.startsWith(target.path + '/')) expanded.delete(p);
    }
    saveExpanded();
    await loadTree();
    if (wentHome) renderWelcomeIndex(); // the tree is reloaded; now rebuild the index
  } catch (err) {
    alert((err as Error).message);
  }
}

// ---------- rename via header title click (live-preview style: display <-> raw) ----------
let renaming: Node | null = null;

docHead.addEventListener('click', (e) => {
  if (renaming || !selected) return;
  if ((e.target as HTMLElement).closest('button')) return;
  const node = byPath.get(selected);
  if (!node) return;
  renaming = node;
  docTitle.hidden = true;
  renameInput.hidden = false;
  renameInput.value = node.name;
  renameInput.focus();
  renameInput.select();
});

function endRename(commit: boolean): void {
  const node = renaming;
  if (!node) return;
  renaming = null;
  renameInput.hidden = true;
  docTitle.hidden = false;
  const name = renameInput.value.trim();
  if (!commit || !name || name === node.name) return;
  void commitRename(node, name);
}

async function commitRename(node: Node, name: string): Promise<void> {
  try {
    await leavingFile(); // flush + push under the old path while it still exists
    const { path, renumbered } = await api('/api/rename', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: node.path, name }),
    });
    remapPaths(renumbered);
    moveDraft(node.path, path);
    remapExpanded(node.path, path);
    await loadTree();
    setSelected(path);
    const fresh = byPath.get(path)!;
    renderTree();
    if (fresh.children !== undefined) {
      expanded.add(path);
      saveExpanded();
      await showGroup(fresh);
    } else {
      await openFile(path);
    }
  } catch (err) {
    alert((err as Error).message);
    setSelected(node.path);
    const stale = byPath.get(node.path);
    if (stale) {
      if (stale.children !== undefined) void showGroup(stale);
      else void openFile(stale.path);
    }
  }
}

renameInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') endRename(true);
  else if (e.key === 'Escape') endRename(false);
});
renameInput.addEventListener('blur', () => endRename(true));
