# AGENTS.md — context for continuing development

Read this fully before making changes. It contains the product vision, the user's
explicit preferences, architecture, deployment, and the hard-won gotchas.
What shipped, when, lives in git history — this file carries only decisions and
invariants that are still in force.

## What this is

**I author** (project/package name: `iauthor`, display name always written "I author")
is a private, single-user markdown writing webapp. The owner writes books/poems on
holiday trips from laptop (or phone, bare minimum). Markdown files live in a plain
directory on their VPS; the webapp is the only interface.

Non-goals: multi-user, collaboration, databases, heavy frameworks, features beyond
the plan. If a change adds complexity, it needs a good reason.

## Product decisions made by the user (do not relitigate)

- **No passwords.** Login = 4–12 digit PIN + TOTP (authenticator app). Recovery codes
  are one-time substitutes for TOTP only; the PIN is always required. Trusted devices
  re-enter only the PIN after the idle lock.
- **Device trust**: after a full login (PIN+TOTP) the browser gets a 30-day rolling
  HttpOnly cookie. New device → full login; same device → PIN-only unlock when idle-locked.
- **Naming schema is the data model**: chapters are `.md` files; work/book/part are
  folders; numeric prefixes (`01_name`, underscore-separated, case preserved) define
  order. No frontmatter ordering, no status fields. Display names (Work/Book/Part/
  Chapter labels with Roman/Arabic numbering) are computed from the tree in `works.ts`
  (`title` on tree nodes; top-level entries shown bare) — the disk schema stays raw.
- **Local git in the works dir**: commits via the autosave coalescer
  (`src/lib/autosave.ts`) — a save burst commits at 5s idle or ≥1000 chars, whichever
  first; create/delete/rename/reorder flush the burst first so each mutation stays ONE
  commit (`path : 2026-10-11 14:03:22` message grammar). Server-only history, never
  pushed. The user never manages git.
- **Backup = the owner's external microservice** (owner decision 2026-10-11):
  the works-dir git repo IS the backup artifact. A separate tiny app (its own repo)
  reads it read-only on a timer and pushes to ProtonDrive — plaintext, trusting
  Proton's E2EE instead of self-managed keys. Iauthor implements nothing: no
  endpoints, no token, no ping. (Contract details: §Backup contract.)
- **Editor sync**: writes go to a local draft, pushed to the server in chunks —
  never char-by-char. Unsynced text renders lighter and darkens once the server
  confirms. Single user → no merge logic; last-write-wins + local git history
  is the safety net. Trigger: cumulative dirty words ≥10, or 5s idle.
- **UI aesthetic**: minimal, angular (border-radius ≤ 2px), cool neutral palette with a
  strong blue accent, self-hosted Literata serif, dark mode, no UI framework, no Tailwind.
  Do not mention the user's password manager or setup in UI text.
- **Nav**: the `I author` title is the *only* tree toggle — desktop hides the panel,
  mobile expands it over the page. No hamburger button; don't reintroduce one.
- **Laptop-first.** Mobile = bare minimum (forms must work).

## Stack

- Astro 5, `output: 'server'`, `@astrojs/node` standalone adapter. One process serves
  pages + API routes. No second backend.
