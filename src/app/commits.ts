// The server's commit announcements (SSE /api/events): one EventSource for
// the whole app, feeding the live history view — every commit slides into
// the DAG while it is open. The connect/reconnect baseline carries the
// server's current seq (no client action needed on it anymore: undo/redo
// are pure native CodeMirror and never key off commits).
import { refreshHistory } from './history.ts';

export function openCommits(): void {
  const es = new EventSource('/api/events');
  es.onmessage = (m) => {
    try {
      JSON.parse(m.data) as { base?: number; seq?: number };
      refreshHistory();
    } catch {
      // a malformed event is skipped, the stream lives on
    }
  };
  // a logged-out tab (401) closes the stream for good; a dropped connection
  // retries automatically and re-baselines on reconnect
  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED) es.close();
  };
}
