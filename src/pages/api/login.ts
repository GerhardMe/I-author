import type { APIRoute } from 'astro';
import { createToken, verifyToken } from '../../lib/auth/device.ts';
import { clearIdle, touch } from '../../lib/auth/idle.ts';
import { isValidPin, verifySecret } from '../../lib/auth/pin.ts';
import { isBlocked, recordFail, recordSuccess } from '../../lib/auth/ratelimit.ts';
import { findRecoveryEntry } from '../../lib/auth/recovery.ts';
import { loadSecrets, saveSecrets } from '../../lib/auth/secrets.ts';
import { verifyTotp } from '../../lib/totp.ts';
import { clientIp, isSecure, json } from '../../lib/http.ts';
import { DEVICE_COOKIE, DEVICE_TTL_MS } from '../../lib/config.ts';

export const POST: APIRoute = async (ctx) => {
  const secrets = loadSecrets();
  if (!secrets) return json(ctx, { error: 'not set up' }, 401);

  const ip = clientIp(ctx);
  if (isBlocked(ip)) return json(ctx, { error: 'rate_limited' }, 429);

  const body = (await ctx.request.json().catch(() => null)) as
    | { pin?: string; totp?: string; recovery?: string }
    | null;
  const pin = body?.pin ?? '';
  if (!isValidPin(pin)) {
    recordFail(ip);
    return json(ctx, { error: 'wrong' }, 401);
  }

  const token = ctx.cookies.get(DEVICE_COOKIE)?.value;
  const trusted = verifyToken(token, secrets.sessionSecret);
  const pinOk = verifySecret(pin, secrets.pin);

  let ok = false;
  let recoveryEntry: ReturnType<typeof findRecoveryEntry> = null;
  if (pinOk) {
    if (trusted) {
      ok = true; // device already validated with TOTP once; PIN re-entry is enough
    } else {
      ok =
        verifyTotp(secrets.totpSecret, body?.totp ?? '') ||
        !!(recoveryEntry = findRecoveryEntry(body?.recovery ?? '', secrets.recovery));
    }
  }

  if (!ok) {
    recordFail(ip);
    return json(ctx, { error: 'wrong' }, 401);
  }

  if (recoveryEntry) {
    recoveryEntry.used = true; // single use
    saveSecrets(secrets);
  }

  recordSuccess(ip);
  if (token) clearIdle(token);
  const { token: fresh } = createToken(secrets.sessionSecret, DEVICE_TTL_MS);
  touch(fresh);
  ctx.cookies.set(DEVICE_COOKIE, fresh, {
    path: '/',
    httpOnly: true,
    sameSite: 'strict',
    secure: isSecure(ctx),
    maxAge: DEVICE_TTL_MS / 1000,
  });
  return json(ctx, { ok: true });
};