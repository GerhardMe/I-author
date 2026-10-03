// Obsidian-style live preview for the markdown editor.
// The document is always the raw markdown source; decorations hide the syntax and
// render compiled output everywhere except on the cursor's line while focused.
// Styles for these JS-created DOM elements live in global.css (Astro scoping
// wouldn't match dynamically created elements).
import { marked } from 'marked';
import {
  EditorState,
  StateEffect,
  StateField,
  RangeSet,
  type Extension,
} from '@codemirror/state';
import {
  EditorView,
  Decoration,
  type DecorationSet,
  WidgetType,
  placeholder,
} from '@codemirror/view';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { markdown } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';

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
  toDOM(): HTMLElement {
    const d = document.createElement('div');
    d.className = 'cm-hr-widget';
    return d;
  }
  eq(): boolean {
    return true;
  }
  ignoreEvent(): boolean {
    return false;
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
  toDOM(): HTMLElement {
    const img = document.createElement('img');
    img.className = 'cm-img-widget';
    img.src = this.src;
    img.alt = this.alt;
    img.title = this.alt || this.src;
    img.loading = 'lazy';
    return img;
  }
  ignoreEvent(): boolean {
    return false; // native click places the cursor at the range boundary
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

class TableWidget extends WidgetType {
  constructor(
    readonly html: string,
    readonly pos: number,
  ) {
    super();
  }
  eq(o: TableWidget): boolean {
    return o.html === this.html && o.pos === this.pos;
  }
  ignoreEvent(): boolean {
    return false; // clicking places the cursor and reveals the raw table
  }
  toDOM(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'cm-table';
    wrap.innerHTML = this.html;
    return wrap;
  }
}

// ---------- decoration build ----------
export type OpenLink = (href: string) => boolean;

// table HTML memo: raw block text → compiled html; cleared whenever the doc changes
let tableMemo = new Map<string, string>();

export function invalidatePreviewMemo(): void {
  tableMemo = new Map();
}

function buildDeco(state: EditorState, onOpenLink: OpenLink): {
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
    const d = Decoration.replace({});
    deco.push({ from, to, value: d });
    atom.push({ from, to, value: d });
  };
  const hideWidget = (from: number, to: number, d: Decoration): void => {
    deco.push({ from, to, value: d });
    atom.push({ from, to, value: d });
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
        hideWidget(
          blockFrom,
          blockTo,
          Decoration.replace({ widget: new TableWidget(html, blockFrom), block: true }),
        );
        for (let k = ti; k < j; k++) skip.add(k);
      }
      ti = j;
      continue;
    }
    ti++;
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
    if (active(l.from, l.to)) return; // cursor's line: raw markdown

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
      hideWidget(l.from, l.to, Decoration.replace({ widget: new HrWidget() }));
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
    create: (s) => buildDeco(s, onOpenLink),
    update(_v, tr) {
      if (tr.docChanged) invalidatePreviewMemo();
      return tr.docChanged || tr.selection || tr.effects.some((e) => e.is(focusToggle))
        ? buildDeco(tr.state, onOpenLink)
        : _v;
    },
  });

  return [
    markdown({ codeLanguages: languages }),
    focusField,
    previewField,
    EditorView.decorations.compute([previewField], (s) => s.field(previewField).deco),
    EditorView.atomicRanges.compute([previewField], (s) => s.field(previewField).atom),
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

export { placeholder };
