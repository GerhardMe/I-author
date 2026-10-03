import { IDLE_LOCK_MS } from '../config.ts';
import { tokenKey } from './device.ts';

const seen = new Map<string, number>();

export function touch(token: string): void {
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