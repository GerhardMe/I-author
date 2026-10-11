// Tree gestures: desktop HTML5 drag & drop, the touch state machine
// (press-and-hold ARMS, movement drags, an unmoved lift opens the menu),
// and the shared insert-line geometry.

import {
  api,
  byPath,
  currentFile,
  expanded,
  nameOf,
  parentOf,
  pathMapper,
  remapPaths,
  saveExpanded,
  setSelected,
  tree,
  type Node,
} from './state.ts';
import { doc, empty, pdfBtn, sidebarEl, treeEl } from './dom.ts';
import { isVisibleNode, loadTree, renderTree } from './tree.ts';
import { leavingFile } from './editor.ts';
import { openFile, renderWelcomeIndex, showGroup } from './toc.ts';
import { openCtxMenuAt } from './files.ts';

// ---------- drag & drop ----------
// Desktop only: HTML5 drag events do not fire for touch, so the mobile tree
// keeps the context menu. The server does the renaming (POST /api/reorder
// takes intent, not names) and answers with an old->new path map, which
// remapPaths applies before the tree is re-read.
let dragPath: string | null = null;
export let dragCard: HTMLElement | null = null; // the floating clone that follows the cursor
let dragRow: HTMLElement | null = null; // the source row: carries the touch drag listeners
let grabX = 0; // where the hand grabbed the row, so the card stays under it
let grabY = 0;
let dragOpened: string[] = []; // folders a hover opened — temporary, closed on hover-away
export let dragPreview = false; // a drag asked for the preview: keep empty folders
let dropHandled = false; // the drop handler already re-rendered the tree

// the insertion line: one element serves create (green) and move (blue)
export const lineEl = document.createElement('div');
lineEl.id = 'insert-line';
lineEl.hidden = true;

// a lift stamp: the trailing synthetic tap / click must not act
export let lastLongPressAt = 0;

// Every row has TWO bands. The TOP half is a slot at the row's OWN level,
// directly above it — for a folder, a slot in its parent, which is the very
// place its first child's top band draws (a child sits one indent in), so
// those two spellings are one and the same line. The BOTTOM half means
// "under it" for a plain entry and "inside it" for a folder. Two bands on
// facing rows are one zone between them: they mean the same thing, so that
// is fine.
type DropIntent = {
  parent: string;
  before: string | null;
  anchorPath: string;
  kind: 'above' | 'inside' | 'below'; // which of the two bands was aimed at
};

// The band logic, parameterized by the row and the pointer height — the
// desktop dragover/drop handlers and the touch aim both resolve through it.
function intentForRow(row: HTMLElement, clientY: number): DropIntent | null {
  if (!dragPath) return null;
  const path = row.dataset.path!;
  // no dropping a folder into itself, and not onto the entry being dragged
  if (path === dragPath || path.startsWith(dragPath + '/')) return null;
  const node = byPath.get(path);
  if (!node) return null;
  const box = row.getBoundingClientRect();
  const isFolder = node.children !== undefined;
  const upper = (clientY - box.top) / box.height < 0.5;
  const parent = parentOf(path);
  // top half of anything: directly above it, at its own level
  if (upper) {
    return { parent, before: nameOf(path), anchorPath: path, kind: 'above' };
  }
  // bottom half of a folder: inside it, appended at the end
  if (isFolder) {
    return { parent: path, before: null, anchorPath: path, kind: 'inside' };
  }
  // bottom half of a plain entry: below it, in the same folder. The last
  // entry has no next sibling, which means append — and the line belongs
  // BELOW it, or the preview would claim the slot above.
  //
  // The next sibling is looked up in the list WITHOUT the dragged entry: the
  // server drops the moved name from the list before resolving `before`, so
  // naming it here would miss and append — a no-op drop (the slot right
  // below the entry above the dragged one) would teleport it to the end.
  const siblings = parent ? byPath.get(parent)?.children ?? [] : tree;
  const rest = siblings.filter((n) => n.path !== dragPath);
  const next = rest[rest.findIndex((n) => n.path === path) + 1];
  return { parent, before: next ? nameOf(next.path) : null, anchorPath: path, kind: 'below' };
}

