// Shared client state for the app shell: the works tree, the selection and
// everything keyed by path. All src/app/ modules read from here; values that
// several modules assign are written through setters — an imported ES module
// binding can only be assigned by its declaring module, so `selected` &
// friends are `export let` (live reads) plus a setter for the writers.

import { remapDrafts } from '../lib/sync.ts';
import { appEl, docWords } from './dom.ts';

export type Node = {
  name: string;
  path: string;
  title: string;
  label: string; // the division label ("Chapter 2", "Book I"); bare entries: ''
  raw: string; // the filename's own title, prefix stripped
  draft: boolean; // self: owns the (draft) chip
  inDraft: boolean; // inside a draft subtree: grays titles
  words?: number; // self (md) or recursive total of all descendant mds
  children?: Node[];
};

export const EXP_KEY = 'iauthor.expanded';
export const LAST_KEY = 'iauthor.last'; // the last opened file, restored at boot

export let tree: Node[] = [];
export const byPath = new Map<string, Node>();
export const expanded = new Set<string>();
export let selected: string | null = null;
export let currentFile: string | null = null;
export let currentGroup: string | null = null; // folder index currently shown, if any
export let hideDrafts = localStorage.getItem('iauthor.hide-drafts') === '1';

export function setTree(nodes: Node[]): void {
  tree = nodes;
}
export function setSelected(p: string | null): void {
  selected = p;
}
export function setCurrentFile(p: string | null): void {
  currentFile = p;
}
export function setCurrentGroup(p: string | null): void {
  currentGroup = p;
}
export function setHideDrafts(v: boolean): void {
  hideDrafts = v;
}

export function saveExpanded(): void {
  try {
    localStorage.setItem(EXP_KEY, JSON.stringify([...expanded]));
  } catch {}
}

export function toggleExpanded(p: string): void {
  if (expanded.has(p)) expanded.delete(p);
  else expanded.add(p);
  saveExpanded();
}

// Renumbering changes MANY paths at once (closing a gap renames every later
// sibling), so every mutation hands back an old->new map and all client state
// keyed by path has to follow: expanded folders, the selection, and the
// unsynced drafts in sessionStorage.
// A moved FOLDER changes the path of everything inside it, while the map only
// carries the folder itself, so match by longest prefix rather than by exact
// key — that is what keeps descendants (expanded folders, unsynced drafts)
// pointing at files that still exist.
export function pathMapper(map: Record<string, string> | undefined): (path: string) => string {
  const pairs = Object.entries(map ?? {}).filter(([a, b]) => a !== b);
  return (path: string) => {
    let best = '';
    let to = '';
    for (const [from, dest] of pairs) {
      if ((path === from || path.startsWith(from + '/')) && from.length > best.length) {
        best = from;
        to = dest;
      }
    }
    return to ? to + path.slice(best.length) : path;
  };
}

export function remapPaths(map: Record<string, string> | undefined): void {
  const hit = pathMapper(map);
  let touched = false;
  for (const p of [...expanded]) {
    const next = hit(p);
    if (next === p) continue;
    touched = true;
    expanded.delete(p);
    expanded.add(next);
  }
  if (selected) setSelected(hit(selected));
  // drafts: the caller cannot enumerate what a moved folder touches, so the
  // store is walked with the same remapper (a missed draft would recreate
  // its file at the old path on the next sync)
  remapDrafts(hit);
  // the last-opened pointer follows renames/reorders the same way, so boot
  // restores the file under its new path instead of falling back to welcome
  const last = localStorage.getItem(LAST_KEY);
  if (last && hit(last) !== last) {
    try { localStorage.setItem(LAST_KEY, hit(last)); } catch {}
  }
  if (touched) saveExpanded();
}

// renaming a folder rewrites all descendant paths: carry expanded state over
// so the subtree stays open and the sidebar visibly updates in place
export function remapExpanded(oldPath: string, newPath: string): void {
  const next = new Set<string>();
  for (const p of expanded) {
    if (p === oldPath) next.add(newPath);
    else if (p.startsWith(oldPath + '/')) next.add(newPath + p.slice(oldPath.length));
    else next.add(p);
  }
  expanded.clear();
  for (const p of next) expanded.add(p);
  saveExpanded();
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );
}

