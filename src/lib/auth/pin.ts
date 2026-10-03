import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };

export function hashSecret(value: string): { salt: string; hash: string } {
  const salt = randomBytes(16);
  const hash = scryptSync(value.normalize('NFKC'), salt, 32, SCRYPT);
  return { salt: salt.toString('hex'), hash: hash.toString('hex') };
}

export function verifySecret(value: string, rec: { salt: string; hash: string }): boolean {
  try {
    const salt = Buffer.from(rec.salt, 'hex');
    const expect = Buffer.from(rec.hash, 'hex');
    const got = scryptSync(value.normalize('NFKC'), salt, expect.length, SCRYPT);
    return timingSafeEqual(got, expect);
  } catch {
    return false;
  }
}

export function isValidPin(pin: string): boolean {
  return /^\d{4,12}$/.test(pin);
}