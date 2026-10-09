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
- **Laptop-first.** Mobile = bare minimum (the sidebar toggle still exists until 4.7
  replaces it with the title-as-toggle overlay; forms must work).

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
src/lib/http.ts      json(), clientIp() (socket address only — see §Auth model), isSecure()
src/lib/visibility.ts  the "what's visible" rule (drafts + notes + empty dirs) in one place;
                     visibleNodes(nodes, opts) — shared by the sidebar and the pdf aggregates
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
                     KaTeX math ($…$ inline, $$…$$ display) via MathWidget; hidden
                     ranges are non-atomic (only the checkbox is atomic) so arrows
                     traverse raw offsets; VERTICAL motion is hybrid — a
                     high-precedence ↑/↓ keymap (arrowStep) steps a plain
                     source-line cursor when it starts inside or would enter a
                     table/$$ block (native moveVertically pixel-skips block
                     replaces; char goal column in a WeakMap), everything else
                     stays native; pinScreenY scroll-compensates reveals so the
                     caret doesn't ride block height changes; widget clicks map
                     back to source (table clicks land in the clicked cell via a
                     per-cell offset map)
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
                     rename, reorder, pdfstyles, pdfstatus
src/pages/           index.astro (app shell), login.astro (PIN is a text field masked
                     with ● in JS — mobile keyboards echo the last digit of
                     password fields), setup.astro, pdf.ts (stream)
pdfstyles/           LaTeX preamble "stylesheets" (a4, a5, academic) — single source
                     of truth for the pdf style menu. a4.tex and a5.tex share 51 of
                     54 lines (differences: label, documentclass pt, geometry) and
                     are kept in sync BY HAND — duplication accepted by design
