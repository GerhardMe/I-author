// POST /api/undo — git-backed undo (owner decisions 2026-10-11): master moves
// back one commit, the abandoned future stays reachable forever on an
// undo-<timestamp> branch. The client escalates here when its native
// (uncommitted-only) undo stack is exhausted. Whole-tree undo: whatever file
// the last commit touched, master moves back — per-file resets are
// incoherent since the log interleaves files.
import type { APIRoute } from 'astro';
import { flushAll, stamp } from '../../lib/autosave.ts';
import { gitOut, transaction } from '../../lib/git.ts';
import { readChapter } from '../../lib/works.ts';
import { json } from '../../lib/http.ts';

// longest-prefix lookup — the same rule the client's remapPaths applies: a
// moved folder changes the path of everything inside it while the map only
// carries the folder itself
function remapPath(map: Record<string, string>, p: string): string {
  let best = '';
  let to = '';
  for (const [from, dest] of Object.entries(map)) {
    if ((p === from || p.startsWith(from + '/')) && from.length > best.length) {
      best = from;
      to = dest;
    }
  }
  return to ? to + p.slice(best.length) : p;
}

export const POST: APIRoute = async (ctx) => {
  const body = (await ctx.request.json().catch(() => null)) as { path?: string } | null;
  try {
    // the pending burst commits FIRST: it becomes the last commit on the
    // soon-stale branch, and master undoes past it
    await flushAll();
    const result = await transaction(async () => {
      let old: string;
      try {
        old = (await gitOut(['rev-parse', 'HEAD'])).trim();
      } catch {
        throw new Error('nothing to undo'); // no commits at all
      }
      // the root commit (INIT or the first save) has nothing before it
      try {
        await gitOut(['rev-parse', '--verify', 'HEAD~1']);
      } catch {
        throw new Error('nothing to undo');
      }
      // flushAll just ran: anything still dirty means its commit FAILED —
      // resetting hard would destroy that text on disk. Abort instead; the
      // next commit sweeps the burst in and undo works then.
      const status = (await gitOut(['status', '--porcelain'])).trim();
      if (status) throw new Error('worktree not clean — undo aborted');
      // colons are illegal in ref names; a second undo in the same second
      // gets a -2 suffix
      const base = `undo-${stamp().replace(' ', '_').replaceAll(':', '-')}`;
      let branch = base;
      for (let i = 2; ; i++) {
        try {
          await gitOut(['rev-parse', '--verify', `refs/heads/${branch}`]);
          branch = `${base}-${i}`;
        } catch {
          break;
        }
      }
      await gitOut(['branch', branch, old]); // the future stays reachable
      await gitOut(['reset', '--hard', 'HEAD~1']); // master moves back
      const head = (await gitOut(['rev-parse', 'HEAD'])).trim();
      const diff = await gitOut(['diff', '--name-status', `${old}..${head}`]);
      const changed: string[] = [];
      const map: Record<string, string> = {};
      for (const line of diff.split('\n')) {
        if (!line.trim()) continue;
        const [status, ...rest] = line.split('\t');
        if (status![0] === 'R') {
          const [from, to] = rest as [string, string];
          changed.push(from, to);
          // paths move BACK: the client's state is keyed at the post-commit
          // names the undo just renamed away, so the map inverts the diff
          map[to] = from;
        } else {
          changed.push(rest[0]!); // M / A / D — one path
        }
      }
      // the open file's content after the undo, resolved back through the
      // map; null when the undo deleted it (the client goes home)
      let content: string | null = null;
      const asked = typeof body?.path === 'string' ? body.path : '';
      if (asked) {
        try {
          content = readChapter(remapPath(map, asked));
        } catch {
          content = null;
        }
      }
      return { changed, map, content, head };
    });
    return json(ctx, { ok: true, ...result });
  } catch (e) {
    return json(ctx, { error: (e as Error).message }, 400);
  }
};