function dropIntent(e: DragEvent): DropIntent | null {
  const row = (e.target as HTMLElement).closest('.tree-row') as HTMLElement | null;
  if (!row) return null;
  return intentForRow(row, e.clientY);
}

async function reorderTo(path: string, intent: DropIntent): Promise<void> {
  const open = currentFile;
  try {
    // flush + push while the entry is still at its old path
    await leavingFile();
    const res = await api('/api/reorder', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path, parent: intent.parent, before: intent.before }),
    });
    remapPaths(res.renumbered);
    await loadTree();
    const moved = res.moved.to as string;
    const node = byPath.get(moved);
    // show the result: reveal the destination and select what landed there,
    // otherwise a file dropped into a closed (or draft-hidden) folder looks
    // like it vanished
    if (intent.parent) {
      expanded.add(intent.parent);
      saveExpanded();
    }
    setSelected(moved);
    const reopen = open ? pathMapper(res.renumbered)(open) : null;
    if (reopen && byPath.has(reopen)) {
      await openFile(reopen);
    } else {
      if (open) {
        doc.hidden = true;
        empty.hidden = false;
        pdfBtn.hidden = true;
        renderWelcomeIndex(); // home after the drop: the index must reflect it
      }
      if (node?.children !== undefined) await showGroup(node);
      else renderTree();
    }
    if (node && !isVisibleNode(moved)) {
      alert(`Moved to "${node.raw}", which the drafts toggle is hiding.`);
    }
  } catch (err) {
    alert((err as Error).message);
    await loadTree();
    renderTree();
  }
}

// The one drag starter, shared by the desktop dragstart handler and the
// touch drag (HTML5 drag is dead on touch, so the touch state machine
// replays this profile by hand — same card, same ghost row, same marks).
function beginDrag(row: HTMLElement, x: number, y: number): void {
  dragPath = row.dataset.path ?? null;
  if (!dragPath) return;
  dropHandled = false;
  row.classList.add('dragging');
  // cleanup rides on the source row itself: renderTree() can detach that row
  // mid-drag (a hover opening a folder rebuilds the tree), and drag events on
  // a detached source no longer bubble to treeEl — but they still fire on it.
  row.addEventListener('dragend', endDrag, { once: true });
  // touch: the drag-phase listeners ride the row itself — a hover-open
  // renderTree() can detach it mid-drag, and touch events keep firing on
  // the touch-start element even detached, but then no longer bubble to
  // treeEl (the same detached-source reason the desktop dragend rides here;
  // unlike desktop dragover they do not retarget and never reach document).
  row.addEventListener('touchmove', touchDragMove, { passive: false });
  row.addEventListener('touchend', touchDragEnd);
  row.addEventListener('touchcancel', touchDragCancel);
  dragRow = row;
  const card = row.cloneNode(true) as HTMLElement;
  card.classList.remove('dragging');
  card.classList.add('drag-card');
  const box = row.getBoundingClientRect();
  grabX = x - box.left;
  grabY = y - box.top;
  card.style.width = `${Math.round(box.width)}px`;
  document.body.appendChild(card);
  dragCard = card;
  moveCard(x, y);
}

treeEl.addEventListener('dragstart', (e) => {
  const row = (e.target as HTMLElement).closest('.tree-row') as HTMLElement | null;
  if (!row) return;
  lpCancel(); // a stray dragstart on touch must not leave a stale armed hold
  armed = false;
  beginDrag(row, e.clientX, e.clientY);
  if (!dragPath) return;
  if (!e.dataTransfer) return;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/plain', dragPath);
  // The dragged copy is our own floating card, not the browser's drag image:
  // engines differ on how they rasterize setDragImage snapshots (Chrome takes
  // its picture lazily, at the next paint, catching styles applied later), and
  // two attempts at out-timing that failed on the author's machine. So the
  // native image is suppressed and a solid clone of the row follows the
  // cursor. pointer-events: none keeps the card from ever blocking a target.
  e.dataTransfer.setDragImage(TRANSPARENT_PX, 0, 0);
});

