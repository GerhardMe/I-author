// POST /api/git/make-master {sha} — the history view's whole-tree restore:
// master jumps to the chosen commit, forward (an undo-* tip — the redo
// direction) or back (an older spine commit). The current HEAD is branched
// first as undo-<ts> when moving away from it, so nothing is ever destroyed
// — the same model as undo, aimed at any commit in the DAG.
import type { APIRoute } from 'astro';
import { flushAll, stamp } from '../../../lib/autosave.ts';
import {
  gitOut,
  isSha,
  nextUndoBranch,
  parseNameStatus,
  transaction,
  type GitChange,
} from '../../../lib/git.ts';
import { readChapter } from '../../../lib/works.ts';
import { json } from '../../../lib/http.ts';

// longest-prefix lookup — the same rule the client's remapPaths applies
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
  const body = (await ctx.request.json().catch(() => null)) as
    | { sha?: string; path?: string }
    | null;
  try {
    if (!isSha(body?.sha)) throw new Error('bad request');
    // the pending burst commits first: it stays part of the history the
    // jump leaves behind (branched, when the jump moves away)
    await flushAll();
    const result = await transaction(async () => {
      // the target must be a commit this repo knows
      let target: string;
      try {
        target = (await gitOut(['rev-parse', `${body.sha}^{commit}`])).trim();
      } catch {
        throw new Error('unknown commit');
      }
      const old = (await gitOut(['rev-parse', 'HEAD'])).trim();
      if (target === old) {
        return { changed: [], map: {}, content: null, head: old };
      }
      // flushAll just ran: anything still dirty means its commit FAILED —
      // resetting hard would destroy that text on disk. Abort instead.
      const status = (await gitOut(['status', '--porcelain'])).trim();
      if (status) throw new Error('worktree not clean — restore aborted');
      // moving to a descendant (redo) needs no branch: the abandoned state
      // is already an ancestor of the target, hence reachable
      let ancestor = false;
      try {
        await gitOut(['merge-base', '--is-ancestor', old, target]);
        ancestor = true;
      } catch {
        ancestor = false;
      }
      if (!ancestor) {
        await gitOut(['branch', await nextUndoBranch(stamp()), old]);
      }
      await gitOut(['reset', '--hard', target]);
      // the diff runs from the CURRENT tree (old) to the TARGET tree, so its
      // rename map already points the way the client's state moves
      const { changed, map }: GitChange = parseNameStatus(
        await gitOut(['diff', '--name-status', `${old}..${target}`]),
      );
      // the open file's content after the jump; null when it is gone
      let content: string | null = null;
      const asked = typeof body?.path === 'string' ? body.path : '';
      if (asked) {
        try {
          content = readChapter(remapPath(map, asked));
        } catch {
          content = null;
        }
      }
      return { changed, map, content, head: target };
    });
    return json(ctx, { ok: true, ...result });
  } catch (e) {
    return json(ctx, { error: (e as Error).message }, 400);
  }
};
