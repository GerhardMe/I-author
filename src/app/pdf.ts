// The pdf compiler's client side: the style menu (mirroring pdfstyles/ on
// the server) and the compile/open flow with its background tab.

import { pdfWaitPage } from '../lib/pdf-wait.ts';
import { api, currentFile, currentGroup, hideDrafts } from './state.ts';
import { pdfBtn, pdfMenu } from './dom.ts';
import { dirty, flushDraft, getEditor } from './editor.ts';
import { sync } from './sync.ts';

// the server compiles via LaTeX (pdfstyles/ folder); the menu mirrors it
type PdfStyle = { id: string; label: string; note: string };
let pdfStyles: PdfStyle[] = [];
let presetId: string = localStorage.getItem('iauthor.pdf-preset') ?? '';

// the pdf compiles whatever is open: a chapter, or the folder index's scope
function currentScope(): string | null {
  return currentFile ?? currentGroup;
}

function syncPdfBtnTitle(): void {
  const s = pdfStyles.find((x) => x.id === presetId);
  pdfBtn.title = s
    ? `pdf (${s.label}) — read or compile this scope, right-click for sizes`
    : 'pdf — read or compile this scope, right-click for sizes';
}

export async function loadPdfStyles(): Promise<void> {
  try {
    const data = await api('/api/pdfstyles');
    pdfStyles = data.styles as PdfStyle[];
  } catch {
    pdfStyles = [];
  }
  if (pdfStyles.length && !pdfStyles.some((s) => s.id === presetId)) {
    presetId = pdfStyles[0]!.id;
  }
  buildPdfMenu();
  syncPdfBtnTitle();
}

function selectPreset(id: string): void {
  presetId = id;
  try {
    localStorage.setItem('iauthor.pdf-preset', id);
  } catch {}
  syncPdfMenu();
  syncPdfBtnTitle();
}

function buildPdfMenu(): void {
  const items: HTMLButtonElement[] = [];
  for (const s of pdfStyles) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ctx-item';
    b.textContent = s.note ? `${s.label} — ${s.note}` : s.label;
    b.dataset.preset = s.id;
    // picking a size is a choice, not just a setting: it becomes the
    // default for later clicks AND compiles right away, so right-click →
    // a4 is one gesture, not two
    b.addEventListener('click', () => {
      selectPreset(s.id);
      hidePdfMenu();
      const scope = currentScope();
      if (!scope || pdfBusy()) return;
      void fetchPdf(scope, false);
    });
    items.push(b);
  }
  if (pdfStyles.length) {
    const re = document.createElement('button');
    re.type = 'button';
    re.className = 'ctx-item';
    re.textContent = 'recompile';
    re.addEventListener('click', () => {
      hidePdfMenu();
      const scope = currentScope();
      if (!scope || pdfBusy()) return;
      void fetchPdf(scope, true);
    });
    items.push(re);
  }
  pdfMenu.replaceChildren(...items);
}

pdfBtn.addEventListener('click', async () => {
  const scope = currentScope();
  if (!scope || pdfBusy()) return;
  // the compiled pdf comes from the server files: flush + push first so it
  // sees the newest text
  flushDraft();
  if (getEditor() && currentFile && dirty()) {
    try {
      await sync.pushNow();
    } catch {}
  }
  await fetchPdf(scope, false);
});

// compile on the server, open only when the pdf is fully there; the button
// carries a worker animation while LaTeX runs. Folder aggregates follow the
// sidebar's drafts toggle: drafts hidden -> excluded, visible -> included

function pdfBusy(): boolean {
  return pdfBtn.classList.contains('busy');
}

async function fetchPdf(scope: string, force: boolean): Promise<void> {
  pdfBtn.classList.add('busy');
  const base =
    `path=${encodeURIComponent(scope)}&preset=${presetId}` +
    `&drafts=${hideDrafts ? '0' : '1'}`;
  // a compiles-longer-than-activation fetch loses the popup privilege, so
  // the tab opens NOW (inside the click gesture) — in the background, with
  // focus handed straight back so the user stays in the app. It shows the
  // server's fragment plan while LaTeX runs, then becomes the pdf.
  const tab = window.open('about:blank', '_blank');
  if (tab) {
    tab.document.write(pdfWaitPage(`/api/pdfstatus?${base}`, force));
    // hand focus straight back to the app. Blurring the new tab alone is
    // ignored by some browsers and window.focus() is often a no-op, so
    // also focus a real element here — the strongest signal there is. All
    // of it must stay synchronous, inside the click gesture, or the tab
    // comes back to the front once the compile finishes.
    tab.blur?.();
    window.focus();
    pdfBtn.focus({ preventScroll: true });
  }
  try {
    const url = `/pdf?${base}${force ? '&recompile=1' : ''}`;
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) {
      throw new Error(
        res.headers.get('x-iauthor-error') || (await res.text()) || res.statusText,
      );
    }
    // the middleware redirects an expired session to /login and fetch follows
    // it transparently, so a "successful" response that is not a pdf is the
    // login page. Redirect the tab to it for real — rendering it inside a
    // blob would strip the app's stylesheets and leave a bare form on an
    // orphaned blob: url.
    if (!(res.headers.get('content-type') || '').includes('application/pdf')) {
      if (tab && !tab.closed) tab.location.replace('/login');
      else location.assign('/login');
      return;
    }
    // WebKit refuses top-level navigation to blob: URLs ("Unsupported
    // URL" on iOS), so the tab goes to the server route instead. The
    // fetch above just refreshed the fragment cache, so it streams at
    // once — no recompile flag here, that would rebuild everything twice.
    const target = `/pdf?${base}`;
    // a tab the user closed mid-compile stays closed — the pdf is on disk
    // either way; the next pdf click streams it without recompiling
    if (tab && !tab.closed) tab.location.replace(target);
    else if (!tab) location.assign(target); // popups blocked: same tab
  } catch (err) {
    tab?.close();
    alert(`pdf: ${(err as Error).message}`);
  } finally {
    pdfBtn.classList.remove('busy');
    syncPdfBtnTitle();
  }
}

function syncPdfMenu(): void {
  for (const b of pdfMenu.querySelectorAll<HTMLButtonElement>('.ctx-item'))
    b.classList.toggle('is-on', b.dataset.preset === presetId);
}

export function hidePdfMenu(): void {
  pdfMenu.hidden = true;
}

pdfBtn.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (!currentScope()) return;
  syncPdfMenu();
  pdfMenu.hidden = false;
  // positioned at the cursor, exactly like the tree context menu
  const m = pdfMenu.getBoundingClientRect();
  pdfMenu.style.left = `${Math.min(e.clientX, window.innerWidth - m.width - 8)}px`;
  pdfMenu.style.top = `${Math.min(e.clientY, window.innerHeight - m.height - 8)}px`;
});
syncPdfBtnTitle();
