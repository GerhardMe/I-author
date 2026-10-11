// App chrome: the collapsible tree (the brand title is the only toggle),
// the mobile topbar scroll-away, the drafts toggle, going home, and the
// session buttons.

import {
  byPath,
  hideCountMenu,
  hideDrafts,
  LAST_KEY,
  navMq,
  narrow,
  navOpen,
  selected,
  setCurrentGroup,
  setHideDrafts,
  setSelected,
} from './state.ts';
import {
  appEl,
  brand,
  doc,
  docBody,
  docDraft,
  docTitle,
  docWords,
  editorHost,
  empty,
  hideBtn,
  hideEye,
  pdfBtn,
  pdfMenu,
  sideFootEl,
  toolbarEl,
  treeEl,
} from './dom.ts';
import { isVisibleNode, loadTree, renderTree } from './tree.ts';
import { flushDraft, leavingFile } from './editor.ts';
import { renderWelcomeIndex, showGroup } from './toc.ts';
import { closeMenu, closeNewDialog, newOpen } from './files.ts';
import { dismissHistory } from './history.ts';

// ---------- hide drafts & notes ----------
export function syncHideBtn(): void {
  hideEye.textContent = hideDrafts ? '◡' : '◉';
  hideBtn.title = hideDrafts ? 'Show drafts and notes' : 'Hide drafts and notes';
}

hideBtn.addEventListener('click', () => {
  setHideDrafts(!hideDrafts);
  localStorage.setItem('iauthor.hide-drafts', hideDrafts ? '1' : '0');
  syncHideBtn();
  renderTree();
  if (selected) {
    const node = byPath.get(selected);
    if (!node || !isVisibleNode(node.path)) {
      setSelected(null);
      doc.hidden = true;
      empty.hidden = false;
      pdfBtn.hidden = true;
      renderWelcomeIndex();
    } else if (node.children !== undefined) {
      void showGroup(node);
    }
  } else if (!empty.hidden) {
    renderWelcomeIndex(); // the welcome is the view: its notes ride the toggle
  }
});

// ---------- collapsible tree: the title is the only toggle (4.7) ----------
// The sidebar is a fixed overlay; when it is OPEN the markdown view's left
// padding statically widens by the tree width (owner decision, 2026-10-06).
// Desktop ALWAYS boots with the tree open (no persistence — a reload undoes
// a close); mobile boots hidden so the page is never covered. The pre-paint
// inline script in the markup applies nav-off on mobile before first paint,
// so neither state ever flashes.

// ---------- mobile topbar: hides on scroll down, back on scroll up ----------
// Only while the tree is closed — the overlay's own title bar must not move
// while it is open. The document is the scroller (.main has no height of its
// own), so the scroll fires on window; near the top the bar always shows.
const BAR_SLACK = 4; // px hysteresis: scroll jitter cannot flip the state
let barLastY = window.scrollY;

window.addEventListener('scroll', () => {
  const y = window.scrollY;
  if (!narrow() || navOpen() || y <= 48) {
    appEl.classList.remove('bar-away');
    barLastY = y;
    return;
  }
  if (y > barLastY + BAR_SLACK) appEl.classList.add('bar-away');
  else if (y < barLastY - BAR_SLACK) appEl.classList.remove('bar-away');
  barLastY = y;
}, { passive: true });

export function setNav(open: boolean): void {
  if (!open && newOpen) return; // the create popup owns the open panel (line, anchor)
  appEl.classList.toggle('nav-off', !open);
  appEl.classList.remove('bar-away'); // a fresh panel shows its title bar
  barLastY = window.scrollY;
  // the overlay covers the page: a touch on it must not scroll what is
  // behind (a hold under the last file row scrolled the document otherwise)
  if (narrow()) document.body.style.overflow = open ? 'hidden' : '';
  brand.setAttribute('aria-expanded', String(open));
  for (const el of [treeEl, toolbarEl, sideFootEl]) {
    if (open) el.removeAttribute('inert');
    else el.setAttribute('inert', ''); // Tab skips the hidden parts
  }
}

// back to the welcome pseudo-file: a deliberate "home" — the open file is
// flushed and pushed first, the last-opened pointer is cleared so boot does
// not drag the old file back over the choice. Going home also leaves every
// transient surface behind: all menus close.
export async function showWelcome(): Promise<void> {
  closeMenu();
  pdfMenu.hidden = true;
  hideCountMenu();
  closeNewDialog();
  dismissHistory(); // the history view never survives going home
  await leavingFile();
  setSelected(null);
  setCurrentGroup(null);
  doc.hidden = true;
  editorHost.hidden = true;
  docBody.hidden = true;
  docTitle.hidden = true;
  docWords.hidden = true;
  docDraft.hidden = true;
  docTitle.classList.remove('draft');
  pdfBtn.hidden = true;
  empty.hidden = false;
  // fresh tree: the works index would otherwise miss saves since the last
  // load; offline it keeps the tree it has rather than failing to go home
  try { await loadTree(); } catch {}
  renderWelcomeIndex();
  try { localStorage.removeItem(LAST_KEY); } catch {}
  if (narrow()) setNav(false); // mobile: the welcome sits behind the overlay
}

// double-click / long-press on the title goes home; the single click stays
// the tree toggle. A long-press leaves a trailing tap behind, so the click
// handler stands down for 700 ms after one fired.
let brandPressAt = 0;
let brandLpTimer: ReturnType<typeof setTimeout> | null = null;
let brandLpX = 0;
let brandLpY = 0;

function brandLpCancel(): void {
  if (brandLpTimer) {
    clearTimeout(brandLpTimer);
    brandLpTimer = null;
  }
}

brand.addEventListener(
  'touchstart',
  (e) => {
    if (e.touches.length !== 1 || brandLpTimer) return;
    const t = e.touches[0];
    brandLpX = t.clientX;
    brandLpY = t.clientY;
    brandLpTimer = setTimeout(() => {
      brandLpTimer = null;
      brandPressAt = Date.now();
      navigator.vibrate?.(10);
      void showWelcome();
    }, 500);
  },
  { passive: true },
);
brand.addEventListener(
  'touchmove',
  (e) => {
    if (!brandLpTimer) return;
    const t = e.touches[0];
    if (Math.abs(t.clientX - brandLpX) > 10 || Math.abs(t.clientY - brandLpY) > 10)
      brandLpCancel();
  },
  { passive: true },
);
brand.addEventListener('touchend', brandLpCancel);
brand.addEventListener('touchcancel', brandLpCancel);
brand.addEventListener('contextmenu', (e) => e.preventDefault()); // Android long-press
brand.addEventListener('dblclick', () => void showWelcome());

brand.addEventListener('click', () => {
  if (Date.now() - brandPressAt < 700) return;
  setNav(!navOpen());
});

// shrinking to mobile hides the panel; back to desktop: the scroll lock
// must not stick. Rows rebuilt: draggable flips with the profile (native
// vs touch)
navMq.addEventListener('change', (e) => {
  if (e.matches) setNav(false); // shrinking to mobile hides the panel
  else document.body.style.overflow = ''; // back to desktop: the lock must not stick
  renderTree(); // rows rebuilt: draggable flips with the profile (native vs touch)
});

const post = (url: string) => {
  flushDraft();
  return fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  }).then(() => {
    location.href = url.includes('lock') ? '/login?locked=1' : '/login';
  });
};
document.getElementById('lock')?.addEventListener('click', () => post('/api/lock'));
document.getElementById('logout')?.addEventListener('click', () => post('/api/logout'));