// Movement rides on dragover at document level for the same detached-source
// reason: the drag event fires on the (possibly detached) source row and
// stops bubbling to treeEl after the first folder open rebuilt the tree.
document.addEventListener('dragover', (e) => {
  if (dragCard) moveCard(e.clientX, e.clientY);
});

// 1x1 transparent gif — the smallest reliable way to show no native image.
const TRANSPARENT_PX = (() => {
  const img = new Image(1, 1);
  img.src =
    'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  return img;
})();

function moveCard(x: number, y: number): void {
  if (!dragCard) return;
  dragCard.style.transform = `translate(${Math.round(x - grabX)}px, ${Math.round(y - grabY)}px)`;
}

// One insertion line, one geometry: flush for a sibling slot, at child indent
// for "inside this folder" — shared by the create preview and the drag
// preview, which differ only in colour (green creates, blue moves). The two
// agree by construction: a child row's box IS the parent's box shifted one
// CHILD_INDENT in, so the flush slot above a first child and the in-folder
// slot below its parent land on the same pixels.
const CHILD_INDENT = 0.9 * parseFloat(getComputedStyle(document.documentElement).fontSize);

export function placeLineInFolder(row: HTMLElement): void {
  placeLine(row.offsetTop + row.offsetHeight, row.offsetLeft + CHILD_INDENT, row.offsetWidth - CHILD_INDENT);
}

// Folders the aim has left close together with their owner: the chain lives
// or dies with its outermost opened folder (dragOpened[0] — pushes only
// happen outer -> inner). While the aim roams ANYWHERE inside that folder
// (other books, parts, chapters, the folder row itself) the whole chain
// stays open; once it leaves, everything it opened closes at once.
function pruneDragOpened(anchor: string | null): void {
  if (!dragOpened.length) return;
  const top = dragOpened[0]!;
  const inside = anchor !== null && (anchor === top || anchor.startsWith(top + '/'));
  if (inside) return;
  closeDragOpened();
}

// A hover-opened folder is temporary: the aim moving off it closes it again,
// as does a drag that ends without a drop inside it. A folder the author had
// open before the drag is never touched here.
function closeDragOpened(render = true): void {
  if (!dragOpened.length) return;
  for (const p of dragOpened) expanded.delete(p);
  dragOpened = [];
  saveExpanded();
  if (render) renderTree();
}

function showDropLine(intent: DropIntent): void {
  // A closed folder is opened so it can be aimed inside — the same move the
  // "new" preview makes on mouseenter (showInsertLine, below). A folder an
  // earlier hover opened closes once the aim moves off it — per folder, so a
  // chain A -> B can be open at once and aiming back into A off B closes
  // only B. Rows are rebuilt by renderTree(), so the anchor has to be
  // looked up again afterwards.
  pruneDragOpened(intent.anchorPath);
  const node = byPath.get(intent.anchorPath);
  if (intent.kind === 'inside' && node?.children !== undefined && !expanded.has(node.path)) {
    expanded.add(node.path);
    dragOpened.push(node.path);
    dragPreview = true; // keep an empty folder on screen so it can be aimed at
    saveExpanded();
    renderTree();
  }
  const row = treeEl.querySelector(
    `.tree-row[data-path="${CSS.escape(intent.anchorPath)}"]`,
  ) as HTMLElement | null;
  if (!row) return;
  if (intent.kind === 'inside') {
    placeLineInFolder(row);
  } else if (intent.kind === 'below') {
    placeLine(row.offsetTop + row.offsetHeight, row.offsetLeft, row.offsetWidth);
  } else {
    // the slot above a row is that row's OWN level, so the line is flush with
    // the row's own box. For a folder that is a slot in its parent, which is
    // exactly where placeLineInFolder draws on the parent row — so aiming
    // above the first child and aiming below the parent are one line, and
    // nothing can look like it lands one level further out than it does.
    placeLine(row.offsetTop, row.offsetLeft, row.offsetWidth);
  }
  lineEl.classList.add('moving');
}

