// The adjustable measure: two handles on the header underline change the
// line width (A, centred) and the field width (B), stored in localStorage.

import { EditorSelection } from '@codemirror/state';
import { doc, docHead, editorHost, mainEl } from './dom.ts';
import { getEditor } from './editor.ts';

// The LINE (.doc-head's border) is always centred: the left handle (A, ▶ at
// the line's start) changes only its width — both margins move equally, so
// the line never leaves the centre. The LINE WRAPS the content: one centred
// .doc-col column, the topline spans it and the text view (.md-body /
// #editor-host / .toc) rides its start by structure; the right handle (B,
// ◀ at the field's right edge) is the ONLY control for the FIELD's width.
// Constraints, floor
// first: the field never goes below 36ch (ABSOLUTE — no drag and no narrow
// line may squash the text), the line can never be narrower than the field
// (A stops where the text stops), and B never leaves the line. State is
// memorized per browser (localStorage) — the same measure in every md file,
// across reloads.
const MIN_FIELD = 36; // ch — the field can never collapse
const MEASURE_KEY = 'iauthor.measure';
let linePx = 0; // px; 0 = default (full content width) — USER INTENT, never
let fieldPx = 0; // px; 0 = default (72ch)   — written back by the clamps
let lineEff = 0; // px; clamped to the current window — what's on screen
let fieldEff = 0; // px; the drag/nudge starting point (the handle sits here)
try {
  const saved = JSON.parse(localStorage.getItem(MEASURE_KEY) ?? '{}');
  if (typeof saved.linePx === 'number' && saved.linePx > 0) linePx = saved.linePx;
  if (typeof saved.fieldPx === 'number' && saved.fieldPx > 0) fieldPx = saved.fieldPx;
} catch {
  /* corrupted store = defaults */
}

const chProbe = document.createElement('span');
chProbe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre';
docHead.append(chProbe);
const ch = (n: number): number => {
  chProbe.style.width = n + 'ch';
  return chProbe.offsetWidth;
};

export function applyMeasure(): void {
  if (doc.hidden) return; // zero-width layout: nothing to clamp against
  const C = doc.clientWidth;
  const minFw = ch(MIN_FIELD);
  // the effective line: the user's drag, or the default FULL WIDTH. B is
  // jailed within it — the topline's width is A's alone, so B can never
  // widen the line or ride off it
  const effLine = linePx ? Math.min(linePx, C) : C;
  // the field: 36ch floor, ABSOLUTE — no drag and no narrow line may squash
  // the text below it; above the floor B stays jailed within the line
  const fw = fieldPx
    ? Math.min(Math.max(fieldPx, minFw), Math.max(effLine, minFw))
    : 0;
  const fwEff = fw || Math.min(ch(72), C);
  // the line: the text rides its start, so it can never shrink below the
  // field — A stops where the text stops; 0 = default (full width)
  const lw = linePx ? Math.min(Math.max(linePx, fwEff), C) : 0;
  // the clamps are WINDOW-LOCAL: they shape what's on screen (lineEff/
  // fieldEff) but never write back into the intent (linePx/fieldPx) and
  // never reach localStorage — shrinking to mobile width (or narrowing a
  // desktop window below the drag) must not record a tiny measure; resizing
  // back re-clamps from the intact intent and the geometry reappears
  lineEff = lw;
  fieldEff = fw;
  if (lw) mainEl.style.setProperty('--line-w', lw + 'px');
  else mainEl.style.removeProperty('--line-w');
  if (fw) mainEl.style.setProperty('--field-w', fw + 'px');
  else mainEl.style.removeProperty('--field-w');
  try {
    localStorage.setItem(MEASURE_KEY, JSON.stringify({ linePx, fieldPx }));
  } catch {
    /* storage full/blocked: the session still works */
  }
}

const measureA = document.createElement('button');
measureA.className = 'measure-h measure-a';
measureA.type = 'button';
measureA.title = 'drag — page width (stays centred)';
measureA.setAttribute('aria-label', 'drag to change the page width');
const measureB = document.createElement('button');
measureB.className = 'measure-h measure-b';
measureB.type = 'button';
measureB.title = 'drag — text width';
measureB.setAttribute('aria-label', 'drag to change the text width');
docHead.append(measureA, measureB);

// Pointer Events with capture — HTML5 drag never fires on touch, and the
// drag needs px deltas per move, not drop targets.
function dragWidth(
  el: HTMLElement,
  start: () => number,
  move: (from: number, dx: number) => void,
): void {
  let sx = 0;
  let s0 = 0;
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    sx = e.clientX;
    s0 = start();
    el.setPointerCapture(e.pointerId);
    const onMove = (ev: PointerEvent) => move(s0, ev.clientX - sx);
    const onUp = () => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
    };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
  });
}

dragWidth(measureA, () => lineEff || doc.clientWidth, (from, dx) => {
  // the handle rides the line's end 1:1 while the line grows 2:1 (centred);
  // starting from lineEff (the clamped, visible width) so the first move
  // doesn't jump from the handle's position to the unclamped intent
  linePx = from - 2 * dx;
  applyMeasure();
});
dragWidth(measureB, () => fieldEff || ch(72), (from, dx) => {
  fieldPx = from + dx; // left edge pinned: only the width follows
  applyMeasure();
});

function nudge(el: HTMLElement, step: (sign: number) => void): void {
  el.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    step(e.key === 'ArrowRight' ? 1 : -1);
  });
}
nudge(measureA, (sign) => {
  linePx = (lineEff || doc.clientWidth) - 2 * ch(1) * sign; // right = narrower
  applyMeasure();
});
nudge(measureB, (sign) => {
  fieldPx = (fieldEff || ch(72)) + ch(1) * sign; // right = wider
  applyMeasure();
});

window.addEventListener('resize', applyMeasure);
applyMeasure(); // no-op while the welcome screen hides #doc; real application
// happens at the first openFile/showGroup, when the clamps have real width

// ---------- tap the page under the text -> caret to the last newline ----------
// On a phone the end of a long chapter is unreachable by tap (no pixels of
// empty editor to hit), so a tap on the page BELOW the field — the margins,
// the padding under the text — drops the caret at the end of the document
// and focuses the editor. Beside the text (same vertical band) does nothing;
// clicks inside the editor, the header, buttons and menus are not ours.
mainEl.addEventListener('click', (e) => {
  const editor = getEditor();
  if (!editor || editorHost.hidden) return;
  const t = e.target as HTMLElement;
  if (t.closest('#editor-host, .doc-head, button, a, input, #pdf-menu, #ctx-menu')) return;
  if (e.clientY < editorHost.getBoundingClientRect().bottom) return;
  e.preventDefault();
  editor.dispatch({
    selection: EditorSelection.cursor(editor.state.doc.length),
    scrollIntoView: true,
  });
  editor.focus();
});
