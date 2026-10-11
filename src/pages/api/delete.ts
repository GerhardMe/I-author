import type { APIRoute } from 'astro';
import { deleteEntry } from '../../lib/works.ts';
import { commit } from '../../lib/git.ts';
import { flushAll } from '../../lib/autosave.ts';
import { json } from '../../lib/http.ts';

export const POST: APIRoute = async (ctx) => {
  const body = (await ctx.request.json().catch(() => null)) as { path?: string } | null;
  try {
    if (!body || typeof body.path !== 'string') throw new Error('bad request');
    // the pending burst commits first, so the mutation stays ONE commit
    await flushAll();
    const renumbered = deleteEntry(body.path);
    await commit(`- ${body.path}`);
    return json(ctx, { ok: true, renumbered });
  } catch (e) {
    return json(ctx, { error: (e as Error).message }, 400);
  }
};