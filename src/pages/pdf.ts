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
  // folder aggregates follow the sidebar's drafts toggle (drafts=1 includes)
  const includeDrafts = ctx.url.searchParams.get('drafts') === '1';
  try {
    const { abs, name } = await ensurePdf(rel, preset, force, includeDrafts);
    const data = fs.readFileSync(abs);
    return new Response(data, {
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': `inline; filename="${name}"`,
        'cache-control': 'no-store',
      },
    });
  } catch (e) {
    const msg = (e as Error).message;
    const status = msg === 'not found' ? 404 : 500;
    // direct visits need a readable page; the client's fetch flow alerts on
    // this same text
    return new Response(
      `<!doctype html><meta charset="utf-8"><title>pdf</title>` +
        `<body style="font: 15px/1.6 Georgia,serif; max-width: 42em; margin: 3rem auto; padding: 0 1rem">` +
        `<h1 style="font-size:1.2em">pdf failed (${status})</h1><pre style="white-space:pre-wrap">${msg.replace(
          /[&<>]/g,
          (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!,
        )}</pre>` +
        // direct visits (the compiler tab lands here when a compile
        // fails) need a way back — there is no browser chrome for it
        // on a phone
        `<p style="margin-top:1.5rem"><a href="/">&#8592; back to the app</a></p></body>`,
      { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-iauthor-error': msg.slice(0, 800) } },
    );
  }
};