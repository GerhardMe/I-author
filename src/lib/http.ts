import type { APIContext } from 'astro';
import { FORCE_SECURE_COOKIES } from './config.ts';

export function json(ctx: APIContext, data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function isSecure(ctx: APIContext): boolean {
  return FORCE_SECURE_COOKIES || ctx.request.headers.get('x-forwarded-proto') === 'https';
}

export function clientIp(ctx: APIContext): string {
  const fwd = ctx.request.headers.get('x-forwarded-for');
  if (fwd) return fwd.split(',')[0].trim();
  try {
    return ctx.clientAddress;
  } catch {
    return 'unknown';
  }
}