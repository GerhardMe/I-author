// Chunked sync machinery: local draft (sessionStorage) and the push state
// machine (dirty-word threshold + idle push). Status surface: hooks.onPushStart/
// onPushEnd + ahead() — the app shell renders dot/spinner from those.
import { countWords } from './words.ts';
import { EditorView } from '@codemirror/view';

export const PUSH_WORDS = 10; // push when ≥ this many dirty words
export const IDLE_MS = 5000; // push when typing pauses this long

// ---------- draft store (sessionStorage — survives reload + PIN lock) ----------
const DRAFT_KEY = 'iauthor.draft';

export type Draft = { content: string; synced: number; at: number };

export function draftKey(p: string): string {
  return `iauthor.draft.${p}`;
}

export function lastDraftPath(): string | null {
  return sessionStorage.getItem(DRAFT_KEY);
}

export function loadDraft(p: string): Draft | null {
  try {
    const raw = sessionStorage.getItem(draftKey(p));
    if (!raw) return null;
    const d = JSON.parse(raw) as Partial<Draft>;
    if (typeof d.content !== 'string' || typeof d.synced !== 'number') return null;
    return { content: d.content, synced: d.synced, at: d.at ?? 0 };
  } catch {
    return null;
  }
}

export function saveDraft(p: string, draft: Draft): void {
  sessionStorage.setItem(DRAFT_KEY, p);
  sessionStorage.setItem(draftKey(p), JSON.stringify(draft));
}

export function dropDraft(p: string): void {
  // only clear the pointer when it names THIS draft — another file's draft
  // must stay restorable at boot (boot() reads lastDraftPath())
  if (sessionStorage.getItem(DRAFT_KEY) === p) sessionStorage.removeItem(DRAFT_KEY);
  sessionStorage.removeItem(draftKey(p));
}

// carry an unsynced draft over to the file's new path after a rename
export function moveDraft(oldP: string, newP: string): void {
  const raw = sessionStorage.getItem(draftKey(oldP));
  if (raw === null) return;
  sessionStorage.setItem(draftKey(newP), raw);
  sessionStorage.removeItem(draftKey(oldP));
  if (sessionStorage.getItem(DRAFT_KEY) === oldP) sessionStorage.setItem(DRAFT_KEY, newP);
}

// Renumbering renames every later sibling, and moving a folder changes the path
// of everything inside it, so the caller cannot enumerate the affected paths —
// walk the store instead and hand every draft path through the same remapper.
export function remapDrafts(map: (path: string) => string): void {
  const keys: string[] = [];
  for (let i = 0; i < sessionStorage.length; i++) {
    const k = sessionStorage.key(i);
    if (k && k.startsWith('iauthor.draft.')) keys.push(k);
  }
  for (const k of keys) {
    const path = k.slice('iauthor.draft.'.length);
    const next = map(path);
    if (next === path) continue;
    const raw = sessionStorage.getItem(k);
    if (raw === null) continue;
    sessionStorage.setItem(draftKey(next), raw);
    sessionStorage.removeItem(k);
    if (sessionStorage.getItem(DRAFT_KEY) === path) sessionStorage.setItem(DRAFT_KEY, next);
  }
}

// ---------- push machine ----------
export type SyncHooks = {
  getPath: () => string | null;
  getContent: () => string | null;
  getEditor: () => EditorView | null;
  onSaved: (content: string) => void;
  onPushStart: () => void; // request sent → awaiting the reply
  onPushEnd: (ok: boolean) => void; // reply in; recompute the status
  onAuthLost: () => void; // 401 → hand off to page (flush + redirect)
};

export type SyncState = {
  setBaseline: (content: string, lastPushedLen: number) => void;
  baselineLen: () => number;
  ahead: (content: string) => boolean; // the doc differs from the server copy
  dirtyWords: () => number;
  addDirty: (insertedText: string, deletedLen: number) => void;
  schedule: () => void;
  pushNow: () => Promise<void>;
  cancel: () => void;
  clearIfClean: () => void;
};

export function createSync(hooks: SyncHooks): SyncState {
  let baseline = ''; // content the server last confirmed
  let lastPushedLen = 0;
  let dirty = 0; // cumulative dirty words since last confirmed push
  let pushTimer: ReturnType<typeof setTimeout> | null = null;
  let pushing = false;

  function setBaseline(content: string, pushedLen: number): void {
    baseline = content;
    lastPushedLen = pushedLen;
    dirty = 0;
  }

  // called from the transaction extender path: accumulate real dirty volume
  // (inserted words + deleted chars/6 approximates deleted words) — immune to
  // insert-then-delete-same-amount cancellation that a net delta would suffer
  function addDirty(
    insertedText: string,
    deletedLen: number,
  ): void {
    dirty += countWords(insertedText) + Math.round(deletedLen / 6);
  }

  function dirtyWords(): number {
    return dirty;
  }

  // status is divergence from the server, not the word counter: a 1-char
  // deletion rounds to 0 dirty words, yet the doc IS ahead of the server
  function ahead(content: string): boolean {
    return content !== baseline;
  }

  function schedule(): void {
    const view = hooks.getEditor();
    if (!view || pushing) return;
    if (dirty >= PUSH_WORDS) {
      void pushNow();
      return;
    }
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
      pushTimer = null;
      void pushNow();
    }, IDLE_MS);
  }

  async function pushNow(): Promise<void> {
    const path = hooks.getPath();
    const content = hooks.getContent();
    if (!path || !content || pushing) return;
    if (pushTimer) {
      clearTimeout(pushTimer);
      pushTimer = null;
    }
    if (content === baseline) {
      clearIfClean();
      return;
    }
    pushing = true;
    hooks.onPushStart();
    let ok = false;
    try {
      const res = await fetch('/api/file', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path, content }),
      });
      if (res.status === 401) {
        hooks.onAuthLost();
        return;
      }
      if (!res.ok) throw new Error('save failed');
      setBaseline(content, content.length);
      dropDraft(path);
      hooks.onSaved(content);
      ok = true;
    } catch {
      // keep the draft; the status falls back to "dirty"
    } finally {
      pushing = false;
      hooks.onPushEnd(ok);
      if (hooks.getEditor() && dirty > 0) schedule();
    }
  }

  function cancel(): void {
    if (pushTimer) {
      clearTimeout(pushTimer);
      pushTimer = null;
    }
  }

  // the doc matches the server copy: drop the draft AND the dirty counter —
  // otherwise pushNow's equal-content early return leaves it set forever
  function clearIfClean(): void {
    const path = hooks.getPath();
    const content = hooks.getContent();
    if (!path || !content) return;
    if (content === baseline) {
      dirty = 0;
      dropDraft(path);
    }
  }

  return {
    setBaseline,
    baselineLen: () => lastPushedLen,
    ahead,
    dirtyWords,
    addDirty,
    schedule,
    pushNow,
    cancel,
    clearIfClean,
  };
}
