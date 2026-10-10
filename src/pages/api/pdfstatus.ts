// GET /api/pdfstatus?path=&preset=&drafts=1 — what a pdf compile would do
// right now: the fragment list with a cached flag on each, so the client's
// compiling placeholder can show what is up to date and what it waits for.
// Hashing only, no LaTeX — cheap enough to poll while a compile runs.
import type { APIRoute } from 'astro';
import { pdfPlan } from '../../lib/pdf.ts';
import { NotFoundError, json } from '../../lib/http.ts';

export const GET: APIRoute = async (ctx) => {
  const rel = ctx.url.searchParams.get('path') ?? '';
  const preset = ctx.url.searchParams.get('preset');
  const includeDrafts = ctx.url.searchParams.get('drafts') === '1';
  try {
    return json(ctx, pdfPlan(rel, preset, includeDrafts));
  } catch (e) {
    const status = e instanceof NotFoundError ? 404 : 500;
    return json(ctx, { error: (e as Error).message }, status);
  }
};