// In-app confirm dialog — the general replacement for window.confirm.
// Unlike the native dialog it does not block the event loop: page animations
// (the deletion preview's pulse) keep running while it asks, and the answer
// arrives as a promise. The backdrop does not swallow touches (pointer-events
// none), so the tree stays scrollable behind it — the author double-checks
// which file blinks red before answering. A CLICK outside the card is
// captured and answers cancel without acting on whatever it landed on (a
// tree row must not open behind the dialog). The markup is created on
// demand; the styles live in global.css — Astro scoping would never match
// JS-created DOM.
let open = false;

export function appConfirm(
  message: string,
  opts: { ok?: string; cancel?: string; danger?: boolean } = {},
): Promise<boolean> {
  if (open) return Promise.resolve(false); // one dialog at a time
  open = true;
  const prevOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden'; // the page must not scroll behind
  return new Promise<boolean>((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'confirm-backdrop';
    const card = document.createElement('div');
    card.className = opts.danger ? 'confirm-card danger' : 'confirm-card';
    const msg = document.createElement('p');
    msg.className = 'confirm-msg';
    msg.textContent = message;
    const row = document.createElement('div');
    row.className = 'confirm-row';
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.textContent = opts.cancel ?? 'cancel';
    const okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = 'confirm-ok';
    okBtn.textContent = opts.ok ?? 'ok';
    row.append(cancelBtn, okBtn);
    card.append(msg, row);
    backdrop.append(card);
    document.body.append(backdrop);

    function done(v: boolean): void {
      backdrop.remove();
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('click', onDocClick, true);
      document.body.style.overflow = prevOverflow;
      open = false;
      resolve(v);
    }
    function onKey(e: KeyboardEvent): void {
      // capture + stop: the app's own Escape paths (nav, menus) stand down
      // while the dialog owns the keyboard
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        done(false);
      }
    }
    function onDocClick(e: MouseEvent): void {
      // scrolling reaches the page through the transparent backdrop, but a
      // click outside the card is a cancel — captured here so nothing behind
      // the dialog acts on it (a tree row must not open, a menu must not open)
      if (card.contains(e.target as Node)) return;
      e.preventDefault();
      e.stopPropagation();
      done(false);
    }
    okBtn.addEventListener('click', () => done(true));
    cancelBtn.addEventListener('click', () => done(false));
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('click', onDocClick, true);
    cancelBtn.focus(); // the safe default owns Enter
  });
}