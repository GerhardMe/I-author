import { defineMiddleware } from 'astro:middleware';
import { DEVICE_COOKIE, DEVICE_TTL_MS } from './lib/config.ts';
import { createToken, tokenExp, verifyToken } from './lib/auth/device.ts';
import { isIdleLocked, touch } from './lib/auth/idle.ts';
import { loadSecrets } from './lib/auth/secrets.ts';
import { isSecure, json } from './lib/http.ts';

const SETUP_PATHS = new Set(['/setup', '/api/setup']);
const ALWAYS_PUBLIC = new Set(['/login', '/api/login', '/api/session', '/api/logout']);

export const onRequest = defineMiddleware(async (ctx, next) => {
  const url = new URL(ctx.request.url);
  const p = url.pathname.replace(/\/+$/, '') || '/';
  const secrets = loadSecrets();

  if (!secrets) {
    if (SETUP_PATHS.has(p)) return next();
    if (p.startsWith('/api/')) return json(ctx, { error: 'not set up' }, 401);
    return ctx.redirect('/setup');
  }
  if (SETUP_PATHS.has(p)) {
    if (p.startsWith('/api/')) return json(ctx, { error: 'already set up' }, 403);
    return ctx.redirect('/');
  }

  if (p === '/api/session' || p === '/api/logout') return next();

  const token = ctx.cookies.get(DEVICE_COOKIE)?.value;
  const valid = verifyToken(token, secrets.sessionSecret);

  if (p === '/login') {
    if (valid && token && !isIdleLocked(token)) return ctx.redirect('/');
    return next();
  }
  if (ALWAYS_PUBLIC.has(p)) return next();

  if (!valid) {
    if (p.startsWith('/api/')) return json(ctx, { error: 'anon' }, 401);
    return ctx.redirect('/login');
  }

  if (isIdleLocked(token!)) {
    if (p.startsWith('/api/')) return json(ctx, { error: 'locked' }, 401);
    return ctx.redirect('/login?locked=1');
  }

  touch(token!);

  if (tokenExp(token) - Date.now() < DEVICE_TTL_MS / 2) {
    const { token: fresh } = createToken(secrets.sessionSecret, DEVICE_TTL_MS);
    ctx.cookies.set(DEVICE_COOKIE, fresh, {
      path: '/',
      httpOnly: true,
      sameSite: 'strict',
      secure: isSecure(ctx),
      maxAge: DEVICE_TTL_MS / 1000,
    });
  }

  return next();
});