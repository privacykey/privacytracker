# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Commands

```bash
npm install            # requires Node 24+ and <27 (see `engines` in package.json)
npm run dev            # http://localhost:3000
npm run build          # production build
npm start              # serve the production build
npm run lint           # ESLint flat config for Next 16
npm run typecheck      # TypeScript without emitting files
npm test               # focused node:test suite
npm run lint:i18n      # check locales/*.json key parity against en.json
```

Docker (production): `docker compose up --build -d`. By default the SQLite DB lives in a Docker-managed **named volume** (`privacytracker-data`), so data survives rebuilds and the container's non-root `audit` user (uid 100 / gid 101) can write it on any host with no setup. Back it up with `docker compose cp web:/app/data ./data-backup`. This is a change from the old `./data` bind mount, which broke on a fresh Linux host: Docker auto-creates the bind source as `root:root`, uid 100 can't create `privacy.db`, and `lib/db.ts` throws `SQLITE_CANTOPEN` (macOS Docker Desktop hid this by uid-mapping bind mounts). If you'd rather keep the DB on the host at `./data/privacy.db`, layer on `docker-compose.bind-mount.yml` after the one-time `mkdir -p data && sudo chown 100:101 data`: `docker compose -f docker-compose.yml -f docker-compose.bind-mount.yml up --build -d`. The `compose-smoke` CI job exercises both paths (and asserts `/fonts/InterVariable.woff2` + `/brand-icon.png` actually serve — the runtime image must copy `public/`).

The test suite is intentionally small and focused (`npm test`). Container healthchecks hit `GET /api/ready` (DB reachable + data directory writable). `GET /api/health` stays as the simpler liveness probe for uptime checks.

Separate Python companion script in `scripts/ios-app-import/` (stdlib-only, Python 3.9+): `python3 scripts/ios-app-import/export_ios_apps.py --mode backup|device`. It is *not* wired into the Node app — it produces a `.txt`/`.csv` that the user feeds back into the web onboarding flow.

## Architecture

This is a Next.js 16 App Router app (TypeScript, React 19) backed by a single local SQLite file. All scraping, parsing, diffing, and AI calls happen server-side inside API routes that import helpers from `lib/`.

### Data flow (the core loop)

1. **Search** (`lib/scraper.ts` → `searchAppsByName`) hits the iTunes Search API to turn user-typed app names into candidate App Store URLs.
2. **Scrape** (`lib/scraper.ts` → `fetchAndParseApp`) downloads the App Store HTML and extracts the `<script id="serialized-server-data">` JSON blob. Apple wraps the payload as `{ data: [...], userTokenHash }` — always unwrap via `Array.isArray(raw) ? raw : raw.data`.
3. **Parse** walks `data[0].data.shelfMapping.privacyTypes.items` first, then falls back to `privacyHeader.seeAllAction.pageData.shelves` (which may still use the legacy `purposes → categories` nesting and must be flattened), then finally generic `pageData.shelves`.
4. **Persist** writes to SQLite as a flat tree: `apps → privacy_types → privacy_categories`. The old `privacy_purposes` table is kept only for migration safety — *do not populate it*.
5. **Snapshot + diff** (`lib/changelog.ts`) rebuilds a `PrivacyTypeSnapshot[]` from the DB *after* the write, diffs it against the previous snapshot, stores both the JSON snapshot and the human-readable change list in `privacy_snapshots`, and bumps `apps.changeCount` when changes exist.
6. **Notify** (`lib/notifications.ts`) inserts a row that the bell UI (`/api/notifications`) polls.
7. **Summarize policy** (`lib/privacy-policy.ts`) optionally follows the developer privacy-policy link, hashes the text, and — if the hash changed and an AI provider is configured — regenerates a structured `summary_json` keyed by the lenses in `POLICY_TOPIC_GUIDES` (collection_scope, ads_marketing, third_party_sharing, etc.). Long documents are split into ~12k-char chunks for small/local models (`providerLikelyNeedsChunking`).

