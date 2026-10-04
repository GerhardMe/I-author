import type { APIRoute } from 'astro';
import { createEntry } from '../../lib/works.ts';
import { commit } from '../../lib/git.ts';
import { json } from '../../lib/http.ts';

export const POST: APIRoute = async (ctx) => {
  const body = (await ctx.request.json().catch(() => null)) as
    | { kind?: string; parent?: string; name?: string }
    | null;
  try {
    const kind = body?.kind;
    if ((kind !== 'folder' && kind !== 'file') || typeof body?.name !== 'string') {
      throw new Error('bad request');
    }
    const { path, renumbered } = createEntry(kind, body?.parent ?? '', body.name);
    const n = Object.keys(renumbered).length;
    await commit(`create ${path}${n ? ` (+${n} renumbered)` : ''}`);
    return json(ctx, { path, renumbered });
  } catch (e) {
    return json(ctx, { error: (e as Error).message }, 400);
  }
};