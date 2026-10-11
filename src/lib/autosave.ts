// Commit cadence for the git-backed undo (owner decisions 2026-10-11).
// Saves stop committing every push: PUT /api/file writes and calls
// markDirty(path, charDelta); ONE 30s ticker commits the pending burst when
// >=200 chars accumulated — under the minimum it does nothing, the next
// tick re-checks (no idle trigger, no mid-burst trigger). flushAll()
// force-commits a pending burst before rename/delete/reorder/new (so each
// mutation stays ONE commit), lock/log-out, pdf compile, and on SIGTERM; at
// boot a dirty worktree commits as `recovered` (a crash can only lose the
// commit, never the text — writes are atomic and already on disk), and a
// fresh repo gets its first commit as `INIT`. Message grammar (owner
// decision 2026-10-11, no timestamps — git stores them): `path` for a
// content update, one line per path when several files are pending. All
// commits ride the serialized queue in git.ts, which announces them to the
// SSE clients. Commit failures stay server-log only — the text itself is
// already on disk, and the next commit sweeps it in.
import { commit, ensureRepo, gitOut } from './git.ts';

const TICK_MS = 30_000;
const MIN_CHARS = 200;

// path -> accumulated |charDelta| since the last commit. An entry with 0
// chars is still a real change (a same-length rewrite) and counts toward
// the minimum.
const pending = new Map<string, number>();

// local server time — the branch names' clock (no longer in commit messages)
export function stamp(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    ` ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

// The client never learns boundaries from this write — the SSE channel
// (git.ts's commit events) announces every commit. Void on purpose.
export function markDirty(path: string, charDelta: number): void {
  pending.set(path, (pending.get(path) ?? 0) + Math.abs(charDelta));
}

// commit everything pending now. Take-and-clear is synchronous, so
// overlapping callers can never double-commit one burst — the second sees
// an empty map. Empty pending: no commit (the mutation routes' own commit
// still fires after them).
export async function flushAll(): Promise<boolean> {
  if (!pending.size) return false;
  const lines: string[] = [];
  for (const path of pending.keys()) lines.push(path);
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
    await commit(hasCommits ? 'recovered' : 'INIT');
  } catch (err) {
    console.warn('[iauthor] autosave boot check failed:', err);
  }
}

// dev HMR re-imports this module: register boot + ticker + SIGTERM once per
// process
const g = globalThis as Record<string, unknown>;
if (!g.__iauthorAutosaveBoot) {
  g.__iauthorAutosaveBoot = true;
  void boot();
  // the cadence: one wall-clock tick, not a per-keystroke timer — a tick
  // under the minimum is simply a no-op (the next tick re-checks)
  setInterval(() => {
    let total = 0;
    for (const n of pending.values()) total += n;
    if (total >= MIN_CHARS) void flushAll();
  }, TICK_MS);
  process.once('SIGTERM', () => {
    void flushAll().finally(() => process.exit(0));
  });
}
