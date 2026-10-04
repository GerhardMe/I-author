import os from 'node:os';
import path from 'node:path';

export const WORKS_DIR =
  process.env.IAUTHOR_WORKS_DIR ?? path.join(os.homedir(), 'writing', 'works');

export const SECRETS_FILE =
  process.env.IAUTHOR_SECRETS_FILE ?? path.resolve('secrets', 'secrets.json');

export const DEVICE_COOKIE = 'ia_device';
export const DEVICE_TTL_MS = 30 * 24 * 3600 * 1000;

function parseDuration(s: string): number {
  const m = /^(\d+)\s*([smhd])$/.exec(s.trim());
  if (!m) return 12 * 3600 * 1000;
  const n = Number(m[1]);
  return n * (m[2] === 's' ? 1000 : m[2] === 'm' ? 60_000 : m[2] === 'h' ? 3_600_000 : 86_400_000);
}

export const IDLE_LOCK_MS = parseDuration(process.env.IAUTHOR_IDLE_LOCK ?? '12h');

// anything affirmative — not just exactly "1" — so `true`/`yes` don't silently
// drop Secure from the cookie
export const FORCE_SECURE_COOKIES = /^(1|true|yes|on)$/i.test(process.env.IAUTHOR_SECURE ?? '');