export async function api<T = any>(url: string, opts?: RequestInit): Promise<T> {
  const res = await fetch(url, { cache: 'no-store', ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data;
}

export const navMq = window.matchMedia('(max-width: 900px)');
export const narrow = (): boolean => navMq.matches;
export const navOpen = (): boolean => !appEl.classList.contains('nav-off');

export const nameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
export const parentOf = (path: string): string => {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
};

// the doc-head counter chip: the mode (words <-> chars) is chosen through a
// right-click dropdown (long-press on touch) — a plain click does nothing.
// Session-only, no persistence. The last figures are remembered so a switch
// re-renders in place; a folder index has no char figure, so it only carries
// words and its menu offers no chars item.
let charMode = false;
let lastWords: number | null = null;
let lastChars: number | null = null;

export const countMenu = document.createElement('div');
countMenu.id = 'count-menu';
countMenu.hidden = true;
const itemWords = document.createElement('button');
itemWords.type = 'button';
itemWords.className = 'ctx-item';
itemWords.textContent = 'words';
const itemChars = document.createElement('button');
itemChars.type = 'button';
itemChars.className = 'ctx-item';
itemChars.textContent = 'chars';
countMenu.append(itemWords, itemChars);
document.body.append(countMenu);

export function showCounter(v: { words: number; chars?: number }): void {
  lastWords = v.words;
  lastChars = v.chars ?? null; // a folder index has no char figure — don't keep a stale one
  renderCounter();
}

function renderCounter(): void {
  const words = lastWords ?? 0;
  docWords.textContent =
    charMode && lastChars !== null ? `${lastChars} chars` : `${words} words`;
}

function syncCountMenu(): void {
  itemWords.classList.toggle('is-on', !charMode);
  itemChars.classList.toggle('is-on', charMode);
}

export function openCountMenu(x: number, y: number): void {
  if (docWords.hidden || lastWords === null) return;
  itemChars.hidden = lastChars === null; // a folder index only carries words
  syncCountMenu();
  countMenu.hidden = false;
  const r = countMenu.getBoundingClientRect();
  countMenu.style.left = `${Math.min(x, window.innerWidth - r.width - 8)}px`;
  countMenu.style.top = `${Math.min(y, window.innerHeight - r.height - 8)}px`;
}

export function hideCountMenu(): void {
  countMenu.hidden = true;
}

function setCharMode(v: boolean): void {
  charMode = v;
  hideCountMenu();
  renderCounter();
}

itemWords.addEventListener('click', () => setCharMode(false));
itemChars.addEventListener('click', () => setCharMode(true));

// ---------- desktop right-click + touch long-press on the counter chip ----------
// The chip sits in the doc-head, outside the tree's gesture machinery, so it
// carries its own small touch profile. touchstart stamps the press: Android's
// native long-press contextmenu stands down under 800ms (our hold owns the
// gesture); a desktop right-click has no touchstart before it and opens as
// always. The trailing synthetic tap of a long-press must not close the menu
// it opened — a fresh stamp guards the click-outside gate (main.ts).
let touchPressAt = 0; // a touchstart stamp: android's native contextmenu stands down
let countPressAt = 0; // the menu's own open stamp: suppresses the trailing tap
const LP_ARM = 500; // hold time before the menu opens
const LP_SCROLL_SLOP = 10; // px of movement that still reads as a scroll attempt

function lpCancel(): void {
  if (lpTimer) {
    clearTimeout(lpTimer);
    lpTimer = null;
  }
}

let lpTimer: ReturnType<typeof setTimeout> | null = null;
let lpX = 0;
let lpY = 0;

docWords.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  // a native contextmenu straight after a touch (Android long-press) is
  // the platform's surprise mid-hold: our own hold opens the menu instead
  if (Date.now() - touchPressAt < 800) return;
  openCountMenu(e.clientX, e.clientY);
});

docWords.addEventListener(
  'touchstart',
  (e) => {
    if (e.touches.length !== 1) {
      // a second finger is a pinch — not a press
      lpCancel();
      return;
    }
    if (lpTimer) return;
    const t = e.touches[0]!;
    touchPressAt = Date.now();
    lpX = t.clientX;
    lpY = t.clientY;
    lpTimer = setTimeout(() => {
      lpTimer = null;
      navigator.vibrate?.(10); // a tiny tick where the platform has it
      countPressAt = Date.now();
      openCountMenu(lpX, lpY);
    }, LP_ARM);
  },
  { passive: true },
);

docWords.addEventListener(
  'touchmove',
  (e) => {
    if (!lpTimer) return;
    const t = e.touches[0]!;
    if (
      Math.abs(t.clientX - lpX) > LP_SCROLL_SLOP ||
      Math.abs(t.clientY - lpY) > LP_SCROLL_SLOP
    )
      lpCancel(); // a scroll attempt — hand the gesture back to the scroller
  },
  { passive: true },
);

docWords.addEventListener('touchend', () => lpCancel());
docWords.addEventListener('touchcancel', () => lpCancel());

export function recentCountPress(): boolean {
  return Date.now() - countPressAt < 700;
}
