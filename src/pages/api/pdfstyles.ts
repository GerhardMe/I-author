// GET /api/pdfstyles — the LaTeX stylesheet menu, built by scanning the
// pdfstyles/ folder (the single source of truth).
import type { APIRoute } from 'astro';
import { listPdfStyles } from '../../lib/pdf.ts';
import { json } from '../../lib/http.ts';

export const GET: APIRoute = async (ctx) => {
  try {
    return json(ctx, { styles: listPdfStyles() });
  } catch (e) {
    return json(ctx, { error: (e as Error).message }, 500);
  }
};