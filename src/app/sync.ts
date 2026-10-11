// The push machine instance: the hooks wire the sync engine to the app
// shell — the open file, the word counter, the tree-row status markers
// (which live in tree.ts) and the commit boundary (editor.ts).

import { createSync } from '../lib/sync.ts';
import { countWords } from '../lib/words.ts';
import { currentFile } from './state.ts';
import { docWords } from './dom.ts';
import { flushDraft, getEditor, markBoundaryPending } from './editor.ts';
import { pushEnd, pushEndState, pushStart, setSync, syncState } from './tree.ts';

export const sync = createSync({
  getPath: () => currentFile,
  getContent: () => (getEditor() ? getEditor()!.state.doc.toString() : null),
  getEditor: getEditor,
  onSaved: (content, committed) => {
    docWords.textContent = `${countWords(content)} words`;
    if (committed) markBoundaryPending(); // fires at the next clean confirm
  },
  onPushStart: () => pushStart(),
  onPushEnd: (ok) => pushEnd(ok),
  onAuthLost: () => {
    flushDraft();
    location.href = '/login?locked=1';
  },
});

// connection loss: the ! only when unsynced text is at stake (a hanging
// push lands here on its own via the fetch timeout); back online: recompute
// to the dot and retry — the next push verifies the connection for real
document.addEventListener('offline', () => {
  const editor = getEditor();
  if (editor && currentFile && sync.ahead(editor.state.doc.toString())) setSync('error');
});
document.addEventListener('online', () => {
  if (syncState === 'error') setSync(pushEndState());
  sync.schedule();
});
