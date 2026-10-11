// POST /api/undo — git-backed undo (owner decisions 2026-10-11): master moves
// back one commit, the abandoned future stays reachable forever on an
// undo-<timestamp> branch. The client escalates here when its native
// (uncommitted-only) undo stack is exhausted. Whole-tree undo: whatever file
// the last commit touched, master moves back — per-file resets are
// incoherent since the log interleaves files.
import type { APIRoute } from 'astro';
import { flushAll, stamp } from '../../lib/autosave.ts';
import {
  gitOut,
  nextUndoBranch,
  parseNameStatus,
  transaction,
  type GitChange,
} from '../../lib/git.ts';
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
      await gitOut(['branch', await nextUndoBranch(stamp()), old]); // the future stays reachable
      await gitOut(['reset', '--hard', 'HEAD~1']); // master moves back
      const head = (await gitOut(['rev-parse', 'HEAD'])).trim();
      // the diff runs from the CURRENT tree (old) to the TARGET tree (head),
      // so its rename map already points the way the client's state moves
      const { changed, map }: GitChange = parseNameStatus(
        await gitOut(['diff', '--name-status', `${old}..${head}`]),
      );
      // the open file's content after the undo, resolved through the map;
      // null when the undo deleted it (the client goes home)
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
