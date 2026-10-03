const attempts = new Map<string, { fails: number; until: number }>();
let lastSweep = 0;

function sweep(): void {
  const now = Date.now();
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [k, a] of attempts) {
    if (a.until < now) attempts.delete(k);
  }
}

export function isBlocked(key: string): boolean {
  sweep();
  const a = attempts.get(key);
  return !!a && a.until > Date.now();
}

export function recordFail(key: string): void {
  const a = attempts.get(key) ?? { fails: 0, until: 0 };
  a.fails += 1;
  const lockMs = a.fails >= 5 ? Math.min(2 ** (a.fails - 5) * 30_000, 15 * 60_000) : 0;
  a.until = Date.now() + lockMs;
  attempts.set(key, a);
}

export function recordSuccess(key: string): void {
  attempts.delete(key);
}