// Shared editor extension assembly for the live editor.
import { EditorState, type Extension, type Transaction } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { createPreview, focusToggle, type OpenLink } from './preview.ts';

export type EditorHooks = {
  onOpenLink: OpenLink;
  onUpdate: (u: { docChanged: boolean; state: EditorState }) => void;
  onTrackTransaction: (tr: Transaction) => null; // accumulates dirty words only
  getView: () => EditorView | null; // for focus/blur; null while constructing
};

export function editorExtensions(hooks: EditorHooks): Extension[] {
  return [
    keymap.of([...defaultKeymap, ...historyKeymap]),
    history(),
    EditorView.lineWrapping,
    createPreview(hooks.onOpenLink),
    EditorState.transactionExtender.of(hooks.onTrackTransaction),
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
