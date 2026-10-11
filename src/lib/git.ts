import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { WORKS_DIR } from './config.ts';

const run = promisify(execFile);

// raw git access for the layers around committing (autosave boot check,
// undo's rev-parse/branch/reset, the history view's log) — same cwd rules
// as the commit path
export async function gitOut(args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd: WORKS_DIR });
  return stdout;
}

export async function ensureRepo(): Promise<void> {
  fs.mkdirSync(WORKS_DIR, { recursive: true });
  if (!fs.existsSync(path.join(WORKS_DIR, '.git'))) {
    await run('git', ['init', '-q', '-b', 'main'], { cwd: WORKS_DIR });
    await run('git', ['config', 'user.name', 'iauthor'], { cwd: WORKS_DIR });
    await run('git', ['config', 'user.email', 'iauthor@local'], { cwd: WORKS_DIR });
  }
  // compiled pdfs are build artifacts, not writing: keep them out of history
  const gi = path.join(WORKS_DIR, '.gitignore');
  if (!fs.existsSync(gi)) {
    fs.writeFileSync(gi, '*.pdf\n');
  } else if (!fs.readFileSync(gi, 'utf8').includes('*.pdf')) {
    fs.appendFileSync(gi, '*.pdf\n');
  }
}

async function runCommit(msg: string): Promise<boolean> {
  await ensureRepo();
  await run('git', ['add', '-A'], { cwd: WORKS_DIR });
  const status = await run('git', ['status', '--porcelain'], { cwd: WORKS_DIR });
  if (!status.stdout.trim()) return false;
  await run(
    'git',
    ['-c', 'user.name=iauthor', '-c', 'user.email=iauthor@local', 'commit', '-q', '-m', msg],
    { cwd: WORKS_DIR },
  );
  return true;
}

// Commits are serialized: two rapid saves would otherwise race on
// .git/index.lock and one would vanish. The queue keeps the single-user
// server's mutating routes from ever running git concurrently.
let queue: Promise<unknown> = Promise.resolve();

export async function commit(msg: string): Promise<boolean> {
  const next = queue.then(() => attempt(msg));
  queue = next.catch(() => {}); // a failed commit must not poison the queue
  return next as Promise<boolean>;
}

// run a multi-command git sequence on the same serialized queue the commits
// use — a coalescer commit can never interleave with a branch+reset (undo)
export function transaction<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn);
  queue = next.catch(() => {});
  return next;
}

// ---------- history-view plumbing ----------

// route-input guards shared by the git history endpoints: full or short hex
// shas, and repo-relative md paths (git resolves the path inside the tree,
// so no traversal is possible; the segment check keeps odd names out)
export function isSha(s: unknown): s is string {
  return typeof s === 'string' && /^[0-9a-f]{7,40}$/.test(s);
}

export function isMdPath(p: unknown): p is string {
  if (typeof p !== 'string' || !/\.(md|markdown)$/i.test(p)) return false;
  const parts = p.split('/');
  return parts.every((x) => x && x !== '.' && x !== '..' && !x.startsWith('.'));
}

// a file's content at a commit; the path resolves inside the git tree
export async function gitShow(sha: string, rel: string): Promise<string> {
  return gitOut(['show', `${sha}:${rel}`]);
}

export type GitChange = { changed: string[]; map: Record<string, string> };

// parse `git diff --name-status A..B`: the changed paths between two trees,
// and the rename map FROM A's names TO B's names — the client's state is
// keyed at the A tree and must follow the files into the B tree (undo and
// make-master both diff from the current tree to the target tree, so the
// direction is the same for both)
export function parseNameStatus(diff: string): GitChange {
  const changed: string[] = [];
  const map: Record<string, string> = {};
  for (const line of diff.split('\n')) {
    if (!line.trim()) continue;
    const [status, ...rest] = line.split('\t');
    if (status![0] === 'R') {
      const [from, to] = rest as [string, string];
      changed.push(from, to);
      map[from] = to;
    } else {
      changed.push(rest[0]!); // M / A / D — one path
    }
  }
  return { changed, map };
}

// a free undo-<timestamp> branch name (colons are illegal in refs; a second
// undo in the same second gets a -2 suffix). The stamp arrives preformatted
// from the caller — git.ts cannot import autosave.ts (it would be circular).
export async function nextUndoBranch(stamp: string): Promise<string> {
  const base = `undo-${stamp.replace(' ', '_').replaceAll(':', '-')}`;
  let branch = base;
  for (let i = 2; ; i++) {
    try {
      await gitOut(['rev-parse', '--verify', `refs/heads/${branch}`]);
      branch = `${base}-${i}`;
    } catch {
      return branch;
    }
  }
}

async function attempt(msg: string): Promise<boolean> {
  try {
    return await runCommit(msg);
  } catch {
    // one retry: a transient failure (EBUSY on a mounted volume, an external
    // git process holding the lock) usually clears in a blink
    await new Promise((r) => setTimeout(r, 250));
    try {
      return await runCommit(msg);
    } catch (err) {
      console.warn('[iauthor] git commit failed:', err);
      return false;
    }
  }
}