// The editor session: CodeMirror lifecycle, the draft flush, and the
// leaving/opening handoffs every other view goes through. Undo/redo are
// pure native CodeMirror — no commit boundaries, no git escalation (owner
// decision 2026-10-11): an undo is an ordinary edit and commits like one.

import { countWords } from '../lib/words.ts';
import { EditorState } from '@codemirror/state';
import { undoDepth, redoDepth } from '@codemirror/commands';
import { EditorView } from '@codemirror/view';
import { loadDraft, saveDraft, dropDraft } from '../lib/sync.ts';
import { editorExtensions } from '../lib/editor.ts';
import { byPath, currentFile, setCurrentFile, setCurrentGroup, setSelected, showCounter } from './state.ts';
import { editorHost, undoBtn, redoBtn } from './dom.ts';
import {
  refreshRowStatus,
  renderTree,
  setSync,
  syncState,
  syncStateFromDoc,
} from './tree.ts';
import { sync } from './sync.ts';
import { openFile } from './toc.ts';

let editor: EditorView | null = null;

export function getEditor(): EditorView | null {
  return editor;
}

export function flushDraft(): void {
  if (!currentFile || !editor) return;
  const content = editor.state.doc.toString();
  // save only unsynced text; a clean doc's draft is redundant and would
  // linger forever (nothing drops it — leavingFile skips a clean push),
  // so drop it instead: the dot logic reads the draft store
  if (sync.ahead(content)) {
    saveDraft(currentFile, {
      content,
      synced: sync.baselineLen(),
      at: Date.now(),
    });
  } else {
    dropDraft(currentFile);
  }
}

// the mobile buttons mirror the native stack: gray = nothing to undo/redo
// (no popup on an exhausted press — a disabled button just doesn't fire)
function syncUndoButtons(): void {
  undoBtn.disabled = !editor || undoDepth(editor.state) === 0;
  redoBtn.disabled = !editor || redoDepth(editor.state) === 0;
}

function onEditorUpdate(u: { docChanged: boolean; state: EditorState }): void {
  syncUndoButtons();
  if (!u.docChanged) return;
  const text = u.state.doc.toString();
  showCounter({ words: countWords(text), chars: text.length });
  // while a reply is awaited (or a push has failed) the spinner/! own the
  // row; the dot comes back when a push confirms (pushEndState recomputes)
  if (syncState !== 'pushing' && syncState !== 'error') setSync(syncStateFromDoc(text));
  scheduleDraft();
  sync.schedule();
}

let draftTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleDraft(): void {
  if (!currentFile || !editor) return;
  if (draftTimer) clearTimeout(draftTimer);
  draftTimer = setTimeout(flushDraft, 400);
}

export function makeEditor(content: string): EditorView {
  const hooks = {
    onOpenLink: openLink,
    onUpdate: onEditorUpdate,
    getView: () => editor,
  };
  const view = new EditorView({
    state: EditorState.create({
      doc: content,
      extensions: editorExtensions(hooks),
    }),
    parent: editorHost,
  });
  editor = view;
  syncUndoButtons(); // fresh session: an empty stack is all gray
  return view;
}

export function destroyEditor(): void {
  if (editor) {
    editor.destroy();
    editor = null;
  }
  editorHost.replaceChildren();
  syncUndoButtons(); // no editor: both buttons gray
}

export function dirty(): boolean {
  return !!editor && !!currentFile && sync.ahead(editor.state.doc.toString());
}

// flush + push before leaving a file (tree switch, delete)
export async function leavingFile(): Promise<void> {
  flushDraft();
  if (editor && currentFile && dirty()) await sync.pushNow();
  sync.cancel();
  destroyEditor();
  const was = currentFile;
  setCurrentFile(null);
  setCurrentGroup(null);
  setSync('idle'); // the markers speak about the open file only
  refreshRowStatus(was); // recompute the row we just left (draft may be gone)
}

// Ctrl/Cmd+S: send the current state to the server right now
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    if (editor && currentFile) {
      flushDraft();
      void sync.pushNow();
    }
  }
});

function openLink(href: string): boolean {
  if (/^(https?:|mailto:)/.test(href)) {
    window.open(href, '_blank', 'noopener');
    return true;
  }
  // relative link: resolve against the current file's folder
  const base = currentFile ? currentFile.slice(0, currentFile.lastIndexOf('/') + 1) : '';
  const stack: string[] = [];
  for (const part of (base + href).split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  const target = stack.join('/');
  const node = byPath.get(target);
  if (node && node.children === undefined) {
    setSelected(target);
    renderTree();
    void openFile(target);
    return true;
  }
  return false;
}

window.addEventListener('beforeunload', flushDraft);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') flushDraft();
});