- Vanilla TypeScript in `<script>` tags (Astro bundles them). No React/Svelte.
- Plain PostCSS (import, nesting, autoprefixer) in `src/styles/global.css` + scoped
  styles only for static markup. **Styles for JS-created DOM must be global** (Astro
  scoping won't match dynamically created elements).
- Client deps: `marked` (markdown → HTML), `katex` (math in the preview),
  `@fontsource-variable/literata`, CodeMirror 6
  (`@codemirror/state`/`view`/`commands`/`language` + `@lezer/highlight`) for the editor,
  `@codemirror/lang-markdown` + `language-data` for markdown parsing and fenced-code
  grammars (grammars load lazily as separate chunks per language).
- Auth crypto: node built-ins only (scrypt, HMAC, timingSafeEqual).
  TOTP is hand-rolled RFC 6238 in `src/lib/totp.ts` (verified against the official vectors).

## Repository layout

```
flake.nix            dev shell: nodejs_22, pnpm, git, rclone; scripts/ on PATH
scripts/             run (dev :4321), build, deploy
src/middleware.ts    auth guard: setup redirect, session check, idle lock, cookie renewal
src/lib/config.ts    all env vars, cookie name, TTLs
src/lib/http.ts      json(), clientIp() (socket address only — see §Auth model), isSecure()
src/lib/visibility.ts  the "what's visible" rule (drafts + notes + empty dirs) in one place;
                     visibleNodes(nodes, opts) — shared by the sidebar and the pdf aggregates
src/lib/totp.ts      TOTP generate/verify + totpAt(secret, unixSeconds, digits)
src/lib/auth/        secrets, pin (scrypt), device tokens (HMAC), idle lock, rate limit,
                     recovery codes
src/lib/naming.ts    the filename grammar, defined once (parseName, slugify, naturalCompare,
                     NOTES, MATTER); pure, imported by server and client bundles
src/lib/works.ts     works tree: listWorks/readChapter/writeChapter/createEntry/renameEntry/
                     deleteEntry, safePath (traversal + symlink + dotfile protection),
                     display titles (Node.title: depth decides — Book/Part/Chapter, top level
                     bare; split into Node.label + Node.raw for print),
                     word counts (Node.words: per-md count, folders sum all descendant mds)
src/lib/words.ts     countWords() — pure, used client- and server-side
src/lib/preview.ts   live-preview engine: widgets, buildDeco, focus field, ctrl+click
                     link routing (createPreview(onOpenLink)); table HTML memoized;
                     KaTeX math ($…$ inline, $$…$$ display) via MathWidget; hidden
                     ranges are non-atomic (only the checkbox is atomic) so arrows
                     traverse raw offsets; ↑/↓ are a plain source-line cursor
                     (arrowStep, Prec.highest); widget clicks map back to source
                     (table clicks land in the clicked cell via a per-cell offset map)
src/lib/sync.ts      chunked-sync engine: unsynced marks, draft store (sessionStorage),
                     push machine (createSync) — dirty-word accumulator + idle push
src/lib/autosave.ts  commit cadence: markDirty/flushAll coalescer (30s tick,
                     ≥200 chars), INIT/recovered boot commits, SIGTERM flush
src/lib/git.ts       ensureRepo + commit(msg) in WORKS_DIR (server-local, never pushed);
                     gitOut, transaction, parseNameStatus, nextUndoBranch,
                     gitShow (the undo/history plumbing), commit events (the
                     seq counter + subscriber list the SSE route streams)
src/lib/pdf.ts       PDF compiler: LuaLaTeX + `markdown` package; ensurePdf(rel, style,
                     force) compiles beside the source in the works dir; pdfPlan(rel,
                     style) is the same cache decision without LaTeX (the loader polls
                     it). Names that reach paper — title page, artifact download name,
                     loader heading — come from the node's `raw` title via scopeTitle(),
                     never from the disk basename, so prefixes can't leak into print;
                     styles from pdfstyles/ (first line `% label: L — note` = metadata)
src/pages/api/       setup, login, session, logout, lock, tree, file (GET/PUT), new, delete,
                     rename, reorder, events (SSE commit stream), pdfstyles, pdfstatus,
                     git/ (history, show, restore-file, make-master)
src/pages/           index.astro (thin shell: components + the boot script import),
                     login.astro (PIN is a text field masked
                     with ● in JS — mobile keyboards echo the last digit of
                     password fields), setup.astro, pdf.ts (stream)
src/components/      Sidebar, DocView, HistoryView, NewDialog — static markup
                     only, deliberately NO per-component scripts (the shell's
                     JS is one bundle with one shared scope; splitting scripts
                     across components would break both)
src/app/             the app shell's client modules (imported by ONE script in
                     index.astro): main.ts (boot + the order-sensitive
                     document-level listeners — Escape precedence and the two
                     click-to-dismiss menus), state.ts (shared state: tree,
                     byPath, expanded, selected, currentFile/group, keys,
                     pathMapper/remapPaths/remapExpanded, api, esc, narrow/
                     navOpen), dom.ts (every static element ref), tree.ts
                     (renderTree/buildList, visibility, row sync markers,
                      loadTree, revealPath), editor.ts (CM lifecycle,
                      flushDraft/leavingFile, openLink),
                      sync.ts (the createSync instance + offline/online),
                      commits.ts (the SSE commit stream: the live history
                      view),
                     toc.ts (buildToc/showGroup/renderWelcomeIndex/openFile +
                     the tree click), gestures.ts (desktop DnD + the touch
                     arm/drag/menu machine + the insert line),
                     files.ts (context menu, create dialog, delete, rename),
                      history.ts (the history view: the jump machine +
                      mobile undo/redo buttons), measure.ts (the two handles),
                     pdf.ts (style menu + fetchPdf), nav.ts (setNav, topbar
                     scroll-away, drafts toggle, brand home, lock/logout)
pdfstyles/           LaTeX preamble "stylesheets" (a4, a5, academic) — single source
                     of truth for the pdf style menu. a4.tex and a5.tex share 51 of
                     54 lines (differences: label, documentclass pt, geometry) and
                     are kept in sync BY HAND — duplication accepted by design
                     (owner decision; an \input-shared base was rejected — it would
                     complicate the pdf cache's style-hash freshness)
src/layouts/         base.astro (theme pre-paint script, Literata import)
src/styles/global.css  design tokens + shared components + app shell + markdown styles
src/lib/editor.ts    CodeMirror extension set (editor_extensions assembled once)
src/lib/pdf-wait.ts  client-side loader polling /api/pdfstatus
src/lib/confirm.ts   in-app confirm dialog (appConfirm) — promise-based, non-blocking
                     replacement for window.confirm; the touch-transparent backdrop
                     keeps the tree scrollable behind it; a click outside the card
                     answers cancel without acting behind the dialog
```

Where a change goes: data/files → `works.ts`, UI shell → `src/app/` (+ markup
in `src/components/`), editor features → `preview.ts`/`sync.ts`, naming →
`naming.ts` (pure, both sides).

### App shell orientation (`src/app/`, one bundled module graph)

Key functions: `main.ts` `boot()` (restore expanded state → loadTree() → reopen
`iauthor.last`, remapped through renames; deleted file → welcome screen; desktop
boots with the tree open) and the document-level listeners whose registration
order is load-bearing (Escape: create dialog → ctx menu → pdf menu → nav →
history; the two click-to-dismiss menus). `loadTree()` in tree.ts (GET /api/tree
→ `tree` + `byPath` Map → renderTree()), `openFile(p)` in toc.ts (revealPath
first, then GET /api/file → makeEditor; restores a newer sessionStorage draft),
`showGroup(n)` in toc.ts (folder index TOC, never an editor), `leavingFile()` in
editor.ts (flushDraft + sync.pushNow if dirty — ALWAYS before switching files or
entering the history view), `setNav(open)` in nav.ts (the ONLY nav mutator — see
§Nav invariants), `remapPaths` in state.ts (see §Path maps below),
sync hooks (`setSync` → `refreshRowStatus`, a targeted DOM update — never a
renderTree mid-drag; the spinner bookkeeping is `pushStart`/`pushEnd` in
tree.ts). Cross-module writes to shared `let` state go through state.ts setters
(`setSelected`/`setCurrentFile`/… — an imported binding can only be assigned by
its declaring module); circular imports between feature modules are fine (every
cross-call happens inside event handlers, never at module init). Orientation
map: **read the source for the rest** — this file does not duplicate it.

## Dev workflow

```
nix develop          # everything below assumes this shell
run                  # astro dev on :4321 (foreground)
dev                  # detached test server on :4321, all interfaces; idempotent,
                     # log /tmp/iauthor-dev.log — THIS is the owner's test env
build                # production build — the agent NEVER runs it (deploy does)
deploy               # push main to GitHub; the server pulls, installs, builds,
                     # restarts and health-checks (see §Deployment) — ONLY on request
```

- **NO TESTING. NEVER.** (owner decision 2026-10-09: "remove ALL testing. I can test.")
  There are NO tests in the repo (all suites and scripts/test-auth deleted
  2026-10-11) and the agent does NOT run `pnpm build`, lint, typecheck, or ANY
  verification/smoke/curl command after a change. Zero. Not
  "when prudent", not "just once", not "because it's cheap". Finish the change, commit
  with a SHORT message, report, done — broken code is caught by the owner in the test
  env, and a commit can always be reverted. The ONLY commands beyond file edits the
  agent runs are `scripts/dev` (keep the test env alive) and git commits.
- **Test env always running, deploy only on request.** At session start run
  `scripts/dev` and report the URL(s) it prints — astro dev hot-reloads, so edits are
  testable the moment they land; never restart it for code changes. The owner tests in
  the test env (local `~/writing/works`, git repo, real content); the agent never does.
  Never push or deploy unless the owner explicitly asks.
- The dev server binds all interfaces; `scripts/dev` sets `IAUTHOR_DOMAINS` to
  `localhost,[::1],<lan-ip>` at startup — a missing IP there means CSRF 403s on POSTs
  from the LAN URL.
- pnpm 10+ blocks build scripts. Since pnpm 12, that config lives in
  `pnpm-workspace.yaml` as `allowBuilds: { esbuild: true, sharp: true }`
  (`pnpm.onlyBuiltDependencies` in `package.json` is dead — pnpm ignores it with a
  warning). Keep that file; if pnpm scaffolds it with placeholder
  "set this to true or false" values (it does when it wants a decision), fill in
  `true` — don't delete the file.

## Auth model (details that matter)

- Secrets live in `secrets/secrets.json` (gitignored, mode 0600): pin hash, totpSecret,
  sessionSecret, recovery codes (`{id, salt, hash, used}`). Written once by
  `/setup`; there is no UI to rotate — deleting the file re-runs setup (after a
  restart — `auth/secrets.ts` caches at module load).
- `POST /api/login` logic: rate limit per IP (fails <5 → free; 5th fail → 30s lock,
  doubling to 15 min). `trusted` = valid device cookie. Trusted + correct PIN → login
  (no TOTP). Untrusted → PIN + (TOTP ±1 window or unused recovery code).
- Idle lock is **in-memory** (`src/lib/auth/idle.ts`): a token with no entry counts as
  locked — so server restarts lock sessions (PIN re-entry, not full login). `POST /api/lock`
  forces this.
- **Pre-setup the app is OPEN** (owner decision, identical local/prod):
  with no secrets file the middleware passes everything — pages, APIs, and `/setup`
  itself — instead of bouncing to `/setup`; there is nothing to log into yet. The app
  shell renders a `set up 2FA` link (`/setup`) in the side-foot instead of
  lock/log out (`authReady` from `loadSecrets()`). The moment `/api/setup` writes
  secrets, full auth applies (the secrets cache updates on save, no restart).
- Middleware rules: `/api/session` and `/api/logout` always pass; `/api/login` passes
  (rate-limited inside); everything else needs a valid, non-idle-locked cookie
  (skipped entirely pre-setup, see above). API requests get JSON 401s; pages get
  redirects.
- **Astro CSRF gotcha**: Astro 403s bodyless POSTs depending on origin normalization.
  All client POSTs must send `content-type: application/json` with a JSON body.
  `security.allowedDomains` is set from `IAUTHOR_DOMAINS` **at build time** (deploy sets it).

## Data & naming

```
WORKS_DIR (server: /home/server/writing/works)
  01_my_novel/                work (folder)
    01_book_one/              book (folder)
      01_part_one/            part (folder)
        01_first_flight.md    chapter (.md)
  02_poems.md                 single-file work (top-level .md)
```

- Display labels: top-level entries are bare titles; every other md is "Chapter N";
  **depth decides what a folder is** — a folder directly under a top-level work is a
  Book whether or not it contains Parts, anything deeper is a Part, level 4+ clamps to
  Part. **The printed number is the entry's POSITION among same-kind siblings** (books
  counted among books in Roman numerals, parts and chapters in Arabic), never its disk
  prefix: the prefix is order only, so a book prefixed `03_` that sits second prints
  "Book II". Counted over the whole sibling list, drafts included, so hiding drafts
  never renumbers; notes.md and matter print bare and consume no number. Never infer a
  kind from a folder's shape — that mislabelled part-less books as Parts.
  Computed in `works.ts`, exposed as `Node.title` via `/api/tree`. Clicking a folder
  opens a fully expanded book-style index (TOC with dotted leaders), never an editor.
