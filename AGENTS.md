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
- **Laptop-first.** Mobile = bare minimum (sidebar behind a ☰ button; forms must work).

## Stack

- Astro 5, `output: 'server'`, `@astrojs/node` standalone adapter. One process serves
  pages + API routes. No second backend.
- Vanilla TypeScript in `<script>` tags (Astro bundles them). No React/Svelte.
- Plain PostCSS (import, nesting, autoprefixer) in `src/styles/global.css` + scoped
  styles only for static markup. **Styles for JS-created DOM must be global** (Astro
  scoping won't match dynamically created elements).
- Client deps: `marked` (markdown → HTML), `@fontsource-variable/literata`, CodeMirror 6
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
                     NOTES); pure, imported by server and client bundles
src/lib/works.ts     works tree: listWorks/readChapter/writeChapter/createEntry/renameEntry/
                     deleteEntry, safePath (traversal + symlink + dotfile protection),
                     display titles (Node.title: depth-dependent Work/Book/Part/Chapter labels),
                     word counts (Node.words: per-md count, folders sum all descendant mds)
src/lib/words.ts     countWords() — pure, used client- and server-side
src/lib/preview.ts   live-preview engine: widgets, buildDeco, focus field, ctrl+click
                     link routing (createPreview(onOpenLink)); table HTML memoized
src/lib/sync.ts      chunked-sync engine: unsynced marks, draft store (sessionStorage),
                     push machine (createSync) — dirty-word accumulator + idle push
src/lib/git.ts       ensureRepo + commit(msg) in WORKS_DIR (server-local, never pushed)
src/pages/api/       setup, login, session, logout, lock, tree, file (GET/PUT), new, delete,
                     rename
src/pages/           index.astro (app shell), login.astro, setup.astro
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
deploy               # test + build locally, sync to VPS, install/build/restart, health check
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

- Display labels (header only, sidebar keeps raw names): top-level entries are bare
  titles; every other md is "Chapter N"; folders get Book/Part/Work anchored to the
  top of the deepest folder chain (Work/Book/Part, level 4+ clamps to Part; books and
  parts numbered in Roman numerals, chapters in Arabic; the number comes from each
  entry's own disk prefix, so gaps are preserved and unprefixed entries show `?`).
  Computed in `works.ts`, exposed as `Node.title` via `/api/tree`. Clicking a folder
  opens a fully expanded book-style index (TOC with dotted leaders), never an editor.
- **The filename is the title.** No `# Title` heading is ever written into files
  (`createEntry` creates empty files); content may begin at the top. Entries at any
  level may go without an `NN_` prefix — unprefixed names sort after prefixed ones
  via naturalCompare and display with a `?` number.
- **Special files** (in any non-top-level folder): `title.md` is a normal chapter with
  no prefix — sorts alphabetically and displays as `Chapter ?: title` (useful for
  work-in-progress; give it an `NN_` prefix via rename once it settles). `notes.md` is
  folder material, never a chapter: it consumes no number and its content is appended
  verbatim (rendered markdown) under the folder's index view. Top-level `notes.md`
  would be a normal top-level md.
- **Sidebar toolbar is one button**: the drafts toggle ("drafts" + eye glyph,
  👁 open / 🙈 hidden, persisted in localStorage) hides drafts, notes, and empty
  directories from tree and indexes; folders whose children all vanish are dropped;
  notes render normally in indexes, they are only hidden together with drafts.
  Create/delete happen via the right-click context menu on the tree.
- **Rename**: clicking anywhere in the header (except the buttons) swaps the title for
  an inline raw-name editor (live-preview style: display title ↔ disk name).
  `POST /api/rename` is literal — the typed name (slugified) becomes the full disk
  name, so numeric prefixes and `draft_` tokens exist only when typed; duplicates are
  rejected, and git-commits; sessionStorage drafts move to the
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

- SSH aliases: `server` (user `server`) and `serverRoot` (root). Debian 13, node 24 + pnpm.
- App: `/home/server/iauthor`. Works: `/home/server/writing/works` (owner `server`).
- systemd unit `/etc/systemd/system/iauthor.service` (user `server`, `HOST=127.0.0.1
  PORT=4322`, env `IAUTHOR_WORKS_DIR`). Caddy site: `write.gerhard.page → localhost:4322`
  (auto-TLS; A record → 158.220.109.206).
- **Always deploy with `scripts/deploy`** — it tests, builds locally, rsyncs (secrets
  survive), installs with `--frozen-lockfile`, builds on the server (keeping `dist.old`
  and restoring it if the build fails), restarts, and health-checks. Do not hand-roll
  SSH deploy steps; that's how things broke before.

## Environment variables

| Var | Default | Meaning |
|---|---|---|
| `IAUTHOR_WORKS_DIR` | `~/writing/works` | works root |
| `IAUTHOR_SECRETS_FILE` | `./secrets/secrets.json` | secrets path |
| `IAUTHOR_IDLE_LOCK` | `12h` | idle lock timeout (`30m`/`12h` style) |
| `IAUTHOR_SECURE` | unset | force Secure cookies (normally auto via `x-forwarded-proto`) |
| `IAUTHOR_DOMAINS` | `localhost` | build-time `security.allowedDomains` (deploy sets it) |
| `HOST`/`PORT` | localhost/4321 | node adapter bind |

## Gotchas learned the hard way

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
selecting.

Next: 5) Paged view — CSS multi-column pagination, page-size presets
(A4/trade/academic-large with big margins), CSS-counter page numbers; pageless default;
page numbers & word counts computed client-side, never stored. 6) Encrypted GitHub
backup: tar+gzip whole tree → AES-256-GCM with master key → one ciphertext blob per
snapshot to a private repo via deploy key; `scripts/restore` to decrypt+untar; prune
option (keep last N); optional rclone crypt → ProtonDrive timer. 7) Mobile pass.

Deferred todo list: print/PDF export via print stylesheet; project-wide search;
client-side LLM word-prediction (flag unlikely tokens as possible typos, suggest fixes).