// GET /api/git/history — the whole DAG for the history view: commits with
// parents and changed paths, the branch tips (the undo-* refs the undos
// created), and the current HEAD so the view can mark "you are here".
// Capped: the latest 200 commits across all refs. Read-only — no queue, a
// concurrent commit cannot corrupt a log read.
import type { APIRoute } from 'astro';
import { flushAll } from '../../../lib/autosave.ts';
import { gitOut } from '../../../lib/git.ts';
import { json } from '../../../lib/http.ts';

const MAX_COMMITS = 200;

export const GET: APIRoute = async (ctx) => {
  try {
    // the pending burst commits first, so the view shows the text just typed
    await flushAll();
    // the @@@ marker cannot collide: our own messages and name-status lines
    // never start with it
    let log = '';
    try {
      log = await gitOut([
        'log',
        '--all',
        '--topo-order',
        `--max-count=${MAX_COMMITS}`,
        '--name-status',
        '--pretty=format:@@@%H%x09%P%x09%at%x09%s',
      ]);
    } catch {
      // a repo with no commits yet: an empty DAG
      return json(ctx, { head: null, branches: [], commits: [] });
    }
    const commits: {
      sha: string;
      parents: string[];
      at: number;
      subject: string;
      changed: string[];
    }[] = [];
    let cur: (typeof commits)[number] | null = null;
    for (const line of log.split('\n')) {
      if (line.startsWith('@@@')) {
        const [sha = '', parents = '', at = '', subject = ''] = line
          .slice(3)
          .split('\t');
        cur = {
          sha,
          parents: parents ? parents.split(' ') : [],
          at: Number(at) || 0,
          subject,
          changed: [],
        };
        commits.push(cur);
        continue;
      }
      if (!line.trim() || !cur) continue;
      const [status, ...rest] = line.split('\t');
      // renames contribute both sides; the view lists what the commit touched
      if (status![0] === 'R' || status![0] === 'C') cur.changed.push(rest[0]!, rest[1]!);
      else cur.changed.push(rest[0]!);
    }
    const branches: { name: string; sha: string }[] = [];
    const refs = await gitOut([
      'for-each-ref',
      'refs/heads',
      '--format=%(refname:short)%09%(objectname)',
    ]);
    for (const line of refs.split('\n')) {
      if (!line.trim()) continue;
      const [name = '', sha = ''] = line.split('\t');
      branches.push({ name, sha });
    }
    let head: string | null = null;
    try {
      head = (await gitOut(['rev-parse', 'HEAD'])).trim();
    } catch {
      head = null; // no commits yet
    }
    return json(ctx, { head, branches, commits });
  } catch (e) {
    return json(ctx, { error: (e as Error).message }, 400);
  }
};