- **The filename is the title.** No `# Title` heading is ever written into files
  (`createEntry` creates empty files); content may begin at the top. The `NN_` prefix
  is grammar, not text: it orders, it never prints. Entries may still lack a prefix
  (unprefixed names sort after prefixed ones via naturalCompare) — they are numbered
  by position like everything else, so no `?` placeholder exists.
- **Prefixes are contiguous, hidden, and app-managed**: `NN_` is order only, never
  printed, and every directory is renumbered to `01…N` on every create, delete,
  rename and drop (`renumberDir`/`applyOrder` in `works.ts` — two-phase, temp names
  first, so a swap of 01/02 cannot clobber a file; reserved bare names are skipped;
  compiled pdfs follow their entry). The sidebar shows `Node.raw`, not the disk name.
  Because a mutation can rename *many* siblings, every mutating route returns a
  `{old: new}` path map (`renumbered`) and the client remaps expanded folders, the
  selection and sessionStorage drafts through it (`remapPaths`). The remap matches by
  **longest prefix**, not exact key: a moved folder changes the path of everything
  inside it while the map carries only the folder, and a missed draft would recreate
  its file at the old path on the next sync (`remapDrafts` walks the draft store).
- **Special files** (in any non-top-level folder): `title.md` is a normal chapter with
  no prefix — sorts alphabetically and is numbered by position like any chapter
  (useful for work-in-progress; give it an `NN_` prefix via rename once it settles).
  `notes.md` is folder material, never a chapter: it consumes no number and its content
  is appended verbatim (rendered markdown) under the folder's index view. Top-level
  `notes.md` would be a normal top-level md.