src/layouts/         base.astro (theme pre-paint script, Literata import)
src/styles/global.css  design tokens + shared components + app shell + markdown styles
src/lib/editor.ts    CodeMirror extension set (editor_extensions assembled once)
src/lib/pdf-wait.ts  client-side loader polling /api/pdfstatus
src/lib/*.test.ts    node:test suites (test-auth runs the src/lib/*.test.ts glob)
```

### index.astro flow map (~1400 lines, the entire UI; all JS in one `<script>`)

```
boot()         restore expanded state (localStorage) → loadTree(); NO last-page
               restore — the welcome message is the boot screen (drafts still
               come back when the user opens the file they belong to); nav:
               desktop boots with the tree open, always
loadTree()     GET /api/tree → `tree` + `byPath` Map (path → Node) → renderTree()
renderTree()   rebuilds <nav id=tree>; rows show Node.raw (no prefix) and are
               draggable; `selected` + `expanded` Sets drive the view
tree click     the caret ([data-caret]) toggles expand/collapse without
               selecting; a folder ROW click never collapses — it opens the
               folder's index and unfolds the row if folded; only a repeat
               click on a folder already being viewed (`currentGroup ===
               node.path`) toggles it. File rows open. Chrome (brand, all
               .btn-tiny buttons, tree rows) is user-select: none
drag & drop     the whole `.tree-row` is the drag handle (draggable=true; native
               drag's own movement threshold keeps a plain click a click). The
               dragged copy is a custom `.drag-card` — a solid clone of the row
               that follows the cursor (`transform` on a document-level
               `dragover`); the browser's own drag image is suppressed with a
               1x1 transparent gif. No `setDragImage` snapshot games: engines
               rasterize it differently (Chrome lazily, at the next paint) and
               two timing attempts shipped translucent on the author's machine.
               The row left behind IS the ghost (opacity .45). Cleanup rides on
               a `dragend` listener attached to the source row itself —
               `renderTree()` can detach that row mid-drag, and drag events on
               a detached source no longer bubble to `treeEl`;
               drop posts intent {path,parent,before} to /api/reorder, then
               remapPaths(renumbered) + loadTree, expand the destination and
               select what landed there (desktop only — HTML5 DnD does not fire
               on touch; keyboard reordering does not exist yet)
drop preview    ONE `#insert-line` element for both create and move; only the
               colour differs (`--ok` green = creating, `.moving` `--accent`
               blue = moving, red row pulse = deleting). Geometry is shared
               too: `placeLineInFolder` draws a slot at child indent for
               "inside this folder", `placeLine` a flush sibling slot. Every row
               has TWO bands: the TOP half is a slot at the row's OWN level,
               directly above it — for a plain entry its own folder, for a folder
               a slot in its parent (so an entry becomes a folder's sibling), and
               because a child sits one `CHILD_INDENT` in, that is exactly where
               `placeLineInFolder` draws on the parent row: aiming above the
               first child and aiming below the parent are one and the same line.
               The BOTTOM half means "below it" for a plain entry and "inside it"
               for a folder. Two bands on facing rows are
               one zone between them — same result, no ambiguity. `DropIntent.kind`
               ('above' | 'inside' | 'below') names the band, and a `below` slot
               draws UNDER its row (the last entry of a folder appends, so the
               line belongs below it, not above).
               Hovering a CLOSED folder expands it (like the
               `new` preview does on mouseenter) — but only temporarily: the
               chain of hover-opened folders lives or dies with its outermost
               member (`dragOpened` list + `pruneDragOpened`: while the aim
               roams anywhere inside the outermost opened folder the whole
               chain stays open; leaving it closes everything at once — a
               subfolder is dismissed only with its owner). A drop landing
               elsewhere closes all via `closeDragOpened`; only the drop
               destination stays open, because `reorderTo` expands it.
               `visible()` keeps such an empty folder on screen via `dragPreview`
               (the `keepEmpty` callback in `visibility.ts`), and `isVisibleNode`
               walks the same rule instead of reimplementing it.
               The rest of the sidebar viewport is also a drop zone (sidebar-level
               dragover/drop/dragleave, guarded against row targets): aiming off
               the rows lands the drag at TOP level, appended under everything —
               the quick way out of a folder; the line draws under the LAST
               visible row at top-level indent.
openFile(p)    revealPath(p) first — expand ancestors + select the row (the opened md
               is always visible/highlighted in the tree) — then GET /api/file →
               makeEditor(content); restores sessionStorage draft if newer
showGroup(n)   folder index TOC (never an editor); awaits leavingFile() + loadTree()
               first so word totals (Node.words) reflect saves since the last load
leavingFile()  flushDraft + sync.pushNow if dirty — ALWAYS before switching files
sync hooks     onSaved/onDirtyChange update the doc-words chip (header)
context menu   right-click: ctxTarget + hover previews (insert-line, delete flash);
               pendingParent/pendingAnchorPath feed the create dialog
rename         header click (except buttons) → raw-name editor → commitRename()
               (+ moveDraft, remapExpanded so subtree stays open)
measure        two handles on .doc-head's underline: A (▶, at the line's START)
               changes only the LINE's width — the line is always centred, both
               margins move equally (lineW = from − 2·dx, handle rides 1:1);
               the LINE WRAPS the content: one centred `.doc-col` column, the
               topline spans it and the field (.doc-col > .md-body /
               #editor-host) rides the column's start BY STRUCTURE — no inset
               formula exists (a content-side inset once desynced the topline,
               shipped and reverted 2026-10-09); B (◀, positioned
               at left: min(var(--field-w), 100%)) is the ONLY width
               control. Both triangles are the buttons themselves (clip-path,
               so the hover/click area is the triangular shape and the apex
               sits exactly on its anchor — offset 0.1ch inward so the apex
               stays on the line at max width); `font: inherit` on the handle
               is load-
               bearing — without it B's 72ch fallback resolves against the
               button's UA font and the handle teleports on first grab. Hover
               brightens the triangle only, no tint box.
               Defaults: the resting geometry is ONE centred column —
               --measure = min(var(--line-w, 100%), 100%), so the LINE spans
               the whole markdown area and the field rests at 72ch on the
               line's start, B at 72ch (not far right); dragging A widens the
               line and the field rides its start — the sketch's longer line.
               `--measure` must NOT be named `--line`: that shadows the --line
               colour token and strips every border inside .main (shipped that
               way once — the topline vanished).                falls out of applyMeasure's clamps, FLOOR FIRST: the field
               clamps to the 36ch floor (absolute — no drag and no narrow line
               may squash the text; the ceiling is max(effLine, minFw), which
               keeps B jailed within the line above the floor), then the line
               clamps to [field, content width] — A always stops where the
               text stops. B can never widen the topline — the topline's
               width is A's alone, and B only has room once A has made it.
               `.measure-b`'s left is also CSS-capped at
               min(--field-w, 100%) as a belt-and-braces guarantee. field ≥
               36ch, line ≥ field, both ≤ content width; B can therefore
               never leave the line. State ({linePx, fieldPx}, 0 = default) is
               memorized per browser in localStorage (`iauthor.measure`) — the
               same measure in every md file, across reloads;
               CSS vars --line-w/--field-w on .main; Pointer
               Events + setPointerCapture (HTML5 DnD is dead on touch); arrow
               keys nudge the focused handle by 1ch; resize re-clamps
setNav(open)   the ONLY nav mutator (4.7): toggles .app.nav-off, aria-expanded
               on the brand button, inert on tree/new-row/toolbar/side-foot.
               The brand click toggles; Escape closes (unless the create
               dialog or a menu is open); a mobile tree-row click closes.
               The sidebar is an overlay; the docked margin is STATIC padding
               on .main, independent of the nav state — nothing moves when
               the tree hides or shows (no slide, applyMeasure not called —
               a grid track misplaced the view, see §Shipped above)
```

Where a change goes: data/files → `works.ts`, UI shell → `index.astro`,
editor features → `preview.ts`/`sync.ts`, naming → `naming.ts` (pure, both sides).

## Dev workflow

```
nix develop          # everything below assumes this shell
run                  # astro dev on :4321 (foreground)
dev                  # detached test server on :4321, all interfaces; idempotent,
                     # log /tmp/iauthor-dev.log — THIS is the owner's test env
test-auth            # pnpm test — exists for the record; the agent NEVER runs it
build                # production build — the agent NEVER runs it (deploy does)
deploy               # push main to GitHub; the server pulls, installs, builds,
                     # restarts and health-checks (see §Deployment) — ONLY on request
```

- **NO TESTING. NEVER.** (owner decision 2026-10-09: "remove ALL testing. I can test.")
  The agent does NOT run `pnpm test`, `pnpm build`, `scripts/test-auth`, `scripts/build`,
  lint, typecheck, or ANY verification/smoke/curl command after a change. Zero. Not
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

- Tests exist (`node --experimental-strip-types`, no TS features that need
  transformation — no enums) but running them is the deploy script's and the owner's
  business, never the agent's.
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
- **Pre-setup the app is OPEN** (owner decision 2026-10-09, identical local/prod):
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
  (`composeName` in `works.ts`) — un-numbering is impossible by design, and without
  preservation editing a title would silently drop the prefix and send the file to
  the end of its folder. The `draft_` token follows the typed name instead: keep it
  in the prefilled name to stay a draft, delete it to un-draft. Duplicates are
  rejected, and git-commits;
  sessionStorage drafts move to the
  new path (`moveDraft`) and the sidebar's expanded state is remapped to the new
  prefix (`remapExpanded`) so the subtree stays open. Renaming a folder rewrites all
  descendant paths.
- `createEntry` slugifies names (spaces → `_`, case preserved, a typed
  `.md`/`.markdown` extension stripped — typing "notes.md" yields `01_notes.md`),
  rejects duplicate slugs (case-insensitive, prefix-stripped), and auto-prefixes
  `NN_` (next number; a user-typed leading `NN-`/`NN_` is kept). Parsers accept
  both `-` and `_` prefixes
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
| `IAUTHOR_IDLE_LOCK` | `12h` | idle lock timeout (`30m`/`12h`/`1d` style) |
| `IAUTHOR_SECURE` | unset | force Secure cookies (`1`/`true`/`yes`/`on`; normally auto via `x-forwarded-proto`) |
| `IAUTHOR_DOMAINS` | `localhost`,`[::1]` | build-time `security.allowedDomains` (deploy sets it) |
| `IAUTHOR_LUALATEX` | `lualatex` | pdf compiler binary (flake puts it on PATH; read by `pdf.ts` directly, not `config.ts`) |
| `HOST`/`PORT` | localhost/4321 | node adapter bind |

## Gotchas learned the hard way

- `pnpm test` globs `src/lib/*.test.ts` on purpose. It used to list the three test
  files explicitly, and `pdf.test.ts` was therefore never executed — a whole file of
  passing-looking assertions that no run ever touched. When adding a test file, check
  the count in the summary actually went up. (The agent never runs tests at all —
  see §Dev workflow: NO TESTING. NEVER.)
- A bare `run` (astro dev without `--host`) binds `::1` only — test with
  `http://[::1]:4321`. `scripts/dev` passes `--host`, so localhost and the LAN IP
  both work there.
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

## Known issues (audit 2026-10-04) — all tiers fixed, decisions recorded

A full read-only audit of the project against this file. Everything below was verified in
the source. Tier 1 was fixed on 2026-10-04 (same day); Tiers 2–4 (the cheap ones) followed
the same day, and the last Tier 4 items were verified against the source and fixed the
same day after owner review. Treat the audit as a work list,
not as spec — where the two disagree, the code is current and the prose above is stale.

**Tier 1 — real bugs, small fixes, no API change — FIXED 2026-10-04:**

- the idle lock fired itself: the middleware `touch`ed the *old* token, then minted a
  *fresh* cookie with no `seen` entry ("no entry" = locked) → ~15 days after each login the
  next request bounced to `/login?locked=1`. Fixed with `touch(fresh)` after minting
  (`middleware.ts`), plus a sweeper in `auth/idle.ts` that drops entries older than the
  idle lock (they are meaningless — the session is locked by then anyway).
- one unreadable folder killed the whole tree: `scan()` now try/catches `readdirSync` and
  renders the folder empty, matching `countFile`'s swallow-an-error behaviour.
- the rate limiter trusted the client's IP: `clientIp` now uses the **socket address
  only** and ignores `x-forwarded-for` entirely — XFF is client-supplied and forgeable,
  and behind Caddy every socket address is the proxy anyway, so the login rate limit is
  one global bucket. Product decision by the owner: a global lockout is fine and even
  desired (a break-in attempt locks everything and is visible).
- `pdf.ts` `chapterTitle`'s fallback spoke the old disk-prefix numbering grammar; it now
  prints the raw title unnumbered (a number there could only contradict the sidebar), and
  the "UNCLENED" typo is gone.

**Tier 2 — consistency / dead code — FIXED 2026-10-04:**

- The "what's visible" rule (drafts + notes + empty folders) lived in **two** copies
  (`index.astro`'s `visible` and `pdf.ts`'s `clean`). It is now `src/lib/visibility.ts`
  (`visibleNodes(nodes, opts)`), shared by both; the sidebar's drag-preview escape hatch
  is an optional `keepEmpty` callback the pdf path omits.
- `renameEntry`'s duplicate check used `fs.existsSync`; it now goes through
  `findExisting`, the same case-insensitive, prefix-stripped rule `createEntry` uses —
  a case-variant collision is rejected on rename too.
- `dropDraft` cleared the global `iauthor.draft` pointer unconditionally; it now clears
  it only when it names the draft being dropped, so a second file's draft stays
  restorable at boot.
- The unsynced chip could stick: `pushNow`'s equal-content early return left the dirty
  counter set. `clearIfClean` now resets it (and fires `onDirtyChange`), and `pushNow`
  calls it on that path.
- Dead code removed: `rawTitle()` (identity wrapper), `scan`'s never-read `depth`
  parameter, `buildDeco`'s unused `onOpenLink`, the `placeholder` re-export.

**Tier 3 — this file is behind the code (fix the prose, not the code) — FIXED 2026-10-04:**

- Self-contradiction resolved: the ☰ line under "Laptop-first" now defers to the Nav
  bullet (the toggle exists today; 4.7 replaces it with the title-as-toggle overlay).
- §Repository layout now lists `editor.ts`, `pdf-wait.ts`, `pdfstatus.ts`, `visibility.ts`
  and the `*.test.ts` suites.
- The `IAUTHOR_LUALATEX` table row now says `pdf.ts` reads it directly (config.ts owns the
  rest).
- §Dev workflow's `deploy` line describes the real push-and-server-builds behaviour.
- The `[::1]` doc trap is fixed in code: `IAUTHOR_DOMAINS` now defaults to
  `localhost,[::1]`, so `http://[::1]:4321` no longer 403s non-GET requests.
- `.gitignore` covers `dist.old/`.

Still stale prose (left open deliberately): the secrets-cache claim ("deleting the
secrets file re-runs setup" is false until the process restarts — `auth/secrets.ts` caches
at module load), the login-page gotcha shape (`login.astro:6` ships `<main hidden>` and
reveals after the `/api/session` probe; the "no unhide later" rule guards a different
element), and the Roadmap 4.5 "prefix-derived numbers" wording (historical, superseded by
the numbering rework below it — needs a footnote, not a rewrite).

**Tier 4 — needs an explicit product decision, not just an edit:**

Fixed the same day (cheap, no product question involved): `--shell-escape` dropped from
the LuaLaTeX invocation (`pdf.ts`); setup response sends `Cache-Control: no-store`;
`parseDuration` accepts `1d`-style durations; `IAUTHOR_SECURE` accepts `true`/`yes`/`on`;
`git.ts` checks for a trailing newline before appending `*.pdf` (fixed during Tier 1);
`.gitignore` covers `dist.old/`. The `seen`-map leak was fixed with the idle sweeper.

Verified against the source (2026-10-04) and **all resolved** — each with a decision:

- `.md.md`: confirmed real — `slugify` kept dots and `createEntry` appended `.md`
  unconditionally, so typing "notes.md" yielded `01_notes.md.md`, while `renameEntry`
  stripped the extension first. Fixed in the grammar once: `slugify` strips a trailing
  `.md`/`.markdown` (typing "notes.md" now yields `01_notes.md`); `renameEntry`'s own
  strip became redundant and was removed.
- **Un-drafting vs un-numbering** (owner decisions): un-numbering stays impossible by
  design — the prefix is preserved unless the typed name carries one explicitly
  (`composeName`). Un-drafting was added: the `draft_` token now FOLLOWS the typed
  name (`draft = t.draft`, not `t.draft || old.draft`) — the rename editor prefills
  the full disk name, so deleting the token is a deliberate act.
- `git.commit()` swallowed every failure and the five mutation routes ignored the
  return value. Fixed by serializing commits through a module-level promise queue in
  `git.ts` (two rapid saves can no longer race on `.git/index.lock`) plus one retry
  after 250 ms before the `console.warn` + `return false`. Owner decision: failures
  stay **server-log only** (no UI signal) — the localStorage draft already protects
  the text itself.
- Oversized files reported **0 words** while unreadable. Fixed by giving the word
  counter its own cap (`MAX_COUNT = 4 × MAX_FILE` in `works.ts`) — the app can't
  create such files anyway (`writeChapter` enforces 512 KB). Also `listWorks`
  `mkdirSync`ed the works dir on every `GET /api/tree` — removed; `scan()` returns
  `[]` on ENOENT and `ensureRepo` owns dir creation.
- `pdfstyles/a4.tex` vs `a5.tex` share 51 of 54 lines. Owner decision: **duplication
  accepted**, kept in sync by hand (noted in §Repository layout; an `\input`-shared
  base was rejected because it would complicate the pdf cache's style-hash freshness
  for 3 lines of divergence).

**Claims that look like drift but are NOT — don't "fix" these:**

- `pnpm test` really does glob (`package.json:9`: `node --experimental-strip-types --test
  src/lib/*.test.ts`), so `pdf.test.ts` runs. The §Gotchas warning is satisfied.
- Printed numbers are positional in **both** the code (`works.ts:162-193`) and §Data &
  naming. Only the historical Roadmap entry lags.
- `renameEntry` preserving the prefix + `draft_` token is documented correctly
  (`composeName`).
- There is no `?` placeholder for unprefixed entries any more; `kindNumber`'s `num === '?'`
  branch (`works.ts:152`) is the only leftover, and it is unreachable.

## Shipped: collapsible tree view (milestone 4.7, 2026-10-06)

The `I author` brand is a `<button>` and the only way to show/hide the tree; the ☰
hamburger (`#menu-btn`) is deleted outright. **Owner decision (2026-10-09, simplifying
the 2026-10-06 docked jump): the sidebar is a fixed overlay, and the markdown view keeps
ONE static left margin regardless of the tree — `@media (min-width: 901px)
.main { padding-left: calc(var(--tree-w) + clamp(1rem, 8vw, 10rem)) }` is unconditional,
so nothing moves when the tree hides or shows (no slide, no `.measure-slide`, no
`applyMeasure()` in `setNav` — the content width no longer changes with the nav; the
measure re-clamps on window resize only). (A grid track was tried first on 2026-10-06:
the fixed sidebar is out of flow, so `.main` auto-placed into the tree's own 18rem track —
the view got squashed into it. Padding can't misplace.)**

- **desktop** — click the title → tree, drafts toggle, new-row and the lock/log-out row
  fade out (`opacity` + a 0.5rem slide), the sidebar's background and right border fade
  to transparent, and only the title stays live at the top-left.
- **mobile (≤900px)** — the title bar (`.side-head`, page-coloured like everything on
  mobile — no card bar) is always
  visible at the top of the fixed overlay; the tree expands **over the whole page**
  (`position: fixed; inset: 0`). **Starts hidden on every load** — a pre-paint inline
  script in the markup applies `nav-off` on mobile so the overlay never flashes before
  the app script runs. Close via the title, `Escape`, or picking a chapter.

### Layout: overlay sidebar

```css
.app { display: grid; grid-template-columns: 1fr; min-height: 100svh; }
@media (min-width: 901px) {
  .main { padding-left: calc(var(--tree-w) + clamp(1rem, 8vw, 10rem)); }
}
.sidebar { position: fixed; top: 0; bottom: 0; left: 0; width: var(--tree-w); z-index: 20; }
@media (max-width: 900px) {
  .sidebar { inset: 0; width: auto; border-right: 0; background: var(--bg); }  /* full-page overlay, page-coloured */
  .side-head { background: var(--bg); }               /* fixed title bar, page-coloured — no separate bar */
  /* title bar stays full-bleed; its underline is a .side-head::after drawn
     line inset 0.5ch both ends (a border can't be shorter than its element);
     nav-off hides it via background: transparent (the fade transition too) */
  .main { padding: 3.5rem 0.5ch 2rem; }                 /* half a char to the sides */
  .measure-h { display: none; }                         /* no handles on mobile */
  .doc-col { width: 100%; }                             /* measure never applies */
  .doc-col > .md-body, .doc-col > #editor-host { width: 100%; }
}
```

`.main` keeps its fluid width and the `clamp` padding. The measure (4.65) lives inside it
and is **independent of the nav state**: the resting geometry is a FULL-width line —
`--measure = min(var(--line-w, 100%), 100%)` sizes ONE centred `.doc-col` column; the
topline (`.doc-head`) spans it and the field rests at 72ch on the
column's start, B at 72ch (not far right). Dragging A widens or narrows the line
symmetrically (the field rides the column's start, B moves with it), B sizes the field
within the line. The measure re-clamps on window resize only (the nav state no longer
changes the container width).

### Collapsed = pointer-transparent

Collapsed `.sidebar`: `background: transparent; border-right-color: transparent;
pointer-events: none`, with only `.brand { pointer-events: auto }`. The invisible panel
then swallows no clicks, text selections or scroll gestures and leaves no dead zone — only
the title is live. `--nav-dur: 0.2s`; fade transitions gated behind `body.nav-anim`
(boot adds it in the same task as the initial `setNav` so the first paint never slides),
dropped under `prefers-reduced-motion`.

### State, a11y, files

- `.app.nav-off` is the only state, `setNav(open)` the only mutator; it also
  toggles `inert` on tree/new-row/toolbar/side-foot so Tab skips the hidden parts, and
  refuses to close while the create dialog is open (the dialog lives inside the panel).
- **No nav persistence** (owner decision): desktop always boots with the tree open — a
  reload undoes a close; mobile always boots hidden (the pre-paint inline script applies
  `nav-off`). Shrinking to mobile (mq change) hides the panel the same way.
- `brand` is `<button aria-expanded aria-controls="tree">`, styled to look like the old
  span (`font: inherit` is load-bearing for buttons).
- `Escape` closes — but only when the create dialog and both menus are closed; they get
  Escape first. The create dialog and the tree context menu force `setNav(true)` first,
  so no control can ever sit behind a closed panel.
- Tree row click: `if (narrow()) setNav(false)` — on desktop the tree stays open
  while switching chapters.
- Touches `index.astro` (markup: brand button, menu-btn deleted, pre-paint inline
  script; ~50 lines of script — `setNav` joins the flow map above) and `global.css`
  (`.app`, `.sidebar`, the `.nav-off` rules, the media-query rewrite, `.menu-btn`
  deletion, `--nav-dur`).

Defaults baked in: desktop boots with the tree **open, always** (no memory), and
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
4.65) adjustable measure — two handles on the header underline: the left one (▶, at the
line's start) changes only the always-centred line's width (both margins equally), the
text view rides the line's start, the right one (◀, at the field's right edge) alone
sets the field's width (36ch floor, line-bound, line ≥ field); state persisted
in localStorage (`iauthor.measure`),
arrow-key nudge on both handles, touch via Pointer Events + capture ·
4.7) collapsible tree view — the `I author` title is the only tree toggle (☰ deleted);
the sidebar is an overlay over the page, and the markdown view keeps ONE static left
margin regardless of the tree (see §Shipped: collapsible tree view above);
mobile expands the tree over the page and starts hidden.

Polish (2026-10-09, shipped): folder row clicks never toggle the tree — they open the
index and only unfold; a repeat click on the viewed folder (or the caret) flips it ·
the whole sidebar viewport is a drop zone (rows keep their bands; anywhere else lands
TOP level, appended last) · hover-opened folders live or die with the chain's outermost
member (`dragOpened` + `pruneDragOpened`) · the measure is ONE centred `.doc-col`
column the topline wraps (the field's derived inset formula is gone — a content-side
inset once desynced the topline, shipped and reverted the same day) · measure line +
handles share `--line-strong` (halfway between the old line tone and the text colour),
apexes offset 0.1ch inward · mobile pass begun: no measure handles, markdown always
full width, half-char side margins, page-coloured title bar + overlay (no card bar),
title-bar underline a drawn `::after` line inset half a char, chrome (brand, buttons,
tree rows) user-select: none.

Numbering rework, phase 1 (shipped): printed numbers are positional among same-kind
siblings instead of the disk prefix; `renameEntry` edits the title and preserves the
prefix + draft token (`composeName`); matter accepts a prefix; print/artifact names
come from `Node.raw` (`scopeTitle`); `pnpm test` globs so new test files actually run.
Phase 2 (shipped): prefixes hidden in the tree, contiguous per directory incl. top
level (one-time `scripts/migrate-numbering.mjs`, dry-run by default, git-committed),
`POST /api/reorder` + drag & drop within and across folders, both returning an old→new
path map so client state (expanded, selection, sessionStorage drafts) remaps.
The numbering rework is complete — no further phases.

Next: 6) Encrypted GitHub
backup: tar+gzip whole tree → AES-256-GCM with master key → one ciphertext blob per
snapshot to a private repo via deploy key; `scripts/restore` to decrypt+untar; prune
option (keep last N); optional rclone crypt → ProtonDrive timer. 7) Mobile pass.

Deferred todo list: project-wide search;
client-side LLM word-prediction (flag unlikely tokens as possible typos, suggest fixes).