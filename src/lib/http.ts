import type { APIContext } from 'astro';
import { FORCE_SECURE_COOKIES } from './config.ts';

// a missing works entry: routes decide the status by TYPE, not by comparing
// error message text (a renamed message once meant a silently wrong status)
export class NotFoundError extends Error {}

export function json(ctx: APIContext, data: unknown, status = 200, noStore = false): Response {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  // one-time secrets (setup) must never sit in a shared or browser cache
  if (noStore) headers['cache-control'] = 'no-store';
  return new Response(JSON.stringify(data), { status, headers });
}

export function isSecure(ctx: APIContext): boolean {
  return FORCE_SECURE_COOKIES || ctx.request.headers.get('x-forwarded-proto') === 'https';
}

// the socket address only: behind Caddy every request arrives from the proxy,
// so the login rate limit is one global bucket — intended. x-forwarded-for is
// client-supplied and forgeable, which would make the lock trivially bypassable
export function clientIp(ctx: APIContext): string {
  try {
    return ctx.clientAddress;
  } catch {
    return 'unknown';
  }
}