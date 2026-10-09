// Obsidian-style live preview for the markdown editor.
// The document is always the raw markdown source; decorations hide the syntax and
// render compiled output everywhere except on the cursor's line while focused.
// Hidden ranges are NOT atomic (only the checkbox is): the cursor traverses raw
// offsets like in a plain markdown file, and every line it enters reveals raw.
// ↑/↓ are a plain source-line cursor over the raw markdown — one file line per
// keystroke, char indent carried between lines; no pixel motion anywhere.
// Widget clicks map back to source positions (a table click lands in the clicked
// cell). Styles for these JS-created DOM elements live in global.css (Astro
// scoping wouldn't match dynamically created elements).
import { marked } from 'marked';
import {
  EditorState,
  Prec,
  StateEffect,
  StateField,
  RangeSet,
  type Extension,
} from '@codemirror/state';
import {
  EditorView,
  Decoration,
  keymap,
  type DecorationSet,
  WidgetType,
} from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { markdown } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { renderToString as renderKatex } from 'katex';
import 'katex/dist/katex.min.css';

// ---------- focus tracking ----------
export const focusToggle = StateEffect.define<null>();

export const focusField = StateField.define<boolean>({
  create: () => false,
  update(v, tr) {
    for (const e of tr.effects) if (e.is(focusToggle)) return !v;
    return v;
  },
});

// ---------- widgets ----------
type DecoRange = { from: number; to: number; value: Decoration };

class BulletWidget extends WidgetType {
  toDOM(): HTMLElement {
    const s = document.createElement('span');
    s.className = 'cm-li-bullet';
    s.textContent = '•';
    return s;
  }
  eq(): boolean {
    return true;
  }
  ignoreEvent(): boolean {
    return false;
  }
}

class HrWidget extends WidgetType {
  constructor(readonly pos: number) {
    super();
  }
  eq(o: HrWidget): boolean {
    return o.pos === this.pos;
  }
  toDOM(view: EditorView): HTMLElement {
    const d = document.createElement('div');
    d.className = 'cm-hr-widget';
    d.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      view.dispatch({
        selection: { anchor: this.pos },
        effects: EditorView.scrollIntoView(this.pos, { y: 'nearest' }),
      });
      view.focus();
    });
    return d;
  }
  ignoreEvent(): boolean {
    return true; // the click reveals the raw rule, cursor at its line start
  }
}

class ImgWidget extends WidgetType {
  constructor(
    readonly alt: string,
    readonly src: string,
    readonly pos: number,
  ) {
    super();
  }
  eq(o: ImgWidget): boolean {
    return o.src === this.src && o.alt === this.alt && o.pos === this.pos;
  }
  toDOM(view: EditorView): HTMLElement {
    const img = document.createElement('img');
    img.className = 'cm-img-widget';
    img.src = this.src;
    img.alt = this.alt;
    img.title = this.alt || this.src;
    img.loading = 'lazy';
    img.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      view.dispatch({
        selection: { anchor: this.pos },
        effects: EditorView.scrollIntoView(this.pos, { y: 'nearest' }),
      });
      view.focus();
    });
    return img;
  }
  ignoreEvent(): boolean {
    return true; // the click reveals the raw image syntax at its start
  }
}

class CheckboxWidget extends WidgetType {
  constructor(
    readonly checked: boolean,
    readonly pos: number, // doc position of the char inside [ ]
  ) {
    super();
  }
  eq(o: CheckboxWidget): boolean {
    return o.checked === this.checked && o.pos === this.pos;
  }
  toDOM(view: EditorView): HTMLElement {
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = this.checked;
    box.addEventListener('click', (e) => {
      e.preventDefault();
      view.dispatch({
        changes: { from: this.pos, to: this.pos + 1, insert: box.checked ? ' ' : 'x' },
      });
    });
    return box;
  }
  ignoreEvent(): boolean {
    return true; // the checkbox handles its own clicks
  }
}