- **Matter names** (`MATTER` in `naming.ts`, next to `NOTES`): front and back matter —
  `front_matter`, `appendix`, `afterword`, `preface`, `foreword`, `epilogue`,
  `acknowledgements`, `colophon`, `dedication`, `epigraph`, `prologue` — print bare
  like a top-level entry and consume no number. An `NN_` prefix is allowed and orders
  the file WITHOUT numbering it, so matter can sit between two books; unlike
  `notes.md`, matter DOES compile into the book, as unnumbered front/back matter in
  the contents.
- **Sidebar toolbar is one button**: the drafts toggle ("drafts" + eye glyph,
  ◉ open / ◡ hidden, persisted in localStorage) hides drafts, notes, and empty
  directories from tree and indexes; folders whose children all vanish are dropped;
  notes render normally in indexes, they are only hidden together with drafts.
  Create/delete happen via the right-click context menu on the tree.
- **Ordering gotcha**: `moveEntry` moves the entry out of its source FIRST and
  only then renumbers the destination, because the destination is often an
  ancestor of the source — renumbering the root after a drop can rename the very
  folder the entry came from. The source path is then resolved through the
  destination's map by **longest prefix** (`remapPath`), because the map carries
  the renamed ancestor while the source is a deeper descendant; an exact-key
  lookup returns a path that no longer exists (`invalid parent`).
