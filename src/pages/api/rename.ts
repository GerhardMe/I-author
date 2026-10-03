import type { APIRoute } from 'astro';
import { renameEntry } from '../../lib/works.ts';
import { commit } from '../../lib/git.ts';
import { json } from '../../lib/http.ts';

export const POST: APIRoute = async (ctx) => {
  const body = (await ctx.request.json().catch(() => null)) as
    | { path?: string; name?: string }
    | null;
  try {
    if (typeof body?.path !== 'string' || typeof body?.name !== 'string') {
      throw new Error('bad request');
    }
    const { path } = renameEntry(body.path, body.name);
    await commit(`rename ${body.path} -> ${path}`);
    return json(ctx, { path });
  } catch (e) {
    return json(ctx, { error: (e as Error).message }, 400);
  }
};