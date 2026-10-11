// The app shell entry: boot, and the document-level listeners whose
// registration ORDER is load-bearing (the menus, the create dialog, the
// nav toggle and the history view contend for Escape; the two
// click-to-dismiss menus must keep their order too). Everything else
// lives in its feature module.

import { EXP_KEY, byPath, expanded, LAST_KEY, narrow, navOpen, saveExpanded, tree } from './state.ts';
import { loadTree, renderTree } from './tree.ts';
import { pdfMenu } from './dom.ts';
import { openFile, renderWelcomeIndex } from './toc.ts';
import { closeMenu, closeNewDialog, ctxMenu, newOpen } from './files.ts';
import { hidePdfMenu, loadPdfStyles } from './pdf.ts';
import { setNav, showWelcome, syncHideBtn } from './nav.ts';
import { historyOpen } from './history.ts';
import { lastLongPressAt } from './gestures.ts';

// a click elsewhere closes the tree context menu — but the synthetic tap
// after a long-press must not close the menu it opened
document.addEventListener('click', () => {
  if (Date.now() - lastLongPressAt < 700) return;
  if (!ctxMenu.hidden) closeMenu();
});

document.addEventListener('click', (e) => {
  if (!pdfMenu.hidden && !pdfMenu.contains(e.target as Node)) hidePdfMenu();
});

// Escape order: the create dialog, then the context menu, then the pdf
// menu, then the nav toggle, then the history view — each layer checks
// that the layers before it are closed and gets first refusal
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (newOpen) {
    closeNewDialog();
    return;
  }
  if (!ctxMenu.hidden) closeMenu();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !pdfMenu.hidden) hidePdfMenu();
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !navOpen()) return;
  // menus and the create dialog get Escape first
  if (newOpen || !ctxMenu.hidden || !pdfMenu.hidden) return;
  if (historyOpen) return; // the history view's own Escape path owns it
  setNav(false);
});

// the history view's Escape: home (the plan's exit rule). Registered after
// the pdf menu's listener so the menus get Escape first; the nav toggle is
// held off — going home must not also fold the tree on desktop.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !historyOpen) return;
  if (newOpen || !ctxMenu.hidden || !pdfMenu.hidden) return; // they get Escape first
  void showWelcome();
  e.stopImmediatePropagation();
});

export async function boot(): Promise<void> {
  void loadPdfStyles(); // the pdf menu fills in whenever the server answers
  syncHideBtn();
  // nav state: the tree is ALWAYS open on desktop at boot (a reload undoes
  // a close); mobile starts hidden — the pre-paint inline script already
  // applied nav-off, so this is a no-op there and nothing animates
  setNav(!narrow());
  document.body.classList.add('nav-anim');
  // restore the expanded/collapsed folders from the last session; first
  // visit (no stored state) starts with all top-level works expanded
  let stored: string[] | null = null;
  try {
    const raw = localStorage.getItem(EXP_KEY);
    if (raw !== null) stored = JSON.parse(raw) as string[];
  } catch {}
  if (stored) for (const p of stored) expanded.add(p);
  await loadTree();
  if (stored) {
    for (const p of [...expanded]) if (!byPath.has(p)) expanded.delete(p);
    saveExpanded();
  } else {
    for (const w of tree) if (w.children !== undefined) expanded.add(w.path);
    saveExpanded();
    renderTree();
  }
  // last-page restore: reopen the file the last session ended on. A stored
  // folder path or a deleted file falls back to the welcome screen; drafts
  // ride along — openFile restores them when they are newer than the server
  renderWelcomeIndex(); // the fallback view is the works index, not a blank page
  const last = localStorage.getItem(LAST_KEY);
  if (last) {
    const node = byPath.get(last);
    if (node && node.children === undefined) void openFile(last);
  }
}

boot();
