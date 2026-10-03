import type { APIRoute } from 'astro';
import { randomBytes } from 'node:crypto';
import { hashSecret, isValidPin } from '../../lib/auth/pin.ts';
import { makeRecoveryCodes } from '../../lib/auth/recovery.ts';
import { saveSecrets, loadSecrets } from '../../lib/auth/secrets.ts';
import { generateSecret, otpauthUri } from '../../lib/totp.ts';
import { json } from '../../lib/http.ts';
import type { Secrets } from '../../lib/auth/secrets.ts';

export const POST: APIRoute = async (ctx) => {
  if (loadSecrets()) return json(ctx, { error: 'already set up' }, 403);

  const body = (await ctx.request.json().catch(() => null)) as { pin?: string; pin2?: string } | null;
  const pin = body?.pin ?? '';
  if (!isValidPin(pin) || pin !== body?.pin2) {
    return json(ctx, { error: 'PIN must be 4-12 digits and match' }, 400);
  }

  const totpSecret = generateSecret();
  const { entries: recovery, codes: recoveryCodes } = makeRecoveryCodes();

  const secrets: Secrets = {
    version: 1,
    createdAt: new Date().toISOString(),
    pin: hashSecret(pin),
    totpSecret,
    sessionSecret: randomBytes(32).toString('hex'),
    masterKey: randomBytes(32).toString('hex'),
    recovery,
  };
  saveSecrets(secrets);

  return json(ctx, {
    totpSecret,
    otpauthUri: otpauthUri(totpSecret, 'you', 'Iauthor'),
    masterKey: secrets.masterKey,
    recoveryCodes,
  });
};