# AGENTS.md — context for continuing development

Read this fully before making changes. It contains the product vision, the user's
explicit preferences, architecture, deployment, and the hard-won gotchas.

## What this is

**I author** (project/package name: `iauthor`, display name always written "I author")
is a private, single-user markdown writing webapp. The owner writes books/poems on
holiday trips from laptop (or phone, bare minimum). Markdown files live in a plain
directory on their VPS; the webapp is the only interface.

Non-goals: multi-user, collaboration, databases, heavy frameworks, features beyond
the roadmap below. If a change adds complexity, it needs a good reason.

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
- **Local git in the works dir**: auto-commits on every save/create/delete. Server-only
  history, never pushed. The user never manages git.
- **Encrypted backups** (planned, milestone 6): gzip + AES-256-GCM snapshot of the whole
  works tree pushed one-way to a private GitHub repo; master key lives in the user's
  password manager. Nothing unencrypted leaves the server.
- **Editor sync** (milestone 3): writes go to a local draft, pushed to the server in
  chunks — never char-by-char. Unsynced text renders lighter and darkens once the
  server confirms. Single user → no merge logic; last-write-wins + local git history
  is the safety net. Trigger: cumulative dirty words ≥10, or 5s idle.
- **UI aesthetic**: minimal, angular (border-radius ≤ 2px), cool neutral palette with a
  strong blue accent, self-hosted Literata serif, dark mode, no UI framework, no Tailwind.
  Do not mention the user's password manager or setup in UI text.
- **Nav**: the `I author` title is the *only* tree toggle — desktop slides between
  docked/focus, mobile expands over the page. No hamburger button; don't reintroduce one.
- **Laptop-first.** Mobile = bare minimum (sidebar behind a ☰ button; forms must work).

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
- Auth crypto: node built-ins only (scrypt, HMAC, timingSafeEqual, AES-GCM later).
  TOTP is hand-rolled RFC 6238 in `src/lib/totp.ts` (verified against the official vectors).

## Repository layout

```
flake.nix            dev shell: nodejs_22, pnpm, git, rclone; scripts/ on PATH
scripts/             run (dev :4321), build, test-auth, deploy
src/middleware.ts    auth guard: setup redirect, session check, idle lock, cookie renewal
src/lib/config.ts    all env vars, cookie name, TTLs
src/lib/http.ts      json(), clientIp(), isSecure()
src/lib/totp.ts      TOTP generate/verify + totpAt(secret, unixSeconds, digits) for tests
src/lib/auth/        secrets, pin (scrypt), device tokens (HMAC), idle lock, rate limit,
                     recovery codes, auth.test.ts
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
                     KaTeX math ($…$ inline, $$…$$ display) via MathWidget
src/lib/sync.ts      chunked-sync engine: unsynced marks, draft store (sessionStorage),
                     push machine (createSync) — dirty-word accumulator + idle push
src/lib/git.ts       ensureRepo + commit(msg) in WORKS_DIR (server-local, never pushed)
src/lib/pdf.ts       PDF compiler: LuaLaTeX + `markdown` package; ensurePdf(rel, style,
                     force) compiles beside the source in the works dir; pdfPlan(rel,
                     style) is the same cache decision without LaTeX (the loader polls
                     it). Names that reach paper — title page, artifact download name,
                     loader heading — come from the node's `raw` title via scopeTitle(),
                     never from the disk basename, so prefixes can't leak into print;
                     styles from pdfstyles/ (first line `% label: L — note` = metadata)
src/pages/api/       setup, login, session, logout, lock, tree, file (GET/PUT), new, delete,
                     rename, pdfstyles
src/pages/           index.astro (app shell), login.astro, setup.astro, pdf.ts (stream)
pdfstyles/           LaTeX preamble "stylesheets" (a4, a5, academic) — single source
                     of truth for the pdf style menu
src/layouts/         base.astro (theme pre-paint script, Literata import)
src/styles/global.css  design tokens + shared components + app shell + markdown styles
```

### index.astro flow map (~950 lines, the entire UI; all JS in one `<script>`)

