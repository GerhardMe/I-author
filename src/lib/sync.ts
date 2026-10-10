// Chunked sync machinery: local draft (sessionStorage) and the push state
// machine. Trigger: a 1s interval — armed whenever the doc is ahead of the
// server, restarted after each confirmed push only if it is still ahead
// (typing pauses → one last save → idle). Status surface: hooks.onPushStart/
// onPushEnd + ahead() — the app shell renders dot/spinner from those.
import { EditorView } from '@codemirror/view';

export const PUSH_MS = 1000; // save every second while the doc is ahead

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
  schedule: () => void;
  pushNow: () => Promise<void>;
  cancel: () => void;
};

export function createSync(hooks: SyncHooks): SyncState {
  let baseline = ''; // content the server last confirmed
  let lastPushedLen = 0;
  let pushTimer: ReturnType<typeof setTimeout> | null = null;
  let pushing = false;

  function setBaseline(content: string, pushedLen: number): void {
    baseline = content;
    lastPushedLen = pushedLen;
  }

  // status is divergence from the server, not the word counter: a 1-char
  // deletion rounds to 0 dirty words, yet the doc IS ahead of the server
  function ahead(content: string): boolean {
    return content !== baseline;
  }

  // arm the interval — once, not per keystroke: it fires PUSH_MS after the
  // first change since the last arm (a true second-tick, not a debounce)
  function schedule(): void {
    if (pushing || pushTimer) return;
    pushTimer = setTimeout(() => {
      pushTimer = null;
      void pushNow();
    }, PUSH_MS);
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
      // re-arm only if typing continued while the push was in flight —
      // otherwise the last save already caught up and we idle until the
      // next keystroke
      const now = hooks.getContent();
      if (hooks.getEditor() && now !== null && ahead(now)) schedule();
    }
  }

  function cancel(): void {
    if (pushTimer) {
      clearTimeout(pushTimer);
      pushTimer = null;
    }
  }

  // the doc matches the server copy: drop the draft so it can't shadow the
  // confirmed content (pushNow's equal-content early return runs this)
  function clearIfClean(): void {
    const path = hooks.getPath();
    const content = hooks.getContent();
    if (!path || !content) return;
    if (content === baseline) {
      dropDraft(path);
    }
  }

  return {
    setBaseline,
    baselineLen: () => lastPushedLen,
    ahead,
    schedule,
    pushNow,
    cancel,
  };
}
