import type { APIRoute } from 'astro';
import { listWorks } from '../../lib/works.ts';
import { json } from '../../lib/http.ts';

export const GET: APIRoute = async (ctx) => {
  try {
    return json(ctx, { works: listWorks() });
  } catch (e) {
    return json(ctx, { error: (e as Error).message }, 500);
  }
};