```
boot()         restore expanded state (localStorage) → loadTree() → restore last draft
loadTree()     GET /api/tree → `tree` + `byPath` Map (path → Node) → renderTree()
renderTree()   rebuilds <nav id=tree>; `selected` + `expanded` Sets drive the view
openFile(p)    GET /api/file → makeEditor(content); restores sessionStorage draft if newer
showGroup(n)   folder index TOC (never an editor); awaits leavingFile() + loadTree()
               first so word totals (Node.words) reflect saves since the last load
leavingFile()  flushDraft + sync.pushNow if dirty — ALWAYS before switching files
sync hooks     onSaved/onDirtyChange update the doc-words chip (header)
context menu   right-click: ctxTarget + hover previews (insert-line, delete flash);
               pendingParent/pendingAnchorPath feed the create dialog
rename         header click (except buttons) → raw-name editor → commitRename()
               (+ moveDraft, remapExpanded so subtree stays open)
```

Where a change goes: data/files → `works.ts`, UI shell → `index.astro`,
editor features → `preview.ts`/`sync.ts`, naming → `naming.ts` (pure, both sides).

## Dev workflow

```
nix develop          # everything below assumes this shell
run                  # astro dev on :4321
test-auth            # pnpm test (node --experimental-strip-types, node:test)
build                # production build
deploy               # test + build locally, sync source + dist to VPS, restart, health check
```

- **Test on the deployed server, not locally.** The user tests UI changes against the
  live VPS after `deploy`. Local verification stops at: `pnpm test` + `pnpm build`
  succeed (both run inside `nix develop -c`; bare `pnpm` doesn't exist outside the
  shell). Don't spin up local servers or complete local setup to "verify" pages —
  it wastes time and the local env has no secrets anyway.

- Tests run with `node --experimental-strip-types` — no test framework, no TS features
  that need transformation (no enums).
- `src/lib/test-setup.ts` must be imported **first** in test files that touch `config.ts`,
  because `WORKS_DIR`/`SECRETS_FILE` are captured at module load.
- pnpm 10+ blocks build scripts. Since pnpm 12, that config lives in
  `pnpm-workspace.yaml` as `allowBuilds: { esbuild: true, sharp: true }`
  (`pnpm.onlyBuiltDependencies` in `package.json` is dead — pnpm ignores it with a
  warning). Keep that file; if pnpm scaffolds it with placeholder
  "set this to true or false" values (it does when it wants a decision), fill in
  `true` — don't delete the file.

## Auth model (details that matter)

- Secrets live in `secrets/secrets.json` (gitignored, mode 0600): pin hash, totpSecret,
  sessionSecret, masterKey, recovery codes (`{id, salt, hash, used}`). Written once by
  `/setup`; there is no UI to rotate — deleting the file re-runs setup.
- `POST /api/login` logic: rate limit per IP (fails <5 → free; 5th fail → 30s lock,
  doubling to 15 min). `trusted` = valid device cookie. Trusted + correct PIN → login
  (no TOTP). Untrusted → PIN + (TOTP ±1 window or unused recovery code).
- Idle lock is **in-memory** (`src/lib/auth/idle.ts`): a token with no entry counts as
  locked — so server restarts lock sessions (PIN re-entry, not full login). `POST /api/lock`
  forces this.
- Middleware rules: `/setup` reachable only pre-setup; `/api/session` and `/api/logout`
  always pass; `/api/login` passes (rate-limited inside); everything else needs a valid,
  non-idle-locked cookie. API requests get JSON 401s; pages get redirects.
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
  by position like everything else, so no `?` placeholder exists. Prefix contiguity
  and drag-to-reorder are phase 2; for now `createEntry` appends with the next free
  number and nothing rewrites existing prefixes.
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
  👁 open / 🙈 hidden, persisted in localStorage) hides drafts, notes, and empty
  directories from tree and indexes; folders whose children all vanish are dropped;
  notes render normally in indexes, they are only hidden together with drafts.
  Create/delete happen via the right-click context menu on the tree.
