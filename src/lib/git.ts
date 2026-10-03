import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { WORKS_DIR } from './config.ts';

const run = promisify(execFile);

export async function ensureRepo(): Promise<void> {
  fs.mkdirSync(WORKS_DIR, { recursive: true });
  if (!fs.existsSync(path.join(WORKS_DIR, '.git'))) {
    await run('git', ['init', '-q', '-b', 'main'], { cwd: WORKS_DIR });
    await run('git', ['config', 'user.name', 'iauthor'], { cwd: WORKS_DIR });
    await run('git', ['config', 'user.email', 'iauthor@local'], { cwd: WORKS_DIR });
  }
}

export async function commit(msg: string): Promise<boolean> {
  try {
    await ensureRepo();
    await run('git', ['add', '-A'], { cwd: WORKS_DIR });
    const status = await run('git', ['status', '--porcelain'], { cwd: WORKS_DIR });
    if (!status.stdout.trim()) return false;
    await run(
      'git',
      ['-c', 'user.name=iauthor', '-c', 'user.email=iauthor@local', 'commit', '-q', '-m', msg],
      { cwd: WORKS_DIR },
    );
    return true;
  } catch (err) {
    console.warn('[iauthor] git commit failed:', err);
    return false;
  }
}