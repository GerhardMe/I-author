import { randomBytes } from 'node:crypto';
import type { RecoveryCode } from './secrets.ts';
import { hashSecret, verifySecret } from './pin.ts';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const RECOVERY_COUNT = 8;

function randomB32(n: number): string {
  const bytes = randomBytes(n);
  let out = '';
  for (let i = 0; i < n; i++) out += B32[bytes[i] % 32];
  return out;
}

export function makeRecoveryCodes(count = RECOVERY_COUNT): { entries: RecoveryCode[]; codes: string[] } {
  const entries: RecoveryCode[] = [];
  const codes: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = randomB32(4);
    const secret = randomB32(4);
    entries.push({ id, ...hashSecret(secret) });
    codes.push(`${id}-${secret}`);
  }
  return { entries, codes };
}

export function findRecoveryEntry(code: string, entries: RecoveryCode[]): RecoveryCode | null {
  const m = /^([A-Z2-7]{4})-([A-Z2-7]{4})$/.exec(code.trim().toUpperCase());
  if (!m) return null;
  const entry = entries.find((e) => e.id === m[1] && !e.used);
  if (!entry) return null;
  return verifySecret(m[2], entry) ? entry : null;
}