- **Rename**: clicking anywhere in the header (except the buttons) swaps the title for
  an inline raw-name editor (live-preview style: display title ↔ disk name). The
  editor prefills the **full disk name**, so prefix and `draft_` are visible while
  editing. `POST /api/rename` edits the **title**, not the whole disk name: the
  numeric prefix is preserved unless the typed name carries one explicitly
  (`composeName` in `works.ts`) — un-numbering is impossible by design. The `draft_`
  token FOLLOWS the typed name: keep it in the prefilled name to stay a draft, delete
  it to un-draft (a deliberate act, since the prefill shows it). Duplicates are
  rejected (case-insensitive, prefix-stripped — `findExisting`), and git-commits;
  sessionStorage drafts move to the new path (`moveDraft`) and the sidebar's expanded
  state is remapped (`remapExpanded`) so the subtree stays open. Renaming a folder
  rewrites all descendant paths.
- `createEntry` slugifies names (spaces → `_`, case preserved, a typed
  `.md`/`.markdown` extension stripped — typing "notes.md" yields `01_notes.md`),
  rejects duplicate slugs (case-insensitive, prefix-stripped), and auto-prefixes
  `NN_` (next number; a user-typed leading `NN-`/`NN_` is kept). Parsers accept
  both `-` and `_` prefixes forever.
- `safePath` rejects `..`, empty/hidden segments, and anything whose realpath escapes
  `WORKS_DIR`. Only `.md`/`.markdown` files are readable/writable; 512 KB cap; atomic
  writes; the word counter has its own higher cap (`MAX_COUNT = 4 × MAX_FILE`) so
  oversized files don't report 0 words.
