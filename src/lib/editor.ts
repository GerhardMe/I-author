// Shared editor extension assembly for the live editor.
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, undo, redo } from '@codemirror/commands';
import { createPreview, focusToggle, type OpenLink } from './preview.ts';

export type EditorHooks = {
  onOpenLink: OpenLink;
  onUpdate: (u: { docChanged: boolean; state: EditorState }) => void;
  getView: () => EditorView | null; // for focus/blur; null while constructing
  onGitUndo: () => void; // native undo exhausted → git undo
  onRedoExhausted: () => void; // native redo exhausted → the git history view
};

export function editorExtensions(hooks: EditorHooks): Extension[] {
  return [
    // the undo ladder (owner decision 2026-10-11): native undo/redo only
    // covers work since the last commit — index.astro resets the native
    // stack at every commit boundary — so an exhausted native command means
    // the boundary is crossed: escalate to git (undo) or the history view
    // (redo). This keymap must precede historyKeymap; returning true on
    // escalation keeps the default binding out of the way.
    keymap.of([
      {
        key: 'Mod-z',
        run: (v) => {
          if (undo(v)) return true;
          hooks.onGitUndo();
          return true;
        },
      },
      {
        key: 'Shift-Mod-z',
        run: (v) => {
          if (redo(v)) return true;
          hooks.onRedoExhausted();
          return true;
        },
      },
      {
        // windows/PC redo binding, same ladder
        key: 'Mod-y',
        run: (v) => {
          if (redo(v)) return true;
          hooks.onRedoExhausted();
          return true;
        },
      },
    ]),
    keymap.of([...defaultKeymap, ...historyKeymap]),
    history(),
    EditorView.lineWrapping,
    createPreview(hooks.onOpenLink),
    EditorView.updateListener.of(hooks.onUpdate),
    EditorView.domEventHandlers({
      focus: () => {
        hooks.getView()?.dispatch({ effects: focusToggle.of(null) });
        return false;
      },
      blur: () => {
        hooks.getView()?.dispatch({ effects: focusToggle.of(null) });
        return false;
      },
    }),
  ];
}
