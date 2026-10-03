import type { APIRoute } from 'astro';
import { verifyToken } from '../../lib/auth/device.ts';
import { isIdleLocked } from '../../lib/auth/idle.ts';
import { loadSecrets } from '../../lib/auth/secrets.ts';
import { json } from '../../lib/http.ts';

export const GET: APIRoute = async (ctx) => {
  const secrets = loadSecrets();
  if (!secrets) return json(ctx, { state: 'setup' });

  const token = ctx.cookies.get('ia_device')?.value;
  if (!verifyToken(token, secrets.sessionSecret)) return json(ctx, { state: 'anon' });

  return json(ctx, { state: isIdleLocked(token!) ? 'locked' : 'open' });
};