// source offsets of each cell's text start in a raw table line (split on
// unescaped pipes; a leading/trailing pipe opens/closes the row, not a cell)
function cellOffsets(text: string, base: number): number[] {
  const pieces: { s: number; e: number }[] = [];
  let s = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '|' && text[i - 1] !== '\\') {
      pieces.push({ s, e: i });
      s = i + 1;
    }
  }
  pieces.push({ s, e: text.length });
  const trimmed = text.trim();
  const lo = trimmed.startsWith('|') ? 1 : 0;
  const hi = pieces.length - (trimmed.endsWith('|') ? 1 : 0);
  const out: number[] = [];
  for (let k = lo; k < hi; k++) {
    let t = pieces[k].s;
    while (t < pieces[k].e && /\s/.test(text[t])) t++;
    out.push(base + t);
  }
  return out;
}

class TableWidget extends WidgetType {
  constructor(
    readonly html: string,
    readonly pos: number,
    readonly rows: number[][], // cell offsets in rendered order — header row first
  ) {
    super();
  }
  eq(o: TableWidget): boolean {
    return o.html === this.html && o.pos === this.pos;
  }
  ignoreEvent(): boolean {
    return true; // clicks map to the clicked cell's source position
  }
  toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'cm-table';
    wrap.innerHTML = this.html;
    wrap.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      let pos = this.pos;
      const cell = (e.target as HTMLElement).closest('td,th') as HTMLTableCellElement | null;
      if (cell) {
        const row = cell.parentElement as HTMLTableRowElement;
        const rowIdx = Array.prototype.indexOf.call(row.parentElement?.children ?? [], row);
        const map = this.rows[rowIdx];
        if (map) pos = map[Math.min(cell.cellIndex, map.length - 1)];
      }
      view.dispatch({
        selection: { anchor: pos },
        effects: EditorView.scrollIntoView(pos, { y: 'nearest' }),
      });
      view.focus();
    });
    return wrap;
  }
}

class MathWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly html: string, // pre-rendered by renderMath — never a ParseError here
    readonly display: boolean,
    readonly pos: number,
  ) {
    super();
  }
  eq(o: MathWidget): boolean {
    return o.src === this.src && o.display === this.display && o.pos === this.pos;
  }
  ignoreEvent(): boolean {
    return true; // the click reveals the raw math at its source start
  }
  toDOM(view: EditorView): HTMLElement {
    const el = document.createElement(this.display ? 'div' : 'span');
    el.className = this.display ? 'cm-math-block' : 'cm-math-inline';
    el.innerHTML = this.html;
    el.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      view.dispatch({
        selection: { anchor: this.pos },
        effects: EditorView.scrollIntoView(this.pos, { y: 'nearest' }),
      });
      view.focus();
    });
    return el;
  }
}

// ---------- decoration build ----------
export type OpenLink = (href: string) => boolean;

// table HTML memo: raw block text → compiled html; cleared whenever the doc changes
let tableMemo = new Map<string, string>();

// katex HTML memo: math source → compiled html (null = render error); same lifecycle
let mathMemo = new Map<string, string | null>();

export function invalidatePreviewMemo(): void {
  tableMemo = new Map();
  mathMemo = new Map();
}

function renderMath(src: string, display: boolean): string | null {
  const key = (display ? 'd:' : 'i:') + src;
  let html = mathMemo.get(key);
  if (html === undefined) {
    try {
      html = renderKatex(src, { displayMode: display, throwOnError: true });
    } catch {
      html = null; // bad LaTeX — callers fall back to the raw source
    }
    mathMemo.set(key, html);
  }
  return html;
}

// inline math: single dollars (not $$), not after an escape or another dollar;
// requires a non-space after the opening and before the closing dollar so
// currency text ("costs $5 and $10") stays prose
const INLINE_MATH = /(?<![$\\])\$(?!\s)((?:\\.|[^$\n])+?)(?<!\s)\$(?!\$)/g;