function clearDropMarks(): void {
  lineEl.hidden = true;
  lineEl.classList.remove('moving');
}

export function placeLine(top: number, left: number, width: number): void {
  lineEl.style.top = `${top}px`;
  lineEl.style.left = `${left}px`;
  lineEl.style.width = `${width}px`;
  lineEl.style.right = 'auto';
  lineEl.hidden = false;
}

treeEl.addEventListener('dragover', (e) => {
  if (!dragPath) return;
  const intent = dropIntent(e);
  clearDropMarks();
  if (!intent) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  showDropLine(intent);
});

treeEl.addEventListener('dragleave', (e) => {
  if ((e.target as HTMLElement).closest('.tree-row')) return;
  clearDropMarks();
  closeDragOpened(); // the aim left the tree: the opened folder was temporary
});

treeEl.addEventListener('drop', (e) => {
  if (!dragPath) return;
  const intent = dropIntent(e);
  clearDropMarks();
  if (!intent) return;
  e.preventDefault();
  const path = dragPath;
  // hover-opened folders close again; the drop destination is re-opened by
  // reorderTo's expanded.add
  closeDragOpened(false);
  dragPath = null;
  dragPreview = false;
  dropHandled = true;
  void reorderTo(path, intent);
});

// The rest of the panel viewport is a drop zone too: aiming anywhere that is
// NOT a row (the empty space under the list, the toolbar, the side-foot)
// lands the drag at TOP level, appended under everything — the quick way out
// of a folder. Rows keep their own band semantics; these handlers only catch
// aims off the rows. The line is drawn under the LAST visible row, flush at
// top-level indent, so "after everything" reads even when that last row is a
// nested child deep inside an expanded folder.
function showTopLevelLine(): void {
  const rows = treeEl.querySelectorAll<HTMLElement>('.tree-row');
  if (!rows.length) {
    lineEl.style.top = '0.35rem';
    lineEl.style.left = '0.5rem';
    lineEl.style.right = '0.5rem';
    lineEl.style.width = 'auto';
    lineEl.hidden = false;
    return;
  }
  const last = rows[rows.length - 1]!;
  const tops = treeEl.querySelectorAll<HTMLElement>(':scope > ul > li > .tree-row');
  const head = tops[0] ?? last;
  placeLine(last.offsetTop + last.offsetHeight, head.offsetLeft, head.offsetWidth);
  lineEl.classList.add('moving');
}

// runs after the treeEl handlers (bubbling): a row target has already been
// served there and returns early here; everything else is top level
sidebarEl.addEventListener('dragover', (e) => {
  if (!dragPath) return;
  if ((e.target as HTMLElement).closest('.tree-row')) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  // the aim is off any folder the hover opened
  closeDragOpened();
  clearDropMarks();
  showTopLevelLine();
});

sidebarEl.addEventListener('drop', (e) => {
  if (!dragPath) return;
  if ((e.target as HTMLElement).closest('.tree-row')) return;
  e.preventDefault();
  const path = dragPath;
  // all hover-opened folders close: the drop leaves them for the top level
  closeDragOpened(false);
  dragPath = null;
  dragPreview = false;
  dropHandled = true;
  clearDropMarks();
  void reorderTo(path, { parent: '', before: null, anchorPath: '', kind: 'below' });
});

// leaving the panel (not just the rows) hides the top-level line; the tree
// rows' own dragleave handles their marks
sidebarEl.addEventListener('dragleave', (e) => {
  if (!dragPath) return;
  if ((e.target as HTMLElement).closest('.tree-row')) return;
  const to = e.relatedTarget as HTMLElement | null;
  if (to && sidebarEl.contains(to)) return; // still inside the panel
  clearDropMarks();
});

