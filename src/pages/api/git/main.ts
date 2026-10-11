// POST /api/git/main — back to head: leave the temporary checkout and land
// on main proper. The tree the client is leaving may hold uncommitted work
// in flight — flushAll() commits it ONTO the branch we leave (never onto
// main), then the worktree must be clean: git itself refuses to carry dirty
// state across a checkout, and a failed commit aborts instead of clobbering.
// Called by the history view's "back to head" button and by the app boot
// (owner decision 2026-10-11: a page reload returns to head — the peek is
// temporary; its commits stay on the branch and remain visible in the DAG).
import type { APIRoute } from 'astro';
import { flushAll } from '../../../lib/autosave.ts';
import { gitOut, onMain, parseNameStatus, transaction, type GitChange } from '../../../lib/git.ts';
import { json } from '../../../lib/http.ts';

export const POST: APIRoute = async (ctx) => {
  try {
    await flushAll();
    const result = await transaction(async () => {
      if (await onMain()) {
        const head = (await gitOut(['rev-parse', 'HEAD'])).trim();
        return { changed: [] as string[], map: {}, head };
      }
      const status = (await gitOut(['status', '--porcelain'])).trim();
      if (status) throw new Error('worktree not clean — return aborted');
      const old = (await gitOut(['rev-parse', 'HEAD'])).trim();
      await gitOut(['checkout', '-q', 'main']);
      const { changed, map }: GitChange = parseNameStatus(
        await gitOut(['diff', '--name-status', `${old}..main`]),
      );
      const head = (await gitOut(['rev-parse', 'HEAD'])).trim();
      return { changed, map, head };
    });
    return json(ctx, { ok: true, ...result });
  } catch (e) {
    return json(ctx, { error: (e as Error).message }, 400);
  }
};
