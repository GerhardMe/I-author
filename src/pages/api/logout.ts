import type { APIRoute } from 'astro';
import { clearIdle } from '../../lib/auth/idle.ts';
import { DEVICE_COOKIE } from '../../lib/config.ts';
import { json } from '../../lib/http.ts';

export const POST: APIRoute = async (ctx) => {
  const token = ctx.cookies.get(DEVICE_COOKIE)?.value;
  if (token) clearIdle(token);
  ctx.cookies.delete(DEVICE_COOKIE, { path: '/' });
  return json(ctx, { ok: true });
};