function buildDeco(state: EditorState): {
  deco: DecorationSet;
  atom: DecorationSet;
} {
  const doc = state.doc;
  const sel = state.selection.main;
  const focused = state.field(focusField);
  const deco: DecoRange[] = [];
  const atom: DecoRange[] = [];
  const active = (from: number, to: number): boolean =>
    focused && from <= sel.to && to >= sel.from;
  const hide = (from: number, to: number): void => {
    // deliberately NOT atomic: arrows traverse the raw source and the cursor's
    // line reveals raw, so a caret inside a hidden range is always visible
    deco.push({ from, to, value: Decoration.replace({}) });
  };
  const hideWidget = (from: number, to: number, d: Decoration, atomic = false): void => {
    deco.push({ from, to, value: d });
    if (atomic) atom.push({ from, to, value: d });
  };

  // inline markdown: images, links, code, bold, italic, strike
  function scanInline(text: string, base: number): void {
    const taken: [number, number][] = [];
    const free = (a: number, b: number): boolean => !taken.some(([x, y]) => a < y && b > x);
    const take = (a: number, b: number): void => {
      taken.push([a, b]);
    };
    const mark = (from: number, to: number, cls: string, attrs?: Record<string, string>): void => {
      deco.push({
        from,
        to,
        value: Decoration.mark({ class: cls, attributes: attrs }),
      });
    };

    for (const m of text.matchAll(/!\[([^\]]*)\]\(([^)\s]+)\)/g)) {
      if (!free(m.index, m.index + m[0].length)) continue;
      take(m.index, m.index + m[0].length);
      hideWidget(
        base + m.index,
        base + m.index + m[0].length,
        Decoration.replace({ widget: new ImgWidget(m[1], m[2], base + m.index) }),
      );
    }
    for (const m of text.matchAll(/\[([^\]]+)\]\(([^)\s]+)\)/g)) {
      if (!free(m.index, m.index + m[0].length)) continue;
      const txtFrom = m.index + 1;
      const txtTo = txtFrom + m[1].length;
      if (!free(txtFrom, txtTo)) continue;
      take(m.index, m.index + m[0].length);
      hide(base + m.index, base + txtFrom); // '['
      mark(base + txtFrom, base + txtTo, 'cm-link', { title: m[2], 'data-href': m[2] });
      hide(base + txtTo, base + m.index + m[0].length); // '](url)'
    }
    for (const m of text.matchAll(/`([^`\n]+)`/g)) {
      const a = m.index;
      const b = a + m[0].length;
      if (!free(a, b)) continue;
      take(a, b);
      hide(base + a, base + a + 1);
      hide(base + b - 1, base + b);
      mark(base + a + 1, base + b - 1, 'cm-code');
    }
    for (const m of text.matchAll(INLINE_MATH)) {
      const a = m.index;
      const b = a + m[0].length;
      if (!free(a, b)) continue; // inside code spans/links/images: leave alone
      take(a, b);
      const html = renderMath(m[1], false);
      if (html === null) {
        mark(base + a, base + b, 'cm-math-err'); // bad LaTeX: raw source, error styling
        continue;
      }
      hideWidget(
        base + a,
        base + b,
        Decoration.replace({ widget: new MathWidget(m[1], html, false, base + a) }),
      );
    }
    for (const m of text.matchAll(/\*\*([^*\n]+)\*\*/g)) {
      const a = m.index;
      const b = a + m[0].length;
      if (!free(a, b)) continue;
      take(a, b);
      hide(base + a, base + a + 2);
      hide(base + b - 2, base + b);
      mark(base + a + 2, base + b - 2, 'cm-strong');
    }
    for (const m of text.matchAll(/(?<=[\s(>]|^)\*(?=\S)([^*\n]+?)(?<=\S)\*(?!\*)/g)) {
      const a = m.index;
      const b = a + m[0].length;
      if (!free(a, b)) continue;
      take(a, b);
      hide(base + a, base + a + 1);
      hide(base + b - 1, base + b);
      mark(base + a + 1, base + b - 1, 'cm-em');
    }
    for (const m of text.matchAll(/(?<=[\s(>]|^)_(?=\S)([^_\n]+?)(?<=\S)_(?![\w])/g)) {
      const a = m.index;
      const b = a + m[0].length;
      if (!free(a, b)) continue;
      take(a, b);
      hide(base + a, base + a + 1);
      hide(base + b - 1, base + b);
      mark(base + a + 1, base + b - 1, 'cm-em');
    }
    for (const m of text.matchAll(/~~([^~\n]+)~~/g)) {
      const a = m.index;
      const b = a + m[0].length;
      if (!free(a, b)) continue;
      take(a, b);
      hide(base + a, base + a + 2);
      hide(base + b - 2, base + b);
      mark(base + a + 2, base + b - 2, 'cm-strike');
    }
  }

  // line snapshot with fenced-code state
  const lines: { text: string; from: number; to: number; fenced: boolean }[] = [];
  let open = false;
  for (let i = 1; i <= doc.lines; i++) {
    const l = doc.line(i);
    const isFence = /^\s*(```|~~~)/.test(l.text);
    if (isFence) open = !open;
    lines.push({ text: l.text, from: l.from, to: l.to, fenced: isFence || open });
  }

  // table blocks → rendered table widget (raw when the cursor is inside)
  const skip = new Set<number>();
  let ti = 0;
  while (ti < lines.length) {
    const a = lines[ti];
    if (a.fenced || !a.text.trim() || !a.text.includes('|')) {
      ti++;
      continue;
    }
    const sep = lines[ti + 1];
    if (sep && !sep.fenced && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(sep.text)) {
      let j = ti + 2;
      while (j < lines.length && lines[j].text.trim() && lines[j].text.includes('|')) j++;
      const blockFrom = a.from;
      const blockTo = lines[j - 1].to;
      if (!active(blockFrom, blockTo)) {
        const raw = lines
          .slice(ti, j)
          .map((x) => x.text)
          .join('\n');
        let html = tableMemo.get(raw);
        if (html === undefined) {
          html = marked.parse(raw) as string;
          tableMemo.set(raw, html);
        }
        // cell offsets in rendered order: header row first, then body rows
        // (the separator line at ti+1 renders nothing)
        const rows = [cellOffsets(a.text, a.from)];
        for (let k = ti + 2; k < j; k++) rows.push(cellOffsets(lines[k].text, lines[k].from));
        hideWidget(
          blockFrom,
          blockTo,
          Decoration.replace({
            widget: new TableWidget(html, blockFrom, rows),
            block: true,
          }),
        );
        for (let k = ti; k < j; k++) skip.add(k);
      }
      ti = j;
      continue;
    }
    ti++;
  }

  // display math $$...$$ blocks — a paragraph on its own, may span lines;
  // skipped inside fenced code and on lines already claimed by a table
  let di = 0;
  while (di < lines.length) {
    const l = lines[di];
    if (l.fenced || skip.has(di)) {
      di++;
      continue;
    }
    const openM = /^(\s*)\$\$/.exec(l.text);
    if (!openM) {
      di++;
      continue;
    }
    let closeLine = -1;
    let closeAt = -1; // doc position of the closing '$$'
    const same = l.text.indexOf('$$', openM[1].length + 2);
    if (same !== -1 && /^\s*$/.test(l.text.slice(same + 2))) {
      closeLine = di;
      closeAt = l.from + same;
    } else {
      for (let j = di + 1; j < lines.length; j++) {
        if (lines[j].fenced) break;
        const k = lines[j].text.indexOf('$$');
        if (k === -1) continue;
        if (!/^\s*$/.test(lines[j].text.slice(k + 2))) break; // stray text: not a block
        closeLine = j;
        closeAt = lines[j].from + k;
        break;
      }
    }
    if (closeLine !== -1) {
      const blockFrom = l.from;
      const blockTo = lines[closeLine].to;
      if (active(blockFrom, blockTo)) {
        deco.push({
          from: blockFrom,
          to: blockTo,
          value: Decoration.mark({ class: 'cm-math' }),
        });
      } else {
        const src = doc.sliceString(l.from + openM[1].length + 2, closeAt);
        const html = renderMath(src, true);
        if (html === null) {
          deco.push({
            from: blockFrom,
            to: blockTo,
            value: Decoration.mark({ class: 'cm-math-err' }),
          });
        } else {
          hideWidget(
            blockFrom,
            blockTo,
            Decoration.replace({
              widget: new MathWidget(src, html, true, blockFrom),
              block: true,
            }),
          );
        }
      }
      for (let k = di; k <= closeLine; k++) skip.add(k);
      di = closeLine + 1;
      continue;
    }
    di++;
  }

  // per-line block syntax
  lines.forEach((l, idx) => {
    if (skip.has(idx)) return;
    if (l.fenced) {
      deco.push({ from: l.from, to: l.from, value: Decoration.line({ class: 'cm-fenced' }) });
      if (!active(l.from, l.to)) {
        const fm = /^(\s*)(`{3,}|~{3,})/.exec(l.text);
        if (fm) hide(l.from + fm[1].length, l.to); // hide ``` markers + info string
      }
      return;
    }
    if (active(l.from, l.to)) {
      // cursor's line: raw markdown — still tag inline math so it reads as math
      for (const m of l.text.matchAll(INLINE_MATH)) {
        deco.push({
          from: l.from + m.index,
          to: l.from + m.index + m[0].length,
          value: Decoration.mark({ class: 'cm-math' }),
        });
      }
      return;
    }

    const text = l.text;
    let m: RegExpExecArray | null;

    m = /^(\s*)(#{1,6})(\s+)/.exec(text);
    if (m) {
      deco.push({
        from: l.from,
        to: l.from,
        value: Decoration.line({ class: `cm-h${Math.min(m[2].length, 4)}` }),
      });
      const s = m[1].length;
      const e = s + m[2].length + m[3].length;
      hide(l.from + s, l.from + e);
      scanInline(text.slice(e), l.from + e);
      return;
    }

    m = /^(\s*)(---+|\*\*\*+|___+)\s*$/.exec(text);
    if (m && (idx === 0 || !lines[idx - 1].text.trim())) {
      // a `---` right after text is a setext heading — leave it raw
      hideWidget(l.from, l.to, Decoration.replace({ widget: new HrWidget(l.from) }));
      return;
    }

    m = /^(\s*)((?:>\s*)+)/.exec(text);
    if (m && m[2].length) {
      deco.push({ from: l.from, to: l.from, value: Decoration.line({ class: 'cm-quote' }) });
      const s = m[1].length;
      const e = s + m[2].length;
      hide(l.from + s, l.from + e);
      scanInline(text.slice(e), l.from + e);
      return;
    }

    m = /^(\s*)([-*+])(\s+)(\[[ xX]\])?/.exec(text);
    if (m) {
      deco.push({ from: l.from, to: l.from, value: Decoration.line({ class: 'cm-li' }) });
      const s = m[1].length;
      hideWidget(l.from + s, l.from + s + 1, Decoration.replace({ widget: new BulletWidget() }));
      let after = s + 1 + m[3].length;
      if (m[4]) {
        hideWidget(
          l.from + after,
          l.from + after + 3,
          Decoration.replace({ widget: new CheckboxWidget(m[4][1] !== ' ', l.from + after + 1) }),
          true, // the only atomic range: the box is one interactive object
        );
        after += 3;
      }
      scanInline(text.slice(after), l.from + after);
      return;
    }

    scanInline(text, l.from);
  });

  return {
    deco: RangeSet.of(deco, true),
    atom: RangeSet.of(atom, true),
  };
}

export function createPreview(onOpenLink: OpenLink): Extension[] {
  const previewField = StateField.define<{ deco: DecorationSet; atom: DecorationSet }>({
    create: (s) => buildDeco(s),
    update(_v, tr) {
      if (tr.docChanged) invalidatePreviewMemo();
      return tr.docChanged || tr.selection || tr.effects.some((e) => e.is(focusToggle))
        ? buildDeco(tr.state)
        : _v;
    },
  });

  // ↑/↓ are a plain source-line cursor over the raw markdown: one file line
  // per keystroke, char indent carried between lines (vgoal), clamped to the
  // target line's end. No pixel motion, no block-widget special cases — the
  // reveal on entry just happens around the caret (scrollIntoView keeps it
  // visible). Multi-cursor and doc boundaries fall through to native (no-ops).
  const vgoal = new WeakMap<EditorView, number>();
  function arrowStep(view: EditorView, dir: 1 | -1, extend: boolean): boolean {
    const { state } = view;
    const sel = state.selection;
    if (sel.ranges.length !== 1) return false;
    const main = sel.main;
    if (!extend && !main.empty) return false;
    const line = state.doc.lineAt(main.head);
    const next = line.number + dir;
    if (next < 1 || next > state.doc.lines) return false;
    const target = state.doc.line(next);
    const col = vgoal.get(view) ?? main.head - line.from;
    const head = Math.min(target.from + col, target.to);
    view.dispatch({
      selection: extend ? { anchor: main.anchor, head } : { anchor: head, head },
      scrollIntoView: true,
    });
    vgoal.set(view, col);
    return true;
  }

  return [
    Prec.highest(
      keymap.of([
        { key: 'ArrowDown', run: (v) => arrowStep(v, 1, false) },
        { key: 'ArrowUp', run: (v) => arrowStep(v, -1, false) },
        { key: 'Shift-ArrowDown', run: (v) => arrowStep(v, 1, true) },
        { key: 'Shift-ArrowUp', run: (v) => arrowStep(v, -1, true) },
      ]),
    ),
    // indent memory: any selection change that isn't arrowStep's own dispatch
    // (click, horizontal move, typing) clears it — arrowStep re-sets it right
    // after its dispatch, so its indent survives
    EditorView.updateListener.of((u) => {
      if (u.selectionSet) vgoal.delete(view);
    }),
    markdown({ codeLanguages: languages }),
    focusField,
    previewField,
    EditorView.decorations.compute([previewField], (s) => s.field(previewField).deco),
    EditorView.atomicRanges.compute([previewField], (s) => () => s.field(previewField).atom),
    // ctrl/cmd+click on a link opens it (external → new tab, relative .md → in-app)
    EditorView.domEventHandlers({
      mousedown(e, view) {
        if (!(e.metaKey || e.ctrlKey)) return false;
        const el = (e.target as HTMLElement).closest?.('.cm-link') as HTMLElement | null;
        const href = el?.getAttribute('data-href');
        if (!href) return false;
        e.preventDefault();
        onOpenLink(href);
        return true;
      },
    }),
    syntaxHighlighting(
      HighlightStyle.define([
        { tag: [t.keyword, t.operator, t.moduleKeyword], color: 'var(--accent)' },
        { tag: [t.comment, t.meta], color: 'var(--muted)', fontStyle: 'italic' },
        { tag: [t.string, t.special(t.string)], color: 'var(--fg)' },
        { tag: [t.number, t.bool, t.atom], color: 'var(--accent)' },
        { tag: t.definition(t.variableName), color: 'var(--fg)' },
      ]),
    ),
  ];
}
