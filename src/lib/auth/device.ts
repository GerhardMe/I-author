import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

function hmac(secretHex: string, payload: string): Buffer {
  return createHmac('sha256', Buffer.from(secretHex, 'hex')).update(payload).digest();
}

export function createToken(secretHex: string, ttlMs: number): { token: string; exp: number } {
  const exp = Date.now() + ttlMs;
  const nonce = randomBytes(12).toString('hex');
  const payload = `${exp}.${nonce}`;
  const sig = hmac(secretHex, payload).toString('base64url');
  return { token: `${payload}.${sig}`, exp };
}

export function verifyToken(token: string | undefined, secretHex: string): boolean {
  if (!token) return false;
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [expStr, nonce, sig] = parts;
  const expect = hmac(secretHex, `${expStr}.${nonce}`);
  let got: Buffer;
  try {
    got = Buffer.from(sig, 'base64url');
  } catch {
    return false;
  }
  if (got.length !== expect.length || !timingSafeEqual(got, expect)) return false;
  const exp = Number(expStr);
  return Number.isFinite(exp) && exp > Date.now();
}

export function tokenExp(token: string | undefined): number {
  if (!token) return 0;
  const exp = Number(token.split('.')[0]);
  return Number.isFinite(exp) ? exp : 0;
}

export function tokenKey(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}