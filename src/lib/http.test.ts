import './test-setup.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clientIp } from './http.ts';
import type { APIContext } from 'astro';

function ctx(ip: string, headers: Record<string, string> = {}): APIContext {
  return {
    clientAddress: ip,
    request: { headers: new Headers(headers) },
  } as unknown as APIContext;
}

test('clientIp is the socket address; x-forwarded-for is ignored', () => {
  // XFF is client-supplied and forgeable; behind Caddy every socket address is
  // the proxy anyway, so the rate limit is one global bucket — intended
  assert.equal(clientIp(ctx('10.0.0.7', { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' })), '10.0.0.7');
  assert.equal(clientIp(ctx('10.0.0.7')), '10.0.0.7');
  assert.equal(clientIp(ctx('10.0.0.7', { 'x-forwarded-for': 'evil' })), '10.0.0.7');
});