- **Rename**: clicking anywhere in the header (except the buttons) swaps the title for
  an inline raw-name editor (live-preview style: display title ↔ disk name).
  `POST /api/rename` edits the **title**, not the whole disk name: the typed name
  (slugified) becomes the entry's title while its numeric prefix and `draft_` token
  are preserved unless the typed name carries them explicitly (`composeName` in
  `works.ts`) — otherwise editing a title would silently drop the prefix and send the
  file to the end of its folder. Duplicates are rejected, and git-commits;
  sessionStorage drafts move to the
  new path (`moveDraft`) and the sidebar's expanded state is remapped to the new
  prefix (`remapExpanded`) so the subtree stays open. Renaming a folder rewrites all
  descendant paths.
- `createEntry` slugifies names (spaces → `_`, case preserved), rejects duplicate
  slugs (case-insensitive, prefix-stripped), and auto-prefixes `NN_` (next number; a
  user-typed leading `NN-`/`NN_` is kept). Parsers accept both `-` and `_` prefixes
  forever; `scripts/migrate-names.mjs` renamed pre-existing hyphenated entries.
- `safePath` rejects `..`, empty/hidden segments, and anything whose realpath escapes
  `WORKS_DIR`. Only `.md`/`.markdown` files are readable/writable; 512 KB cap; atomic writes.
- Every mutation (`new`, `file PUT`, `delete`, `rename`) ends with `git.commit(...)`
  in the works dir. Empty folder creations produce no commit (git doesn't track
  dirs) — expected.
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
- **Always deploy with `scripts/deploy`** — it tests locally, pushes `main` to
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
| `IAUTHOR_IDLE_LOCK` | `12h` | idle lock timeout (`30m`/`12h` style) |
| `IAUTHOR_SECURE` | unset | force Secure cookies (normally auto via `x-forwarded-proto`) |
| `IAUTHOR_DOMAINS` | `localhost` | build-time `security.allowedDomains` (deploy sets it) |
| `IAUTHOR_LUALATEX` | `lualatex` | pdf compiler binary (flake puts it on PATH) |
| `HOST`/`PORT` | localhost/4321 | node adapter bind |

## Gotchas learned the hard way

- `pnpm test` globs `src/lib/*.test.ts` on purpose. It used to list the three test
  files explicitly, and `pdf.test.ts` was therefore never executed — a whole file of
  passing-looking assertions that no run ever touched. When adding a test file, check
  the count in the summary actually went up.
- Local dev server binds `::1` — test with `http://[::1]:4321`, not `127.0.0.1`.
- When verifying UI changes, make sure you're serving the **fresh** dist (stale servers
  from earlier test runs have caused false results). Kill old processes first
  (`pkill -f 'dist/server/entr[y]'` — bracket trick avoids killing your own shell).
- Login page ships all fields visible in HTML; the locked path hides the 2FA group via
  JS. Do not "unhide later" — there is no unhide step, only hide paths. (This exact bug
  shipped twice.)
- Every CodeMirror `WidgetType` subclass must implement `toDOM` — one without it
  (`e.toDOM is not a function`) crashed the whole decoration pipeline, silently killing
  tables/fences too. Diagnosed only via a headless-DOM dump; unit tests (node:test) can't
  catch DOM-render bugs. Test on the server, per the workflow rules.
- Never commit secrets or the `.env`. The project repo itself has almost nothing
  committed yet; only commit when explicitly asked.

## Planned: collapsible tree view (milestone 4.7)

Agreed design, **not yet implemented** — follow it instead of re-deriving. The
`I author` brand becomes a `<button>` and the only way to show/hide the tree; the ☰
hamburger (`#menu-btn`) is deleted outright. Two regimes from one state class:

- **desktop** — click the title → tree, drafts toggle, new-row and the lock/log-out row
  fade out, the sidebar's background and right border fade to transparent, and the tree
  column collapses so the reading measure re-centres **9rem to the right**. That slide is
  the point, not a bug: *docked* (writing/navigating) vs *focus* (reading). Both states
  centre the same 72ch measure — docked inside `viewport − 18rem`, focus inside the
  viewport — so the travel is always exactly half the tree width and `.doc-head`'s rule
  gets equal margins either way. On mobile nothing moves at all (the panel is an overlay,
  no width is reserved), so docked/focus is a desktop-only concept.
