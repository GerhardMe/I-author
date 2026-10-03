// The filename grammar, defined once. Pure functions only — this module is
// imported by both the server (works.ts) and client bundles (no node imports).
//
// Entry name = [NN[-|_]][draft_]Title[.md|.markdown]
//   NN        optional numeric prefix (1-4 digits, - or _ separator), defines order
//   draft_    optional draft token (after the prefix), marks the entry as draft
//   Title     the raw title; the filename is the title, case preserved
export type ParsedName = {
  prefix: number | null; // numeric disk prefix value: 01_ -> 1
  draft: boolean; // carries the draft_ token
  stem: string; // base after prefix strip (case + underscores kept) — for duplicate checks
  raw: string; // display title: prefix + draft_ stripped, [-_] -> spaces
};

const EXT = /\.(md|markdown)$/i;
const PREFIX = /^(\d{1,4})[-_]/;

export function parseName(name: string): ParsedName {
  const base = name.replace(EXT, '');
  const m = PREFIX.exec(base);
  const rest = m ? base.slice(m[0].length) : base;
  const draft = /^draft_/.test(rest);
  const raw = rest.replace(/^draft_/, '').replace(/[-_]+/g, ' ').trim() || base;
  return { prefix: m ? Number(m[1]) : null, draft, stem: rest, raw };
}

// folders/files/notes sort by natural order: prefixed entries first, numbers
// compared numerically, unprefixed entries alphabetically after them
export function naturalCompare(a: string, b: string): number {
  const ax = a.toLowerCase().match(/(\d+|\D+)/g) ?? [];
  const bx = b.toLowerCase().match(/(\d+|\D+)/g) ?? [];
  for (let i = 0; i < Math.min(ax.length, bx.length); i++) {
    const an = /^\d+$/.test(ax[i]);
    const bn = /^\d+$/.test(bx[i]);
    if (an && bn) {
      const d = Number(ax[i]) - Number(bx[i]);
      if (d) return d;
    } else if (an !== bn) {
      return an ? -1 : 1;
    } else if (ax[i] !== bx[i]) {
      return ax[i] < bx[i] ? -1 : 1;
    }
  }
  return ax.length - bx.length;
}

export function slugify(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^A-Za-z0-9._-]/g, '')
    .replace(/^\.+/, '')
    .replace(/^[-_]+/, '')
    .slice(0, 80);
}

// folder material appended to the folder's index view, never a chapter
export const NOTES = /^notes\.md$/i;