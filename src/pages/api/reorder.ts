// POST /api/reorder — drag & drop. The client sends INTENT (which entry, which
// directory, before which sibling), never a list of names: the server does the
// renaming so the disk stays contiguous and the answer can carry the old->new
// path map that client state (selection, expanded folders, sessionStorage
// drafts) has to remap. One git commit for the whole move.
import type { APIRoute } from 'astro';
import { moveEntry } from '../../lib/works.ts';
import { commit } from '../../lib/git.ts';
import { json } from '../../lib/http.ts';

export const POST: APIRoute = async (ctx) => {
  const body = (await ctx.request.json().catch(() => null)) as
    | { path?: string; parent?: string; before?: string | null }
    | null;
  try {
    if (typeof body?.path !== 'string' || typeof body.parent !== 'string') {
      throw new Error('bad request');
    }
    const before = typeof body.before === 'string' ? body.before : null;
    const { moved, renumbered } = moveEntry(body.path, body.parent, before);
    const n = Object.keys(renumbered).length;
    await commit(`reorder ${moved.from} -> ${moved.to}${n ? ` (+${n} renumbered)` : ''}`);
    return json(ctx, { moved, renumbered });
  } catch (e) {
    return json(ctx, { error: (e as Error).message }, 400);
  }
};