- Every mutation (`new`, `file PUT`, `delete`, `rename`, `reorder`) ends with a commit
  in the works dir — saves through the autosave coalescer (`flushAll()` before the
  mutation), the mutation itself as one commit after. Empty folder creations produce no
  commit (git doesn't track dirs) — expected.
- Client `fetch`es of `/api/tree` use `cache: 'no-store'` — stale HTTP-cache reads
  once made the sidebar look frozen after renames.

### Where paths flow (matters for any naming/path refactor)

The `rel` path string (e.g. `01_work/01_part/01_chapter.md`) is the client-side key
everywhere — changing its shape orphans things silently:

- `index.astro`: `byPath` Map, `selected`, tree `dataset.path`, `contextPath()`
- `sync.ts`: draft store keys (`iauthor.draft.<path>` + `iauthor.draft` pointer)
- `preview.ts`: relative `.md` link resolution resolves against the current file's
  folder and looks the result up in `byPath` — new path shapes must remain resolvable
- API routes: `tree`, `file` (GET/PUT), `new`, `delete`, `rename` — all take/return
  `path` strings

**Scope/migration constraints for a naming/filesystem refactor:** the on-disk
`NN_name` schema is frozen product data (do not redesign it as part of a refactor).
Any rename/migration of existing files must go through `git.commit(...)` in the works
dir. The works dir lives outside the app dir and is never touched by deploy/rsync, so
migrations won't be undone by deploys.

## Deployment (VPS)

- Repo: `github.com:GerhardMe/I-author` (origin `main`). The server is a plain
  git clone — the repo plus its flake is the whole install.
- SSH aliases: `server` (user `server`) and `serverRoot` (root). Debian 13, Nix
  (multi-user) provides the runtime — node, git, and lualatex all come from this
  repo's flake via `scripts/serve`; nothing hand-installed. Flakes are enabled in
  `/etc/nix/nix.conf` (`extra-experimental-features = nix-command flakes`).
- App: `/home/server/iauthor` (git clone). Works: `/home/server/writing/works`
  (owner `server`, lives outside the repo — never cloned/pushed; its `.gitignore`
  ignores `*.pdf`).
- systemd unit `/etc/systemd/system/iauthor.service` (user `server`, `HOST=127.0.0.1
  PORT=4322`, env `IAUTHOR_WORKS_DIR`, `ExecStart=/home/server/iauthor/scripts/serve`).
  Caddy site: `write.gerhard.page → localhost:4322`
  (auto-TLS; A record → 158.220.109.206).
- **Always deploy with `scripts/deploy`** — it pushes `main` to
  GitHub (dirty tree = error), then the server pulls, runs `pnpm install
  --frozen-lockfile` and builds inside `nix develop` (keeping `dist.old` and
  restoring it if the build fails), restarts, and health-checks. Do not hand-roll
  SSH deploy steps; that's how things broke before. One-time server setup:
  install Nix (multi-user daemon) + enable flakes, clone the repo (deploy key
  `GerhardMe/gerhard.page`), restore `secrets/` into the clone, run deploy once
  to build the `.gcroot` (pins the closure so `nix store gc` can't break the
  service), point the unit at `scripts/serve`.

## Environment variables

| Var | Default | Meaning |
|---|---|---|
| `IAUTHOR_WORKS_DIR` | `~/writing/works` | works root |
| `IAUTHOR_SECRETS_FILE` | `./secrets/secrets.json` | secrets path |
| `IAUTHOR_IDLE_LOCK` | `12h` | idle lock timeout (`30m`/`12h`/`1d` style) |
| `IAUTHOR_SECURE` | unset | force Secure cookies (`1`/`true`/`yes`/`on`; normally auto via `x-forwarded-proto`) |
| `IAUTHOR_DOMAINS` | `localhost`,`[::1]` | build-time `security.allowedDomains` (deploy sets it) |
| `IAUTHOR_LUALATEX` | `lualatex` | pdf compiler binary (flake puts it on PATH; read by `pdf.ts` directly, not `config.ts`) |
| `HOST`/`PORT` | localhost/4321 | node adapter bind |

## Gotchas learned the hard way

- CodeMirror vertical motion cannot be patched around block widgets: `moveVertically`
  pixel-scans via `posAtCoords`, which **skips `block: true` replace widgets entirely**
  (they're not lines) and maps a widget to its nearest boundary — so ↑/↓ leap over
  rendered tables/`$$` blocks no matter what atomic ranges say. The fix was to replace
  vertical motion with a plain source-line cursor (preview.ts `arrowStep`) and delete
  the machinery. Don't reintroduce pixel-based correction around reveals.
- Every CodeMirror `WidgetType` subclass must implement `toDOM` — one without it
  (`e.toDOM is not a function`) crashed the whole decoration pipeline, silently killing
  tables/fences too. Unit tests (node:test) can't catch DOM-render bugs.
- Login page ships all fields visible in HTML; the locked path hides the 2FA group via
  JS. Do not "unhide later" — there is no unhide step, only hide paths. (This exact bug
  shipped twice.)
- Never commit secrets or the `.env`.

## Invariants from shipped work (owner decisions — do not relitigate)

What follows distills the rules that shipped features established. The narrative
history is in git; only the rules are kept here.

**Git history is append-only** (owner decision 2026-10-11, replacing the
branch+master-reset undo). Commits are checkpoints, never undo rungs: no
amount of Ctrl+Z or undo-button pressing ever moves a commit back — an undo
is an ordinary edit and commits like one (push → coalescer → new commit).
Going back in time is the history view's job alone (branch hopping via
make-master — server routes exist, client wiring does not). No /api/undo.

**Undo/redo (client).** Pure native CodeMirror: the stack is never reset, at
commits or otherwise; an exhausted Ctrl+Z / Ctrl+Shift+Z / mobile-button
press does NOTHING (no escalation, no history-view jump). The stack dies
with the editor session (reload, lock, file switch) — older text is
reachable only through the history view. Text fields keep the browser's own
native undo; the guards around that are gone with the ladder.

**Commit cadence & message grammar.** `PUT /api/file` writes and calls
`markDirty(path, charDelta)`; the coalescer commits on a 30s wall-clock tick
when **≥200 chars** are pending (under the minimum the tick is a no-op — no
idle trigger, no mid-burst char trigger). Messages carry NO timestamps (owner
decision 2026-10-11 — git stores them) and only three shapes: content update `path`
(several pending paths → one line each) · rename/move `old -> new` ·
create `+ path` / delete `- path`. Restore-file is a content update (`path`);
`flushAll()` runs
before `new`/`rename`/`delete`/`reorder`/make-master/lock/log-out/pdf
compile and on SIGTERM; at boot a dirty worktree commits as `recovered`,
a fresh repo's first commit is `INIT`. Commits ride the serialized
promise queue in `git.ts` (`transaction(fn)` for multi-command sequences — a
coalescer commit can never interleave) and are announced over the SSE stream
(`commitSeq()` counter + subscribers in `git.ts`).

**Path maps & longest-prefix remap.** Reorder, rename and checkout return
`{old: new}` path maps (make master/restore will, once wired); the client
remaps expanded folders, selection, drafts and `iauthor.last` through them —
always by **longest prefix** (a moved folder changes the path of everything
inside it while the map carries only the folder).

**History view.** A third main view `#history` beside `#empty`/`#doc`, entered via
the fork btn-tiny in the side-foot (rendered pre-setup too). `leavingFile()` first.
SVG DAG: main spine (reachable from HEAD) in the leftmost lane, branch lanes to the
right in fork order, newest first, "you are here" dot on HEAD's commit. Hover a
node → tooltip (commit message, timestamp underneath — branch names are never
shown; owner decision 2026-10-11). The view is LIVE: SSE commit events
debounce-refetch the DAG while it is open (`refreshHistory`), so new commits
slide in without reopening. **Nodes are clickable (the jump machine, owner
decision 2026-10-11)**: a click checks the WHOLE works tree out at that
commit — temporarily. main NEVER moves: the checkout lands on a fresh branch
named for the moment (`nextUndoBranch`), edits made there commit onto that
branch, and a page reload (boot calls `/api/git/main` before loadTree) or
the "back to head" button (`#hist-main`, shown only when `!onMain` from the
history API) returns to main proper. The DAG stays open across jumps
(`jumpSwitch` in history.ts: flush+push unsynced text FIRST — it commits
onto the branch we leave — drop drafts of changed paths, detach without
pushing, loadTree, reopen the file or home). The server aborts any switch
on a dirty worktree (a failed commit must surface, never be reset away).
Still not wired: the preview panel (message, time, sha7, changed files),
per-file read-only preview (`/api/git/show`), **fetch file** (restore-file)
and **make master** — server routes exist for all of them. Escape → welcome
(`stopImmediatePropagation`, menus first); any tree-row click leaves the
view. On mobile, entering closes the overlay.

**APIs for history** (`src/pages/api/git/`): `history` (latest 200 commits
over all refs, flushed first, answers `onMain`), `checkout` (the jump: branch
at the target commit + checkout it, main never moves), `main` (back to head,
also the boot's reload-return), `show` (file content at a commit — `isSha`/
`isMdPath` guards; git resolves the path inside the tree, no `safePath`), 
`restore-file`, `make-master`. `PUT /api/file` responds `{ok}` — commits are
none of its business (the SSE stream announces them).

**Nav invariants.** `.app.nav-off` is the only state, `setNav(open)` the only
mutator; it toggles `aria-expanded` + `inert` on tree/toolbar/side-foot, owns the
mobile overlay scroll lock (body overflow hidden while open — cleared on close
AND when the mq flips to desktop) and clears `.bar-away`. **No nav persistence**:
desktop always boots with the tree open; mobile always boots hidden (pre-paint
inline script applies `nav-off` so it never flashes). The markdown view keeps ONE
static left margin regardless of the tree (unconditional padding on `.main`) —
nothing moves when the tree hides or shows; the measure re-clamps on window resize
only. Collapsed sidebar is pointer-transparent except `.brand` (no dead zone).
Fade transitions gated behind `body.nav-anim` + `prefers-reduced-motion` (boot adds
nav-anim in the same task as the initial setNav — the first paint never slides).
Mobile: scrolling down past 48px with the tree closed adds `.bar-away` (title bar
slides away, ◐ and undo/redo buttons ride it; any scroll up brings them back).
Escape closes the nav only when the create popup and menus are closed (they get
Escape first); the create popup and the context menu force `setNav(true)` first.

**Tree UX contracts.** The caret toggles without selecting; a folder ROW click never
collapses — it opens the folder's index and unfolds; only a repeat click on the
viewed folder (`currentGroup === node.path`) toggles. Chrome (brand, .btn-tiny,
tree rows) is user-select: none; row `:hover` is gated behind `@media (hover: hover)`.
Drag & drop: the whole row is the handle; the dragged copy is a custom `.drag-card`
(no `setDragImage` games — engines rasterize differently); cleanup rides a `dragend`
listener on the source row itself (renderTree can detach it mid-drag). Drop bands:
each row's TOP half = a slot at its OWN level above it (above the first child ==
below its parent — one line), BOTTOM half = below (entry) or inside (folder);
ONE `#insert-line` element serves create (green) and move (blue), red pulse =
delete. Hovering a closed folder expands it, but the chain of hover-opened folders
lives or dies with its outermost member (`dragOpened` + `pruneDragOpened`); the
whole sidebar viewport is a drop zone — aiming off the rows lands TOP level,
appended last. HTML5 DnD does not fire on touch.

