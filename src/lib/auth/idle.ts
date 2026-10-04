import { IDLE_LOCK_MS } from '../config.ts';
import { tokenKey } from './device.ts';

const seen = new Map<string, number>();
const SWEEP_EVERY_MS = 60_000;
let lastSweep = 0;

// entries older than the idle lock are meaningless — the session is locked by
// then no matter what the stored time is — so sweeping keeps the map at the
// size of the live sessions instead of one entry per login forever
function sweep(): void {
  const now = Date.now();
  if (now - lastSweep < SWEEP_EVERY_MS) return;
  lastSweep = now;
  for (const [k, t] of seen) {
    if (now - t > IDLE_LOCK_MS) seen.delete(k);
  }
}

export function touch(token: string): void {
  sweep();
  seen.set(tokenKey(token), Date.now());
}

export function isIdleLocked(token: string): boolean {
  const last = seen.get(tokenKey(token));
  if (last === undefined) return true;
  return Date.now() - last > IDLE_LOCK_MS;
}

export function clearIdle(token: string): void {
  seen.delete(tokenKey(token));
}