function endDrag(): void {
  dragPath = null;
  clearDropMarks();
  dragCard?.remove();
  dragCard = null;
  if (dragRow) {
    dragRow.removeEventListener('touchmove', touchDragMove);
    dragRow.removeEventListener('touchend', touchDragEnd);
    dragRow.removeEventListener('touchcancel', touchDragCancel);
    dragRow = null;
  }
  for (const el of treeEl.querySelectorAll('.dragging')) el.classList.remove('dragging');
  // a drop already handed over to reorderTo, which reloads and re-renders the
  // tree; an endDrag here would only build it a second time
  if (dropHandled) {
    dropHandled = false;
    return;
  }
  // only a folder this drag opened is closed again; one the author had
  // collapsed on purpose stays collapsed (the "new" preview keeps the same
  // rule in previewExpandedPath)
  closeDragOpened();
  dragPreview = false;
  renderTree();
}

// ---------- touch tree: press-and-hold ARMS, movement drags, an unmoved
// lift opens the menu (owner profile, 2026-10-11) ----------
// HTML5 drag is dead on touch and iOS never fires contextmenu, so the
// desktop profile is replayed by hand: tap = open (the native click),
// swipe = native scroll (the arm timer is cancelled by movement), hold
// 500ms = ARMED with nothing visible. From armed, real movement starts a
// genuine drag (card, insert line, hover-opened folders, drop = reorder);
// lifting without having moved opens the context menu at the finger.
// Desktop keeps plain HTML5 drag + right-click — nothing here fires there.
let touchPressAt = 0; // a touchstart stamp: android's native long-press contextmenu stands down
let armed = false; // the hold completed; still invisible until the finger moves or lifts
let lpTimer: ReturnType<typeof setTimeout> | null = null;
let lpX = 0;
let lpY = 0;
let lpRow: HTMLElement | null = null;
const LP_ARM = 500; // hold time before armed
const LP_SCROLL_SLOP = 10; // px of movement that still reads as a scroll attempt
const LP_DRAG_SLOP = 8; // px past arming that turns the hold into a drag

function lpCancel(): void {
  if (lpTimer) {
    clearTimeout(lpTimer);
    lpTimer = null;
  }
}

treeEl.addEventListener(
  'touchstart',
  (e) => {
    if (e.touches.length !== 1) {
      // a second finger is a pinch — not a drag, not a press
      lpCancel();
      armed = false;
      lastLongPressAt = Date.now();
      if (dragCard) endDrag();
      return;
    }
    if (lpTimer || armed || dragCard) return;
    const t = e.touches[0]!;
    touchPressAt = Date.now();
    lpX = t.clientX;
    lpY = t.clientY;
    lpRow = (t.target as HTMLElement).closest('.tree-row') as HTMLElement | null;
    lpTimer = setTimeout(() => {
      lpTimer = null;
      armed = true;
      navigator.vibrate?.(10); // a tiny tick where the platform has it
    }, LP_ARM);
  },
  { passive: true },
);

treeEl.addEventListener(
  'touchmove',
  (e) => {
    if (dragCard) return; // the source row's own listeners own the drag
    const t = e.touches[0]!;
    const dx = t.clientX - lpX;
    const dy = t.clientY - lpY;
    if (!armed) {
      // pressing: past the slop it is a scroll — give the timer up. No
      // preventDefault before arming: native scrolling must stay live.
      if (Math.abs(dx) > LP_SCROLL_SLOP || Math.abs(dy) > LP_SCROLL_SLOP) lpCancel();
      return;
    }
    if (Math.abs(dx) < LP_DRAG_SLOP && Math.abs(dy) < LP_DRAG_SLOP) return;
    // armed on a row: the drag begins; armed on bare space: nothing to
    // drag — hand the gesture back to the scroller untouched
    if (!lpRow) {
      armed = false;
      return;
    }
    e.preventDefault(); // block the scroll before it can claim the gesture
    armed = false;
    beginDrag(lpRow, t.clientX, t.clientY);
    if (dragCard) touchAim(t.clientX, t.clientY);
  },
  { passive: false },
);

