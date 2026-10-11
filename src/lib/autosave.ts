// Commit cadence for the git-backed undo (owner decisions 2026-10-11).
// Saves stop committing every push: PUT /api/file writes and calls
// markDirty(path, charDelta); a single coalescer commits when 5s idle or
// >=1000 chars accumulated, whichever first. flushAll() force-commits a
// pending burst before rename/delete/reorder/new (so each mutation stays
// ONE commit), lock/log-out, pdf compile, and on SIGTERM; at boot a dirty
// worktree commits as `recovered : <time>` (a crash can only lose the
// commit, never the text — writes are atomic and already on disk), and a
// fresh repo gets its first commit as `INIT : <time>`. Message grammar:
// `path : 2026-10-11 14:03:22` (local server time, exactly this format),
// one line per path when several files are pending. All commits ride the
// serialized queue in git.ts. Commit failures stay server-log only — the
// text itself is already on disk, and the next commit sweeps it in.
import { commit, ensureRepo, gitOut } from './git.ts';

const IDLE_MS = 5000;
const CHARS_TRIGGER = 1000;

// path -> accumulated |charDelta| since the last commit. An entry with 0
// chars is still a real change (a same-length rewrite) and commits at idle.
const pending = new Map<string, number>();
let timer: ReturnType<typeof setTimeout> | null = null;

// local server time, exactly the message grammar's format
export function stamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    ` ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

// 5s idle: a true idle debounce — the timer restarts on every markDirty, so
// only a pause in typing commits (the >=1000-char trigger covers bursts)
function arm(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    void flushAll();
  }, IDLE_MS);
}

// Returns whether THIS call crossed the char trigger and started a commit:
// the client resets its native undo stack at every commit boundary, and the
// flag rides the PUT response for exactly that. The commit itself is not
// awaited — typing must never wait for git.
export function markDirty(path: string, charDelta: number): boolean {
  pending.set(path, (pending.get(path) ?? 0) + Math.abs(charDelta));
  let total = 0;
  for (const n of pending.values()) total += n;
  if (total >= CHARS_TRIGGER) {
    void flushAll();
    return true;
  }
  arm();
  return false;
}

// commit everything pending now. Take-and-clear is synchronous, so
// overlapping callers can never double-commit one burst — the second sees
// an empty map. Empty pending: no commit (the mutation routes' own commit
// still fires after them).
export async function flushAll(): Promise<boolean> {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (!pending.size) return false;
  const lines: string[] = [];
  for (const path of pending.keys()) lines.push(`${path} : ${stamp()}`);
  pending.clear();
  return commit(lines.join('\n'));
}

// boot: INIT for a fresh repo (post-wipe), recovered for a dirty worktree.
// Runs at the module's first import — the first API hit after a start.
async function boot(): Promise<void> {
  try {
    await ensureRepo();
    let hasCommits = true;
    try {
      await gitOut(['rev-parse', '--verify', 'HEAD']);
    } catch {
      hasCommits = false;
    }
    const status = await gitOut(['status', '--porcelain']);
    if (!status.trim()) return;
    await commit(hasCommits ? `recovered : ${stamp()}` : `INIT : ${stamp()}`);
  } catch (err) {
    console.warn('[iauthor] autosave boot check failed:', err);
  }
}

// dev HMR re-imports this module: register boot + SIGTERM once per process
const g = globalThis as Record<string, unknown>;
if (!g.__iauthorAutosaveBoot) {
  g.__iauthorAutosaveBoot = true;
  void boot();
  process.once('SIGTERM', () => {
    void flushAll().finally(() => process.exit(0));
  });
}
