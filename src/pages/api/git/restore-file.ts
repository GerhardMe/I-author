// POST /api/git/restore-file {sha, path} — the history view's "fetch file":
// one file's content from a commit becomes a NEW commit on master; master
// itself never moves. The restored file may have been deleted since (or sit
// in a deleted folder), so the write goes through restoreChapter, which
// creates what is missing.
import type { APIRoute } from 'astro';
import { flushAll } from '../../../lib/autosave.ts';
import { commit, gitShow, isMdPath, isSha } from '../../../lib/git.ts';
import { restoreChapter } from '../../../lib/works.ts';
import { json } from '../../../lib/http.ts';

export const POST: APIRoute = async (ctx) => {
  const body = (await ctx.request.json().catch(() => null)) as
    | { sha?: string; path?: string }
    | null;
  try {
    if (!isSha(body?.sha) || !isMdPath(body?.path)) throw new Error('bad request');
    // the pending burst commits first: the restore stays its own commit
    await flushAll();
    const content = await gitShow(body.sha, body.path);
    restoreChapter(body.path, content);
    await commit(`${body.path} (restored ${body.sha.slice(0, 7)})`);
    return json(ctx, { ok: true, changed: [body.path], map: {} });
  } catch (e) {
    return json(ctx, { error: (e as Error).message }, 400);
  }
};
