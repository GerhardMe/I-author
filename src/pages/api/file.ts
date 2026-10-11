import type { APIRoute } from 'astro';
import { readChapter, writeChapter } from '../../lib/works.ts';
import { markDirty } from '../../lib/autosave.ts';
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
    // the burst the write adds to the coalescer's pending map
    let oldLen = 0;
    try {
      oldLen = readChapter(body.path).length;
    } catch {}
    writeChapter(body.path, body.content);
    // no commit here — the autosave coalescer owns the cadence, and the SSE
    // channel (/api/events) announces every commit it makes. The response
    // carries nothing about commits.
    markDirty(body.path, body.content.length - oldLen);
    return json(ctx, { ok: true });
  } catch (e) {
    return json(ctx, { error: (e as Error).message }, 400);
  }
};