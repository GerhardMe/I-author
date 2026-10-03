// GET /pdf?path=&preset=&recompile=1 — compiles the scope if missing/stale
// and streams the PDF from the works dir inline. Not in the middleware's
// public set: a request without a valid, non-locked cookie is redirected to
// login before this runs.
import fs from 'node:fs';
import type { APIRoute } from 'astro';
import { ensurePdf } from '../lib/pdf.ts';

export const GET: APIRoute = async (ctx) => {
  const rel = ctx.url.searchParams.get('path') ?? '';
  const preset = ctx.url.searchParams.get('preset');
  const force = ctx.url.searchParams.get('recompile') === '1';
  try {
    const { abs, name } = await ensurePdf(rel, preset, force);
    const data = fs.readFileSync(abs);
    return new Response(data, {
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': `inline; filename="${name}"`,
        'cache-control': 'no-store',
      },
    });
  } catch (e) {
    if ((e as Error).message === 'not found') {
      return new Response('not found', { status: 404 });
    }
    return new Response(`pdf failed: ${(e as Error).message}`, { status: 500 });
  }
};