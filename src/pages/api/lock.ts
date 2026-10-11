import type { APIRoute } from 'astro';
import { clearIdle } from '../../lib/auth/idle.ts';
import { DEVICE_COOKIE } from '../../lib/config.ts';
import { flushAll } from '../../lib/autosave.ts';
import { json } from '../../lib/http.ts';

export const POST: APIRoute = async (ctx) => {
  // lock/log-out must not strand a pending burst uncommitted
  await flushAll();
  const token = ctx.cookies.get(DEVICE_COOKIE)?.value;
  if (token) clearIdle(token);
  return json(ctx, { ok: true });
};