// Per-IP login rate limiting. 4 fails are free; the 5th starts a lock that
// doubles per further fail up to 15 min. Fail counters expire after a quiet
// window — but only via `at`, never by treating until=0 as "already past"
// (that once let a sweep silently wipe unlocked counters mid-sequence).
const attempts = new Map<string, { fails: number; until: number; at: number }>();
const COUNTER_TTL_MS = 10 * 60_000; // unlocked fail counter lifetime
const SWEEP_EVERY_MS = 60_000;
let lastSweep = 0;

function sweep(): void {
  const now = Date.now();
  if (now - lastSweep < SWEEP_EVERY_MS) return;
  lastSweep = now;
  for (const [k, a] of attempts) {
    if (a.until ? a.until <= now : now - a.at > COUNTER_TTL_MS) attempts.delete(k);
  }
}

// test hook: a sweep as if the SWEEP_EVERY_MS cooldown had elapsed
export function forceSweep(): void {
  lastSweep = 0;
  sweep();
}

export function isBlocked(key: string): boolean {
  sweep();
  const a = attempts.get(key);
  return !!a && a.until > Date.now();
}

export function recordFail(key: string): void {
  sweep();
  const now = Date.now();
  const a = attempts.get(key) ?? { fails: 0, until: 0, at: now };
  a.at = now;
  a.fails += 1;
  a.until = a.fails >= 5 ? Math.min(2 ** (a.fails - 5) * 30_000, 15 * 60_000) + now : 0;
  attempts.set(key, a);
}

export function recordSuccess(key: string): void {
  attempts.delete(key);
}
