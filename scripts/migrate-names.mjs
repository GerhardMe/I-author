#!/usr/bin/env node
// One-off migration: rename works entries from NN-name to NN_name
// (all hyphens -> underscores in file and folder names). Deepest-first.
// Dry-run by default; pass --apply to rename and git-commit.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const apply = process.argv.includes('--apply');
const root = process.env.IAUTHOR_WORKS_DIR || path.join(os.homedir(), 'writing', 'works');

if (!fs.existsSync(root)) {
  console.error(`works dir not found: ${root}`);
  process.exit(1);
}

const renames = [];

function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walk(abs);
    if (!e.name.includes('-')) continue;
    const target = e.name.replaceAll('-', '_');
    if (fs.existsSync(path.join(dir, target))) {
      console.error(`SKIP (target exists): ${abs} -> ${target}`);
      continue;
    }
    renames.push([abs, path.join(dir, target)]);
  }
}

walk(root);

if (!renames.length) {
  console.log('nothing to rename');
  process.exit(0);
}

for (const [from, to] of renames) console.log(`${from} -> ${to}`);

if (!apply) {
  console.log(`\ndry run: ${renames.length} rename(s). Re-run with --apply to execute.`);
  process.exit(0);
}

for (const [from, to] of renames) fs.renameSync(from, to);

execFileSync('git', ['add', '-A'], { cwd: root });
try {
  execFileSync('git', ['commit', '-m', 'rename entries to underscore naming'], {
    cwd: root,
    stdio: 'pipe',
  });
  console.log(`applied ${renames.length} rename(s), committed`);
} catch {
  console.log(`applied ${renames.length} rename(s), nothing new to commit`);
}