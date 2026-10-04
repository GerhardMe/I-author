#!/usr/bin/env node
// One-off migration: make the NN_ prefixes contiguous everywhere and give
// top-level works a prefix too. The prefix is order only (phase 2 of the
// numbering rework), so this makes the disk say what the labels already say.
//
// Same rules as works.ts applyOrder: reserved bare names (notes.md, title.md,
// bare matter) keep no prefix and are skipped, order is naturalCompare, and
// every move is parked under a temp name first so a swap of 01/02 cannot
// clobber a file. Dry-run by default; pass --apply to execute.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const apply = process.argv.includes('--apply');
const root = process.env.IAUTHOR_WORKS_DIR || path.join(process.homedir(), 'writing', 'works');

const MD = /\.(md|markdown)$/i;
const RESERVED = [
  /^notes\.md$/i,
  /^title\.md$/i,
  /^(front_matter|appendix|afterword|preface|foreword|epilogue|acknowledgements|colophon|dedication|epigraph|prologue)\.md$/i,
];

// naturalCompare, same as naming.ts
function naturalCompare(a, b) {
  const ax = a.toLowerCase().match(/(\d+|\D+)/g) ?? [];
  const bx = b.toLowerCase().match(/(\d+|\D+)/g) ?? [];
  for (let i = 0; i < Math.min(ax.length, bx.length); i++) {
    const an = /^\d+$/.test(ax[i]);
    const bn = /^\d+$/.test(bx[i]);
    if (an && bn) {
      const d = Number(ax[i]) - Number(bx[i]);
      if (d) return d;
    } else if (an !== bn) {
      return an ? -1 : 1;
    } else if (ax[i] !== bx[i]) {
      return ax[i] < bx[i] ? -1 : 1;
    }
  }
  return ax.length - bx.length;
}

const stem = (name) => name.replace(MD, '').replace(/^\d{1,4}[-_]/, '');
const target = (name, i) =>
  `${String(i + 1).padStart(2, '0')}_${stem(name)}${MD.test(name) ? '.md' : ''}`;

if (!fs.existsSync(root)) {
  console.error(`works dir not found: ${root}`);
  process.exit(1);
}

let count = 0;

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const names = entries
    .filter((e) => !e.name.startsWith('.') && (e.isDirectory() || MD.test(e.name)))
    .map((e) => e.name)
    .filter((n) => !RESERVED.some((r) => r.test(n)))
    .sort(naturalCompare);
  const targets = names.map(target);
  const moved = names.map((n, i) => n !== targets[i]);
  const finalNames = names.map((n, i) => (moved[i] ? targets[i] : n));

  names.forEach((n, i) => {
    if (!moved[i]) return;
    count++;
    console.log(`  ${path.relative(root, dir)}/${n} -> ${targets[i]}`);
  });

  if (apply && moved.some(Boolean)) {
    // phase 1: park everything that moves (dot-prefixed, so nothing scans it)
    names.forEach((n, i) => {
      if (!moved[i]) return;
      const from = path.join(dir, n);
      const to = path.join(dir, `.__ord${i}__${MD.test(n) ? '.md' : ''}`);
      fs.renameSync(from, to);
      if (fs.existsSync(`${from}.pdf`)) fs.renameSync(`${from}.pdf`, `${to}.pdf`);
    });
    // phase 2: place it under its final name
    names.forEach((n, i) => {
      if (!moved[i]) return;
      const from = path.join(dir, `.__ord${i}__${MD.test(n) ? '.md' : ''}`);
      const to = path.join(dir, targets[i]);
      fs.renameSync(from, to);
      if (fs.existsSync(`${from}.pdf`)) fs.renameSync(`${from}.pdf`, `${to}.pdf`);
    });
  }

  // recurse: after a rename the children sit under their FINAL parent name
  const finalOf = new Map(names.map((n, i) => [n, finalNames[i]]));
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const sub = apply ? (finalOf.get(e.name) ?? e.name) : e.name;
    walk(path.join(dir, sub));
  }
}

walk(root);

if (!count) {
  console.log('nothing to renumber');
  process.exit(0);
}

if (!apply) {
  console.log(`\ndry run: ${count} rename(s). Re-run with --apply to execute.`);
  process.exit(0);
}

execFileSync('git', ['add', '-A'], { cwd: root });
try {
  execFileSync('git', ['commit', '-m', 'numbering: contiguous NN_ prefixes everywhere'], {
    cwd: root,
    stdio: 'pipe',
  });
  console.log(`\napplied ${count} rename(s), committed`);
} catch {
  console.log(`\napplied ${count} rename(s), nothing new to commit`);
}