**Touch profile.** tap = open (native click), swipe = native scroll (arm timer
cancels on >10px), hold 500ms = ARMED with nothing visible (10ms vibration); from
armed, moving >8px starts a real drag (reusing the desktop machinery), an unmoved
lift opens the context menu at the finger. `lastLongPressAt` (700ms) suppresses the
trailing synthetic tap; `touchPressAt` (800ms) stands down Android's own long-press
contextmenu. On touch, drag/create previews ride the popups instead of hover (the
insert line shows while the create dialog is open; the delete flash pulses during
the confirm window — appConfirm does not block). The create popup `#new-dialog` is
a confirm-style card at body level: outside click capture-cancels (nothing behind
it acts), Escape cancels first, Enter adds, errors stay inside the dialog.

**Measure (adjustable line/field width).** Two handles on `.doc-head`'s underline:
A (▶, at the line's START) changes only the always-centred LINE's width (both
margins equally); B (◀) is the ONLY field-width control. The LINE WRAPS the
content: one centred `.doc-col` column, the field rides its start BY STRUCTURE —
no inset formula (a content-side inset once desynced the topline; shipped and
reverted). Clamps, floor first: field ≥ 36ch (absolute), line ≥ field, both ≤
content width; B can never widen the topline. `--measure` must NOT be named
`--line` (shadows the --line colour token — strips every border inside .main).
`font: inherit` on the handles is load-bearing (else B's 72ch fallback resolves
against the button's UA font and the handle teleports). State in localStorage
(`iauthor.measure`), same in every file; Pointer Events + setPointerCapture;
arrow keys nudge by 1ch; resize re-clamps. No handles on mobile (full width).
The two handle buttons are STATIC markup in DocView.astro (so they paint with
the page instead of arriving with the app bundle); only the wiring lives in
measure.ts. The saved measure governs the welcome screen too: applyMeasure
clamps against `#empty` when `#doc` is hidden (the ch probe lives on body —
a probe inside a hidden element reports 0 widths), and index.astro's
pre-paint inline script sets `--line-w`/`--field-w` on `.main` from
localStorage before first paint (key literal duplicated there — inline
scripts can't import TS constants).

**Welcome pseudo-file & misc UI.** `#empty` is a read-only `.doc-col` with a
`.doc-head` — deliberately NOT a real file (a top-level welcome.md would take a
number and pollute the frozen disk schema). **Trap**: `#empty` precedes `#doc` in
the markup, so every `.doc-head` query must be scoped to `#doc` (`docHead = 
doc.querySelector('.doc-head')`) — keeps rename wiring, the ch probe and the
measure handles off the welcome header. Tap below the text → caret to the end
(the end of a long chapter is unreachable by tap otherwise). Mobile undo/redo
buttons (`#undo-btn`/`#redo-btn`) are SIBLINGS of `.app` so the `~` selectors work
(same rules as the theme toggle ◐: nav-off z-index, bar-away scroll-away, nav-anim
gates).

## Backup contract (milestone 6, implemented elsewhere)

The owner's external microservice (separate repo, NOT this codebase — iauthor
implements nothing): the works dir is a git repo, everything textual is committed
(the autosave coalescer closes bursts within ~5s), pdfs are gitignored and
recompilable. The microservice (systemd timer, user `server`; **READ-ONLY rule**:
never commit/add/reset inside the works repo, that would pollute the undo history):
`git clone --mirror` once, `git fetch --prune` each tick, push a timestamped
`git bundle --all` (full DAG incl. all undo branches) to ProtonDrive via rclone,
keep last N; restore = clone the bundle → point `IAUTHOR_WORKS_DIR` at it.
Concurrent reads are safe (git ref updates are atomic); a burst caught uncommitted
rides the next snapshot.

## Planned (owner request, not yet built): scope prefaces

A preface file that can live on ANY level — a preface to a part, to a book, or
to a whole work — acting as the preface of whatever folder it sits in. Sketch
the owner gave: a `00_file.md`-style special name. Open design questions to
settle BEFORE building (owner decides):

- **Naming/marker**: `00_` cannot be the marker as-is — numeric prefixes are
  app-managed and renumbered to `01…N` on every mutation, so a `00_` prefix
  would not survive (`renumberDir` skips reserved bare names only). Either a
  reserved bare name token (the MATTER way) or an explicit `00_` exception
  carved out of the renumbering grammar — needs a decision.
- **Relationship to MATTER**: `preface`/`foreword`/`prologue` already exist as
  matter names (bare print, no number, compile as front matter). Decide what a
  scope preface does differently — e.g. always first in its scope's pdf, shown
  as preamble in the folder index, one per scope vs. many.
- **Any level**: work, book, part — placement in the pdf contents (`pdf.ts`)
  and in the folder index view (`showGroup`) must follow the depth.

## Deferred todo list

- Client-side LLM word-prediction (flag unlikely tokens as possible typos, suggest fixes).
