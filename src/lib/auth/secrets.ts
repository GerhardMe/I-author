import fs from 'node:fs';
import path from 'node:path';
import { SECRETS_FILE } from '../config.ts';

export interface RecoveryCode {
  id: string;
  salt: string;
  hash: string;
  used?: boolean;
}

export interface Secrets {
  version: number;
  createdAt: string;
  pin: { salt: string; hash: string };
  totpSecret: string;
  sessionSecret: string;
  masterKey: string;
  recovery: RecoveryCode[];
}

let cache: Secrets | null | undefined;

export function loadSecrets(): Secrets | null {
  if (cache !== undefined) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8')) as Secrets;
  } catch {
    cache = null;
  }
  return cache;
}

export function saveSecrets(s: Secrets): void {
  fs.mkdirSync(path.dirname(SECRETS_FILE), { recursive: true });
  const tmp = `${SECRETS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, SECRETS_FILE);
  try {
    fs.chmodSync(SECRETS_FILE, 0o600);
  } catch {
    /* not critical */
  }
  cache = s;
}