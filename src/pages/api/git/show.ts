// GET /api/git/show?sha=&path= — a file's content at a commit: the history
// view's read-only preview. The sha/path guards live in git.ts (isSha,
// isMdPath); git resolves the path inside the commit's tree, so nothing can
// escape the repo — the file may long be gone from the worktree.
import type { APIRoute } from 'astro';
import { gitShow, isMdPath, isSha } from '../../../lib/git.ts';
import { json } from '../../../lib/http.ts';

export const GET: APIRoute = async (ctx) => {
  const sha = ctx.url.searchParams.get('sha');
  const rel = ctx.url.searchParams.get('path');
  try {
    if (!isSha(sha) || !isMdPath(rel)) throw new Error('bad request');
    const content = await gitShow(sha, rel);
    return json(ctx, { content });
  } catch (e) {
    return json(ctx, { error: (e as Error).message }, 400);
  }
};
