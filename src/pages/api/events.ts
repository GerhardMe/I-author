// GET /api/events — the commit announcement stream (server-sent events).
// Every successful commit in the works dir rides out here: the seq orders
// the events, the coordinates update the live history view. On connect the
// current seq goes out first — the baseline that closes offline gaps on
// reconnect (missed commits produce a seq jump, which the client treats
// exactly like a fresh event). Reads ride
// the normal auth middleware; a logged-out tab gets 401 and EventSource
// stops itself.
import type { APIRoute } from 'astro';
import { commitSeq, onCommit } from '../../lib/git.ts';

const PING_MS = 20_000;

export const GET: APIRoute = (ctx) => {
  const encoder = new TextEncoder();
  let off: (() => void) | null = null;
  let ping: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream({
    start(controller) {
      const cleanup = () => {
        if (off) off();
        off = null;
        if (ping) {
          clearInterval(ping);
          ping = null;
        }
        try {
          controller.close();
        } catch {
          // already closed
        }
      };
      const send = (data: unknown): void => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          cleanup();
        }
      };
      ctx.request.signal.addEventListener('abort', cleanup);
      send({ base: commitSeq() }); // the reconnect baseline, before subscribing
      off = onCommit(send);
      ping = setInterval(() => {
        // a comment line: keeps Caddy/proxies from idling the connection
        try {
          controller.enqueue(encoder.encode(': ping\n\n'));
        } catch {
          cleanup();
        }
      }, PING_MS);
    },
    cancel() {
      if (off) off();
      off = null;
      if (ping) {
        clearInterval(ping);
        ping = null;
      }
    },
  });
  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
    },
  });
};
