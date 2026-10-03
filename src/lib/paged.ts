// Paged view (milestone 5, phase 1): Word-style pagination inside the editor.
// Page breaks are block decorations over the live preview — the document is
// untouched, editing/sync/drafts behave exactly as pageless. Page geometry
// comes from presets exported here; index.astro feeds the numbers to CSS via
// custom properties on #editor-host, so this file is the single source of truth.
// Phase 2 will add running page numbers across the whole work; for now the
// count is within the chapter, starting at 1.
import { StateEffect, StateField, type Extension, type Range } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  WidgetType,
  type ViewUpdate,
} from '@codemirror/view';

// ---------- presets ----------
// page geometry in CSS px at 96dpi (1mm = 96/25.4px); measured against the
// real DOM, so these are also what the pagination math accumulates against
export type PagePresetId = 'a4' | 'a5' | 'bicameral';

export type PagePreset = {
  id: PagePresetId;
  label: string;
  note: string;
  w: number; // trim width
  h: number; // trim height
  mx: number; // side margin
  my: number; // head/foot margin
};

export const pagePresets: PagePreset[] = [
  { id: 'a4', label: 'A4', note: '210 × 297 mm', w: 794, h: 1123, mx: 94, my: 94 },
  { id: 'a5', label: 'A5', note: '148 × 210 mm', w: 559, h: 794, mx: 76, my: 76 },
  // "The Origin of Consciousness in the Breakdown of the Bicameral Mind",
  // Mariner Books paperback (ISBN 978-0618057078): 6.1″ × 9″ trim
  { id: 'bicameral', label: 'Bicameral', note: '6.1″ × 9″ · academic', w: 586, h: 864, mx: 88, my: 100 },
];

export const DEFAULT_PRESET_ID: PagePresetId = 'bicameral';

export function getPreset(id: PagePresetId): PagePreset {
  return pagePresets.find((p) => p.id === id) ?? pagePresets[0]!;
}

let active = getPreset(DEFAULT_PRESET_ID);

// ---------- effects + field ----------
export const repaginate = StateEffect.define<null>();
const setBreaks = StateEffect.define<DecorationSet>();

// block widgets only (page gaps); positions map through edits until the
// debounced recompute replaces the whole set
const breaksField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setBreaks)) return e.value;
    return tr.docChanged ? v.map(tr.changes) : v;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// ---------- page gap widget ----------
// the gap between two pages: foot margin of the ended page (with its number
// centered in it), then the head margin of the next one
class GapWidget extends WidgetType {
  constructor(readonly num: number) {
    super();
  }
  eq(o: GapWidget): boolean {
    return o.num === this.num;
  }
  toDOM(): HTMLElement {
    const d = document.createElement('div');
    d.className = 'cm-page-gap';
    const n = document.createElement('span');
    n.className = 'cm-page-num';
    n.textContent = String(this.num);
    d.append(n);
    return d;
  }
  ignoreEvent(): boolean {
    return true; // pure whitespace — clicks here do nothing
  }
}

// ---------- pagination ----------
function isPaged(view: EditorView): boolean {
  return view.dom.parentElement?.classList.contains('paged') ?? false;
}

function blockHeight(el: Element): number {
  const cs = getComputedStyle(el);
  return (
    el.getBoundingClientRect().height +
    parseFloat(cs.marginTop) +
    parseFloat(cs.marginBottom)
  );
}

// walk the rendered content (full render in paged mode, so the whole flow is
// measurable): accumulate block heights against the preset's content box; a
// new page starts where the flow would cross the boundary. Hidden ranges
// (e.g. a table widget swallowing its lines) have no .cm-line children —
// positions come from posAtDOM, so the mapping stays exact.
function computeBreaks(view: EditorView, preset: PagePreset): DecorationSet {
  const pageH = preset.h - 2 * preset.my;
  const doc = view.state.doc;
  const kids = view.contentDOM.children;
  const ranges: Range<Decoration>[] = [];
  let used = 0; // height used on the current page
  let pending = 0; // block widgets (tables, hrs) waiting to be charged to the next line
  let lastLine = 0;
  let page = 1; // number of the page currently being filled

  for (const child of Array.from(kids)) {
    if (child.classList.contains('cm-page-gap')) continue; // virtual space
    const h = blockHeight(child);
    if (!child.classList.contains('cm-line')) {
      pending += h; // charged together with the line that follows it
      continue;
    }
    let line: number;
    try {
      line = doc.lineAt(view.posAtDOM(child, 0)).number;
    } catch {
      continue; // DOM node not attached/mapped — skip it
    }
    if (line <= lastLine) continue; // stale DOM entry
    lastLine = line;
    const total = pending + h;
    pending = 0;
    if (used > 0 && used + total > pageH) {
      ranges.push(
        Decoration.widget({
          widget: new GapWidget(page),
          block: true,
          side: -1,
        }).range(doc.line(line).from),
      );
      page++;
      used = total;
    } else {
      used += total;
    }
  }

  // the last page ends at the doc end: a trailing gap carries its number
  ranges.push(
    Decoration.widget({
      widget: new GapWidget(page),
      block: true,
      side: 1,
    }).range(doc.length),
  );
  return Decoration.set(ranges, true);
}

// ---------- plugin ----------
class PagedPlugin {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private ro: ResizeObserver;

  constructor(readonly view: EditorView) {
    this.ro = new ResizeObserver(() => this.schedule());
    this.ro.observe(view.contentDOM);
  }

  update(u: ViewUpdate): void {
    const force = u.transactions.some((tr) =>
      tr.effects.some((e) => e.is(repaginate)),
    );
    if (u.docChanged || u.selectionSet || u.focusChanged || force) {
      this.schedule(force ? 0 : 300);
    }
  }

  schedule(delay = 300): void {
    if (!isPaged(this.view)) return;
    if (this.timer) clearTimeout(this.timer);
    if (delay === 0) {
      this.timer = null;
      // forced (toggle/preset change): measure right after the next paint —
      // never dispatch inside the update pass
      requestAnimationFrame(() => this.measure());
    } else {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.measure();
      }, delay);
    }
  }

  private measure(): void {
    const view = this.view;
    if (!isPaged(view)) return;
    view.dispatch({ effects: setBreaks.of(computeBreaks(view, active)) });
  }

  destroy(): void {
    this.ro.disconnect();
    if (this.timer) clearTimeout(this.timer);
  }
}

export function createPagedExt(): Extension {
  return [breaksField, ViewPlugin.fromClass(PagedPlugin)];
}

// turn paged mode on (with a preset) or off; geometry goes to CSS via custom
// properties on #editor-host, then a forced repaginate measures fresh layout
export function setPaged(view: EditorView | null, on: boolean, id: PagePresetId): void {
  active = getPreset(id);
  if (!view) return;
  const host = view.dom.parentElement;
  if (!host) return;
  host.classList.toggle('paged', on);
  host.style.setProperty('--page-w', `${active.w}px`);
  host.style.setProperty('--page-h', `${active.h}px`);
  host.style.setProperty('--page-mx', `${active.mx}px`);
  host.style.setProperty('--page-my', `${active.my}px`);
  if (on) {
    view.dispatch({ effects: repaginate.of(null) });
  } else {
    view.dispatch({ effects: setBreaks.of(Decoration.none) });
  }
}
