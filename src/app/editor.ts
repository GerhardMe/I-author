// The editor session: CodeMirror lifecycle, the draft flush, the commit
// boundary that keeps the native undo stack uncommitted-only, and the
// leaving/opening handoffs every other view goes through.

import { countWords } from '../lib/words.ts';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { loadDraft, saveDraft, dropDraft } from '../lib/sync.ts';
import { editorExtensions } from '../lib/editor.ts';
import { byPath, currentFile, setCurrentFile, setCurrentGroup, setSelected } from './state.ts';
import { docWords, editorHost } from './dom.ts';
import {
  pushEndState,
  refreshRowStatus,
  renderTree,
  setSync,
  syncState,
  syncStateFromDoc,
} from './tree.ts';
import { sync } from './sync.ts';
import { openFile } from './toc.ts';
import { gitUndo, redoExhausted } from './history.ts';

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

// ---------- commit boundary: native undo stays uncommitted-only ----------
// Native Ctrl+Z/Ctrl+Shift+Z covers only work since the last commit; the
// native stack is reset at every commit boundary by rebuilding the editor
// with the same doc. Two triggers approximate the server coalescer
// (5s idle / >=1000 chars): the PUT response's `committed` flag (the char
// trigger fired during that write) and a 5s idle timer armed after each
// confirmed push (the idle trigger). When typing is in flight the boundary
// waits for the next clean push confirm — a reset never kills native undo
// of unsynced text.
let boundaryTimer: ReturnType<typeof setTimeout> | null = null;
let boundaryPending = false;

export function markBoundaryPending(): void {
  boundaryPending = true;
}

function resetStack(): void {
  if (!editor || !currentFile) return;
  const content = editor.state.doc.toString();
  if (sync.ahead(content)) return; // only at a clean boundary
  const sel = editor.state.selection;
  const top = editor.scrollDOM.scrollTop;
  destroyEditor();
  const view = makeEditor(content);
  view.dispatch({ selection: sel });
  view.scrollDOM.scrollTop = top;
}

function boundary(): void {
  if (boundaryTimer) {
    clearTimeout(boundaryTimer);
    boundaryTimer = null;
  }
  if (!editor || dirty()) return; // typing in flight: the next clean confirm fires it
  resetStack();
  boundaryPending = false;
}

function armBoundary(): void {
  if (boundaryTimer) clearTimeout(boundaryTimer);
  boundaryTimer = setTimeout(() => {
    boundaryTimer = null;
    boundary();
  }, 5000);
}

// after a confirmed push: a pending committed-flag boundary fires at the
// next clean confirm, otherwise the idle boundary arms
export function afterPush(ok: boolean): void {
  if (!ok) return;
  if (pushEndState() !== 'idle') return;
  if (boundaryPending) boundary();
  else armBoundary();
}

function onEditorUpdate(u: { docChanged: boolean; state: { doc: { toString(): string } } }): void {
  if (!u.docChanged) return;
  docWords.textContent = `${countWords(u.state.doc.toString())} words`;
  // while a reply is awaited (or a push has failed) the spinner/! own the
  // row; the dot comes back when a push confirms (pushEndState recomputes)
  if (syncState !== 'pushing' && syncState !== 'error')
    setSync(syncStateFromDoc(u.state.doc.toString()));
  // typing postpones the idle boundary (the flag from a committed push
  // survives: it fires at the next clean confirm instead)
  if (boundaryTimer) {
    clearTimeout(boundaryTimer);
    boundaryTimer = null;
  }
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
    onGitUndo: () => {
      void gitUndo();
    },
    onRedoExhausted: redoExhausted,
  };
  const view = new EditorView({
    state: EditorState.create({
      doc: content,
      extensions: editorExtensions(hooks),
    }),
    parent: editorHost,
  });
  editor = view;
  return view;
}

export function destroyEditor(): void {
  if (editor) {
    editor.destroy();
    editor = null;
  }
  editorHost.replaceChildren();
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