Re-syncs call the same `fetchAndParseApp(url, resync=true)` path, which is what produces change notifications.

### Feature flags (round 3 — v0.1.0)

Every user-facing surface is gated by the focus system: audience (`self` /
`loved_one` / `guardian`) × goals (`understand`, `declutter`, `minimal`,
plus an `accessibility` modifier). Defaults flow through a layered
resolver — hard default → audience rule → goal rule → accessibility
modifier → runtime-environment (Tauri) → dependency check → user
override (final word).

**Five-module split** (don't break this — Next 16 enforces it):

- `lib/feature-flag-rules.ts` — server-safe types + sparse rule tables (`HARD_DEFAULTS`, `AUDIENCE_RULES`, `GOAL_RULES`, `ACCESSIBILITY_RULES`, `FLAG_DEPENDENCIES`, `TOUR_STEPS`). Pure data + helpers.
- `lib/feature-flags.ts` — server-safe resolver (`resolveFlag`, `setResolverContext`, override mutators, cache accessors). NO React imports.
- `lib/feature-flags-hooks.ts` — `'use client'` only: `useFlag`, `useFocus` via `useSyncExternalStore`. Importing this from a Server Component fails the build.
- `lib/feature-flags-server.ts` — `'server-only'`: `getResolverContextFromDb`, `resolveFlagFromDb`. Pulls focus state + overrides via `lib/feature-flag-storage.ts`.
- `lib/feature-flag-storage.ts` — SQLite reads/writes via `better-sqlite3`. Exports the 7-function CRUD plus quarantine helpers.

**Flag keys** are typed (`FlagKey` union); typos fail at `tsc`. Adding a flag means: (1) add the key to the union in `feature-flag-rules.ts`, (2) add a `HARD_DEFAULTS` entry, (3) add rules in the relevant tables only if behaviour differs from the default.

**Migration** runs eagerly in `instrumentation.ts` (5 ordered steps: schema check → user_intent → notification_prefs → callout rename → quarantine). Idempotent end-to-end. Up to 3 retries on failure before the error UI surfaces a "Reset DB" escape hatch.

**Annotations** (`annotations` table) and **audit-bundle export** (`lib/audit-bundle.ts`) sit on top of the flag system. Private notes (`visibility = 'private'`) are unconditionally excluded from exports at the SQL level — there is no force-include path.

**Kill-switch:** `flag.devopts.feature_flag_system.enabled = off` collapses every flag to its hard default. Use this if a release misbehaves; flipping it back on re-engages the rule engine without a code rollback.

Inventory + rule design: see [Feature flags](https://privacytracker-docs.privacykey.org/develop/feature-flags).

### Historical Wayback import

`lib/historical-import.ts` back-fills privacy-label history from archive.org. The earliest target it will probe is **2021-02-01** (Q1 2021), exposed as `APP_STORE_HISTORICAL_FLOOR` and aliased as `APP_STORE_WEB_LAUNCH` for back-compat. The floor was originally 2025-11-05 because the live scraper only knew the modern `<script id="serialized-server-data">` blob Apple introduced with the Nov 2025 redesign; pushing it back to Q1 2021 became safe once the scraper grew an `extractFromShoebox` fallback that parses Apple's older Ember/FastBoot site (privacy data lives at `d[0].attributes.privacy.privacyTypes` inside `shoebox-media-api-cache-apps`). The two parsers share the same identifier enums (`DATA_USED_TO_TRACK_YOU`, etc.), so downstream snapshot diffing, severity styling, and change detection all work without translation. The helper picks one target per calendar quarter from the floor forward and fetches the closest Wayback capture via `archive.org/wayback/available?url=…&timestamp=YYYYMMDD`. A capture more than 45 days (`CAPTURE_DRIFT_TOLERANCE_MS`) off its target quarter is dropped rather than standing in for the whole bucket. When the first probe misses (no capture or outside tolerance), `findCaptureWithinTolerance` walks symmetric offsets (±14/±28/±42 days via `WAYBACK_FALLBACK_OFFSET_DAYS`) inside the window before giving up — the availability API resolves "closest" relative to the probe timestamp, so shifting the probe often surfaces a different, in-window capture. `skipped_no_capture` therefore means archive.org has nothing anywhere near the quarter; this tool never writes to Wayback, only reads from it. Wayback replay URLs always use the `id_` suffix (`/web/<ts>id_/<orig>`) so Apple's original HTML comes through clean of the toolbar injector.

Imported rows go through the same `buildSnapshot → diffSnapshots → saveSnapshot` path as live scrapes, but `saveSnapshot` accepts `{ source: 'wayback', waybackUrl, scrapedAt, skipChangeCountBump, triggeredBy }`. The defaults for wayback are: `source='wayback'`, `skipChangeCountBump=true` (back-dating shouldn't inflate the unacknowledged badge), `scrapedAt` set to the archive capture's timestamp so timeline ordering matches reality, and `triggeredBy='wayback'` inferred from `source`. Snapshot diffs for the first imported row use `buildSnapshot(appId)` as the baseline, which avoids the "every category is new" noise.

When an empty quarter has no Wayback capture anywhere in the tolerance window (`walk.kind === 'none'`), the importer now fires `submitToWaybackSaveNow(app.url)` fire-and-forget-ish to archive the live App Store page so a future import can pick it up. We submit at most once per app per run (tracked by the `saveNowSubmitted` Set), report the outcome as `requested_snapshot` on the `ImportTargetResult`, and surface the count via `ImportAppHistoryResult.snapshotsRequested` — which the bulk and per-app route summaries fold into their activity-log strings ("N snapshots requested").

Entry points:

- `POST /api/apps/[id]/import-history` — single-app backfill. `DELETE` on the same route purges that app's wayback rows.
- `POST /api/wayback/import-all[?stream=1]` — bulk backfill across every app with a URL. Stream mode emits NDJSON events (`batch-start`, `app-start`, `target`, `app-done`, `summary`). `DELETE` wipes every wayback row in the DB. The HTTP layer is a thin wrapper over `lib/wayback-bulk-runner.ts`; state persistence + mutex live there so an auto-resume path can share the same loop.
- `GET /api/wayback/import-all` — polled by `SettingsView` to rehydrate the progress card on mount and tick it while a run (including an auto-resumed one) is in flight. Returns `{ running, mutexHeld, stale, currentAppName, summary, state }` via `describeCurrentRun()`.
- `GET /api/apps/[id]/history-stats` — returns `{ categoryTrend, quarterly }` aggregates (calendar-quarter buckets aligned to `APP_STORE_HISTORICAL_FLOOR` = Q1 2021) for the widgets under the timeline. `computeCategoryTrend` returns added/removed per bucket; `computeQuarterlyChanges` returns change-event counts for the sparkline.

**Crash-safe resume (wayback-specific).** Bulk wayback runs persist two keys in `app_settings`: `wayback_import_running` (boolean mutex string) and `wayback_bulk_state` (JSON blob — run id, queue with per-app `QueueEntryStatus`, running totals, `initiator: 'manual' | 'resume'`). The runner rewrites the blob at every app boundary, so a server kill mid-run loses at most one app's worth of work. `importAppHistory` is safe to re-run — its per-target dedup (`alreadyCovered` + `wayback_snapshot_url` row check) prevents duplicate snapshots, and Wayback's Save Page Now is idempotent. On startup, `instrumentation.ts` checks the state blob: if it has pending work, it fires `createWaybackResumeNotification`, writes a "Sync resumed" activity row, and spawns `runBulkWaybackImport({ initiator: 'resume', resumeState })` in the background. If the mutex is held but the state blob is absent (stale lock), the mutex is cleared and a "stuck lock cleared" notification is raised instead. The SettingsView status card renders a purple "↻ Resumed after restart" pill above the live tally when `state.initiator === 'resume'` so users understand the run they didn't click is being finished for them. Only clean completion (or an explicit outer-catch) clears the state blob + mutex; a process kill leaves them in place for the next boot. The same pattern now covers the bulk App Store sync (`lib/sync-bulk-runner.ts`) and the bulk privacy-policy sync (`lib/policy-bulk-runner.ts`) — see the "Crash-safe resume (all three jobs)" section below.

Relevant settings in `app_settings`: `wayback_show_imported` (`'true'`/`'false'`, controls whether the per-app timeline renders imported rows by default — the detail page still has a local toggle), `wayback_import_running` (cross-request mutex), `wayback_bulk_state` (resume state blob), and the shared `policy_scrape_throttle_*` keys.

The timeline renders wayback rows with a purple dot (`.timeline-dot.wayback`), a clock (🕰) glyph, a "Wayback · YYYY-MM-DD" badge, and a "View on Wayback" link to the capture URL. `lib/changelog-types.ts` exposes these via `source?: 'live' | 'wayback'` and `wayback_snapshot_url` on `SnapshotChangelogRow` — both are normalised server-side in `getChangelog` so older rows default to `'live'`. Each row also carries a `triggered_by` value (`'scheduled' | 'manual' | 'import' | 'wayback' | null`) which drives the `TriggerPill` in the card header; legacy (pre-migration) rows get `null` and render a generic "Live sync" pill. When a wayback baseline snapshot_json is byte-identical to an adjacent live row, `getChangelog` sets `matches_live_sync: true` and the timeline renders a green "Matches live sync" badge so users can see at a glance that the archive and the live App Store page agree.

### Database

`lib/db.ts` exports a **singleton** `better-sqlite3` instance. Opening it runs `CREATE TABLE IF NOT EXISTS` for every table and applies inline `ALTER TABLE` migrations (`firstSeen`, `changeCount`, `bundleId`, `developer`, `privacyPolicyUrl`, `privacy_categories.type_id`, and `privacy_snapshots.source` / `privacy_snapshots.wayback_snapshot_url`). Any new column must be added both to the `CREATE TABLE` body **and** to the `migrations` array, or existing installs will break.

Pragmas set on open: `journal_mode = WAL`, `busy_timeout = 5000`, `foreign_keys = ON`. The DB file path is always `<cwd>/data/privacy.db`, created on demand. `better-sqlite3` is declared in top-level `serverExternalPackages` in `next.config.js` — keep it there so Next doesn't try to bundle it.

All DB calls are **synchronous**. Multi-step writes use `db.transaction(() => { … })()` (see `saveToDb` in `lib/scraper.ts`) — follow that pattern for any new write path that touches more than one table.

### API surface (`app/api/*/route.ts`)

Each route is a thin wrapper over `lib/`. Routes that read mutable state use `export const dynamic = 'force-dynamic'`. The public contract is documented at https://privacytracker-docs.privacykey.org/api-reference/introduction — keep those request/response shapes stable when editing.

### AI configuration

`lib/ai-config.ts` is the single source of truth for providers (`disabled` | `openai` | `anthropic` | `custom`), default base URLs, default models, and per-provider behavior flags (`providerUsesChatCompletions`, `providerLikelyNeedsChunking`, `providerRequiresApiKey`). `custom` targets Ollama or any OpenAI-compatible endpoint. The legacy `ollama` value is normalized to `custom` in `normalizeAiProvider`. All persisted settings live in the `app_settings` key/value table via `lib/scheduler.ts` (`getSetting`/`setSetting`).

### Background sync

`instrumentation.ts` runs on Node server startup (`instrumentationHook: true` in `next.config.js`), sets a 30-minute ticker, checks `getSchedulerStatus().isDue`, and calls `runScheduledSync()` which re-scrapes every app with `resync=true`. `sync_running` acts as a cross-request mutex stored in `app_settings` — respect it if you add another entry point that could trigger sync. As of the sync-resume refactor, `runScheduledSync` is a thin adapter over `runBulkSync` in `lib/sync-bulk-runner.ts`; the runner owns the durable queue, per-app state blob (`sync_bulk_state`), and activity/audit rows. Apple's 429 handling is unchanged — the runner bails out of the loop on the first 429, records a `partial` activity row with `rateLimited` totals, and **still clears state + mutex cleanly** so the next scheduled tick (30 mins away) can retry fresh. That's deliberately different from a process-kill: 429 is an expected recoverable condition, not a crash.

### Crash-safe resume (all three jobs)

Three bulk runners now share the same crash-safe pattern: wayback (`lib/wayback-bulk-runner.ts`), App Store sync (`lib/sync-bulk-runner.ts`), and privacy-policy sync (`lib/policy-bulk-runner.ts`). Each one pairs a state module (`*-bulk-state.ts`) with a runner, persists the queue + totals after every app boundary, and honours `initiator: 'manual' | 'scheduled' | 'resume'` so resumed runs can be identified in UI + activity logs. Keys in `app_settings`:

- wayback: `wayback_import_running` (mutex), `wayback_bulk_state` (blob)
- sync: `sync_running` (mutex, reused from the old scheduler), `sync_bulk_state` (blob)
- policy: `policy_sync_running` (mutex, reused from the old route), `policy_bulk_state` (blob)

On startup, `instrumentation.ts` schedules three staggered resume checks (8s / 10s / 12s) — each one inspects its own state blob and (a) no-ops when nothing's pending, (b) heals a stale lock (mutex held but no queue) by clearing it and firing a `*_stale_cleared` notification, or (c) raises a resume notification, writes a "Sync resumed" activity row, and spawns the runner with `initiator: 'resume'` fire-and-forget. Synthetic notification app ids are `__wayback_resume__`, `__sync_resume__`, and `__policy_resume__`. The resume notifications live in `lib/notifications.ts` as `createWaybackResumeNotification`, `createSyncResumeNotification`, and `createPolicyResumeNotification`.

`GET /api/tasks/active` returns a unified `{ wayback, sync, policy }` snapshot (each with `running`, `initiator`, `currentAppName`, `summary`, `runId`). `TaskCenter` (`app/components/TaskCenter.tsx`) polls it every 4 s and surfaces any running job where `initiator === 'resume'` as a dropdown row tagged "Resumed after restart" — keyed by job name + runId so a new resume cycle replaces the old card cleanly. Manual runs are left alone because the calling UI (SettingsView) already owns their `startTask` handle; filtering to resume-only prevents duplicate cards. The per-job GETs (`/api/wayback/import-all`, `/api/policy/sync-all`) remain the source of truth for their own detailed progress UIs.

### Privacy-profile presets

`PrivacyProfileEditor` exposes four named whole-profile shortcuts above the existing per-category strip: **Strict**, **Balanced**, **Anti-tracking only**, and **Permissive**. They live in `lib/privacy-profile.ts` as `PROFILE_PRESETS` (the tier maps), `PROFILE_PRESET_META` (label / icon / `severityCls`), and `PROFILE_PRESET_KEYS` (the canonical order rendered in the UI). Every preset is **complete** — it covers all 14 categories from `PROFILE_CATEGORY_KEYS` — so applying one always produces a deterministic profile and `matchPreset(profile)` can round-trip the choice back to the active pill. A single per-row edit drops the highlight, signalling "this is now custom".

`PROFILE_PRESETS.balanced` is locked to `DEFAULT_PROFILE` by reference (`{ ...DEFAULT_PROFILE }`) and has a regression test pinning the equality. If you change `DEFAULT_PROFILE` you change the Balanced preset — that's intentional, but worth knowing because returning users with the Balanced highlight will silently migrate to the new tier set. `anti_tracking` always sets every category to `linked` (only third-party tracking flags); `permissive` mostly sits at `tracking` but pulls health / financial / location to `linked` and `sensitive_info` to `not_linked` so the profile is meaningfully different from "no profile". `strict` is asserted to never be more permissive than `permissive` on any category — the test catches accidental drift.

The editor takes an optional `confirmOnPresetApply` prop (default `true`). When the local state is non-empty and doesn't already match the clicked preset, an inline confirm bubble appears under the pill before overwriting; the bubble is the only place a preset can wipe user customisations. `PrivacyProfileSetup` (the onboarding screen) sets it to `hasExistingProfile` so first-time users — whose editor state is just a preloaded `DEFAULT_PROFILE` — can explore presets without nag confirms. `SettingsView` keeps the default `true`.

**Adding a new preset.** (1) Append the key to `PROFILE_PRESET_KEYS`, (2) add complete tier maps under `PROFILE_PRESETS`, (3) add meta under `PROFILE_PRESET_META` (pick a `severityCls` so the active-pill accent walks the green→red gradient sensibly), (4) add `labels.<key>` + `descriptions.<key>` strings under `settings.profile_editor.presets` in `locales/en.json` (Crowdin handles other locales — see Translations), and (5) extend the asserts in `tests/app/profile-presets.test.ts` if the new preset has invariants worth pinning.

**Audit-bundle pass-through.** `buildAuditBundle` runs `matchPreset(getPrivacyProfile())` at export time and emits the result as `recommender_profile_preset` (alongside the raw `recommender_profile`). The field is optional in the bundle type so v1/v2 readers keep working unchanged — `BUNDLE_VERSION` stays at 2 since the field is purely additive. The importer reads it back through to `ImportSummary.recommenderProfilePreset` and `recommender_profile_suggestion.preset` in `app_settings`; `AuditBundleImport.tsx` renders "Recommender used the *Strict* preset" both in the preview modal and the post-import banner using the existing `settings.profile_editor.presets.labels.*` strings.

**Activity-log pass-through.** `PUT /api/privacy-profile` records a `profile_preset_applied` activity row whenever a save crosses a preset boundary — picking a preset, switching presets, or clearing a previously-set profile. Custom-to-custom edits (single-row tweaks inside a non-preset state) intentionally don't fire; the activity log is for noteworthy state transitions, not the editor's debounced keystrokes. The pure helper `describePresetTransition(old, new)` in `lib/privacy-profile.ts` is the single source of truth for when to write a row and what `summary` / `detail` to attach. The detail blob carries `{ from: ProfilePresetKey | null, to: ProfilePresetKey | null, cleared?: true }` so the activity feed can render "from {Label} to {Label}" without re-running `matchPreset`.

### UI

Server components under `app/dashboard/**` hand off to client components in `app/components/*View.tsx` / `*Wizard.tsx` (these are the large interactive surfaces — `OnboardWizard`, `SettingsView`, `AppDetailView`, `AppGrid`). Global tokens and severity/category styling live in `app/globals.css` and `lib/privacy-meta.ts` (`SEVERITY_CONFIG`, `CATEGORY_META`). The `@/*` TS path alias maps to the repo root.

### Disclosure pages (`/privacy-policy`, `/legal`)

Both pages are server components sharing the `.legal-layout` / `.legal-sidebar` / `.legal-content` CSS primitives in `app/globals.css`, and both are linked from the hovering bottom-left pill (`app/components/SiteInfoHint.tsx`).

**Fonts are self-hosted.** Inter v4.1 (SIL OFL-1.1) ships as two woff2 files in `public/fonts/` — `InterVariable.woff2` + `InterVariable-Italic.woff2`, with `Inter-LICENSE.txt` alongside. `app/globals.css` declares them via `@font-face`; `app/layout.tsx` preloads the upright woff2. No Google Fonts, no CDN round-trip. When you upgrade Inter, download the new release from https://github.com/rsms/inter/releases/latest (or from the mirror at https://registry.npmjs.org/inter-ui — same files, published by rsms), drop the woff2s into `public/fonts/`, refresh `Inter-LICENSE.txt`, and bump the `'Inter typeface'` entry's `version` string in `app/legal/page.tsx`. That entry is the one manual version string on the page — see below.

**Legal page versions are read from `package.json` at build time.** `app/legal/page.tsx` imports `../../package.json` and every dependency entry calls `pkgVersion('pkg-name')` instead of hard-coding a string. The helper pulls from either `dependencies` or `devDependencies`, strips the `^`/`~`/`>=`/etc. range prefix, and throws if the name isn't present — better a failed build than rendering `undefined` on a legal disclosure. So bumping a dep (`npm install next@latest`, etc.) is a one-file change and `/legal` picks up the new version on the next build automatically; **do not** re-edit `app/legal/page.tsx` to change a version string unless you're adding / removing / renaming the entry itself. The one exception is the `'Inter typeface'` entry — Inter isn't an npm dep so its version is still hard-coded; bump it when you refresh the woff2s.

**Cross-page deep-link pulse.** `/privacy-policy` links to `/dashboard/settings#ai-summaries` to send users to the AI provider card. `SettingsView`'s hash `useEffect` listens for `#ai-summaries` (alongside the existing `#ai-timeouts` handler) and toggles `.settings-section-pulse` on the target for 1.6 s — reusing the `pmap-card-target-pulse` keyframes so the flash matches Privacy Map and timeline deep-links. If you add another pulse-worthy settings target, extend that single `useEffect` (don't add a parallel one) and add the id to the scroll-margin rule.

**Pre-filled GitHub issue link.** The "Questions or corrections" section on `/privacy-policy` links to `issues/new?template=bug_report.yml&report-type=Privacy%20policy%20concern%20or%20correction&source-page=/privacy-policy`. The old standalone `privacy-policy.yml` template was folded into `.github/ISSUE_TEMPLATE/bug_report.yml`; keep the URL structural (template + field-id prefills) and let the YAML template own the content and placeholders. The repo URL lives in a `GITHUB_REPO` constant at the top of `app/privacy-policy/page.tsx` — keep it in sync with `README.md`, `SECURITY.md`, and the Homebrew tap if the repo is ever renamed. **Do not** revert to stuffing `title=` / `body=` query params with HTML-shaped strings like `<!-- comment -->` — browser XSS heuristics and some corporate proxies flag `<!--` in URL query strings and block the click before the request ever reaches GitHub.

## Translations

Localised UI ships through next-intl. `locales/en.json` is the source of truth; every other `locales/<lang>.json` is round-tripped through Crowdin (free OSS plan) so non-developer reviewers can edit copy in a friendly UI without touching JSON. The full workflow — Crowdin project setup, repo secrets, the weekly pull-request cycle, and how to add a new locale — lives at [Translations](https://privacytracker-docs.privacykey.org/develop/translations). The short version for daily work is: edit `locales/en.json`, run `npm run lint:i18n` to catch parity drift, push to main, and the GitHub Action handles the rest.

ICU placeholders (`{count, plural, one {# app} other {# apps}}`, `{name}`, etc.) are validated by Crowdin on upload and by `next-intl` at render. Don't strip braces or rename placeholders without coordinating across both bundles. Brand names (privacytracker, App Store, Apple Configurator, ToS;DR, PrivacySpy) stay in English in every locale; they're proper nouns. Module-level English fallback maps in components (e.g. `RISK_LABEL` in HomeView, `CATEGORY_META` in lib/privacy-meta) are intentionally kept after the JSX swapped to translator lookups — they document what the keys mean for future contributors and serve as the safety net when a translator key is missing.

The privacy-profile badge type carries a `kind: 'no_profile' | 'match' | 'mismatches'` discriminator alongside its English `label` / `description` fallbacks; client code resolves the localised label via `localiseBadgeLabel(tBadge, badge)` from `lib/i18n-meta.ts` rather than reading the English fields directly. `describeWorstMismatchLocalised` plays the same role for the worst-mismatch sentence on dashboard banners. The English-only `summariseBadge` / `describeWorstMismatch` helpers stay around for notification + audit-bundle exports that compose plain-text strings server-side.

## Things that commonly trip people up

- The App Store page parser depends on Apple's HTML. If labels suddenly stop appearing, the first suspect is the shelf fallback chain in `saveToDb` or the privacy-policy link regex (which must handle both straight `'` and curly `’` apostrophes in the "Developer's Privacy Policy" aria-label).
- `apps.id` is the numeric Apple track ID extracted from `/id(\d+)` in the URL — not a UUID. Snapshots, privacy rows, and notifications all key off it.
- When adding new privacy fields, remember the diff is computed against `buildSnapshot(appId)` *after* `saveToDb` has already wiped and re-inserted `privacy_types` for that app. Capture `previousSnapshot` *before* calling `saveToDb`, mirroring the existing flow.
- Adding a new Tauri `#[tauri::command]` requires updating **three** places, not one. The command goes in `invoke_handler!` inside `src-tauri/src/main.rs`, the same bare name goes in the `AppManifest::new().commands(&[...])` list inside `src-tauri/build.rs` (so `tauri-build` generates the `allow-<command>` permission manifest under the `__app-acl__` namespace), and a corresponding `"allow-<kebab-cased-command>"` entry — *no namespace prefix* — goes in `src-tauri/capabilities/main.json`. Commands registered via `generate_handler!` are APP-level, not plugin-level; the right tauri-build API is `AppManifest`, not `InlinedPlugin`. We learned this the hard way: InlinedPlugin generates a parallel-looking manifest but capability references like `appcmd:allow-X` resolve against the `appcmd` *plugin*'s command table, which is empty (the commands live in the app's table), and every invoke fails with "Command X not allowed by ACL". `AppManifest` puts the permissions under `tauri_utils::acl::APP_ACL_KEY = "__app-acl__"` — and the resolver (`tauri-utils/src/acl/resolved.rs`) defaults unprefixed identifiers to that key, so bare `"allow-check-cfgutil"` in capabilities Just Works.

- The capability also needs `"local": true` AND a `"remote": { "urls": [...] }` entry that matches the webview's actual URL — for us, `http://127.0.0.1:*` and `http://localhost:*` (the Node sidecar's address). Without the remote entry, the ACL grants the permission to the *capability* but the *capability* doesn't apply to the URL, and the dispatcher rejects the invoke with the cryptic "Command X not allowed on window 'main', webview 'main', URL: http://127.0.0.1:NNN allowed on: [windows: 'main', URL: local]" — only visible in debug builds. Release builds strip the diagnostic and just say "Command X not allowed by ACL", which sent us down a long red herring chasing the (correct) permission setup. The sidecar URL is in `tauri.conf.json`'s window definition (`http://127.0.0.1:<port>`); the capability's remote URLs must match its host.

- **Keyboard a11y testing on macOS Safari is misleading.** macOS has a system-wide **"Keyboard navigation"** setting (System Settings → Keyboard, or Safari → Settings → Advanced → "Press Tab to highlight each item on a webpage"). It is **off by default**, and while off, Safari (and every WebKit browser) only Tabs between **text fields and lists** — it skips *every* `<button>` and `<a>` link on *every* website. So a Mac+Safari tester will report that the onboarding "next" buttons, method/goal cards, and help links "have no tab order" or "get skipped" even though the markup is correct (native `<button>`/`<a>` controls + the global `:where(a, button, …):focus-visible` ring at `app/globals.css`, no `inert`/`tabindex`/Tab-interception). **Before treating "Tab skips the buttons" as a bug, confirm in Chrome or Firefox** (both ignore the macOS setting and always Tab to everything) — if it only fails in Safari-with-the-setting-off, it's the OS, not the code. Note this cannot be worked around from CSS/JS; a site cannot force WebKit to Tab to a button when the user has keyboard navigation disabled. (Real `div+onClick` defects — like the old onboarding dropzones, now fixed — are a *separate* issue and DO fail in every browser.)

## Imported Claude Cowork project instructions