treeEl.addEventListener('touchend', (e) => {
  if (dragCard) return; // the source row's own listeners own the drop
  if (armed) {
    armed = false;
    // an unmoved lift IS the menu: the fresh stamp keeps the synthetic tap
    // this lift leaves behind from opening the row or closing the menu
    lastLongPressAt = Date.now();
    openCtxMenuAt(lpX, lpY, lpRow);
    return;
  }
  lpCancel(); // a plain tap or scroll — the native click does the opening
});
treeEl.addEventListener('touchcancel', () => {
  if (dragCard) return; // the source row's own listeners own the cleanup
  lpCancel();
  armed = false;
});

// The touch drag's own listeners — attached to the SOURCE row in beginDrag,
// removed in endDrag. They must live there, not on treeEl: a hover-opened
// folder rebuilds the tree mid-drag and detaches the row the touch started
// on, and touch events (unlike desktop dragover, which retargets to the
// element under the pointer) keep firing on that detached node without ever
// bubbling to treeEl or document again — the drag froze mid-air and the
// stale dragCard made the whole tree unresponsive until reload.
function touchDragMove(e: TouchEvent): void {
  if (!dragCard) return;
  // dragging: the gesture is ours — never a scroll
  e.preventDefault();
  const t = e.touches[0]!;
  moveCard(t.clientX, t.clientY);
  touchAim(t.clientX, t.clientY);
}

function touchDragEnd(e: TouchEvent): void {
  if (!dragCard) return;
  // the drag ends where the finger is: a row under it reorders (the
  // drop handlers' exact sequence — intent first, dragPath is still
  // needed for the band logic), anything else cancels plainly
  const t = e.changedTouches[0]!;
  const path = dragPath;
  const el = document.elementFromPoint(t.clientX, t.clientY);
  const row = (el?.closest('.tree-row') as HTMLElement | null) ?? null;
  const intent = row ? intentForRow(row, t.clientY) : null;
  clearDropMarks();
  closeDragOpened(false);
  dragPath = null;
  dragPreview = false;
  if (intent) {
    dropHandled = true; // endDrag must not re-render under reorderTo
    void reorderTo(path, intent);
    endDrag();
  } else {
    endDrag(); // no target: a plain cancel, like dropping outside the panel
  }
  lastLongPressAt = Date.now();
}

function touchDragCancel(): void {
  if (!dragCard) return;
  endDrag();
}

// the touch drag aims by hit-test: the card is pointer-events: none, so
// elementFromPoint sees the row (or the bare panel) under the fingertip —
// the desktop dragover pair's exact service, reused through intentForRow
function touchAim(x: number, y: number): void {
  const el = document.elementFromPoint(x, y);
  if (!el) return;
  const row = el.closest('.tree-row') as HTMLElement | null;
  clearDropMarks();
  if (row) {
    const intent = intentForRow(row, y);
    if (intent) showDropLine(intent);
    return;
  }
  if (!sidebarEl.contains(el)) {
    closeDragOpened(); // the aim left the panel: the opened folders close
    return;
  }
  closeDragOpened(); // bare panel space: top level, appended under everything
  showTopLevelLine();
}

treeEl.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  // Android fires a real contextmenu for a long-press too — but under the
  // touch profile the armed hold owns that gesture: the menu may open only
  // on an unmoved lift (or through the touch drag's own flow), never as a
  // native surprise mid-hold. A fresh touchstart stamp stands down; a
  // desktop right-click has no touchstart before it and opens as always.
  const now = Date.now();
  if (now - lastLongPressAt < 700) return;
  if (now - touchPressAt < 800) return;
  openCtxMenuAt(
    e.clientX,
    e.clientY,
    (e.target as HTMLElement).closest('.tree-row') as HTMLElement | null,
  );
});
