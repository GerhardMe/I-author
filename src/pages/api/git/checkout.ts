// POST /api/git/checkout {sha} — click a node in the history DAG and
// the whole works tree becomes that commit's state (owner decision
// 2026-10-11). main NEVER moves: the checkout lands on a fresh branch named
// for the moment of the jump, so edits made there commit onto that branch —
// the jump is a temporary peek (reload, or the "back to head" button,
// returns to main). Every switch commits first: pending burst via
// flushAll(), then the worktree must be clean — git itself would refuse to
// carry dirty state across a checkout, and reset is not an option (text may
// only be destroyed by a failed commit, which the guard surfaces instead).
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
import { json } from '../../../lib/http.ts';

export const POST: APIRoute = async (ctx) => {
  const body = (await ctx.request.json().catch(() => null)) as
    | { sha?: string }
    | null;
  try {
    if (!isSha(body?.sha)) throw new Error('bad request');
    // the pending burst commits FIRST — onto the branch we are about to leave
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
        // clicking where we already are: nothing to move
        return { changed: [] as string[], map: {}, head: old };
      }
      // flushAll just ran: anything still dirty means its commit FAILED —
      // checkout would refuse or clobber; abort instead (the guard that kept
      // reset --hard honest in the undo route does the same job here)
      const status = (await gitOut(['status', '--porcelain'])).trim();
      if (status) throw new Error('worktree not clean — checkout aborted');
      // one name, one jump: branch at the target, then land on it — commits
      // made while peeking go here, main stays untouched
      const branch = await nextUndoBranch(stamp());
      await gitOut(['branch', branch, target]);
      await gitOut(['checkout', '-q', branch]);
      // the diff runs from the CURRENT tree (old) to the TARGET tree, so its
      // rename map already points the way the client's state moves
      const { changed, map }: GitChange = parseNameStatus(
        await gitOut(['diff', '--name-status', `${old}..${target}`]),
      );
      const head = (await gitOut(['rev-parse', 'HEAD'])).trim();
      return { changed, map, head };
    });
    return json(ctx, { ok: true, ...result });
  } catch (e) {
    return json(ctx, { error: (e as Error).message }, 400);
  }
};
