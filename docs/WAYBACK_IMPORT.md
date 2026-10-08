# Wayback import redesign (Rust)

The historical import reads archived App Store pages from archive.org to
reconstruct an app's privacy-label history back to February 2021. This
document is the design and the working contract for the redesign that
replaces the quarterly sweep. It is **Rust-only**: the Node rollback
(`BACKEND=node`) keeps the importer as it was before this work, and the
parity fixtures for this feature become Rust-owned (see P0).

## Why

A 201-app bulk run finished one app and paused. The summary read
"2 imported, 5 no-op, 17 skipped", which counts checkpoints, not apps: one
app is 22 quarterly dates, the February 2021 floor and the install date.

- **No pacing.** Each app sent one CDX index call, then one full archived
  page per uncovered checkpoint, back to back, and the next app started at
  once.
- **Retrying into the block.** archive.org answers a burst with 429, then a
  block reported to last about 5 minutes, then refused TCP connections. The
  runner retried after 30 s, so the retry always failed.
- **A throttled archive looked like an empty one.** A refused connection or
  a timeout read as "no capture" (fixed in #386).
- **Wasted reads.** Labels rarely change, but every app cost about 22 page
  reads, plus a Save Page Now request when the archive had nothing recent.

Published guidance is thin. The EDGI `wayback` client says the Internet
Archive asked it to run at 80% of hard limits of 30/min for the CDX index
and 600/min for replays, and to wait 60 s on a 429 without `Retry-After`.
Others report about 15 requests a minute before a 5-minute block.

## Principles

1. Budget requests, not apps. One shared pace for every archive.org caller.
2. Wait out throttling. Never retry inside a block, never hand a throttled
   run back to the user while waiting would do.
3. Read pages only where labels change.
4. A throttled or unreachable archive never reads as an empty one.

## Packages

| Package | Owner | Summary |
|---|---|---|
| P0 Foundation | integrator | Options scaffold, Rust-owned fixtures (`PT_BLESS`), manifest reclassification |
| P1 Paced client | agent | One pacer for every archive.org request, stored cooldowns |
| P2 Change-finding | agent | Skeleton reads plus bisection instead of a quarterly sweep |
| P3 Bulk runner | agent | Wait instead of pause, survey phase, capture cache, ordering, app-level progress |
| P4 UI | agent | Settings card, detail card and timeline for the new states |
| P5 Coverage | agent, after P2 and P3 | US storefront lookups, renamed-app hint and older addresses |

Status: every package is merged on the integration branch, where the
full core suite and the frontend checks pass and the three Rust-owned
fixtures are blessed on the merged code. Known limits, left for later:
`historyStartsAt` reads the archive's listing only, never stored rows, so
an app imported before P5 from a non-US page whose US archive starts
later can be told its history starts late while its timeline already
shows older rows; and `apps` stores no release date, so an app first
published after mid-2021 is also told its history starts late and
offered the address input.

### File ownership

Two packages never edit the same file. Anything not listed is the
integrator's; ask in your final report instead of editing it.

| Package | May edit |
|---|---|
| P1 | new `core/src/scrape/archive_pacer.rs` (and its tests), `core/src/scrape/mod.rs` (module line), `core/src/server/policy_store.rs`, `core/src/server/imports_writes.rs`, `core/src/server/runner_writes.rs`, `core/src/server/sync_runner.rs`, server state wiring in `core/src/server/mod.rs` |
| P2 | `core/src/scrape/history.rs`, `core/src/scrape/history_tests.rs`, `core/tests/fixtures/history-cases.json` |
| P3 | `core/src/server/wayback_runner.rs`, `core/src/server/wayback_runner_tests.rs`, `core/tests/fixtures/wayback-runner-cases.json`, `core/src/server/operations.rs` (Wayback payload only) |
| P4 | `app/components/settings/WaybackImportSection.tsx` and its CSS, `lib/use-wayback.ts`, `app/components/detail/AppHistoryImportCard.tsx` and its CSS, `app/components/ChangelogTimeline.tsx` (wayback rows only), new `lib/wayback-*.ts` helpers and their `tests/app/` tests, the Wayback keys in `locales/en.json` and `locales/zh.json` |
| Integrator | `CHANGELOG.md`, `AGENTS.md`, `core/README.md`, `.github/workflows/ci.yml`, `scripts/parity/`, `core/scripts/`, this document |

## Contracts

### P0: options scaffold (in place)

`HistoryOptions` (`core/src/scrape/history.rs`) carries three fields the
runner sets for bulk runs. Defaults keep today's behaviour.

- `captures: Option<Vec<Capture>>`: a capture list the caller already
  holds; the import does not ask the CDX index.
- `skip_save_now: bool`: never ask Save Page Now.
- `skip_availability_fallback: bool`: when the index is unusable for a
  reason other than throttling, fail with `INDEX_UNAVAILABLE` instead of
  probing the availability API.

### P0: Rust-owned fixtures (done)

`history-cases.json` and `wayback-runner-cases.json` are no longer
re-recorded from Node: their CI extractor steps and the two Node
extractors are gone, and the Rust replays have a bless mode
(`core/src/bless.rs`). From the repository root, with the build variables
from "Rules for agents":

```bash
PT_BLESS=1 cargo test --locked --manifest-path core/Cargo.toml --lib historical_import_matches_node -- --nocapture
PT_BLESS=1 cargo test --locked --manifest-path core/Cargo.toml --lib wayback_runner_paths_match_node -- --nocapture
PT_BLESS=1 cargo test --locked --manifest-path core/Cargo.toml --lib import_history_route_matches_its_blessed_fixture -- --nocapture
```

Each rewrites every case's outputs (`calls`, `stream`, `rows` and
`expected`; the runner's NDJSON frames are in the expected body) from the
current Rust behaviour, leaves its inputs (setup, replies, options,
hooks, clock) alone, lists the cases it rewrote and passes. Review every
blessed diff; a blessed fixture is a regression test, not an oracle.
Cases whose requests change need new canned replies, written by hand or
by a generator in the test file. A new case needs only its inputs: the
bless appends its outputs, and the runner replay dumps the six tables
every recorded case has when a case has no `rows`. Blessing unchanged
code rewrites nothing. `GET /api/wayback/import-all` moved from READS to
QUARANTINE in `scripts/parity/manifest.mjs`.

The 15 per-app `import-history` route cases moved with P2 to the
Rust-owned `import-history-route-cases.json`; the imports extractor
reserves their forwarded addresses, so the remaining 162 cases of
`imports-cases.json` re-record unchanged. Still recorded from Node: the
Wayback status reads in `operations-cases.json` (36 of
`GET /api/wayback/import-all` and 37 of `/api/tasks/active`, over planted
v1 and v2 state blobs), which P3 keeps byte-identical by adding its v3
keys only for a v3 blob. Report a change that moves them rather than
re-recording them.

### P1: paced client

- A `Pacer` per server (not a global, since one process can hold several
  servers), with an injectable clock, shared behind an `Arc`, and a
  wrapper that implements `Fetcher` around any inner fetcher. Requests to
  `archive.org`, `web.archive.org` and `www.web.archive.org` are paced;
  everything else passes through untouched.
- Rate starts at 10 requests a minute (one every 6 s), never above 15 or
  below 2. Halve it after a throttle; add 1 per minute after 20
  consecutive successes.
- A throttle is an HTTP 429, any 5xx, or a transport failure that
  `Unavailable::transport` classifies. It starts a cooldown of
  `max(Retry-After, base)`, where base is 5 min doubling with each
  consecutive throttle, capped at 60 min. A success resets the count.
- During a cooldown, a request to an archive host gets a synthetic reply,
  status 429 with `Retry-After` set to the remaining seconds, and never
  reaches the network. The existing classification turns it into
  `Unavailable` with `retry_after_ms`, so callers need no new paths: the
  per-app route already answers 503 `archive_unavailable` with
  `retryAfterMs`.
- Stored in `app_settings`: `wayback_cooldown_until` (epoch ms) and
  `wayback_pacer_state` (JSON `{"perMinute", "consecutiveThrottles",
  "updatedAt"}`), loaded at start and written on change, so a restart
  keeps a cooldown. P3 reads both keys directly for its estimate and
  display, so it has no compile dependency on P1.
- Every archive.org caller goes through it: the bulk runner
  (`runner_writes.rs`), the boot resume (`sync_runner.rs`), the per-app
  route (`imports_writes.rs`) and the policy store's `lookup_latest` and
  Save Page Now (`policy_store.rs`).
- Tests construct an unpaced pacer (no sleeps); cooldown logic is tested
  with a fake clock.

### P2: change-finding import

`import_app_history` keeps its signature. With an index:

1. **Skeleton.** Read the earliest capture on or after the floor, the
   newest capture, and the capture nearest each anchor stepping back from
   today by `interval_months` (default 12; the per-app route's
   `intervalMonths` 1 to 6 still makes it denser). Stored wayback rows are
   known samples and are never re-read, unless `force`, which still never
   duplicates a row by capture URL.
2. **Bisect.** Wherever two neighbouring samples differ, read the capture
   nearest the midpoint in time and recurse into the half (or halves) that
   still differ. Stop when the bracketing captures are adjacent in the
   index or no more than 7 days apart.
3. **Unusable captures** (no labels, parse failure, a non-throttling fetch
   failure) are skipped for the next nearest capture, at most 2 tries per
   point.
4. **Rows written:** the earliest usable read (baseline); for each change,
   the last capture with the old labels (an unchanged row) and the first
   with the new labels (the change row); and the newest read. Labels are
   constant between change points, so the "Since you added this app"
   baseline (newest row at or before `firstSeen`) stays correct without an
   install-date read.

Without an index (per-app path only, when the fallback is allowed): one
availability probe per skeleton anchor, at offset 0, and no bisection.
Throttling still propagates at once; rows already written stay, and the
next run reuses them as samples.

The result keeps every existing field and adds `reads` (pages fetched),
`changes` (change points found), `labelVersions` (distinct label states),
`firstCaptureMs` and `lastCaptureMs` (index range), and `windows`
(`[{"fromMs", "toMs"}]`, one per change). Each `targets[]` entry keeps its
shape and adds `"phase": "skeleton" | "bisect"`.

A change that reverts between two skeleton reads is missed, as the
quarterly sweep misses one inside a quarter. `intervalMonths` buys
density where it matters.

### P3: bulk runner

State blob `wayback_bulk_state` moves to `version: 3` (the blob's own
`version` field, `STATE_SCHEMA_VERSION` in the runner). A v2 blob still
resumes, as a reading phase with no survey. Every reader of the blob must
accept 3: the runner's `read_bulk_state`, the status projection in
`operations.rs` (`describe` accepts only 1 and 2 today and rewrites the
version to 2) and the health check's lock heal. `operations-cases.json` is
still recorded from Node and plants v1 and v2 blobs, so a v1 or v2 blob
must read byte-identically through `GET /api/wayback/import-all` and
`GET /api/tasks/active`; the new keys appear only when a v3 blob carries
them. Additions:

- `phase`: `"survey"` or `"reading"`.
- `waitingUntil` (epoch ms) and `waitReason`, present only while waiting.
- `consecutiveThrottles`.
- `survey`: `{"appsSurveyed", "appsWithCaptures", "appsWithoutCaptures",
  "capturesTotal", "estimatedReads", "completedAt"}`.
- `estimate`: `{"readsDone", "readsRemaining", "perMinute", "etaMs"}`,
  recomputed at every app boundary from `wayback_pacer_state.perMinute`
  (10 when absent).
- Queue entries add `captureCount`, `firstCaptureMs`, `lastCaptureMs`,
  `noArchive`, `reads`, `changes`, `labelVersions`.
- Totals add `appsDone`, `appsRead`, `appsWithHistory`, `appsNoArchive`,
  `reads`, `changes`, `labelVersions`, and (P5) `appsHistoryLate`, which
  counts finished apps whose import result says `historyStartsLate` (a
  missing flag counts as false; a queue saved before the count existed
  starts it at 0).

Behaviour:

1. **Survey** (fresh runs): one CDX listing per app through the shared
   fetcher, cached in `app_settings` as `wayback.captures.<appId>` =
   `{"fetchedAt", "url", "timestamps": ["yyyymmddhhmmss", ...]}`. A cache
   younger than 7 days is reused without a request. No schema change.
2. **Order:** apps with captures and no stored wayback rows first, then by
   capture count, descending. Apps with no captures finish as `noArchive`
   with no reads.
3. **Read:** `HistoryOptions { captures: <cached>, skip_save_now: true,
   skip_availability_fallback: true, .. }`.
4. **Throttle:** set `waitingUntil = now + retry_after_ms` (300 s when
   absent), persist, emit `waiting`, sleep abortably, then retry the same
   app. After 6 consecutive throttles with no app completed in between,
   pause with `pauseCause: "rate_limited"` as today.
5. **Activity rows** speak in apps and changes: per app "Instagram: 3 label
   changes found, 12 pages read"; per run "Wayback import: 201 of 201 apps
   checked, 37 label changes found, 58 apps have no archived pages".

`GET /api/wayback/import-all` keeps its keys and carries the v3 blob in
`state`. NDJSON frames are additive; existing ones keep their shapes, and
`backoff` is replaced by `waiting`:

```json
{"type": "phase", "phase": "survey"}
{"type": "survey-app", "appId": "1", "name": "A", "index": 0, "total": 201, "captureCount": 1744, "firstCaptureMs": 0, "lastCaptureMs": 0, "cached": false}
{"type": "survey-done", "survey": {}, "estimate": {}}
{"type": "waiting", "appId": "1", "name": "A", "until": 0, "reason": "archive.org rate-limited for CDX index"}
{"type": "estimate", "estimate": {}}
```

### P4: UI

- Settings card: the phase ("Checking the archive index: 37 of 201 apps",
  "Reading archived pages: 12 of 143 apps"), the estimate ("About 1 h 50
  min left"), the wait ("Waiting for archive.org, resumes at 14:32"), the
  survey result ("143 apps have archived pages, 58 have none"), and totals
  in apps and label changes rather than checkpoints.
- Detail card: on 503 `archive_unavailable`, "archive.org is busy. Try
  again after 14:32" from `retryAfterMs`; results as label changes found;
  "Archived history starts on <date>" when `firstCaptureMs` is well after
  February 2021.
- Timeline: a wayback change row directly after a wayback unchanged row
  reads "Changed between <date> and <date>".
- Every new field is optional, so the Node rollback still renders today's
  card. Strings go in `locales/en.json` and, by hand, `locales/zh.json`.

### P5: coverage (after P2 and P3)

- For a stored URL on a storefront other than `us`, the survey lists the
  US address first (labels are per app) and falls back to the stored one
  when the US index is empty.
- `historyStartsLate` when the first capture is more than 180 days after
  both the floor and the app's release date, when known. The detail card
  then offers "Add an older App Store address", saved as
  `wayback.alt_urls.<appId>`; the survey and the per-app import merge
  captures from those addresses.

## Rules for agents

- **Rust only.** Do not change the Node backend (`lib/` modules the Node
  server runs, `app/api/`). Frontend code (`app/components/`, client hooks
  in `lib/use-*.ts`, `locales/`) is shared and in scope for P4.
- **Never send a live request to archive.org.** Use stubs and recorded
  replies. This network has been blocked by archive.org.
- **Disk is tight.** Run `df -h /System/Volumes/Data` before building.
  Build with `CARGO_INCREMENTAL=0 CARGO_PROFILE_DEV_DEBUG=0
  CARGO_PROFILE_TEST_DEBUG=0` in your own worktree's target (never a
  shared `CARGO_TARGET_DIR`), and delete your `core/target` after your
  final push. Do not run `pnpm build` or Playwright locally.
- **Stay in your files** (table above). Do not edit `CHANGELOG.md`,
  `AGENTS.md` or `core/README.md`; put the entries you would add in your
  final report.
- **Branches:** commit in small, signed commits; push your branch; merge
  `origin/feat/archive-org-imports-strategy-850ef6` into it before you
  finish and resolve conflicts there. Do not open a pull request.
- **Checks before you finish:** `cargo test --locked --manifest-path
  core/Cargo.toml`, `cargo clippy` if you changed Rust, and for frontend
  work `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm lint:i18n`.
- **Final report:** branch and commits, what changed, the tests and their
  results, anything left undone, the CHANGELOG and AGENTS.md text you
  propose, and anything the other packages or the integrator must know.