- **mobile (≤900px)** — the title sits in a fixed top bar, always visible; the tree
  expands **over the whole page** below it (`position: fixed; inset: 0`), gerhard.page
  workspaces style. **Starts hidden on every load.** Close via the title, `Escape`, or
  picking a chapter.

### Layout: overlay sidebar, toggled grid track

`.sidebar` becomes `position: fixed` (replaces `sticky`; scrolling unchanged) overlaying its
own track. `.app` keeps the grid and the track *is* the toggle:

```css
.app { grid-template-columns: 0rem 1fr; transition: grid-template-columns var(--nav-dur) ease; }
.app:not(.nav-off) { grid-template-columns: 18rem 1fr; }  /* docked: the track reserves the tree */
.main { max-width: calc(72ch + 2.5rem); margin-inline: auto; padding: 2rem 1.25rem; }
@media (max-width: 900px) {
  .app { grid-template-columns: 0rem 1fr; }              /* overlay only: nothing reserved */
  .main { padding: 3.5rem 1.25rem 2rem; }               /* clears the fixed title bar */
}
```

Track 1 is a **length** in both states, so it interpolates instead of snapping, and the
measure is width-capped in both states, so **the text never re-wraps while it slides**.
`.doc-head`, `.md-body`, `#editor-host` and `.toc` all sit inside that one column for free
(their inner `max-width: 72ch` rules become redundant). The old clamp padding
(`2rem clamp(1rem, 8vw, 10rem)`) and any 1300px breakpoint die here — centring inside the
remaining box replaces both. `box-sizing: border-box` is global, hence `calc(72ch + 2.5rem)`.

### Collapsed = pointer-transparent

Collapsed `.sidebar`: `background: transparent; border-right-color: transparent;
pointer-events: none`, with only `.brand { pointer-events: auto }`. The invisible 18rem
column then swallows no clicks, text selections or scroll gestures and leaves no dead zone
— only the title is live, which is exactly the requested behaviour. `.tree`, `.new-row`,
`.side-foot`, `.toolbar` fade with `opacity` + a 0.5rem slide; background and border fade
via `background-color`/`border-color`. `--nav-dur: 0.2s`, dropped entirely under
`prefers-reduced-motion`.

### State, a11y, files

- `.app.nav-off` is the only state, `setNav(open, persist?)` the only mutator;
  `document.body.classList.add('nav-anim')` after boot so the first paint doesn't animate.
- `localStorage['iauthor.nav'] = '1'|'0'`, same precedent as `iauthor.hide-drafts`.
  Boot: `narrow() ? false : stored !== '0'` — mobile always starts hidden, and a mobile
  collapse passes `persist=false` so it never overwrites the desktop preference.
- `brand` is `<button aria-expanded aria-controls="tree">`, styled to look like today's
  span; hidden parts get `inert` so Tab skips them.
- `Escape` closes. The create dialog and the tree context menu force `setNav(true)` first,
  so no control can ever sit behind a closed panel.
- Tree row click: `if (narrow()) setNav(false)` — on desktop the tree stays open while
  switching chapters. Replaces `sidebar.classList.remove('open')`.
- Touches `index.astro` (markup lines 6–9, the `menu-btn` handler, ~15 lines of script —
  `setNav` joins the flow map above) and `global.css` (`.app`, `.sidebar`, `.main`, the
  `.nav-off` rules, the media-query rewrite, `.menu-btn` deletion, `--nav-dur`).
- Verify: `test-auth` + `build`, then `scripts/deploy` and test the slide, the fade and the
  mobile overlay on the VPS — animation and DOM behaviour is exactly what local tests can't
  catch.

Defaults baked in: desktop boots **docked** (focus mode is opt-in but remembered), and
`lock` / `log out` / `drafts` stay inside the panel, reachable only with the tree open (they
are tree chrome, not reader chrome).

## Roadmap

