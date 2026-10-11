import type { APIRoute } from 'astro';
import { renameEntry } from '../../lib/works.ts';
import { commit } from '../../lib/git.ts';
import { flushAll } from '../../lib/autosave.ts';
import { json } from '../../lib/http.ts';

export const POST: APIRoute = async (ctx) => {
  const body = (await ctx.request.json().catch(() => null)) as
    | { path?: string; name?: string }
    | null;
  try {
    if (typeof body?.path !== 'string' || typeof body?.name !== 'string') {
      throw new Error('bad request');
    }
    // the pending burst commits first — under the OLD name — so the
    // mutation stays ONE commit
    await flushAll();
    const { path, renumbered } = renameEntry(body.path, body.name);
    await commit(`${body.path} -> ${path}`);
    return json(ctx, { path, renumbered });
  } catch (e) {
    return json(ctx, { error: (e as Error).message }, 400);
  }
};