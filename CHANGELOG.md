# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Entries for `v0.1.0` – `v0.1.2` were written retrospectively from the
[GitHub release notes](https://github.com/privacykey/privacytracker/releases);
they summarise each release rather than listing every merged pull request.
Going forward, changes are recorded here as they land.

## [Unreleased]

### Changed

- `GET /api/diagnostics/runtime` now returns a backend-tagged envelope
  (`backend`, `schemaVersion: 2`, `process`, `heap` with a `kind` of `v8`,
  `sqlite`, `scheduler` with a `kind` of `event-loop`, `http`,
  `slowQueries`, `dbWorker`, `scrapeActivity`, `rateLimiter`) in place of
  the Node-shaped `memory` / `v8Heap` / `resourceUsage` / `eventLoop` /
  `apiTimings` keys. Sections a backend cannot measure are `null`, never
  zeros. The same envelope replaces `runtime_metrics` + `db_worker` in
  `GET /api/desktop/diagnostics` (as `runtime_diagnostics`) and `runtime` +
  `apiTimings` + `dbWorker` in the support bundle (`schemaVersion` 3). The
  Diagnostics page reads the new shape; the health check's persisted
  result is unchanged. This is the contract the Rust core will serve from
  its own process — with `rust-allocator` / `tokio` sections and SQLite
  page-cache and lock-wait numbers Node cannot report — so the page is
  written once. Pinned by a plain-JS validator
  (`scripts/parity/diagnostics-envelope.mjs`) that both the parity harness
  and `tests/app/runtime-diagnostics.test.ts` hold the payload to.

### Fixed

- Rust core: the data directory and database path are process-wide
  configuration (a `OnceLock`, resolved once from `PRIVACYTRACKER_DATA_DIR`
  or `<cwd>/data` exactly as `lib/db.ts` resolves them at module scope),
  no longer fields of the per-request `AppState`. CodeQL's Rust model
  treats every axum extractor — `State` included — as user-provided input,
  so a data directory that reached `fs::metadata` / `read_dir` through
  `State` was reported as `rust/path-injection` on each of the four
  deployment reads that stat the database or its directory. Kept out of the
  request's reach there is no flow to report; behaviour on the wire is
  unchanged. Developer-facing only.

- Rust-core parity harness: `read-parity.mjs` now refuses to run when copying
  the Node database would let the Rust core's unknown-device backfill fire on
  the copy. Both backends port that backfill, so whichever opens the database
  first decides what both see — a Node server booted on an empty directory and
  then seeded leaves apps with no devices, and the Rust core inventing them on
  open would make any `app_devices`-reading route (`/api/apps?meta=grid` is the
  first) differ for reasons of boot order rather than correctness. Measured at
  1 device and 22 links on a 22-app copy. Developer-facing only.

### Added

- Rust core Phase 3, batch 4: the Wayback historical import (`core/src/scrape/history.rs`) and the archive.org client it drives (`core/src/scrape/wayback.rs`) — the quarterly target walk back to the February 2021 floor with the install-date anchor, the CDX index listing with its availability-API probe fallback, date-window and capture-URL dedupe, replay fetch and the archived-page privacy parse with its no-labels/parse-failure split, the back-dated snapshot row and the successor re-diff in one transaction with Node's SQL byte for byte, the Save Page Now request via Location or Content-Location and the attempt note it records, and archive.org throttling surfaced as the import's error with Retry-After in seconds or as an HTTP date. The outbound request gains `follow_redirects` and `read_body` for Save Page Now's manual-redirect probe. Gated by a new Node-derived oracle: 26 scenarios with recorded archive.org replies comparing every raw fetch, every write and transaction marker, the snapshot rows and the result, regenerated in CI. This completes Phase 3; Rust remains inactive in Node, Tauri and Docker builds. Developer-facing only.

- Rust core Phase 3, batch 3b: `searchAppsByName` and `lookupAppsByBundleId` (`core/src/scrape/search.rs`) — query normalisation, the iTunes search with its empty-result retry and developer-match reordering, the bundle lookup in chunks of a hundred with the 5xx split retry, case-insensitive matching and dedupe, the shared search cooldown a 429 records, and candidate mapping with JavaScript's absent-versus-null fields. The outbound request gains a `max_url_length` (the lookup allows 16 KiB) and the string helpers an `encodeURIComponent` port. Gated by a new Node-derived oracle: 31 scenarios with recorded iTunes replies comparing every raw fetch, every write, the settings rows and the batch object, regenerated in CI. Rust remains inactive in Node, Tauri and Docker builds. Developer-facing only.

- Rust core Phase 3, batch 3: the fetch layer of `fetchAndParseApp` (`core/src/scrape/fetch.rs`) and `scrapeInitialUrls`, which completes the function in Rust — URL refusal, the scrape cooldown and pacer (`ratelimit.rs`), the page fetch through the outbound transport, Apple's 429/403 signal with Retry-After in seconds or as an HTTP date and the cooldown it records, non-OK statuses, transport failures, redirects, and the iTunes lookup with its storefront normalisation (`region.rs`). The transport now runs its redirect, size-cap and decoding loop over an injectable raw hop and carries response headers. Gated by a new Node-derived oracle: 36 scenarios with recorded raw replies, comparing every raw fetch made, every write, every touched table and the result, regenerated in CI. Search and bundle-id lookup follow; Rust remains inactive in Node, Tauri and Docker builds. Developer-facing only.

- Rust core Phase 3, batch 2: the persist path of `fetchAndParseApp` (`core/src/scrape/persist.rs`) — the pre-commit reads, label/accessibility/age-rating change detection, the single transactional commit with Node's SQL byte for byte, the parser-fallthrough, version-update and profile-mismatch notifications with their dedupe windows and retention prunes, quiet-hours `not_before`, and the error activity row with its diagnostics. Gated by a new Node-derived oracle: the real handler run end to end over 26 scenarios with a frozen clock and counted ids, recording every write in order plus the rows it leaves, regenerated in CI. No fetch or routes yet; Rust remains inactive in Node, Tauri and Docker builds. Developer-facing only.

- Rust core Phase 3, batch 1: the App Store page parser (`core/src/scrape/`) — page metadata, the `serialized-server-data` extraction and name rules, the privacy-type fallback chain with its swallowed-versus-escaping error boundary, both 2021 shoebox shapes, the accessibility shelf, the related-app shelves and the two three-state flags. Gated by a new Node-derived oracle: the real `fetchAndParseApp` run over 27 synthetic pages with the result projected from the rows it writes, regenerated in CI. No fetch, persistence or routes yet; Rust remains inactive in Node, Tauri and Docker builds. Developer-facing only.

- Rust-core parity harness: the manifest coverage walk — every `app/api/**/route.ts` classified in `scripts/parity/manifest.mjs`, nothing phantom — now runs on its own as `pnpm parity:manifest`, in the `core-parity` CI job and under `pnpm test` (`tests/app/parity-manifest-coverage.test.ts`). Until now only `parity-diff.mjs` ran it, and the Rust read gate invokes that with `--skip-coverage`, which is how `/api/device-scope` shipped unclassified. Developer-facing only.

- Rust core Phase 2 is complete: twelve more GET routes bring the read API to all 65 routes in the Phase 2 inventory plus the newer device-scope read (66 total), covering operational status and exports, comparison previews and related apps. A bounded public HTTP client validates DNS and redirects, caps decompressed bodies and enforces deadlines. Node-derived cases and live probes preserve responses and read limits without starting jobs or persisting preview data. Rust remains inactive in Node, Tauri and Docker builds. Developer-facing only.

- Rust core Phase 2: seven user-content GET routes (54 read routes total), covering activity, notifications and preferences, tasks, annotations, shortlists and JSON/Markdown exports. Fixed-clock Node comparisons and live response, cleanup and rate-limit probes preserve existing behavior. Rust remains inactive in shipped builds. Developer-facing only.

- Rust core Phase 2: five device GET routes (47 read routes total), preserving ownership, import history, app links and exact Node response behavior. Includes 58 Node-derived status/body cases and live parity probes. Rust remains inactive in shipped builds. Developer-facing only.

- Rust core Phase 2: nine fleet statistics and analysis GET routes (42 read routes total), with device-scope parity, fixed-clock Node oracle cases and raw-response/rate-limit probes. Rust remains inactive in shipped builds. Developer-facing only.

- Rust-core migration: the three process-introspection reads join the Rust
  read API (33 of 64 read routes) — `GET /api/diagnostics/runtime`,
  `/api/desktop/diagnostics` and `/api/diagnostics/errors` — emitting the
  backend-tagged envelope with `backend: "rust"`: a counting global
  allocator for `heap`, tokio's runtime metrics plus a 20 ms scheduler-lag
  sampler for `scheduler`, `sqlite3_memory_used` / `sqlite3_db_status` and
  the connection-mutex wait for the `sqlite` sections Node cannot fill, a
  request-timing layer with Node's sampling rule for `http`, and SQLite's
  own profile hook for `slowQueries`. The parity harness validates each
  side against the envelope contract instead of byte-comparing a V8 heap
  against a Rust allocator, and holds the Rust body to live numbers.
  Developer-facing only.
- **Importing from a second device now asks whose it is — and, for
  someone else's, asks you to confirm you have their permission.** From
  your second device onward, any import that creates a new device
  record (any method: cable, CSV, screenshots or typed in) has a "Whose
  device is this?" step: yours, someone you're helping, or a child you
  look after — pre-selected from your current setup, so your own iPad
  is one click. Your first device isn't asked, and nothing is recorded
  about its owner until you say so in Settings → Devices. Choosing
  anyone but yourself reveals a statement that you have their
  permission to view the apps on their device and to remove apps from
  it; the import won't continue until it's ticked. The confirmation is
  timestamped, recorded in the audit log, and required before the app
  will remove anything from that device. It can also be given later in
  Settings → Devices, and is cleared automatically if the device is
  reassigned to you. Your own devices — phone, iPad, work and personal
  — are never asked for it; they're told apart by name.

- **Exports now say when they're broader than the page.** Every export
  stays whole-install by design — a file whose contents depend on a
  device filter the reader can't see is worse than one that's simply
  complete — but while a device scope is active the Stats page, Settings
  → Export Data, the shortlist download and the audit bundle each carry
  a line saying so. Previously the Stats page could read "3 apps
  tracked" directly above a download containing ten, with nothing
  reconciling the two. The note disappears entirely when no scope is
  set.

- **Device ownership** — each device can record whose it is (a name, and
  whether you're working on your own apps, helping someone else, or
  looking after a child's device), set in Settings → Devices. The nav
  picker groups devices by owner, and when you scope to someone else's
  device while your focus still says "just me", it offers to switch —
  which is the gap that previously let someone drift into the
  delete-apps flow with the button silently disabled and the reason
  buried in Settings. The offer is always a suggestion with an explicit
  "Stay as I am"; nothing changes automatically, and switching preserves
  every other focus setting. Ownership is never guessed from a device's
  name. Removing apps still requires a focus of just you — that rule is
  unchanged — but the refusal now names the device you're viewing
  instead of citing the rule alone.

- **Device scope picker in the nav** — one control naming which device's
  apps you are looking at, with an icon and the device's name, and a
  multi-select popover to narrow to any subset ("show all", or just two
  of three). It applies everywhere: the apps grid, the dashboard's
  counts, Stats, the Privacy Map, the shortlist, and the review queue
  that feeds "delete apps off a phone" all follow it. Previously the only
  device control was a single-select dropdown inside the apps-grid
  toolbar, so every other surface silently spoke for the whole fleet —
  which meant someone helping a relative could be several screens into a
  removal workflow with nothing on screen saying whose phone it applied
  to. The choice persists across reloads and is gated by
  `flag.nav.device_scope`; it renders from the first device onward and
  disappears only on installs with none. Apps with no device link
  (hand-added entries and CSV
  imports) get their own "Not tied to a device" bucket rather than
  vanishing silently.

- Rust-core migration: the five deployment-facing reads join the Rust read
  API (30 of 64 read routes) — `GET /api/ready`, `/api/deployment/diagnostics`,
  `/api/diagnostics/database`, `/api/diagnostics/disk` and
  `/api/diagnostics/health`. Reproduces the `x-forwarded-*` header synthesis
  `next start` performs before route handlers run (without it the readiness
  checks differ on every direct request), embeds `package.json` for
  `app.name`/`version`, and moves `pt-core serve` to `PRIVACYTRACKER_DATA_DIR`
  / `<cwd>/data` exactly as `lib/db.ts` resolves the data directory. The
  parity harness primes a health-check result before copying the database
  and holds the connection pragmas, backup fixture and env-derived fields
  to equality where the differ blanks numbers. The three process-
  introspection diagnostics (`runtime`, `errors`, `desktop`) are left for a
  design decision. Developer-facing only.

- Rust-core migration: the four settings-backed reads join the Rust read API
  (25 of 64 read routes) — `GET /api/settings`, `/api/settings/desktop`,
  `/api/dashboard/layout` and `/api/feature-flags`. The last ports the focus
  resolver over rule tables generated from the Node source rather than
  transcribed (`core/scripts/extract-settings-cases.mjs`, with a CI drift
  check like the `diffSnapshots` fixture), and the same script records the
  real `maskWebhookUrl`, `reconcileLayout` and resolver outputs for the Rust
  tests to replay. The profile matcher's strip-underscore collation is
  replaced by an ICU-root model verified against Node on the flag keys, flag
  surfaces and category keys. The parity fixture now stores a masked secret,
  out-of-range desktop rows, a non-preset layout and flag overrides so the
  four routes are compared on real state, and a probe exercises the
  write-on-read runtime marker the differ never triggers. Developer-facing
  only.

- Rust-core migration: `/api/apps/[id]/detail` joins the Rust read API
  (21 of 64 read routes) — the fourteen-key aggregate the app-detail page
  renders, assembled from reads already ported plus three new ones
  (`getUnacknowledgedChanges`, `getRecentPolicyChange`,
  `getAppImportProvenance`). Every read but the app row degrades to its own
  fallback rather than failing the request, as in Node. Three fields are
  null on the canned seed and were only ever compared as null; the fixture
  now populates them and the probe refuses a run where they are not.
  Developer-facing only.

- Rust-core migration: `GET /api/apps` joins the Rust read API (20 of 64
  read routes) — all five of its query-string branches at once, since axum
  routes by path. Ports `getAllApps`/`getAppsPage`, `getAppWithPrivacy` with
  the full policy-analysis hydration, `getGroupedPrivacyView`, and the
  `meta=grid` side-band (`buildAppGridMeta` and its four map helpers,
  including the profile-matching engine). Five of the route's eight responses
  had no parity-manifest entry; they do now. The fixture gained a stored
  privacy profile and a user verdict so the two `meta=grid` maps the canned
  seed leaves empty are actually compared. Developer-facing only.

- Rust-core migration: `/api/apps/[id]/changelog` joins the Rust read API
  (19 of 64 read routes), bringing the timeline kernel `getChangelog` /
  `getChangelogPage` with it — including the read-time archive bridge, which
  is a second caller of the already-ported `diffSnapshots`. The manifest hits
  this route once with no query string, on an app where neither read-time
  mutation fires and no review row exists, so the parity fixture gained a
  timeline app (a wayback row identical to its live neighbour, plus review
  rows) and the probe covers `archive_bridge`, `matches_live_sync`, the
  review row shape, `hasMore` and both 400 branches. Developer-facing only.

- Rust-core migration: `/api/apps/[id]/history-stats` joins the Rust read API
  (18 of 64 read routes), porting the quarterly aggregates
  `computeCategoryTrend` and `computeQuarterlyChanges`. The canned seed
  exercises only their `added` arm — across all ten seeded apps nothing is
  ever removed, no entry is category-tagged, and `changes_detected` is only
  ever 0 or 1 — so the parity fixture gained an app covering the removal arm,
  the category filter and the strict `changes_detected !== 1`. Developer-facing
  only.

- Rust-core migration: `/api/apps/[id]/since-install` joins the Rust read API
  (17 of 64 read routes), bringing `diffSnapshots` with it — the first real
  business logic in the core rather than a read shim. The parity differ is
  structurally blind to it (every seeded app's baseline and latest snapshot
  have identical label membership, so all ten answer `"changes": []`), so the
  diff is pinned by a differential fixture generated by running the actual
  Node function, and the route by nine scenario apps whose raw response bytes
  are compared across both backends. Fixing this also fixed a harness bug that
  affected any future dynamic route: `read-parity.mjs` did not escape `[` and
  `]` when building its `--only` regex, so `[id]` was read as a character
  class and the route was never compared. Developer-facing only.
- Rust-core migration: the **inbound rate limiter** (`checkRateLimit` /
  `rateLimitKeyForRequest` from `lib/security.ts`) is ported to Rust, which
  unblocks `/api/manual-apps` and `/api/import/audit-bundle/recent` — both
  rate-gate their GET before doing any work — and takes the Rust read API to
  16 of the 64 read routes. Not to be confused with `lib/rate-limit.ts`,
  Apple's outbound scrape cooldowns, which is untouched. The parity differ
  structurally cannot see a limiter (it sends one request per route against a
  120/min limit), so `read-parity.mjs` now bursts a gated route on both
  backends and requires them to deny from the same request number.
  Developer-facing only.

- Rust-core migration **Phase 2, batch 3**: `/api/sync/status`,
  `/api/verdicts` and `/api/imports/queue` join the Rust read API, taking it
  to 14 of the 64 read routes. All byte-identical to Node, verified against a
  server seeded with real verdict and queued-import rows rather than empty
  tables. The parity differ gained `--ids-from`, for comparing a backend that
  shares the other side's database rather than being independently seeded;
  it is off by default, so the full Node-vs-Node run still proves the two
  sides agree on their own. Developer-facing only.

- Rust-core migration **Phase 2, batch 2**: `/api/focus` and `/api/imports`
  join the Rust read API, taking it to 11 routes. They add the two response
  shapes batch 1 lacked — a fully derived multi-key object, and a bare array
  with a 404 branch — and the `/api/imports?id=<missing>` error shape is now
  gated by the parity manifest, which nothing checked before. Both are
  byte-identical to Node under the dual-live differ. Developer-facing only;
  the shipped app still runs entirely on Node, and the inertness guard added
  in Phase 1 still passes.

- Rust-core migration **Phase 2, batch 1**: the `core/` crate now serves an
  HTTP read API (`pt-core serve`), starting with nine routes — the reads the
  client shell makes on first paint plus the container/auth probes. It ports
  the `proxy.ts` request gate (host allowlist, the fail-closed auth rule and
  its five exact-match public-read carve-outs, and the CSRF check), so the
  Rust server refuses what the Node server refuses. A new gate,
  `scripts/parity/read-parity.mjs` (`just parity-read`), boots it against a
  copy of a running Node server's database and byte-compares every implemented
  route; `parity-diff.mjs` gained an opt-in `--only` filter so a partially
  implemented backend can be compared without the unimplemented routes
  drowning the signal. Nine of nine routes are byte-identical, and the auth
  gate is probed separately because the differ authenticates every request and
  so cannot see a missing one. Developer-facing only; the shipped app still
  runs entirely on Node.

- Rust-core migration **Phase 1**: a standalone `core/` crate that
  reproduces the `lib/db.ts` SQLite schema + migration contract exactly.
  `pt-core migrate <path>` opens a `privacy.db` and brings its schema up to
  date — the pragma set, the 0700/0600 permission tightening, the full
  CREATE/index block, every guarded `ALTER TABLE ADD COLUMN`, and the data
  backfills db.ts runs on open (unknown-device placeholder, the
  `pending_search` heal, the stuck-`running` reset, the
  `privacy_policy_versions` seed). The CREATE block is lifted verbatim from
  db.ts by a generator so it cannot drift. A new gate,
  `scripts/parity/schema-parity.mjs` (`just parity-schema`), proves the Rust
  migrator leaves any starting database in the same schema state db.ts would
  — one Node dumper reads both sides, the logical schema is compared
  authoritatively, and data backfills are checked by aggregate counts.
  Fresh, legacy-upgrade and current+state fixtures all pass byte-identical,
  and the gate is self-tested to fail when a single migration is dropped.
  This is developer-facing only; nothing in the shipped app changes yet.

- The AI disclosure page (`/dashboard/about/ai-disclosure`) now tells the
  whole story of how the app was built, in three parts. **Before this
  repository** credits the April 2026 groundwork — the scraper, the first
  dashboard and onboarding, privacy profiles, the Wayback import, feature
  flags, localisation, the desktop build — to the era it came from, and is
  honest that the project was restarted here in May so none of that history
  carried over, that some of it was never version-controlled, and that
  neither Antigravity nor Codex records a commit co-author. **Models used**
  is the breakdown: eight models, each a collapsible row naming the areas it
  worked on, ordered by first appearance. Claude Sonnet 4.6, Opus 4.8,
  Opus 5, Fable 5 and Fable 5.1 join the entries that were already there,
  and the OpenAI entry is now *Codex* — the tool rather than a model
  version, because the version changed across the project and was never
  recorded. Its list is substantial: the September security round
  (network-deployment sign-in, outbound destination validation, bounded
  request bodies, runtime scanning, desktop backup verification), backup and
  restore data preservation, the v0.2 release gates, CSV export safety, and
  the TypeScript 7 translation-scanner work. **What the model list leaves
  out** says the part no git history records: hundreds of hours of
  real-device testing, user testing and product decisions, all of it human.
  The attribution note states plainly that the trailers are incomplete —
  they miss the pre-repository era, they miss Codex entirely, and a portion
  of this repository's own commits carry none either. The rows are native
  `<details>` elements, so they expand without JavaScript and the page keeps
  prerendering statically.

- **Per-app historical import.** The App Detail → Change History tab now
  has a "Check the archive" card that reconstructs just that app's history,
  the single-app counterpart to Settings → Historical Import. It posts the
  new `force` option on `POST /api/apps/[id]/import-history`, which
  re-probes every quarter instead of skipping the ones a nearby row already
  covers — so a second run picks up captures the archive has gained since,
  or ones an older parser could not read. Forcing never duplicates a
  snapshot. When archive.org is rate-limiting, the route answers 503 with
  `code: "archive_unavailable"` (not a 500) and the card says to wait and
  retry rather than showing a raw error. Gated by
  `flag.detail.timeline.wayback_import`.
- **History tab pages backwards.** The detail payload now carries the newest
  50 changelog rows plus `changelogHasMore`; a "Show older entries" control
  fetches the rest from the new `GET /api/apps/[id]/changelog?before=…`
  route. Every sync writes a row even when nothing changed, so on a daily
  schedule the reconstructed Wayback history used to fall off the bottom of
  the timeline after about seven weeks with no way to reach it.
- **First-run checklist task "Reconstruct your apps' label history"** for
  the self + monitor focus, linking to Settings → Admin → Historical Import.
  The import still only runs on an explicit click, as the privacy policy
  promises; the task completes once any archive row exists.
- The Wayback importer bridges the last archive → first-live-scrape hop at
  read time: the first scrape's card shows what changed since the newest
  archive capture ("Compared with the archive capture from …"), without
  rewriting the stored row or raising anything in the review queue.
- `just fetch-node-sidecar` (`scripts/fetch-node-sidecar.sh`) — downloads
  and GPG-verifies the Node binary the desktop app bundles as its sidecar,
  into `src-tauri/binaries/`. The binary is ~139MB and gitignored, so a
  fresh clone previously had no way to build the desktop app: both
  `just tauri-dev` and `just tauri-build` died several minutes in with
  `stage-standalone: cannot find Node binary at …`, after a Next build and
  a full cargo build that had both looked healthy. Both recipes now depend
  on the fetch, which is a no-op once the binary is present. The new
  `src-tauri/binaries/README.md` documents the verification chain and, more
  importantly, why the version must match the Node that ran `pnpm install`
  — better-sqlite3's prebuild is resolved against that ABI, so a mismatched
  bundle builds cleanly and then kills the sidecar with
  `NODE_MODULE_VERSION`.

### Changed

- **The device menu's "switch mode" prompt now explains what switching
  does.** It used to say "You're looking at Robin's apps. Switch to
  helping someone else?" — which assumes you already know what that mode
  is. It now states the mismatch ("Robin's device — but you're set up
  for working on your own apps") and then what the other mode actually
  turns on: for helping someone, the shareable bundle, printable
  recommendations and per-app notes, plus that it's required before
  apps can be removed from their device; for a child's device, age
  ratings and the safety summary. The button names the mode too.

- **Fixed: the apps grid scrolled the whole page sideways on a phone.**
  Its toolbar row was set never to shrink, which stopped the mobile
  wrap rule from ever applying — six buttons stayed on one line and
  pushed the page out to nearly twice the screen width. The row now
  wraps onto three lines at 375px and the page stays put.

- The local visual-regression net now covers the device-scope chrome:
  the picker open, a scoped grid, the focus-switch prompt, the scoped
  Stats page with its export note, and the device owner editor. Its
  fixture builds a fixed two-device fleet instead of deleting devices
  down to none — with no devices the picker renders nothing, so the new
  chrome had no cover at all — including two mobile shots for the
  drawer's own copy of the picker and its viewport-pinned popover, which
  share no code path with the desktop ones. Developers who keep local
  baselines will need to regenerate them
  (`VISUAL=1 npx playwright test tests/e2e/visual.spec.ts -u`).

- **App removal now checks whose device it is, not just what mode
  you're in.** Previously the gate asked only whether your focus was set
  to "just me" — so it would happily remove apps from a relative's phone
  the moment it was plugged in, while refusing to touch your own phone
  whenever you were in helping mode. It now compares the device's
  recorded owner against how you're set up: your device in your own
  mode, theirs in helping mode, a child's in guardian mode. A mismatch
  is refused, and the refusal names the device instead of citing a rule.

  This makes removal possible on a device belonging to someone you're
  helping, which was not possible before. It requires you to have
  recorded that the device is theirs and to have switched into the
  matching mode, and everything else still applies: the phone connected,
  unlocked and trusting this Mac, the feature switched on, a fresh
  verified backup, and Touch ID for every single app. Devices with no
  recorded owner behave exactly as they did before.

- **Fixed: the mobile nav drawer reported a critical accessibility
  violation once a device existed.** The drawer is a `role="menu"`,
  which may only contain menu items, and the new device-scope control
  was a plain button inside it — axe flagged `aria-required-children`.
  The control is now a menu item that opens its own submenu, which is
  what it already behaved like.

- **Fixed: the apps grid's device filter changed the counts but not the
  cards.** The risk tabs and the "N of M" figure were computed from a
  filtered list while the card list was built from a separate,
  re-implemented filter chain that never applied the device filter at
  all — so picking a device updated every number on the page and none of
  the apps. The card list is now derived from the same filtered list the
  counts use, so the two cannot disagree. Custom apps, which have no App
  Store listing and never carry a device link, are now treated as
  unattached and hidden when the scope excludes that bucket.

- The Rust-core parity harness now classifies **all 120** API routes, up
  from 17. `scripts/parity/manifest.mjs` splits them into reads (57),
  reads with a volatility transform (8), mutations (56), destructive
  teardown (4) and quarantine (35, each with a written reason), and
  `parity-diff.mjs` enforces a **coverage gate**: it walks `app/api` at
  startup and fails if any `route.ts` is unlisted. The manifest had gone
  stale while the surface grew from 110 to 120 routes with nothing
  noticing; that can no longer happen silently. The differ also gained
  write support — mutations replay against both servers with identical
  bodies and then re-read the affected collection, so a write that
  returns a plausible 200 but persists differently is caught. Writes are
  opt-in (`--mutate` / `--teardown`) because the manifest contains
  `/api/reset`; a bare invocation stays read-only. Node-vs-Node
  self-test: 130 checks, 0 differences, and `--no-normalize` still fails,
  which is what proves the differ can detect one.

- **Wayback import probes the CDX index once per app** instead of up to
  seven availability calls per target, and picks each quarter's closest
  capture locally; the availability walk remains as a fallback. Save Page
  Now now runs only when the archive has no capture within 45 days of
  today (it used to fire on the first empty quarter — usually Q1 2021,
  which archiving today's page cannot fill — for nearly every app on every
  run), and "Remove all imported history" also removes the notes it leaves.
- A throttled archive (HTTP 429 / 5xx) is now an error the bulk runner
  backs off from — it waits out `Retry-After`, retries the app once, then
  pauses the queue with a "paused by rate limiting" explanation and a
  Resume button — rather than being recorded as "no capture" and triggering
  Save Page Now.
- The monthly reconstruction cadence (`intervalMonths: 1`) now lands every
  month: the dedupe window follows the cadence (15 days monthly, 45 days
  quarterly) instead of a fixed 45 days that skipped every other month.
- `macos-release.yml` now calls `scripts/fetch-node-sidecar.sh` instead of
  carrying its own ~40 lines of inline download-and-verify shell. The
  Node release-key fingerprints had been duplicated between the workflow
  and (until now) nothing else; they have exactly one home now and cannot
  drift between CI and a developer's machine. Behaviour is unchanged —
  same GPG-then-hash verification, same output paths — with the build
  matrix's target passed through `TAURI_BUILD_TARGET`, the variable
  `stage-standalone.mjs` already reads when choosing which binary to wrap.

### Security

- Upgraded Next.js 16.2.12 → 16.3.4, clearing three advisories that were
  failing the dependency audit on every pull request:
  **two critical unauthenticated remote-code-execution issues** in Next.js
  (GHSA-p293-qw3h-jr36, affecting Windows-hosted servers, and
  GHSA-2xp9-vwfh-vxw4 in the Image Optimization API when AVIF files are
  used), and a high-severity libheif issue in the transitive `sharp`
  dependency (GHSA-rgj7-g3m4-5g8c). 16.3.3 patches the two Next.js issues
  but still resolves `sharp ^0.35.3`; 16.3.4 is the first release that
  requires the patched `sharp ^0.35.4`, so it clears all three in one bump.
  This deployment already set `images.unoptimized: true`, which disables the
  vulnerable image-optimisation endpoint, but the versions are patched
  regardless.

### Fixed

- Feature flags now actually take effect in the browser. Every client
  component that gated UI on a flag read it through a resolver context
  that nothing primes on the client — so all ~65 of those reads silently
  returned the flag's hard default, ignoring both your focus (audience /
  goals) and any override you set in Dev Options. Choosing "Keep it
  minimal" left label hints, tooltips, the Live Text walkthrough, the
  Task Center widget, Developer Options and the Wayback import section on
  screen; the loved-one audience never got its social-share or audit-PDF
  affordances; and toggling a flag in Dev Options changed nothing outside
  the panel. All of them now read resolved values from
  `GET /api/feature-flags` through one shared, cached fetch per page
  load. The broken `useFlag` / `useFocus` hooks are gone rather than
  patched — a hook that cannot be primed has no correct use — and a
  static guard (`tests/app/client-flag-reads.test.ts`) fails the build if
  they return, if a client module imports the resolver, or if a
  tri-state flag is read through a boolean hook.
- A URL with a trailing slash (`/dashboard/`) answered with a redirect that
  carried none of the app's security headers, while the canonical URL
  (`/dashboard`) carried all six. Next emits that redirect inside its router,
  before `proxy.ts` runs, and its redirect branch discards every header
  accumulated so far — including the static set from `next.config.js`. The
  redirect is now issued by `proxy.ts` itself and goes out with the full
  header set. Low severity in practice: a redirect has no body to inject
  into, and the browser followed it to a URL that was properly protected.
  This is defence-in-depth and consistency.
- The route-parity differ's opaque-id normaliser was over-eager: its pattern
  also matched ordinary snake_case enum *values* such as `not_collected`,
  rewriting them to `~id`. That silently blinded the gate — a backend
  returning the wrong privacy tier compared equal. It now requires a digit or
  capital in the suffix, which every generated id has and no English enum word
  does. Verified against the full 121-route Node-vs-Node run, and the run also
  picked up `/api/apps/[id]/changelog`, a route added after the manifest
  landed, via the coverage gate.


- Desktop app: the hash-based Content Security Policy introduced in 0.2.0
  blocked Tauri's IPC channel, so every call into the desktop app's native
  side — the notification permission check that runs on each page load, the
  updater, and the app's own commands — was rejected and silently retried
  over a slower fallback, filling the log with `connect-src` violations. The
  policy now allows Tauri's IPC origins when running inside the desktop app;
  the browser and Docker deployments keep the unchanged, narrower policy.
- **Wayback imports never actually reached 2021.** Captures from Feb–Oct
  2021 keep the app record in `shoebox-ember-data-store` (keyed by app id,
  `data.attributes.privacy`), which the shoebox extractor skipped by id and
  never probed, so every 2021 target failed as `skipped_parse_failure`
  while the Settings copy promised history "back to Q1 2021". Both shoebox
  shapes are parsed now; in a live run Instagram's history extends from
  March 2021 instead of March 2022. Captures from the first weeks of Feb
  2021 that carry no privacy section at all are reported as skipped
  (`skipped_no_labels`) rather than failed.
- The oldest imported Wayback row was diffed against *today's* labels, so
  the 2021 baseline card claimed "now collects" for labels the app had
  since dropped (and vice versa), the universal changelog carried the
  inverted entries, and the history chart's first bucket counted them. The
  oldest row is now a baseline with no changes, and a wayback row that
  lands *before* an existing one re-diffs the row that follows it.
- `history-stats` counted accessibility and privacy-policy entries as
  privacy-label changes.
- Settings copy for the Historical Import still said "since the App Store
  web launch on 5 November 2025" and that the closest capture is used;
  the floor is Q1 2021 and captures beyond 45 days are skipped. The Task
  Center deep link for a running Wayback job pointed at the device-import
  section instead of `#wayback-import`.
- A fresh install no longer probes its own install date (which equals
  "today" and is already covered by the first live scrape).

## [0.2.0] — 2026-09-05

### Added

- Canned sample data now populates every app-detail surface: each demo app
  gets its hand-written AI policy summary stored as a real, ready analysis
  (lens grid, highlights, and source preview render without any AI provider),
  declared accessibility features on the Accessibility tab, and — for
  Instagram — a policy-change history that lights up the recent-change banner
  and the rating-shift strip.
- The app-detail axe gate now also scans the Accessibility, AI Policy, and
  Change History tabs (activated and populated), and the app-detail E2E spec
  covers the change-review panel, the privacy-label accordion toggle, and all
  three tabs.
- Blocking accessibility gate in CI: axe-core scans of the welcome screen,
  onboarding import flow, dashboard, app detail, and mobile navigation, plus
  keyboard-only coverage of the onboarding path.
- Community health documentation — contributing guide, code of conduct,
  support guide, pull-request template, and code owners.
- `pnpm screenshots` — captures a consistent set of UI screenshots from
  the built-in demo fixture, for docs and release notes.
- A `justfile` collecting the common workflows — `just --list` shows the
  set, covering the dev loop, the desktop (Tauri) build, Docker, and the
  verification suites.

- A Content Security Policy mode switch for operators: `PRIVACYTRACKER_CSP`
  is `enforce` (default), `report-only` (send the policy as report-only to
  see what it *would* block), or `off` (debugging only). Violations the
  browser reports are listed on the Diagnostics page; nothing leaves the
  machine. The policy itself is now hash-based rather than nonce-based,
  which is what lets every page be served as a fixed, prebuilt file.

### Changed

- **v0.2 upgrade requirements:** Docker deployments require
  `AUDITOR_ADMIN_TOKEN`, including containers published only on localhost.
  macOS desktop builds require macOS 13.5 or later. v0.1.2 users make a one-time
  manual DMG/Homebrew upgrade; the legacy update feed remains pinned to v0.1.2
  to protect older Macs. See [release and recovery guidance](docs/RELEASING.md).
- Release versions are prepared through reviewed PRs. Tag builds stay in a
  draft, validate signing approvals, build each Mac architecture natively,
  verify both updater signatures, and scan exact Docker image digests before
  promoting image tags. Signing-only rehearsals cannot upload release assets.
- Full backups now include devices, app/device links, review history, activity
  and related-app observations. Restore clears those tables consistently,
  preventing stale links to apps absent from a backup. Keep a stopped data-folder
  copy before upgrading; older JSON backups never contained these records.

- Upgraded to TypeScript 7.0.2 and enabled Next.js's compiler CLI integration
  for web, Docker, desktop and Storybook builds, retaining build-time type
  checks with the native compiler. Docker explicitly removes native compiler
  packages left behind by dependency pruning from the shipped image.
- Translation regression checks parse JSX independently of the TypeScript
  compiler API, preserving the existing untranslated-text baseline while
  allowing the checks to run with TypeScript 7.

- **Settings is now four pages instead of one.** Your preferences, sync,
  policies and admin each get their own address
  (`/dashboard/settings/you`, `/sync`, `/policies`, `/admin`), so a page
  loads only what it needs and you can link someone straight to the part
  you mean. Existing links and bookmarks — including the ones in
  notifications — still land in the right place.

- **First-run experience.** Per-feature toggles moved behind an "Advanced"
  disclosure, illustrated goal cards shrunk on phones, and the primary action
  pinned to a sticky footer so it stays reachable. AI summaries now default to
  **Disabled** instead of preselecting a provider, and a stored "disabled"
  choice is honoured on reload. "Save & generate" stays disabled until the
  provider's fields validate. New users now get exactly one post-onboarding
  guide — the task checklist — instead of a checklist plus a coachmark tour
  pointing at it.
- Import candidate selection is now a native radio group: keyboard-operable
  with arrow keys, and announced correctly by screen readers.

- The interface language is now applied in the browser from your saved
  choice rather than on the server, so pages load as prebuilt files. The
  first paint waits for the language bundle (a brief blank rather than an
  English flash), and the no-JavaScript fallback message is English only.

### Fixed

- Outbound requests now validate the DNS addresses used by the actual connection,
  including streaming AI calls and redirects. IPv4-mapped IPv6 can no longer
  bypass private-network or metadata checks. Local AI endpoints remain supported.

- Docker and network deployments now require an access token for private pages
  and all private API reads as well as writes. A sign-in page provides access;
  missing configuration stays locked. Local launchers explicitly bind loopback.
  Cookie-authenticated mutations also require the full matching browser origin.
- JSON and file-upload limits now apply while reading the request, with a
  deadline and early cancellation. Oversized uploads return 413 and timed-out
  uploads return 408; backup and audit-bundle imports use the same bounded reader.

- CSV exports prefix formula-looking cells for spreadsheet viewing, including
  imported app and developer names. JSON exports retain the original values.

- CSV exports now keep column headings readable (`App Name`, `Last Synced`,
  `Privacy Type`) instead of replacing their spaces with `%20`.
- The activity log's type filter works for every event type again. It
  validated the requested type against a list that had fallen eight
  entries behind — so filtering by newer events (privacy-profile preset
  changes, verdicts, migrations, health checks) silently returned the
  *unfiltered* feed instead.
- The Stats page's policy radar no longer reshuffles which six apps it
  shows between visits: when several apps share the same last-synced
  time (which every bulk sync produces), the selection previously fell
  back to database scan order.
- Light-theme colour contrast on the app-detail page now meets WCAG AA:
  not-declared accessibility rows no longer dim their text below the
  threshold, the "Declared by developer" tag and the preference-key legend
  use theme-aware colours, the AI-policy note boxes no longer render dark
  navy in light mode, and the change-history chart's +N/−N counters use the
  theme palette instead of fixed chart-band colours.
- **Failed update checks now back off** instead of retrying forever. An
  installation with no internet access used to attempt a connection to
  GitHub — and wait out its timeout — every time anything asked whether an
  update was available. Consecutive failures now widen the gap between
  attempts (15 minutes, doubling, up to a day). Checking manually still
  makes a real attempt straight away.
- **The SQLite database is now private by default** — `0700` on the data
  directory, `0600` on the database and its write-ahead-log files. Existing
  installations are tightened automatically on their next start. The file
  holds your full app inventory, your notes, and (for now) any configured AI
  provider key.
- Accessible names restored for the icon-only home and "Add Apps" links in the
  compact navigation bar.
- Expandable section headers no longer nest their info-tooltip button inside
  the toggle, and the collapsed notes sidebar no longer keeps invisible
  controls in the tab order.
- The app-name entry field has a real label rather than only a placeholder.
- Colour contrast now meets WCAG AA across the interface: link and secondary
  text colours, the accent blue in light mode, and the navigation drawer were
  all below the 4.5:1 threshold in places.
- Nested panels — activity-log rows, the developer tools cards, and
  import-history banners — now have visible backgrounds. They were styled
  against `--surface-1/2/3` and `--border-1/2` design tokens that were never
  actually defined, so they rendered transparent. Defining those tokens for
  light, dark, high-contrast and reduce-transparency modes also clears the
  last dark-only boxes on the app-detail policy blocks (the scrollable source
  and trace wells) and in the Live Text illustration, which drew a dark phone
  frame in the light theme.
- Builds and lint now work from a git worktree nested under the main
  clone's `.claude/worktrees/`: `next.config.js` pins
  `outputFileTracingRoot` so `pnpm build:standalone` no longer emits
  `server.js` under a nested path, and `biome.jsonc` anchors its
  `.claude` exclusion at the repo root so `pnpm lint` stops reporting
  "Checked 0 files" there.

### Security

- Refresh the Docker and desktop Node runtime to 24.20.0, require patched Alpine TLS libraries, remove unused package managers from the runtime image, and apply compatible JavaScript/Rust dependency patches. Scan the final image in CI and track desktop runtime/scanner pins with Renovate.
- Documented in the README that a configured AI provider key is stored in
  plaintext in the local database. Moving desktop keys into the OS keychain is
  planned.

- Verify desktop backup artifacts before recording them and before uninstall pre-flight. Match native discovery to the selected device, use file-based freshness, reject invalid timestamps and symlinks, show the server's backup state throughout confirmation and retry flows, and stop Configurator process groups on timeout or excessive output.

## [0.1.2] — 2026-06-12

### Added

- Animated onboarding purpose cards and dashboard vignettes.
- Periodic health check with non-destructive self-heal for long-running
  instances.
- Read-only deployment mode for shared or kiosk installs.

### Changed

- Privacy-label icons and ordering aligned with Apple's own presentation.
- Full internationalisation sweep — the interface is translator-ready and
  round-trips through Crowdin.
- Onboarding hardening across the four import paths.

## [0.1.1] — 2026-05-20

### Fixed

- **Launch-time freeze affecting every copy of v0.1.0.** The bundled Node
  helper exited immediately with `MODULE_NOT_FOUND` for `@swc/helpers`,
  leaving an unresponsive window. The packaging step had dereferenced pnpm's
  symlinked `node_modules` layout, moving `@swc/helpers` out of Node's
  resolution path; it now preserves those relative symlinks verbatim through
  both staging and the release tarball.

  The auto-updater runs *after* the Node helper boots, so it never fired on
  v0.1.0 — anyone on that version had to install v0.1.1 manually. Every
  install from v0.1.1 onward self-updates normally.

## [0.1.0] — 2026-05-18

Initial beta release, available as a macOS app, a Docker image, or a plain
Next.js app.

### Added

- App Store privacy-label tracking with change detection over time.
- Historical back-fill to Q1 2021 via the Wayback Machine.
- Focus-tailored dashboard adapting to who the device belongs to (yourself, a
  loved one, or someone you support) and what you want from it.
- Four onboarding import paths: typed names, CSV/TXT upload, Apple
  Configurator on desktop, and screenshot OCR.
- Changelog timelines, privacy heatmap, per-app severity strips, an editable
  home-card layout, and exportable audit bundles.
- AI-generated privacy-policy summaries with a bring-your-own provider model.
- Background sync with a notifications bell, and crash-safe resume across the
  live, Wayback, and privacy-policy jobs.

[Unreleased]: https://github.com/privacykey/privacytracker/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/privacykey/privacytracker/compare/v0.1.2...v0.2.0
[0.1.2]: https://github.com/privacykey/privacytracker/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/privacykey/privacytracker/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/privacykey/privacytracker/releases/tag/v0.1.0