Done: 1) scaffold + auth (PIN/TOTP/recovery/device cookie/idle lock) · 2) works tree,
file APIs, sidebar, local git auto-commit · deploy routine · login/setup polish ·
3) editor — CodeMirror 6, chunked sync (push at ≥10 words changed or 5s idle), unsynced
words lighter → fade on confirm, sessionStorage draft survives reload/PIN lock ·
4) live preview (Obsidian-style) — single CodeMirror source of truth; decorations hide
syntax and render compiled output everywhere except the cursor's line while focused;
tables/checkbox widgets/inline styles; fenced code highlighted via language-data;
ctrl/cmd+click opens links (external → new tab, relative .md → in-app) ·
4.5) naming/filesystem refactor — `01_name` disk schema (migration ran on the server),
display titles (Work/Book/Part/Chapter, bare top level, prefix-derived numbers),
drafts + hide toggle, folder index view, notes/title special files, header rename,
`src/lib/naming.ts` grammar module · 4.6) tree context menu — right-click a row or
empty space for `new`/`delete` (hover previews: green blinking insertion line, red
pulsing subtree); create dialog with md/dir toggle + auto `NN_` prefix prefill;
sidebar toolbar reduced to the drafts toggle (eye glyph); expand/collapse state
persisted in localStorage (`iauthor.expanded`), caret clicks toggle without
selecting · 5) PDF compiler via LaTeX (replaced an in-editor paged view that
fought screen text sizes — deleted) — the `pdf` dock button opens
`/pdf?path=&preset=` which compiles (or just streams, if fresh) a real PDF
beside its source in the works dir (`01_flight.md` → `01_flight.pdf`,
folder `01_work/` → `01_work.pdf`); LuaLaTeX + the `markdown` package,
preamble "stylesheets" live in `pdfstyles/` (first line `% label: ...`,
menu from `GET /api/pdfstyles`, default `academic` = 6.1″×9″; Book/Part folders get a division page of their own (always after a page break) stacking the printed convention — the more senior the division, the smaller its type: enclosing division in small caps, own label below, title large via `\part*` (so the style's titlesec block still owns it); each page names its
  **immediate** container — a book's parts print the book, a work's books print the
  work — and the fragment key covers those lines, so renaming a book rebuilds its
  parts' pages; only books take Roman numerals — parts and chapters are Arabic;
recompile item + stale-mtime auto-recompile; preset in
`iauthor.pdf-preset`); folder scopes get title page + `\tableofcontents`
(real page numbers, two-pass compile), chapters get ruled unnumbered section
headings, markdown content headings shift down one level; folder aggregates
follow the sidebar's drafts toggle (`drafts=1` includes them — a `.texbuild`
state file keys artifact freshness by style + toggle + mtimes), while a
directly requested draft chapter always compiles; works dir `.gitignore` gets
`*.pdf` seeded by `ensureRepo`;
KaTeX renders `$…$`/`$$…$$` math in the editor preview (`preview.ts`).

Planned: 4.7) collapsible tree view — the `I author` title becomes the only tree toggle,
☰ hamburger deleted; desktop slides between docked and focus (9rem re-centre), mobile
expands the tree over the page and starts hidden. Design agreed, nothing built yet — see
§Planned: collapsible tree view above.

Numbering rework, phase 1 (shipped): printed numbers are positional among same-kind
siblings instead of the disk prefix; `renameEntry` edits the title and preserves the
prefix + draft token (`composeName`); matter accepts a prefix; print/artifact names
come from `Node.raw` (`scopeTitle`); `pnpm test` globs so new test files actually run.
Phase 2 (not started): prefixes hidden in the tree, contiguous per directory incl.
top level (one-time `scripts/` migration, git-committed), `POST /api/reorder` +
drag & drop within and across folders returning an old→new path map so client state
(expanded, selection, sessionStorage drafts) remaps.

Next: 6) Encrypted GitHub
backup: tar+gzip whole tree → AES-256-GCM with master key → one ciphertext blob per
snapshot to a private repo via deploy key; `scripts/restore` to decrypt+untar; prune
option (keep last N); optional rclone crypt → ProtonDrive timer. 7) Mobile pass.

Deferred todo list: project-wide search;
client-side LLM word-prediction (flag unlikely tokens as possible typos, suggest fixes).