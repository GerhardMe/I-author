// Every static-page element reference the app shell needs, built once.
// JS-created DOM (the context menu, the insert line, the measure handles and
// the ch probe) is created in its feature module — but its styles are global
// (global.css): Astro scoping would never match dynamically created elements.

export const treeEl = document.getElementById('tree')!;
export const sidebarEl = document.getElementById('sidebar')!;
export const empty = document.getElementById('empty')!;
export const doc = document.getElementById('doc')!;
export const docTitle = document.getElementById('doc-title')!;
export const docBody = document.getElementById('doc-body')!;
export const docWords = document.getElementById('doc-words')!;
export const docDraft = document.getElementById('doc-draft')!;
export const renameInput = document.getElementById('doc-rename') as HTMLInputElement;
export const hideBtn = document.getElementById('hide-drafts') as HTMLButtonElement;
export const hideEye = document.getElementById('hide-drafts-eye')!;
export const newDialog = document.getElementById('new-dialog')!;
export const newCard = document.getElementById('new-card')!;
export const newIn = document.getElementById('new-in')!;
export const newErr = document.getElementById('new-err')!;
export const newName = document.getElementById('new-name') as HTMLInputElement;
export const editorHost = document.getElementById('editor-host')!;
export const emptyBody = document.getElementById('empty-body')!;
export const welcomeNotes = document.getElementById('welcome-notes') as HTMLTemplateElement;
export const histEl = document.getElementById('history')!;
export const histScroll = document.getElementById('hist-scroll')!;
export const gitBtn = document.getElementById('git-history') as HTMLButtonElement;
export const undoBtn = document.getElementById('undo-btn') as HTMLButtonElement;
export const redoBtn = document.getElementById('redo-btn') as HTMLButtonElement;
export const pdfBtn = document.getElementById('pdf-toggle') as HTMLButtonElement;
export const pdfMenu = document.getElementById('pdf-menu')!;
export const appEl = document.querySelector('.app') as HTMLElement;
export const mainEl = document.querySelector('.main') as HTMLElement;
export const brand = document.getElementById('brand') as HTMLButtonElement;
export const toolbarEl = document.querySelector('.toolbar') as HTMLElement;
export const sideFootEl = document.querySelector('.side-foot') as HTMLElement;
// clicking anywhere in the header (except the buttons) opens the raw-name
// editor. Scoped to #doc: the welcome screen (#empty) has its own .doc-head
// further up the markup and must never receive the rename wiring, the ch
// probe or the measure handles — document.querySelector would find THAT
// header first.
export const docHead = doc.querySelector('.doc-head')!;
// the measure handles: static markup in DocView.astro (so they paint with the
// page instead of arriving with the app bundle); only the wiring lives in
// measure.ts. The ch probe is invisible, so it stays JS-created.
export const measureA = docHead.querySelector('.measure-a') as HTMLButtonElement;
export const measureB = docHead.querySelector('.measure-b') as HTMLButtonElement;
