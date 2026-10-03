import type { APIRoute } from 'astro';
import { readChapter, writeChapter } from '../../lib/works.ts';
import { commit } from '../../lib/git.ts';
import { json } from '../../lib/http.ts';

export const GET: APIRoute = async (ctx) => {
  try {
    const rel = ctx.url.searchParams.get('path') ?? '';
    const content = readChapter(rel);
    return json(ctx, { path: rel, content });
  } catch (e) {
    return json(ctx, { error: (e as Error).message }, 400);
  }
};

export const PUT: APIRoute = async (ctx) => {
  const body = (await ctx.request.json().catch(() => null)) as
    | { path?: string; content?: string }
    | null;
  try {
    if (!body || typeof body.path !== 'string' || typeof body.content !== 'string') {
      throw new Error('bad request');
    }
    writeChapter(body.path, body.content);
    await commit(`save ${body.path}`);
    return json(ctx, { ok: true });
  } catch (e) {
    return json(ctx, { error: (e as Error).message }, 400);
  }
};