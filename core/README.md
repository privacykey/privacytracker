# privacytracker-core (Rust) — the `rust-core` branch

This branch is the long-lived home of the Rust core migration: replacing
the Node/Next *server* runtime with a single Rust crate while keeping the
React frontend and the public API contract byte-for-byte identical. It is
kept mergeable from `main` and is **not** shipped from until the parity
and benchmark gates below pass.

## Target topology

One crate (`core/`) owning everything that is server-side today — SQLite,
the App Store scraper, snapshot diffing, the Wayback importer, the three
crash-safe bulk runners, schedulers, the policy pipeline, and the HTTP API
— served two ways:

- **Docker**: an axum binary + the static-exported React frontend,
  replacing `next start`.
- **Desktop**: the same axum server embedded in the Tauri process on
  localhost, replacing the Node sidecar. HTTP stays the only data
  interface — the identical static frontend bundle ships in both
  distributions, and Tauri IPC remains reserved for genuinely native
  calls (cfgutil, Touch ID, updater), exactly as today.

`core/` is a standalone crate, deliberately **not** a workspace root —
`src-tauri/` keeps its own independent Cargo build.

## What lands on `main`, and what lands here

**Revised.** This branch was originally the home of every phase, with
`main` untouched until the Phase 6 cutover. That plan traded one risk for
a worse one: a multi-month branch accumulating divergence, which the
design study itself ranks as debt #4 ("two brains during the transition
— keep the window short"). Three and a half weeks in, with no Rust
written yet, this branch was already 87 commits behind `main`.

So the rule is now:

> **Anything INERT lands on `main`. Only the cutover lands here.**

The `core/` crate is inert by construction — no shipped artifact builds,
imports or runs it. The Docker image, the Tauri bundle and `pnpm build`
never compile it; it declares its own empty `[workspace]` so it cannot
disturb `src-tauri`'s cargo build; and it adds no npm dependency. Merging
it into `main` therefore costs `main` nothing, while giving every phase
continuous CI (`core-parity`) and small, reviewable PRs.

**Batches stack while the previous one is in review.** A batch that
depends on an unmerged batch branches from that batch's branch and targets
it, not `main`, and stays in draft. Merge the oldest first, rebase its
child onto the updated `main`, retarget the child and let its checks rerun
before marking it ready; repeat down the stack. Never merge a dependent PR
into an already-merged feature branch.

That inertness is **enforced, not assumed**:
`tests/app/rust-core-inert.test.ts` fails if any shipping path
(`app/`, `lib/`, `proxy.ts`, `next.config.js`, `instrumentation.ts`,
`src-tauri/src/`, the Dockerfile, the standalone staging script) starts
referencing the core. It runs in `pnpm test`, inside the required
`quality` job. `scripts/parity/**` is exempt — those harnesses exist to
drive the core.

**Phase 6 is the one PR allowed to break that guard**, because wiring
axum into the desktop or Docker path is exactly what stops being inert.
That PR belongs on this branch, with burn-in, and should delete the guard
in the same commit that does the wiring so the removal is visible in
review.

This also *improves* the eventual A/B test rather than compromising it.
The comparison wants `main`-built Node app vs `rust-core`-built Rust app
differing by the backend only. With the crate already on `main` and
inert, this branch's diff shrinks to the cutover wiring itself — a far
cleaner isolation than "Node app vs Node app plus 30k lines of Rust".

Phase 0 (page shells + the `scripts/parity/` and `scripts/bench/`
harnesses) landed on `main` for the same reason and remains there.

## Phases

0. *(on main)* Pages → client-fetching shells; parity + bench harnesses.
1. *(on main, inert)* `core/` crate: rusqlite + the exact `lib/db.ts`
   schema/migration contract, proven against real upgraded `privacy.db`
   files.
2. *(on main, inert)* Read-only API in axum, gated by the parity harness.
3. *(on main, inert)* Scraper + diff + persist, gated by golden HTML
   fixtures.
4. *(on main, inert)* Writers, schedulers, the crash-safe runners, health
   check.
5. *(on main, inert)* The AI policy pipeline.
6. **(this branch)** Desktop cutover (embed axum, drop the Node sidecar),
   then Docker after burn-in. The first phase that is NOT inert, and the
   one PR allowed to delete
   `tests/app/rust-core-inert.test.ts`. Its binaries must ship the
   third-party notice in `core/V8-LICENSE` (the `Date.parse` port in
   `jsdate`) alongside `NOTICE`.

## The gates (how the two implementations are compared)

**Parity** — `scripts/parity/parity-diff.mjs --a <nodeURL> --b <rustURL>`
(on `main`): seeds both servers identically (focus, profiles, canned
sample data), replays the same request manifest against both, normalises
volatile fields (timestamps, UUIDs, durations), and fails on any
remaining byte difference. Self-test: two Node instances must diff to
zero; the Rust server must hold the same zero before any cutover.
Additionally, the whole Playwright suite (46 behavioural specs + the
axe gates) and the local visual net (13 shots) run against either
backend unchanged, because they only speak HTTP.

**Benchmarks** — `scripts/bench/bench.mjs` (on `main`), same flags for
both backends:

| Metric | Definition |
| --- | --- |
| Cold start | spawn → first `GET /api/ready` 200 |
| Idle RSS | process-tree RSS after ready + 5 s settle |
| Loaded RSS | RSS after the latency mix completes |
| Latency mix | p50/p95/p99 per route over N sequential + M concurrent rounds: `/api/apps`, `/api/apps?limit=250&meta=grid`, `/api/activity`, `/api/devices`, `/api/feature-flags`, `/` and `/dashboard` (HTML) |
| Suite time | wall time of the full Playwright run against the target |
| Docker image size | `docker image ls` for the built tag |
| Mac bundle size | `.app` size (and installed sidecar/runtime footprint) |

Numbers are recorded per run in the PR/burn-in notes, never committed as
artifacts.

## Ground rules

- The public API shapes documented at
  https://docs.privacytracker.privacykey.org/api-reference/introduction
  are frozen; internal route shapes are pinned by the parity manifest.
- The SQLite schema contract in `lib/db.ts` (CREATE TABLEs, inline ALTER
  migrations, the feature-flag migration, WAL/permissions behaviour) is
  frozen; the Rust layer reproduces it exactly so existing installs
  upgrade cleanly — and can roll *back* to the Node build during burn-in.
- While the port is in flight, `lib/` server logic on `main` is treated
  as feature-frozen wherever practical; anything that must change there
  is mirrored here in the same week, or the parity gate will say so.

## Status — Phase 1 (this crate)

`core/` is a **standalone crate** (its own `[workspace]`, not tied to
`src-tauri/`). It builds a `pt-core` binary and, so far, does exactly one
thing: open a `privacy.db` and bring its schema up to the current contract,
a faithful port of `lib/db.ts`.

```
just parity-schema      # Rust-vs-Node schema diff (the gate)
just test-core          # in-crate unit tests
cargo run -p privacytracker-core --bin pt-core -- migrate <path>
```

**What is ported:** the pragma set (`journal_mode=WAL`, `busy_timeout=5000`,
`foreign_keys=ON`), the 0700/0600 permission tightening, the full
CREATE/INDEX block, every guarded `ALTER TABLE ADD COLUMN` migration, and the
data backfills db.ts runs on open (unknown-device placeholder, the
`pending_search` heal, the stuck-`running` reset, the `privacy_policy_versions`
seed). The big CREATE block is lifted verbatim from `db.ts` by
`core/scripts/extract-schema.mjs` into `core/src/schema_sql.rs` (generated,
checked in) so it cannot drift; the orchestration and short ALTER lists are
hand-ported in `core/src/db.rs` in db.ts's exact order.

**What is deliberately NOT ported yet:** the feature-flag data migration
(`lib/migrations/v1_feature_flags.ts`). It is instrumentation-driven and
depends on feature-flag resolver semantics — a later phase. The parity gate
compares a db.ts-opened database against a pt-core-opened one, neither having
run the feature-flag migration, so the comparison stays apples-to-apples.

**The gate — `scripts/parity/schema-parity.mjs`.** The Phase 1 contract is:
*for any starting database X, the Rust migrator leaves X in the same schema
state db.ts would.* Not "fresh == upgraded" — `ALTER ADD COLUMN` makes those
differ in stored SQL text while being identical tables — but Rust(X) == TS(X).
One Node dumper reads both sides (so only the migrator differs), the
authoritative comparison is the logical schema (columns, indexes, foreign
keys), and the data backfills are checked by aggregate counts so the random
ids they mint never cause a spurious diff. Cases: an empty DB (fresh path), a
deliberately old-shaped DB (upgrade path), and a current-schema DB with
live-ish state (re-open path). All three pass byte-identical today, and the
gate is self-tested to fail when a single ALTER is dropped.

**When `lib/db.ts` changes:** re-run `node core/scripts/extract-schema.mjs`,
port any new ALTER/backfill into `core/src/db.rs`, and run `just parity-schema`
— it will name exactly what diverged.

## Status — Phase 2 complete (66 reads)

The crate now also serves HTTP:

```
PRIVACYTRACKER_DATA_DIR=<dir> pt-core serve [--port N]   # else <cwd>/data; port 0/omitted = OS-assigned
just parity-read http://127.0.0.1:3001 <nodeDataDir>
```

**Routes implemented: all 65 reads in the Phase 2 inventory plus the newer `/api/device-scope` read (66 total).** The sections below record
each batch and its verification. The initial nine were `/api/health`, `/api/auth/admin-token/status`,
`/api/locale`, `/api/date-format`, `/api/preferences`, `/api/coachmark-state`,
`/api/dev-menu-state`, `/api/privacy-profile`, `/api/accessibility-profile`.

Chosen for shape coverage rather than convenience — between them they exercise
a constant response with a non-200 branch (health's 503), a no-database
header-driven route (locale), three *different* settings-scalar coercions
(allowlist / trim-emptiness / `=== "true"`), and two insertion-ordered nullable
maps (the profiles). All nine are reads the client shell makes on first paint,
or container/auth probes.

**The gate — `scripts/parity/read-parity.mjs`.** Boots this server against a
copy of a running Node server's database and byte-compares every implemented
route through the existing dual-live differ. `parity-diff.mjs` gained an
opt-in `--only <regex>`; without it the 100-odd unimplemented routes fail on
`200 vs 404` and drown the signal. The copy-the-database step is scaffolding:
the differ seeds via POST, which a read-only server cannot answer, so Node is
seeded and its checkpointed database is cloned. That disappears once the write
routes land.

**The migration is not read-only, and the copy step has to account for it.**
`lib/db.ts` backfills a placeholder "Unknown device" and links every app to it
when a database holds apps but no devices, and `core/src/db.rs` ports that
faithfully. So opening a database with the Rust core can WRITE to it, and
which side opened it first decides what both sides then see:

* boot Node on an empty directory and seed it — apps exist, devices do not,
  because Node ran its backfill before there was anything to back-fill;
* read-parity copies that state;
* the Rust server opens the copy, its backfill fires, and it now holds a
  device and one link per app that Node does not;
* any route reading `app_devices` — `/api/apps?meta=grid` is the first —
  reports a difference that is an artefact of boot order.

Measured: opening a 22-app copy holding zero devices produced 1 device and 22
links. Restarting the Node server at any point after seeding hides it again,
which is what makes it worth asserting rather than remembering, so
`assertBackfillWontFire` refuses the run (exit 2) with the remedy rather than
letting a future device-reading route fail mysteriously.

**What the parity gate cannot see.** It authenticates every request, so a
route that forgot its auth gate still answers 200 and passes. The same blind
spot covers the inbound rate limiter: the differ sends ONE request per route
against a 120/min limit, so a backend that omitted the limiter entirely would
pass every check. The runner therefore probes both directly — a gated route
with no token must 401 while a public one still 200s, and a burst past the
limit must 429 at the same request number on both backends — and `trust.rs` /
`auth.rs` / `ratelimit.rs` carry unit tests. Two further probes, for the
trailing-slash redirect and for the forwarded-host / CSRF-origin inputs, are
described in their own sections below. Treat "parity green" as a statement
about response bytes only.

**Three decisions worth not re-litigating:**

- `serde_json` is built with **`preserve_order`**. Without it `Value::Object`
  is a BTreeMap and alphabetises, which silently reorders every stored blob we
  re-emit. This is self-tested: removing the feature makes both profile routes
  fail the gate and the other seven still pass.
- Nullable fields serialise **present-null by default**; `skip_serializing_if`
  is added per field only where the Node source is confirmed to produce
  `undefined`. `JSON.stringify` drops `undefined` and keeps `null`, and the
  differ treats those as different.
- One `Mutex<Connection>`, not a pool. Node uses a single synchronous
  better-sqlite3 handle; a pool would give each connection its own WAL
  snapshot, letting two queries in one handler see different states — which
  the Node server structurally cannot do.

### Batch 2 (+2 routes, 11 total)

`/api/focus` and `/api/imports`. Two shapes batch 1 did not cover:

- **A derived multi-key object** — `/api/focus` computes all ten of its keys
  rather than echoing settings. Three traps, all invisible in the response
  shape: mutual exclusion is applied *on read* (a database holding
  `minimal=true` AND `monitor=true` reports `monitor: false`, so echoing the
  stored values diverges); `audience` and `audienceSet` read the SAME key with
  different fallbacks and can legitimately disagree; and `audience` is an
  unchecked cast in Node, so it stays a `String` here rather than an enum that
  would normalise or reject a garbage value. The suppression rule is pinned by
  a unit test and was negative-tested against the harness — the naive echo
  fails the gate on `"monitor"`.
- **A bare array with a 404 branch** — `/api/imports`. No envelope, `[]` and
  never `null` when empty. `?id` is a JavaScript truthiness check, so an EMPTY
  `?id=` falls through to the list rather than 404ing, which a Rust
  `Option<String>` check gets wrong. `queued` deliberately folds
  `pending_search` in. `attemptCount` coerces NULL to 0 while the adjacent
  `nextAttemptAt` stays null — an asymmetry a tidying port would smooth away.

The `?id=<missing>` → 404 branch was ungated before; it now has a manifest
entry, so both backends are held to the same error shape.

### Batch 3 (+3 routes, 14 total)

`/api/sync/status`, `/api/verdicts`, `/api/imports/queue`. Three more shapes:
a query-parameter-scoped read with a 400 branch, a nested list inside an
envelope, and interval arithmetic over stored epochs.

Details worth not smoothing away: `sync/status`'s `isDue` is guarded by
`interval > 0`, so a manual schedule is never due however old `lastRun` is;
`/api/verdicts` 400s on an EMPTY `?appId=` exactly as on a missing one (JS
truthiness again); and the queue's `pausedUntil` is null unless the stored
fence is still in the FUTURE, while `lastRunAt` turns a stored 0 into null
rather than 0.

The harness gained `--ids-from <a|b>`. `/api/verdicts` needs the `{app}`
placeholder, which the differ resolves by calling `/api/apps` on each side —
a route the Rust core will not implement for several batches. In the
read-parity flow the Rust server runs on a **byte copy** of Node's database,
so the ids are identical by construction and resolving from one side is
correct. It is off by default: two independently seeded servers must still
agree on their own, and the full Node-vs-Node run still proves that.

### The inbound rate limiter (+2 routes, 16 total)

`/api/manual-apps` and `/api/import/audit-bundle/recent` were held back from
batch 3 for one reason: both call `checkRateLimit` before doing any work.
Porting them with the limiter faked out or skipped would have shipped a route
with its gate quietly removed — and, as above, the differ could not have told.

`core/src/server/ratelimit.rs` ports the INBOUND limiter from
`lib/security.ts`. Do not confuse it with `lib/rate-limit.ts`, which is an
unrelated thing: Apple's *outbound* scrape cooldowns, persisted in
`app_settings`. This one is a per-process in-memory sliding window over request
timestamps, so the two backends have independent state by construction. That
matches Node — a restart forgets the window there too — but it means the state
is not itself a parity contract, only the behaviour of a fresh window is.

Three details a tidying port would get wrong:

- **The deny path does not record a timestamp.** Node returns before the push,
  so a client hammering a denied endpoint does not extend its own cooldown
  indefinitely. Pushing on deny looks harmless and makes recovery impossible.
- **`clientIpFromHeaders` returns nothing without a trusted proxy**, and the
  key collapses to a shared `…:local` suffix. Honouring `X-Forwarded-For`
  unconditionally would let header rotation mint a fresh bucket per request and
  defeat the limiter outright. With a trusted proxy it takes the **last** XFF
  entry, not the first — that is the hop the proxy appended, and the only one a
  client cannot forge.
- **`withinMs` on the recent-imports route is validated only when PRESENT.**
  Node checks `raw !== null`, not truthiness, so an empty `?withinMs=` IS
  present and 400s — the opposite of the `?id=` behaviour two sections up.
  That route also swallows read errors into a 200 `{"recent": null}`, so a
  query failure must not become a 500.

The probe in `read-parity.mjs` runs **after** the diff, deliberately: it leaves
both backends' bucket exhausted, and probing first makes the differ's own
`/api/manual-apps` request answer 429 — a harness artefact indistinguishable
from a real parity failure. It asserts the two backends deny from the same
request number rather than a hard-coded 121, so the differ's own prior traffic
cannot silently bake itself into the expectation.
### `/api/apps/[id]/since-install` (+1 route, 17 total)

The first per-app route, the first with a path parameter, and the first whose
body is COMPUTED rather than read: it ports `diffSnapshots`, which is real
business logic rather than a read shim. That is why it was deferred out of
every previous batch.

**The gate is blind to the part that matters.** Every app the canned seed
creates ends up with a baseline and a latest snapshot whose types and
categories have identical membership — the arrays are reordered between them,
which is itself a useful signal (it proves the diff is identifier-keyed), but
nothing is ever added or removed. All ten seeded apps therefore answer
`"changes": []`, and this would have passed the read gate unchanged:

```rust
fn diff_snapshots(_: &[TypeSnapshot], _: &[TypeSnapshot]) -> Vec<ChangeEntry> {
    Vec::new()
}
```

None of the route's other branches — `baselineIsApprox`, `isSingleSnapshot`,
the null response, the empty-string `snapshot_json` trap — is reachable from
the seed either. Two things close that, and neither is optional:

- **`core/tests/diff_cases.rs`** replays
  `core/tests/fixtures/diff-cases.json`, whose expected values were produced
  by IMPORTING AND CALLING the real `diffSnapshots` from `lib/changelog.ts`
  (`just parity-diff-cases`). There is no transcription step, so there is no
  transcription risk. CI regenerates it and fails on drift, which is what
  catches a change to the Node function that nobody ported. The fixture was
  negative-tested against four plausible wrong ports — an empty-vec diff
  (25 of 31 cases diverge), a sorted-key map, first-value-wins on duplicates,
  and a defaulted `categories` — and catches all four.
- **`scripts/parity/since-install-fixture.mjs`** writes ten scenario apps
  into the Node data directory *before* read-parity checkpoints and copies it,
  so both backends compute from identical rows; the probe in
  `read-parity.mjs` then compares their RAW RESPONSE BYTES. That is stricter
  than the differ itself, which parses and re-serialises and so cannot see a
  whitespace or content-type difference. The probe also asserts the diff
  scenario produced at least four change entries — otherwise it would be
  passing vacuously.

**A harness bug this route exposed.** `read-parity.mjs` built its `--only`
regex by escaping `/` and nothing else. `/api/apps/[id]/since-install`
contains `[id]`, which a regex reads as a CHARACTER CLASS, so the pattern
matched `/api/apps/i/since-install` and never the literal route: the manifest
entry silently dropped out of the run and the gate reported PARITY OK having
never compared it. Every previous route was static, so nothing had tripped it.
Fixed by escaping the whole route.

**What a tidy port gets wrong here** — each of these is pinned by a test:

- `new Map(arr.map(t => [t.identifier, t]))` keeps the FIRST occurrence's
  position and the LAST occurrence's value. A `BTreeMap` sorts, a `HashMap`
  randomises, and a `Vec` scan emits the duplicate twice.
- Map keys use SameValueZero, so `1`, `"1"`, `null` and a MISSING field are
  four distinct keys — while `0`/`-0` and `1`/`1.0` are one. Both halves are
  easy to get wrong in opposite directions, and serde's `Option<Value>`
  default silently merges missing with null.
- `details` appears ONLY on added-type entries, and must be `[]` — not
  absent — when the new type has no categories. Blanket
  `skip_serializing_if` is the reflex that breaks it, and it would also
  delete `sinceInstall`, `baselineVersion` and `latestVersion` from the wire.
- The removed-CATEGORY description quotes the NEW type's title. It reads like
  a bug; it is the contract.
- Field order comes from the RETURN OBJECT LITERAL, not from the
  `SinceInstallDiff` interface — those disagree, and the interface is the one
  that looks authoritative.
- `isSingleSnapshot` compares `scraped_at`, not row identity, so two distinct
  rows sharing a timestamp collapse to "one snapshot" and diff to nothing.
- `snapshot_json IS NOT NULL` does NOT exclude the empty string; the JS
  truthiness check does, and only for the row already picked. Tidying that
  into the SQL changes which row wins and whether `baselineIsApprox` is set.

**The two backends do not run the same SQLite.** `rusqlite`'s bundled
amalgamation is 3.46.0; `better-sqlite3`'s is 3.53.2 — seven minor releases
apart, and `just parity-schema` already prints the TypeScript side's version
for this reason. That matters here because two behaviours this route leans on
are decided by the query planner rather than by any `ORDER BY`:
`buildSnapshot`'s type/category order (which becomes the stored
`snapshot_json` byte order) and the `LIMIT 1` tie-break when several
snapshots share a `scraped_at`. Both agree today on every query involved.
Neither is guaranteed by anything but that agreement, so "both sides run
SQLite" is not the argument it looks like — if a future SQLite changes an
index choice, the fix is an explicit `ORDER BY` on both sides in the same
commit, not a version bump on one.

### `/api/apps/[id]/history-stats` (+1 route, 18 total)

The quarterly aggregates behind the widgets under the per-app timeline.
Structurally the same route as `since-install` — same guard chain, same
`{appId, …}` envelope — over two new pure functions ported into
`core/src/server/trend.rs`.

Unlike `since-install`, the canned seed DOES give this one real numbers:
Instagram's history steps differ, so the stored `changes_summary` blobs carry
entries and `totalAdded` is 7 across three quarters. But only one arm:

- across all ten seeded apps **`totalRemoved` is 0**, so a port that dropped
  the removal arm entirely would pass;
- every seeded entry is an untagged privacy-label one, so the
  `category` filter is never exercised;
- `changes_detected` is only ever 0 or 1, so the strict `!== 1` is never
  distinguished from `> 0`.

`scripts/parity/since-install-fixture.mjs` therefore gained a
`pt-fixture-trend` app whose rows cover all three, and the probe asserts both
arms are non-zero before trusting the comparison (`+3/-3` today).

Three things the Node code does that read like bugs and are not:

- **The first bucket starts on 1 JANUARY 2021**, not on the documented floor
  of 1 February. `bucketByQuarter` floors the floor's month to its quarter
  (`Math.floor(1 / 3) === 0` → Q1), and Q1 begins in January. Anchoring on
  the floor date shifts every boundary by a month.
- **The two aggregates disagree about what a change is.**
  `computeQuarterlyChanges` tests `changes_detected !== 1` — strict, so a row
  storing 2 is skipped — while `computeCategoryTrend` never reads the column
  and counts that row's entries. Both behaviours are pinned.
- **A row outside every bucket is dropped, not clamped.**
  `Array.prototype.find` returns undefined for a snapshot older than Q1 2021
  or dated in the future, and it silently contributes nothing.

### `/api/apps/[id]/changelog` (+1 route, 19 total)

The per-app timeline, and the reason it lands before the two big routes:
both are this function wearing a hat. `/api/apps?id=X&changelog=true` is
literally `getChangelog(id, 50)`, and `/api/apps/[id]/detail`'s `changelog` /
`changelogHasMore` fields are `getChangelogPage` verbatim. Written once in
`core/src/server/changelog.rs`, it turns two large routes into assembly.

Four things decide the bytes:

- **Two keys are added by MUTATION** after the row object is built, so they
  serialise AFTER `app_version_updated_at` rather than wherever an interface
  would put them. `archive_bridge` comes from `bridgeOldestLiveRow`;
  `matches_live_sync` from the neighbour scan that runs after it. Verified on
  the wire against Node.
- **The merge is a STABLE sort with a partial tie-break.** Equal `scraped_at`
  puts a snapshot before a review; two rows of the same kind compare EQUAL and
  keep the order SQL returned them in. A comparator that invents a tiebreak
  (by id, say) reorders real pages — the fixture dates a review to the same
  instant as a snapshot so this is actually observed.
- **Both queries take the same `limit`**, and the merge is sliced afterwards.
  A page of 50 reads up to 50 snapshots AND 50 reviews and discards half.
- **`changes_summary` is parsed without a try/catch here**, unlike every other
  parse in that file — see the divergence below.

**What the manifest's single request misses.** It hits this route once, on
Instagram, with no query string, and on that app neither mutation fires and no
review row exists. So four things were uncompared: `archive_bridge` — which is
where `diffSnapshots` runs on this path — `matches_live_sync`, the
`kind: "review"` row shape, and both 400 branches. `archive_bridge` turned out
to be reachable already, by accident, through `pt-fixture-wayback` and
`pt-fixture-approx` written for since-install; the rest needed a new
`pt-fixture-timeline` app carrying a wayback row byte-identical to its live
neighbour plus two review rows (one of them a legacy NULL
`covered_snapshot_ids`). The probe compares all of it.

The two validation branches earn their probe lines because they are checked by
DIFFERENT functions and the asymmetry is invisible in the source:

| query | parsed with | result |
|---|---|---|
| `?before=` (empty) | `Number("")` → 0 | **200** — valid, means "before the epoch" |
| `?before=abc` | `Number` → NaN | 400 |
| `?limit=` (empty) | `parseInt("")` → NaN | 400 |
| `?limit=25abc` | `parseInt` prefix-tolerant | **200** — reads as 25 |

**A second knowing divergence.** `getChangelog`'s `JSON.parse` of
`changes_summary` has no try/catch, so a malformed blob throws out of the route
and Node answers 500 with a ZERO-BYTE body — not even the `{"error":…}`
envelope. The Rust port returns the standard envelope: same status, different
body. Consistent with `diff.rs` and `trend.rs`, and unreachable from data this
application writes.

### `/api/apps` (+1 route, 20 total)

One path, five responses, dispatched on the query string in a fixed order of
early returns: `?id=X&changelog=true` → `?id=X` → `?view=grouped` →
`?limit=` → the bare array. axum routes by path, so every branch had to exist
before any could ship — which is why the changelog kernel (#234) landed
first: `?id&changelog=true` is `getChangelog(id, 50)`.

**Five of the eight responses had no manifest entry.** The coverage gate
counts routes, and two entries already made `/api/apps` look covered. The
`?id`, `?changelog=true` and `?view=grouped` shapes and both error branches
now have entries (`allowErrorStatus` for the 404/400, which the differ
otherwise reads as a broken entry).

**What decides the bytes, per branch:**

- *Bare / paginated* — `SELECT a.*` expands to the table's RUNTIME column
  order, which differs between a fresh install and an upgraded one
  (`privacyPolicyUrl` is ALTER-appended, so it comes LAST on this database).
  `row_to_json` reads the order off the statement; a struct would hard-code
  one layout. `getAllApps` orders by name with no tiebreak, `getAppsPage`
  adds `, id ASC` — deliberately different, and left that way.
- *`?id`* — `getAppWithPrivacy` plus the policy-analysis hydration, the
  densest present-null-vs-absent surface in the API: twelve of twenty keys
  are `?? undefined` (absent when null), two are present-null, one is the raw
  column. The dead `privacy_categories.purpose_id` column still ships. Built
  as ordered maps, not structs. Verified byte-identical on all 22 apps,
  including the ten real policy rows.
- *`?view=grouped`* — three ordering mechanisms on one un-ORDER-BY'd join
  (insertion-ordered object keys, a `Set`, two stable sorts that return 0 on
  ties), all resolving to planner row order. Verified byte-identical.
- *`&meta=grid`* — four maps keyed by app id. **JavaScript enumerates
  array-index keys first, ascending, then the rest by insertion** — so the
  seed's numeric ids sort while `pt-fixture-*` ids trail. `js_keyed_object`
  reproduces that; an insertion-ordered map fails on every mixed page. And
  `computeProfileMismatch` ties break on `localeCompare`: ICU puts
  `CONTACT_INFO` before `CONTACTS`, byte order the reverse. A strip-the-
  underscore collation matches Node on all 196 ordered pairs of the real
  keys; byte order fails two.

**Two more JavaScript semantics, now in `core/src/jsstr.rs`:** `\s`/`trim`
strip U+FEFF and NOT U+0085 — the exact inverse of `char::is_whitespace` on
those two — and `.length`/`.slice` count UTF-16 units.

**The seed leaves half of `meta=grid` empty.** No stored profile, no user
verdicts → `profileBadges` and `userVerdicts` are `{}` and the profile engine
never runs. The fixture now stores a profile with `CONTACT_INFO` and
`CONTACTS` at equal tiers (so the tie-break is observed) plus a user verdict,
and `probeGridMeta` refuses a run where either map is empty or no badge has
mismatches.

### `/api/apps/[id]/detail` (+1 route, 21 total)

Everything the app-detail page renders, in one payload of fourteen keys. It
is the assembly job the previous batches were building towards: the app row
is `getAppWithPrivacy`, the timeline is `getChangelogPage`, the two profiles
are the parsers behind `/api/privacy-profile` and `/api/accessibility-profile`,
the import item is `hydrateImportItem` from `/api/imports`. Three reads are
new: `getUnacknowledgedChanges`, `getRecentPolicyChange` and
`getAppImportProvenance`.

Two things shape it, and neither is a query:

- **Every read is wrapped in `safe()`** with its own fallback. A failure in
  one degrades that field to the page's old default and nothing else, so a
  schema drift in one table cannot blank the page. The single exception is
  the app row, whose failure IS the 404. A port that propagates any other
  read's error turns a partial answer into a 500.
- **`ID_RE = /^\d{1,20}$/` runs BEFORE the existence check.** A non-numeric
  id is a 400, not a 404 — which also means the `pt-fixture-*` apps can never
  reach this route. Its fixture coverage hangs off Instagram instead.

Smaller coercions that each earned a comment: `policyDiffAlertDays` is
`parseInt` guarded by `>= 0` (0 is meaningful — it disables the banner);
the two boolean settings are `!== "false"`, so only that literal is false;
`audience` is `getSetting(...) || "self"` with `||`, so a stored empty
string is `"self"`; `childAgeBand` is present-null unless it is one of the
five band keys.

**What the seed leaves null.** `importProvenance` (the seed writes no
import items), `a11yProfile` (no accessibility profile stored) and
`childAgeBand` (no band stored). All three were therefore compared as
`null` against `null`. The fixture now writes an import row for Instagram
and both settings, and `probeDetail` refuses a run where any of the three is
still null.

**One knowing divergence.** A `changes_summary` that is valid JSON but not
an array (`{}`) makes `computeCategoryTrend` throw and the route answer 500 —
its try/catch wraps only the `JSON.parse`, while the `for…of` that follows
sits outside it. Verified against the running Node server. `computeQuarterlyChanges`
keeps its `.filter` inside the try and merely skips the row, so the two
functions do not agree with each other either. The Rust port treats a
non-array as no entries and answers 200. Same trade as in `diff.rs`:
reproducing an uncaught crash means reproducing Next's error page, and the
alternative to refusing is inventing an answer. Deliberately NOT in the parity
fixture — a row for it would fail the gate by design rather than catch a
regression.

**The differ cannot see the bucket boundaries.** Every `startMs`/`endMs` here
is above 1.4e12, which `normalize()` masks as `~epoch`. The `label` strings
are compared, so a whole-quarter slip is caught; a sub-quarter one is not.
`trend.rs` therefore unit-tests the date arithmetic against a FIXED clock,
with the `Date.UTC` expectations read out of `node -e` rather than computed by
the same algorithm under test — a self-derived constant would agree with any
bug it shared.

**Two knowing divergences**, both verified against the real Node function and
both unreachable from data this application writes: object/array identifiers
(JavaScript compares them by reference, which nothing survives
deserialisation with) and integers beyond 2^53 inside a title (JavaScript
loses precision; `serde_json` does not). A structurally malformed blob — a
type with no `categories` — throws out of `diffSnapshots` in Node and 500s;
here it fails to deserialise and the route answers `"sinceInstall": null`.
Different, but both refuse: the alternative was to default the field and
invent an answer.

### The settings reads (+4 routes, 25 total)

`/api/settings`, `/api/settings/desktop`, `/api/dashboard/layout` and
`/api/feature-flags`. Three are `app_settings` reads wearing a coercion
each; the fourth runs the focus resolver. The differ compares all four on
ONE database state, and the canned seed leaves that state nearly empty for
them — no API key, no country, no webhook, no `desktop_*` rows, no stored
layout, no overrides, a `self`/`monitor` focus. It was comparing `""`
against `""`, defaults against defaults, and one resolver context out of
the hundreds a database can hold. Three things close that.

**`core/scripts/extract-settings-cases.mjs`** (`just parity-settings-cases`)
imports and RUNS the Node code and writes two files:

- `core/src/server/flag_rules.json` — the six rule tables (`HARD_DEFAULTS`,
  `AUDIENCE_RULES`, `GOAL_RULES`, `ACCESSIBILITY_RULES`, `FLAG_DEPENDENCIES`,
  `WIRED_FLAGS`) lifted from `lib/feature-flag-rules.ts` and
  `lib/feature-flag-wired.ts`. The server `include_str!`s it, so 221 defaults
  and seventy dependency edges are never transcribed — the one wrong entry a
  transcription produces is the one no seeded focus ever selects.
- `core/tests/fixtures/settings-cases.json` — expected outputs of
  `maskWebhookUrl` (module-local to the route, so its source text is lifted
  into a scratch module and executed), `reconcileLayout` +
  `matchDashboardPreset` + the five `DASHBOARD_PRESETS`, and the resolver
  over 39 contexts: every audience × nine goal sets, the desktop runtime, and
  override cases for the dependency collapse, the escape hatch, the kill
  switch, a garbage value and a garbage audience. One reference context
  carries the full 221-row body; the rest record only the rows that differ
  from it, since the sort order is value-independent.
  `core/tests/settings_cases.rs` replays it byte for byte. CI regenerates
  both files and fails on drift, as it does for `diff-cases.json`.

**The fixture** (`SETTINGS_FIXTURE`, `FLAG_OVERRIDE_FIXTURE` in
`since-install-fixture.mjs`) writes a stored API key, an explicit country, a
Slack webhook, six `desktop_*` rows each chosen to trip a different coercion,
a layout blob holding every kind of junk `reconcileLayout` filters, a
`guardian` + monitor + accessibility focus, and four overrides — a parent
forced off, its child forced on, a quarantined one, an unknown key.
`probeSettingsReads` refuses a run where Node's answers show any of it did
not land (a masked secret, a coerced desktop value, a reconciled layout that
matches no preset, an override that collapsed its dependents while its
child escaped, 221 ICU-sorted rows).

**`probeDesktopRuntimeMark`** — `GET /api/settings/desktop` WRITES.
`markDesktopRuntimeIfTrusted` upserts `runtime_environment = "desktop"` when
the process env or the `x-privacytracker-runtime` header says so, and the
resolver reads that row back to force `flag.desktop.app_section` on. The
first write-on-GET in this server, ported as it is: a Rust server that never
wrote it would resolve that flag differently from Node on every desktop
boot. The differ never sends the header, so the probe sends it to both
sides after the diff (it changes both databases for good), then checks the
flag flipped from off to on and the bodies still match.

What the port had to get right, none of it visible in the response shape:

- **Resolver order.** Goal rules apply in the fixed order monitor, cleanup,
  minimal — not storage order. The runtime rule (step 5) runs before the
  override (step 7), so an override off beats the forced on. The dependency
  parent is resolved through the whole chain, its own override included. The
  kill switch short-circuits BEFORE the override, so its own row reports
  `currentValue: "on"` while `override: "off"`; and `focusValue` copies
  `killSwitchOff` unchanged, so stripping that override does not turn the
  engine back on. A garbage stored audience makes `AUDIENCE_RULES[x][key]`
  throw and the route answers 500 `{error:"Failed to list flags"}` — unless
  the garbage names an `Object.prototype` property, in which case the lookup
  finds a function and no rule applies. `override_value` is an unchecked
  cast: `"banana"` is echoed and still fails the parent's `!== "on"`.
- **`reconcileLayout`.** A canonical card missing from the stored order is
  slotted after its nearest preceding canonical neighbour that is already
  placed — and with none, `unshift`ed to the FRONT. So `order: ["hero"]`
  comes back `task_list`-first with hero sixth. `[]` is `typeof "object"`
  and truthy, so it is NOT the early-return default; it reconciles to the
  same answer by the long road.
- **Desktop coercions.** Booleans are `=== "true"` (so `TRUE` is false);
  the idle timeout is `parseInt` gated to `0..=1440`; the theme is a
  case-sensitive allowlist; zoom is `parseFloat` gated to `0.5..=3.0` and
  serialised as a JavaScript number (`1`, not `1.0`). `js_parse_float` joins
  `jsnum.rs` for this — prefix-tolerant like `parseInt`, but `"Infinity"` is
  the one word it takes and `"1e400"` overflows to it, which is why the
  guard is `isFinite`. `js_parse_int` was also corrected to skip
  JavaScript's whitespace (U+FEFF yes, U+0085 no) rather than Rust's.
- **`maskWebhookUrl`.** Origin lowercased, path case kept; default ports
  dropped even when spelled `:0443`; credentials, query and hash blanked;
  `.`/`..`/`%2e` segments resolved; backslashes are slashes; non-special
  schemes have the origin `"null"` (so `mailto:` masks to `null/***`); a
  refused URL is the word `configured`.

**Collation.** `/api/feature-flags` sorts 221 keys with `localeCompare`, and
the strip-underscore comparator the profile matcher used was right on the
fourteen category keys by coincidence — it has no answer for `.` against
`_`, or digits against letters. Replaced by `jsstr::js_locale_compare`, an
ICU-root model for ASCII: primary weights from a 94-character table that is
Node's own `localeCompare` order (punctuation, symbols, digits, then
case-folded letters), then lowercase-before-uppercase on a primary tie.
Pinned against the table, the sorted 221 keys, the 18 surfaces and the
fourteen category keys, all from Node. Not general: no accents, no
ignorable controls, no numeric collation — and nothing it sorts contains
any of those.

**The URL parser is a WHATWG subset, not the `url` crate**, for the reason
given under the forwarded-host section. On write, `validateExternalUrl`
stores `new URL(raw).toString()` — an http(s) URL already canonical — so
re-parsing that is exact, and the subset is chosen to also cover what a
hand-edited row plausibly holds. Not reproduced, each unreachable from an
app-written row and each changing only the host's spelling inside an
otherwise identical mask: IDNA, IPv4 shorthand, IPv6 compression,
percent-escapes in a host, `file:` hosts beyond `file:///`.

### The deployment reads (+5 routes, 30 total)

`/api/ready`, `/api/deployment/diagnostics`, `/api/diagnostics/database`,
`/api/diagnostics/disk` and `/api/diagnostics/health`. Five of the eight
routes under the diagnostics umbrella, chosen because they describe the
DEPLOYMENT — the database file, its directory and pragmas, the process env,
the request's forwarded headers, the host OS — and are therefore portable
exactly. The other three (`/api/diagnostics/runtime`,
`/api/diagnostics/errors`, `/api/desktop/diagnostics`) describe the Node
PROCESS: V8 heap statistics, an event-loop-lag histogram, a `console.error`
interceptor, the db-worker thread's timings. Those cannot be ported; they
are re-specified instead. `/api/diagnostics/runtime` (and the block
`/api/desktop/diagnostics` embeds) now emits a backend-tagged envelope —
`lib/runtime-diagnostics-envelope.ts`, validated by
`scripts/parity/diagnostics-envelope.mjs` — whose backend-specific sections
carry a `kind` (`heap.kind: "v8" | "rust-allocator"`, `scheduler.kind:
"event-loop" | "tokio"`) and whose unmeasurable sections are `null`. The
Rust port fills `sqlite.memory` / `sqlite.cache` / `sqlite.lockWait` from
`sqlite3_db_status` and its connection mutex, which Node cannot; the
harness holds each side to the contract (`validate`) rather than
byte-comparing a V8 heap against an allocator.

**What `next start` does to the headers.** `inferDeploymentNetwork` read
`proxyDetected: true`, `forwardedHost` equal to the Host header and
`protocol: "http"` on every direct request to the Node server, with no
proxy anywhere. Next's `base-server.js` fills `x-forwarded-host`, `-port`,
`-proto` and `-for` when they are absent (never `x-real-ip`), before any
route handler runs — so Node's "Proxy detection" check can never say "no
proxy headers seen" under `next start`. A Rust server that left the headers
alone would answer `/api/ready` differently on every request, for reasons
that are Next's, not the app's. `forwarded.rs` reproduces the synthesis as
the outermost layer. It is safe ahead of the gate: every synthesised value
equals what the gate would derive anyway, and a caller-supplied header is
kept exactly as `??=` keeps it — verified on the wire with a forged
`X-Forwarded-Host`.

**Two fields name the process, not the deployment.** `app.node` is
`process.version`; this server answers `pt-core <crate version>` and the
manifest masks the field — the only field it masks for that reason.
`app.nodeEnv` is `NODE_ENV ?? "development"`, which `next start` sets to
`production` inside its own process; here the env var wins when set, else
the build profile decides, and the harness passes `NODE_ENV=production`.
Everything else agrees, including the two that are easy to skip:
`app.name`/`version` come from the repo's `package.json`, embedded at build
time (the crate says `0.0.0`); `app.arch` is spelled Node's way (`arm64`,
`x64`), and `app.platform` is `uname`'s sysname and release.

**`pt-core serve` now takes its data directory from the environment**,
exactly as `lib/db.ts` does — `PRIVACYTRACKER_DATA_DIR`, else `<cwd>/data`
— because `database.dataDirSource` reports which, and the old positional
path had no honest value for it. The harness hands the Rust side its copy
through the env, the way the Tauri shell hands Node its directory. The
Rust server inherits every other `PRIVACYTRACKER_*` value from the harness
process, so run the harness under the Node server's env
(`PRIVACYTRACKER_BIND_HOST` above all) or `security.bindAmbiguous` differs
for reasons of env, not port; `probeDiagnosticsReads` names the field.

**What the copy cannot make equal.** Page counts, WAL bytes and file sizes
differ between a live database and its checkpointed copy, which is why the
manifest compares the three `/api/diagnostics/*` reads through
`blankNumbers`. The probe holds the stable parts to equality instead: the
connection pragmas (`journal_mode`, `busy_timeout`, `foreign_keys`,
`wal_autocheckpoint`, `page_size` — the ones `open_and_migrate` sets to
match `db.ts`), the backup fixture's count and bytes, and non-zero volume
stats on both sides. `/api/diagnostics/health` is a passthrough of the
stored `health_check_last_result` blob, which does not exist until sixty
seconds after boot; the harness runs one on demand before the copy so both
sides read a real result rather than `{neverRun:true}` against
`{neverRun:true}`.

Smaller things each earned a test: `redactHomeDir` maps only `$HOME` and
`$HOME/…` (a sibling sharing the prefix is untouched); `fs.accessSync`'s
failure message is libuv's (`EACCES: permission denied, access '/p'`), not
std's; `PRAGMA busy_timeout` answers in a column named `timeout`, which is
why Node falls back to the first column; `Date.prototype.toISOString` is
twenty lines of civil-date arithmetic (`jsdate.rs`) pinned to `node -e`
output including a leap day and a negative epoch; and the `libc` crate is
now a direct dependency for `statfs`, `access` and `uname` — it was already
in the lockfile under rusqlite and tokio.

### The runtime envelope (+3 routes, 33 total)

`/api/diagnostics/runtime`, `/api/desktop/diagnostics` and
`/api/diagnostics/errors` — the three that could not be ported, because
they describe the serving process, and were re-specified instead (PR #241
moved Node to a backend-tagged envelope; this is the Rust side of it).
Where the deployment reads were held to Node byte for byte, these are held
to a CONTRACT — `scripts/parity/diagnostics-envelope.mjs`, run on each
side by the manifest's `validate` hook with `skipCrossCompare` on — and
`probeRuntimeEnvelope` in `read-parity.mjs` then holds the Rust body to
what it must actually contain, since a body that reported every section
as `null` would satisfy the contract too.

**What the Rust core measures, and from where.**

- `process` — `getrusage(RUSAGE_SELF)`, the same syscall libuv wraps for
  `process.resourceUsage()`, so CPU time, page faults and context switches
  share a source with Node's; plus what Node cannot report: virtual size,
  thread count and open descriptors from `proc_pidinfo` (macOS) or `/proc`
  (Linux). `ru_maxrss` is bytes on macOS and kilobytes on Linux; libuv
  normalises, so does `sysproc.rs`.
- `heap` — `kind: "rust-allocator"`: a counting `#[global_allocator]`
  (`core/src/alloc.rs`, two relaxed atomics per allocation) reporting live
  bytes, the high-water mark and live allocation count. The honest analogue
  of V8's `used_heap_size`; there is no limit to be a fraction of.
- `sqlite` — the three sections Node leaves `null`: `memory` from
  `sqlite3_memory_used` / `_highwater` and `sqlite3_db_status`
  (`CACHE_USED`, `SCHEMA_USED`, `STMT_USED`); `cache` hits / misses /
  writes / spills per connection since open; `lockWait`, the time each
  handler waits to acquire the single connection's mutex. Every handler now
  takes the connection through `AppState::db()`, which times the wait —
  with one connection behind one mutex, that is this server's contention
  signal.
- `scheduler` — `kind: "tokio"`: worker, alive-task and global-queue
  counts from the runtime's stable metrics, and `lag` from a task that
  sleeps 20 ms in a loop and records **the interval it actually took** —
  which is what `monitorEventLoopDelay` records. Measured on the installed
  Node, an idle loop at `resolution: 20` reports min 20.02 ms and p50
  21.04 ms: the raw delta between timer fires, resolution included.
  Recording the overshoot instead — the first cut here — read ~20 ms
  "better" than Node for the same stall, and since the two backends share
  the severity thresholds (100 ms / 1000 ms), warn and danger would have
  fired ~20 ms late.
- `http` — one timing layer inside the gate (a request the gate refuses
  never reaches Node's ring either), with Node's sampling rule: every slow
  (≥ 100 ms) or erroring (≥ 400) response, one in five of the rest — and
  the 1-in-5 counter advances only on the rest, because `||` short-circuits
  past `++sampleCounter` in Node. The label is always the matched route
  PATTERN: an unmatched path is not recorded at all, which is both what
  Node does (its 404s come from Next, not from a wrapped handler) and the
  safe choice, since the only label available there is a client-chosen
  string that would end up in the GitHub-issue blob. `inFlight` counts the
  request reading it, decremented by a drop guard so a panicking or
  disconnected handler cannot inflate it.
- `slowQueries` — SQLite's own `sqlite3_profile` callback, installed on the
  connection at open, so every statement is timed with no call-site
  instrumentation (Node wraps `db.prepare()`). Three fields say something
  different and each is unavoidable: `method` is always `"statement"` (the
  hook sees statements, not the `all`/`get`/`run`/`iterate` call Node
  names), `paramCount` counts `?` placeholders rather than bound arguments,
  and `durationMs` carries whole milliseconds because the callback's
  nanosecond argument is documented as having only millisecond resolution,
  where Node's `performance.now()` gives two decimals.
- `dbWorker` and `scrapeActivity` are `null`: no worker thread, no scraper
  until Phase 3. `rateLimiter` counts the limiter's tracked keys and its
  denials since start.

The histograms (`histogram.rs`) are log-linear over microseconds — ~1.6 %
precision at every magnitude for 30 KB, no dependency — and accumulate
since start or reset, as Node's `perf_hooks` histogram does; percentiles
report the bucket's upper bound as HDR's `valueAtPercentile` does. An empty
histogram reports `null` mean/stddev, which C1 made explicit in the
contract because Node's was already emitting them.

`/api/desktop/diagnostics` reproduces Node's payload key for key
(`generated_at`, `runtime`, `host`, `runtime_diagnostics` with the rings
capped at 20, `scheduler`, `bulk_runners`, `db`); the probe requires its
database-derived parts — app and snapshot counts, the scheduler and runner
flags — to EQUAL Node's, since both servers read the same copy.
`/api/diagnostics/errors` is a ring the server's own warnings and errors
go through (`diag::log_warn` / `log_error`, in front of stderr), with
Node's `?limit` semantics: `parseInt` prefix, then
`Math.max(1, Math.min(200, …))`. Its sources are the ones whose Node
counterparts are `console.warn`/`console.error` calls the interceptor
captures: the migration warnings in `db.rs`, the per-helper failures in
`grid_meta.rs` and `routes_detail.rs`, the response-serialisation failure
in `json.rs`, and the rate limiter's DENY — throttled, as Node's is, to
one warning per key per second. That last one is also what lets the parity
harness check the `?limit` clamp against a ring that has something in it:
`probeErrorRing` runs after the rate-limiter probe on purpose.

**The lock is held for the database and nothing else.** `runtime_diag::build`
takes the already-read `sqlite` section rather than the connection, so the
handlers acquire the mutex for the counters and release it before the
syscalls, histogram walks and serialisation. Holding it across all of that
would serialise every other handler behind a 2-second diagnostics poll —
and inflate the very `lockWait` number the section reports.

Not ported, because they are write routes: the `DELETE` that clears the
rings and the `POST` that toggles profiling. The clear helpers exist and
are tested; the routes wait for the writers phase.

### The trailing-slash redirect (proxy.ts step 0.5)

The gate ports `proxy.ts`'s steps 0, 1 and 2 (host allowlist, fail-closed
auth, CSRF). Step **0.5** — the canonical trailing-slash 308 — was missing
from the first cut, so `GET /api/health/` was a 308 in Node and, here, a 401
for every path (the un-routed path fell through to the auth gate; a public
path with auth off would have 404ed instead). It applies to every path,
per-app routes included.

`skipTrailingSlashRedirect: true` in `next.config.js` is why Node owns this
redirect at all: Next's own version is emitted in the router before
middleware runs and returns `resHeaders: null`, so `GET /dashboard/` answered
308 with **zero** security headers while `GET /dashboard` carried six. Do not
touch that flag — see AGENTS.md → "Static routes + hash-based CSP".

Four details, all verified against a running Node server rather than read off
the source:

- **The Location is RELATIVE.** proxy.ts builds an absolute `URL`, but Next
  serialises a same-origin middleware redirect back to a path, so the wire
  carries `location: /api/health`. An absolute Location here would diverge.
- **The query survives and an empty one is dropped** — `/a/?x=1` → `/a?x=1`,
  `/a/?` → `/a`. Both fall out of `URL` serialisation, not the regex.
- **`Cache-Control` is not uniform across the gate's branches**, and the
  asymmetry is observable, so the port reproduces it rather than tidying it:

  | branch | status | `Cache-Control` |
  | --- | --- | --- |
  | Host not allowed | 400 | *(absent)* |
  | Trailing slash | 308 | `no-store` |
  | Auth failure | 401 | `no-store` |
  | CSRF | 403 | *(absent)* |
  | pass-through | 200 | `no-store` |

  The 401 was the one divergence: this server sent it without the header.

- **Repeated slashes are the one deliberate difference.** Next normalises
  `/api/health//` in its router before middleware, so Node answers a
  header-less 308 to `/api/health/` and needs a second hop; the Rust gate
  strips the whole run at once. Both land on the same canonical path — only
  the hop count differs, and the header-less hop is the quirk
  `skipTrailingSlashRedirect` exists to avoid, not a contract to copy.

Not reproduced, deliberately: Next also emits `Refresh: 0;url=<loc>` and
echoes the location in the redirect body. Both are Next redirect-serialisation
trivia, and this server does not emit Next's security-header block either.

**The gate — `probeTrailingSlash` in `scripts/parity/read-parity.mjs`.** The
differ cannot see any of this: `parity-diff.mjs` only ever requests the
canonical paths in its manifest, so a backend that 404ed every `…/` form
would pass every check. The probe requests four paths on **both** backends
with no token and requires the same status, Location and Cache-Control —
including an auth-gated path, which pins step 0.5 above step 1, and a
canonical path as a control. Negative-tested: disabling step 0.5 makes it
fail on three of the four.

### `X-Forwarded-Host` and the CSRF origin check (proxy.ts steps 0 and 2)

Found while porting step 0.5, fixed in the same change. The gate's
`effective_host` honoured `X-Forwarded-Host` **unconditionally**. Node only
believes it behind `PRIVACYTRACKER_TRUST_PROXY` (`trustProxy()` in
`lib/request-origin.cjs`); with the flag off — the default — the header is
attacker-controlled. Verified against a running Node server with the flag
unset:

| request | Node | Rust before |
| --- | --- | --- |
| real `Host` + `X-Forwarded-Host: evil.example` → `/api/health` | 200 | 400 |
| `Host: evil.example` + `X-Forwarded-Host: 127.0.0.1:<port>` | 400 | **200** |

The second row is a host-allowlist bypass, and because the same helper backs
the CSRF same-origin comparison, a forged forwarded host paired with a
matching `Origin` passed step 2 as well.

`trust.rs` now carries a port of the whole of `request-origin.cjs` —
`trust_proxy`, `effective_host`, `request_origin`, `is_same_origin_request` —
and the gate and the rate limiter share the one `trust_proxy`. The origin
comparison is a real port rather than the authority-string compare it
replaces, which had its own holes: it ignored the scheme entirely and
tolerated a trailing slash. Node's rule is `parsed.origin === expected &&
origin === parsed.origin`, i.e. the `Origin` header must both match and
already be in canonical serialised form. All verified as 403s on Node: an
`https://` Origin on the http server, a trailing slash, an uppercase scheme,
`null`, no Origin. And the expected side is normalised, so `Host:
LOCALHOST:3011` still matches `Origin: http://localhost:3011` (reaches the
route on both).

Two details that would be easy to get wrong:

- **`X-Forwarded-Proto` is compared case-sensitively.** Node builds
  `${forwarded}:` and tests it against `"http:"` / `"https:"`, so a trusted
  proxy sending `HTTPS` yields no origin at all — and therefore no
  same-origin match — rather than an https one.
- **The origin serialiser is hand-rolled**, because the `url` crate is not in
  the lockfile and brings IDNA/ICU with it. It reproduces `new URL(...).origin`
  for what a `Host` or `Origin` header carries in practice (lowercased scheme
  and host, default port dropped, `:0080` → 80, bracketed IPv6 kept, query and
  fragment tolerated, path / userinfo / bad port / whitespace rejected), with
  expected values generated by calling the real `URL` class. Not covered —
  IPv4 shorthand like `127.1`, IDNA, percent-decoding, IPv6 compression — is
  rejected by step 0's `normalize_host` allowlist on both backends before the
  origin check runs.

Also corrected on the way: `env_flag` (`PRIVACYTRACKER_NETWORK_EXPOSED` and
now the proxy flag) special-cased `TRUE` and missed `Yes` / `ON`; Node's
`envFlag` and `trustProxy` are both trimmed and case-insensitive.

**The gate — `probeForwardedHost` in `read-parity.mjs`.** Six cases over
plain `node:http` (undici's `fetch` silently drops a caller-set `Host`, so
the spoof case cannot be expressed through it). Each carries the answer Node
gave and holds BOTH backends to it — two backends agreeing on the wrong
answer is not parity. The CSRF cases pin only the gate's decision, since past
the gate Node's login route and the Rust core's missing route legitimately
answer differently. Unit tests in `trust.rs` take a `trust` flag directly
and cover both settings; the one gate-level test that needs the env unset
holds a shared lock with the rate limiter's env-mutating tests.

### Fleet statistics and analysis (+9 routes, 42 total)

Ports `/api/stats`, `/api/stats/{matrix,radar,timeline}`, `/api/triage`,
`/api/review-queue`, `/api/age-rating/summary`,
`/api/privacy-profile/mismatches` and `/api/changelog`. All nine are
registered with every database-backed response branch. The Node server,
Docker and Tauri still do not import, compile or run the Rust core.

`/api/compare` and `/api/related-apps` were deferred in this batch: compare's `url:`
slots scrape live HTML, and related-apps' default mode fetches Apple feeds.
They require outbound HTTP and preview parsing even though their HTTP verb is
GET; the final Phase 2 batch below adds those dependencies. Registering only their library/cached branches would claim incomplete
routes as finished. This batch brought coverage to 42 of the Phase 2 inventory's 65
compared reads; the user-content batch below brings this branch to 54.

**Shared code.** `scope.rs` mirrors request-only device selection: unknown
ids fall back to the full fleet, overlapping links never duplicate an app,
and `unattached` means no junction rows. The stored UI preference never
changes a bare API response. Summary counts, triage lists and mismatch
queries apply scope in SQL; the review queue's raw verdict union uses the
same scoped id set. The existing app-list and profile-footprint helpers
now also support these fleet/scoped callers without changing their old
unscoped behavior.

**Details that carry the bytes:**

- Matrix cells use the worst severity per category; canonical categories
  precede unknown categories sorted by UTF-16 units. Nested objects keyed
  by app/category ids enumerate array-index keys first. Category counts
  still include unknown severity rows where the Node query does.
- Radar keeps the last duplicate lens, emits `unclear` as `1.5`, distinguishes
  corrupt/absent summaries, and omits null status. An unknown truthy rating
  omits `score`, because Node's lookup produces `undefined`. The old manifest
  transform that discarded radar content is removed: Node already added the
  deterministic `lastSynced DESC, id ASC` selection tie-break.
- Timeline uses UTC days, Monday weeks and calendar months, includes both
  endpoint timestamps, fills empty buckets and counts syncs/reviews
  separately. Accessibility adds/removals have separate counters;
  accessibility modifications and Wayback attempts do not contribute to
  `total`. Automatic boundaries remain 14 and 120 days. Invalid Dates skip
  the fill loop, and finite query integers beyond i64 remain accepted.
- Triage's `changesThisWeek` counts entries in only its eight newest
  snapshots, not the whole week's history. Reviewable rows retain
  `changeCount` and `acknowledgedAt`; risk/stale rows strip them. Top change
  prefers the first addition, then removal. Its failure payload has a
  different literal key order from its normal empty-database response.
- The review queue keeps `reviewableCount` (raw union, including legacy
  orphan verdicts) distinct from `rowCount` (tracked rows). Each read fails
  independently. Candidate badges require an actual footprint; modes are
  normalized; advisory verdicts stay separate from the user's verdict.
  Notes include private visibility because this is a local review, not an
  export. Like Node, a full read sweeps expired soft-deleted annotations
  transactionally; `?count=1` returns before that write.
- Age parsing prefers the first digits-before-plus match before trying
  Brazil's plus-before-digits form; unknown and out-of-range ratings never
  count as violations. The band is validated without trimming.
- Universal changelog filters individual entries before slicing, defaults
  missing categories to privacy-label, keeps original entry indices in ids,
  and reports `total` only within the candidate cap (`limit * 8`, max 4000).
  Its `limit=0` clamps to one. Unknown filters are ignored; query integers
  accept prefixes; repeated query keys take the first value.

**Gates.** `stats-fixture.mjs` adds three apps, overlapping devices, novel
accessibility metadata, mixed change categories, leap-day timestamps,
recommendations, shortlist candidates and active/soft-deleted notes before
copying the Node database. Its probes compare raw response bytes, refuse
vacuous results, and exhaust each of the five new rate-limited routes only
AFTER the body comparisons. The manifest covers device subsets, empty/stale
scope, count-only, radar input variants, timeline validation and changelog
pagination/filter branches.

`node --conditions=react-server --import tsx core/scripts/extract-stats-cases.mjs`
executes the real Node readers on 75 fixed-clock database scenarios and 13
age coercions, producing `core/tests/fixtures/stats-cases.json` and the wire
metadata in `stats_meta.json`. Rust replays identical SQL and compares the
serialized bytes and annotation sweep effects. CI regenerates both files
before crate tests, detecting Node drift even though live read parity is
still a local gate. Invalid JSON/error paths and independent read failures
are included. No new dependency or schema migration is introduced.

Two pre-existing gate defects surfaced during verification: the feature-flag
probe's stale 221-row expectation is now 222, and three diagnostics tests
that clear the same process-global HTTP ring share a test-only mutex. The
mutex does not affect runtime behavior.

SQL without an explicit tie-break retains Node's planner-decided order;
these backends still bundle different SQLite versions. The parity fixture
checks current agreement rather than inventing Rust-only ordering. Valid
but malformed stored JSON shapes that app writers never produce are not a
general JavaScript emulation contract (for example a JSON string used as a
universal-changelog entry array); invalid JSON and common null/object cases
are pinned by the oracle.


### Device reads (+5 routes, 47 total)

`GET /api/devices`, `/api/devices/[id]`, `/api/devices/[id]/bundles`,
`/api/devices/[id]/tracked-apps` and `/api/devices/for-app/[appId]` now read
stored device metadata, ownership, import history and app links. All five
remain inside the existing host/auth gate; none adds a per-route rate limit
because none of the Node GETs has one. The device mutation handlers and
hardware access remain for later phases. No shipping path, dependency,
Node server logic or schema changes in this batch.

**The wire contract follows the route, not the helper that sounds closest.**
`/api/devices?ecid=…` trims JavaScript whitespace and does an exact SQL match.
It does not use `getDeviceByEcid`'s case/prefix normalisation from the device
action gate. A nonempty ECID chooses `{ device, importHistory }`; no match
returns both keys as null. Missing, empty or whitespace-only ECIDs choose
`{ devices }`, with `appCount` appended to each device. Repeated query keys
use the first value, even when that value is empty.

`rowToDevice`'s object literal determines the field order. Nullable metadata
stays explicitly null; `ownerLabel` is JS-trimmed, invalid stored audiences
read as null, and only a numeric `is_unknown_placeholder === 1` is true.
`permissionAcknowledgedAt` uses nullish fallback, preserving zero. Reads
never infer an owner or stamp an acknowledgement. Device lists sort by
`last_synced_at DESC, name` and include placeholders and zero-app devices.

**ID handling and failures are intentionally asymmetric.** Detail uses its
path ID verbatim and returns `404 {"error":"device not found"}` for a miss;
its error branch is `500 {"error":"internal"}`. Bundles and tracked-apps
trim the ID, return an empty list for a missing device, and also return an
empty list with status 200 on database errors. Reverse app lookup trims,
returns `400 {"devices":[]}` for a blank ID, an empty 200 for an unknown
app, and an empty 500 on read errors. The device list's own failure envelope
is `500 {"devices":[]}`, including failures during ECID lookup.

Import history counts `completed_at IS NOT NULL`, including zero and rows
whose `imported` count is zero, and takes the maximum completion timestamp.
An existing device without completed imports has `{ count: 0,
lastCompletedAt: null }`. The imports helper catches its own SQL errors;
a missing imports table must not turn an otherwise valid device into a 500.

Bundles use SQL `DISTINCT`, exclude only NULL and the empty string, and keep
whitespace-only bundle IDs. Tracked apps retain null/empty bundle IDs and
sort with SQLite `COLLATE NOCASE` (ASCII folding, not locale collation).
Bundle order and ties without a secondary ORDER BY remain planner-decided,
matching Node. The bundled SQLite versions differ, so the fixture pins
current agreement rather than adding a Rust-only sorting rule.

**Coverage.** `scripts/parity/devices-fixture.mjs` seeds five devices,
six linked apps, overlapping memberships, duplicate/null/empty/blank bundle
IDs, mixed-case and non-ASCII names, three ownership audiences and completed,
zero-timestamp and pending imports. The live manifest adds 28 branch cases
beside the five existing device entries. Twelve raw-response probes assert
that their scenarios were exercised, including unmasked timestamp values
and key order. This brings the complete local gate to **126 comparisons
across 47 routes**, plus the existing auth/runtime/rate-limit probes.

`node --conditions=react-server --import tsx core/scripts/extract-devices-cases.mjs`
executes the actual Node GET handlers in 58 isolated database scenarios.
Rust replays the same SQL and compares exact status and body bytes. Cases
include empty databases, Unicode whitespace, repeated ECIDs, legacy invalid
owner/placeholder values, and missing-table fault injection. Both the Node
oracle and Rust replay assert that GET leaves SQLite's change count intact.
CI regenerates `core/tests/fixtures/devices-cases.json` before running the
crate tests, so Node route drift cannot silently leave a stale oracle green.

The negative control changes the ECID SQL to `COLLATE NOCASE`; the live gate
must fail its case-sensitive lookup case and raw-response probe. Normal
shipping builds remain protected by the unchanged `rust-core-inert` test.
This batch left 18 compared reads; the user-content batch below leaves 11.
The final Phase 2 batch below completes the deferred comparison and related-app
reads, including their outbound branches.

### User content (+7 routes, 54 total)

Ports `/api/activity`, `/api/notifications`, `/api/notification-prefs`,
`/api/user-tasks`, `/api/annotations`, `/api/shortlist` and
`/api/shortlist/export`. Every handler branch is registered. With the five
device reads from PR #245, this batch brought coverage to 54 of 65. The Node app, Tauri and Docker still do not compile or start `core/`;
`rust-core-inert.test.ts` remains unchanged.

Activity retains prefix-tolerant integer parsing, the route's unclamped
pagination echoes, SQL's clamps, inclusive time filters, null ordering and
arbitrary JSON details (including JavaScript number precision and key order).
Notifications limit to 30 rows before applying the four resolved type flags,
include synthetic rows, respect quiet-hours deferral, and count all eligible
unread rows. Their malformed-JSON error path matches Next's empty HTTP 500.
Preferences use the same resolver and legacy stored-boolean fallback.

User tasks derive completion from existing profile, verdict, visit, history,
sync-schedule and device-resync facts. Focus/workflow inclusion, opt-in
candidates, prerequisite blocking, completion-before-dismissal, 14-day
staleness and preview resets match Node. No task writers or background jobs
are started.

Annotation lists preserve private/imported notes and the existing global
30-second soft-delete cleanup; count-only reads do not purge. Shortlists
scope the source app while keeping the global pair lookup, preserve group
insertion order, optional snapshots/mismatches, candidate modes and prices.
Exports are whole-install in both JSON and Markdown, including exact download
headers and multiline notes. List and export use separate 120/min and 30/min
rate buckets.

**Gates.** `content-fixture.mjs` adds populated activity, 35 notifications,
private/deleted annotations and tracked/untracked alternatives before the
Node database is copied. `content-probes.mjs` checks raw responses and headers,
resolved flag changes, task state, cleanup side effects, malformed JSON and
both rate limits. Only JSON export's freshly generated `exported_at` varies;
the probe validates that timestamp and compares every remaining field.

Regenerate the 109 fixed-clock Node handler scenarios with:

```sh
node --conditions=react-server --import tsx core/scripts/extract-content-meta.mjs
node --conditions=react-server --import tsx core/scripts/extract-content-cases.mjs
```

CI requires both generated files to stay current. Rust replays the same SQL
against fresh databases, comparing status, response bytes, content headers
and surviving annotation IDs. Cases include empty/populated reads, query
coercions, per-type filtering, legacy preference fallbacks, all task focus
combinations, task timestamps, global purge boundaries, scoped/global
shortlists, both export formats and database failures.

### Operational reads (+9 routes, 63 total)

Ports `/api/tasks/active`, the GETs on `/api/wayback/import-all` and
`/api/policy/sync-all`, `/api/backup/snapshots`, `/api/rate-limit/status`,
`/api/ai/debug-log`, `/api/csp-report`, `/api/export` and
`/api/manual-apps/[id]`. This initially left two reads; the final batch
below completes them in the same PR. All shipping paths remain inert.

The job reads project existing state without clearing locks, upgrading
persisted blobs or starting/resuming work. Wayback accepts v1/v2 state and
normalizes its pause/cancel status in memory. Its `running` value requires
a held, non-stale mutex and a status other than `paused`; sync and policy
report running when either a state blob or mutex exists. A held lock with
no pending/in-progress entries is stale, including completed queues.
Unknown entry statuses still count toward total. Missing direct properties
are omitted; the task-center view's null-coalesced fields remain present.
A null queue entry throws in Node and therefore yields an empty HTTP 500.
The unified view also includes at most ten active per-app policy runs,
ordered by their effective start time, with tolerant last-log extraction.
The shared policy reader now drops log entries missing `at`, matching
Node's `Number(undefined)` behavior; explicit null still coerces to zero.

Manual detail bounds IDs by UTF-16 length, preserves whitespace, falls back
to `sideloaded` source metadata, caps events at 200 with rowid ordering for
timestamp ties, and returns the latest policy version. Invalid IDs and
misses use their distinct 400/404 envelopes. AI logs cap at 50 and omit
nullable optional fields while retaining empty strings and zero durations.
Their 60/min read bucket and manual detail's separate 120/min bucket sit
behind the existing authentication gate. No AI call or policy fetch occurs.

Cooldowns retain prefix integer parsing and hide expired reasons. Operational
JSON uses JS number spelling even at the decimal/exponent boundaries and
beyond i64, through the one response serializer in `json.rs` (see
`jsnum::js_number_spelling`) rather than a writer of its own. JSON exports
reuse the existing full-app reader and ignore device scope. CSV defaults on
anything except the exact first `format=json`; quoting, formula prefixes,
newlines, UTC dates and attachment headers follow Node. Both formats retain
the existing in-memory response construction.

Backup settings preserve exact boolean parsing, clamps and nullable run
times. Listing includes every matching filename, follows symlinks, uses
parsed filename dates or the exact file mtime, and sorts newest first.
Filenames go through `jsdate::parse`, a port of `Date.parse` that follows
the ISO/legacy rules of
[V8's date parser](https://github.com/v8/v8/tree/main/src/date), including
local timezone/DST interpretation. Every filename this app writes is either
the strict ISO shape or, with the collision suffix, `NaN` in Node too, so
the legacy rules only matter for hand-renamed files; the port still lives
at crate level beside `jsnum` and `jsstr` because Node also parses date
strings in the scraper, the Wayback importer and the stats views, which
Phases 3–5 port. Its attribution is in `core/V8-LICENSE`; the Phase 6
bullet above records that binaries must carry the notice.
The database lock is released before filesystem work. Missing directories
return an empty list; a non-directory or broken matching symlink causes the
same empty HTTP 500 as Node. No snapshot is created or pruned.

CSP GET reads a process-local ring. Its live value is empty until Phase 4
adds the bounded POST writer; it cannot read the separate Node process's
ring. A populated-ring Node oracle verifies ordering and response shape
without exposing a test writer over HTTP. Authentication applies to GET.

**Coverage.** `extract-operations-cases.mjs` executes the real Node handlers
in 197 scenarios and generates another 180 date-parsing expectations across
UTC, Melbourne and New York. Rust runs the real schema migrations before
replaying each scenario, compares raw status/body/content headers and
asserts zero SQLite writes. Filesystem cases use disposable files with
explicit mtimes, so filename fallback is measured rather than normalized.
CI regenerates the fixture and rejects drift.

The live fixture populates durable queues, manual history, AI logs and a
formula-looking app with privacy data. Raw probes verify runner status
transitions, malformed-state errors, export bytes, privacy gates and read
limits. Backup files/settings are populated after the existing disk probe
so its independent fixture remains meaningful. Only each export's newly
generated timestamp and cooldown's server clock are normalized, after
checking recency; backup directory prefixes are substituted because the
two servers deliberately read separate copies. All stored timestamps,
file sizes, list order and response headers are compared unchanged.

Active policy rows are primed after both servers finish their database
startup so startup cleanup cannot turn the coverage into an empty result.
The manual-list limit probe accounts for the differ's extra Node-only ID
resolution requests. Backup probes restore settings and remove their files
so another server startup cannot launch a backup from the fixture settings.

The local production gate passed 166 comparisons across all 63 routes and
every raw probe. As a negative control, treating paused Wayback state as
running failed 31 Node-oracle cases, the live Wayback comparison and both
raw pause-status probes; the remaining live probes passed. The intentional
fault was removed before the final passing run.


### Comparison, discovery and scope (+3 routes, 66 total)

Completes `/api/compare` and `/api/related-apps`, including on-demand Apple
preview, lookup and chart requests. All 65 reads in the Phase 2 plan and the newer `/api/device-scope` read are
registered. The nine operational reads and these three reads share PR #247,
now based on `main` after #246 merged. Full scraper persistence, historical
HTML support, notifications and snapshot writes remain Phase 3 work.

`outbound.rs` supplies bounded public GET requests. Both URL validation and
the actual connector reject private/metadata addresses; every DNS answer
must be public, including a second answer after the preflight check. Each
redirect is revalidated, cross-origin credentials are stripped, and a
single deadline covers resolution, headers, redirects and body reading.
Declared and decompressed sizes are bounded. gzip, Brotli, zlib and raw
deflate are decoded explicitly so the declared compressed size is checked
before decoding. TLS uses rustls. No private-service exception, environment
bypass, proxy support or write method is exposed by the production client.

Comparison copies stored privacy, policy and accessibility values without
holding SQLite across network awaits. Preview parsing matches the separate
Node `compare-scrape.ts` contract: modern serialized JSON only, direct/header/
generic privacy fallback, legacy purpose flattening, accessibility tri-state,
policy URL sanitization and exact 429/error responses. Historical shoebox
HTML remains unsupported here because Node comparison does not parse it.
Invalid spec slicing preserves JavaScript's 40 UTF-16 units, including an
escaped lone surrogate at the boundary.

Related apps retains cached shelf order, nullable fields, country handling,
lookup fallback without persistence, chart order/duplicates, source exclusion
and soft failures. The observed default limit is **one** (`Number(null)`),
not the five claimed by Node's comment. Fractional limits truncate for a
stored shelf but round up while iterating chart entries. These behaviors are
preserved rather than silently corrected during the port.

**Verification layers.** The live HTTP gate covers stored and empty responses,
validation errors, private-host rejection and the comparison limiter. Apple
responses are exercised deterministically by running the actual Node handlers
against recorded HTTP replies: 116 cases compare exact status, response bytes,
headers and outbound requests in Rust, assert zero SQLite writes, and verify
that network requests never hold the database mutex. A separate transport
oracle covers 168 URL verdicts, 31 IP verdicts and 22 real local HTTP scenarios
including redirects, credential stripping, compression, size limits and
header/body deadlines. The production DNS resolver is also tested directly.
Only the test client maps virtual Apple hosts onto the local fixture server;
there is no production bypass. CI regenerates both oracles before testing.
Live success parity does not depend on mutable Apple pages or feeds.


The complete inventory check also found `/api/device-scope`, introduced after
the Phase 2 inventory was drawn up and previously absent from the manifest. Its GET now returns the
reconciled saved selection, picker device counts and normalized ownership.
Malformed/stale selections fall back to all devices without overwriting the
stored setting. The device oracle now contains 73 cases, including subset
ordering, full/empty collapse, corrupt settings and missing tables. PUT and
DELETE remain part of Phase 4; the shipping Node handlers are unchanged.


The final local production gate passed **178 comparisons across all 66 reads**
and every raw probe. It waits for Node's startup timers before inserting
unfinished-job fixtures so the Node recovery runners cannot mutate the inputs
while Rust reads its copy. As a negative control, rounding a stored related-app
limit up instead of truncating it failed the Node oracle, the live shelf
comparison and the fractional-limit probe; all other live checks passed. The
fault was removed before the final passing run. Production build, TypeScript,
lint, schema parity, 193 Rust tests and the Node suite (715 pass, 4 skip) pass.
The `rust-core-inert` guard is unchanged.

## Status — Phase 3 (scraper + diff + persist)

Phase 3 ports what happens between "the HTML arrived" and "the rows are
committed": the page parser, the write plan, the snapshot diff and the
persist path of `fetchAndParseApp` in `lib/scraper.ts`, plus the
per-capture historical chain in `lib/historical-import.ts`. The diff half
already exists — `diff.rs` is gated by the diffSnapshots oracle — and
`outbound.rs` already knows the Apple hosts. Everything stays inert: no
shipping path calls the Rust scraper, and `rust-core-inert.test.ts` is
unchanged.

**The gate is the write plan, not the wire.** `fetchAndParseApp` is
already split into a pure parse (a `ScrapeWritePlan`), a statement builder
and one transactional commit, so each batch records what the real Node
code produces at its boundary and replays it in Rust:

1. **Page parser (this batch).** HTML in, the pre-commit parse out. Gated
   by `core/tests/fixtures/scrape-cases.json`, below.
2. **Persist.** The statement list `commitScrapedAppToDb` builds — apps
   upsert, privacy rows, accessibility and related rows, the snapshot row,
   the notification and the activity row — compared statement by
   statement, then applied to identical database copies and diffed table
   by table. Both sides need an injectable clock for that.
3. **Fetch.** Apple's rate-limit signal and Retry-After, the scrape
   cooldown, the iTunes lookup, search and bundle-id lookup, through the
   recorded-reply mechanism the discovery oracle already uses.
4. **Historical import.** The per-capture Wayback chain: targets, CDX,
   capture fetch, shoebox parse and the wayback snapshot writer. The bulk
   runner, its mutex and its resume state are Phase 4.

Two page shapes the batch-1 fixtures avoid until batch 2 pins them: a page
whose privacy types repeat an identifier, or whose related shelf repeats an
id, fails Node's commit on a primary key rather than its parser.

### Batch 1 — the page parser (no routes)

`core/src/scrape/` is `fetchAndParseApp` from the fetched HTML to the write
plan: the metadata regexes, the `serialized-server-data` extraction and
the name rules (`page.rs`), the two three-state flags (`flags.rs`), the
privacy-type fallback chain and normaliser (`plan.rs`), the historical
shoebox (`shoebox.rs`), the accessibility shelf (`accessibility.rs`) and
the related-app shelves (`related.rs`). Nothing fetches, diffs or writes.

**The oracle — `core/scripts/extract-scrape-cases.mjs`.** Runs the REAL
`fetchAndParseApp` over 27 synthetic pages with a stubbed `fetch`, the
bulk write held inline (`WORKER_DISABLED=1`) and a fresh database per
case, then projects what the page alone determined out of the rows Node
wrote: the apps row's page-derived columns, the privacy types and
categories in insertion order, the exact `snapshot_json` string, the
accessibility rows and the related-app rows — or, for the eight pages that
make Node throw, the error message. `core/src/scrape/tests.rs` replays
every case; CI regenerates the fixture and fails on drift. No shipping
code changed: because the projection reads rows, the oracle exercises the
handler end to end rather than an exported helper.

The pages cover the Clock fixture from the Node suite verbatim, every
shelf shape (product-page items, the privacyHeader fallback with nested
purposes, generic pageData shelves, both 2021-era shoebox shapes), all
four IAP paths, both accessibility variants and the header-only signal,
Apple's "No Details Provided" copy, the two extraction failures,
single-quoted and spaced script tags beside a decoy id, related-shelf key
fallback and nested shelves, the ten-per-shelf cap, and JavaScript's trim
and slug rules on non-ASCII input.

**What the port is mostly about.** The Node parser is written against
`any`, so the fidelity work is JavaScript semantics rather than App Store
knowledge, and the oracle pins the ones that bite:

- The fallback chain sits inside one `try`; a throw keeps what was pushed
  and skips every later fallback. A `null` item after a good one leaves
  one item; a `null` first item leaves nothing — and the pageData shelves
  beneath are never consulted, while the details flag, reading the same
  shelf, still says `1`.
- The normaliser runs after that `try`. A `categories` that is not
  iterable escapes as a hard error with V8's type-specific message
  (`number 5 is not iterable (cannot read property Symbol(Symbol.iterator))`);
  an `items` that is not escapes with the identifier-rendered one
  (`items is not iterable`); a truthy non-string JSON title escapes as
  `jsonTitle.trim is not a function`.
- `?.length` is truthy for a non-empty string and for an object that says
  so; `for…of` walks a string's characters. A `privacyTypes.items` of
  `"abc"` therefore reaches the normaliser and yields nothing, with the
  details flag at `1`.
- `String(id)` spells `0` as `"0"`, `true` as `"true"`, an array joined
  by commas and an object as `[object Object]`; `trim()` strips U+FEFF and
  NBSP but not U+0085; the slug lowercases with Unicode rules before
  collapsing non-`[a-z0-9]` runs, so `İstanbul Kit` is `i_stanbul_kit`.
- The shoebox decode undoes six entities in Node's order, reads an
  object's values in JavaScript key order, and a candidate whose JSON is
  `null` ends the whole extraction (`Object.values(null)` throws inside
  the one `catch`).

**Known divergences, none reachable from a real page.** The JSON
extraction is `serde_json`, which rejects lone-surrogate escapes and
nesting past 128 levels that `JSON.parse` accepts, and `(?i)` folds a few
non-ASCII letters that JavaScript's flag does not. Node also mints a
random UUID when the URL has no `/id<digits>` segment; every caller
validates the URL first, so the port refuses instead.

Rust suite: 192 pass (187 + 5 new). Negative controls: swallowing the
`null`-item throw in the header chain, and making an object's `.length`
read falsy, each failed exactly the cases that pin them; both faults were
removed before the final passing run.

### Batch 2 — persist (no routes)

`core/src/scrape/persist.rs` is the rest of `fetchAndParseApp` from the
parsed page on: the pre-commit reads (the existing row, the latest
snapshot or the rows it is rebuilt from, the accessibility rows, the
privacy profile), change detection (`diff_snapshots`, the accessibility
diff, the age-rating entry), the single transactional commit, and the two
best-effort bells after it. `notify.rs` carries the three notification
writers with their settings-backed dedupe windows, the retention prune and
`computeNotBefore`; `activity.rs` carries the catch block's diagnostics
and `recordActivity`. The iTunes lookup is still the caller's (batch 3),
so `VersionInfo` is an input.

**The oracle — `core/scripts/extract-persist-cases.mjs`.** Runs the REAL
`fetchAndParseApp` end to end over 26 scenarios and records every write it
makes, in order — each statement's SQL and bound parameters, with
BEGIN/COMMIT/ROLLBACK markers around the bulk write — then dumps every
touched table (digested past 100 rows) and the return value or error.
Three things make that reproducible: the clock is frozen per case, TZ is
UTC, and `crypto.randomUUID` is a counter on both the global and the
`node:crypto` module, so the Rust side mints the same ids from an `Ids`
source — including the one Node mints for `appleId` and immediately
overwrites, which is why every sequence starts at two. Setup for a case is
raw SQL or an earlier scrape; either way the statements it actually ran
are recorded and replayed verbatim. `core/src/scrape/persist_tests.rs`
compares stream, rows and result per case; CI regenerates the fixture.

The scenarios: a new app; re-syncs with no change, label changes (plural
and singular summaries), accessibility changes, an absent accessibility
header (rows kept, flag kept) and a header alone (rows wiped, every
feature "removed"); a version update with and without label changes, and
one inside the one-hour dedupe window; an age-rating change; quiet hours
inside a same-day window, inside a window wrapping midnight, and outside;
the parser-fallthrough bell and its 24-hour cooldown; profile mismatches
on import, on a re-sync that adds a mismatching category, and inside the
dedupe window; a duplicate type identifier and a duplicate related id,
which fail the commit on a primary key, roll back and land in the activity
log; a parse error's activity row; the activity and notification retention
prunes over CTE-seeded tables; an app row with privacy rows but no
snapshot; and related shelves gone on re-sync.

**What the port pins.** The SQL is Node's byte for byte, whitespace and
all, because the stream is compared as text. The version bell's date is
`Intl.DateTimeFormat("en-AU", …)`, whose short months spell June, July and
Sept in full. Quiet hours are local-time arithmetic (`getHours`,
`setHours`, `setDate(+1)`), done through `jsdate::local_time` and
`at_local_time`. Dedupe windows are read as `Number(setting) || 0` for
the version and profile bells and `Number.parseInt` for the parser bell.
A commit failure rolls the transaction back and the error row is written
outside it; the post-commit bells are best effort and never fail the
scrape. Production ids are v4 UUIDs from SQLite's `randomblob`.

**Known divergences, none reachable through Node's own writes.** A corrupt
stored `snapshot_json` fails to parse with a different message than V8's,
and a hand-edited non-string `currentVersion` or `ageRating` is compared
after `String()` coercion where Node compares the raw value.

Rust suite: 194 pass (187 + 7 new). Negative controls: skipping the
discarded `appleId` id shifted every later id and failed every case, and
dropping the version bell's dedupe window made the dedupe case emit two
extra statements; both faults were removed before the final passing run.

### Batch 3 — the fetch layer (no routes)

With `core/src/scrape/fetch.rs` the whole of `fetchAndParseApp` runs here,
plus `scrapeInitialUrls` over it: URL refusal, the scrape cooldown and the
soft pacer (`ratelimit.rs`), the page fetch through `outbound.rs`, Apple's
rate-limit signal and the cooldown it records, the status checks, the
parse, the iTunes lookup with its storefront normalisation (`region.rs`),
and then the persist path. Three stages — `prepare` (validation, cooldown,
storefront), `perform` (no database: pacer, fetch, checks, parse, lookup)
and `complete` (cooldown record, persist, error row) — because a rusqlite
connection must not be held across an await in a `Send` future.
`fetch_and_parse_app` chains them through the `DbAccess` accessor the
Phase 4 routes hand it: the lock for `prepare`, released for `perform`,
taken again for `complete` (see "The lock is taken per section" under
Phase 4, batch 3). Search and bundle-id lookup are the next batch.

**The transport runs over a hop.** Node's `safeFetch` loops over the raw
`fetch` — redirects, the content-length and body caps, decoding — and the
oracle stubs that raw layer. So `outbound.rs` now runs the same loop over
a `Hop`: reqwest in production, recorded replies in the replay. Both sides
therefore exercise the real redirect and cap logic against the same
replies, and `Reply` carries the final response's headers, which is how
Retry-After reaches the scraper. The existing transport oracle (22 real
local HTTP cases) still passes over the refactor.

**The oracle — `core/scripts/extract-fetch-cases.mjs`.** Runs the REAL
`fetchAndParseApp` and `scrapeInitialUrls` over 36 scenarios with the raw
`fetch` replaced by recorded replies, and records every raw fetch Node
made (URL and the headers the scraper set), every write in order with
transaction markers, every touched table, and the return value or error.
`core/src/scrape/fetch_tests.rs` replays each case through the real
transport loop and compares all four. Scenarios: the page-then-lookup
happy path; the storefront setting trimmed, invalid and alpha-3; the
cooldown active (no fetch at all), expired and unparseable; 429 with
Retry-After in seconds, absent, past the ten-minute cap, zero (which
`Date.parse` reads as the year 2000 and so discards), junk, or as an HTTP
date; 403 treated as the same signal (and reported as 429, as Node's
message does); a stored negative cooldown kept in the max; 404 and 503
with their diagnostics hints; a transport failure and a timeout; redirects
followed within the allowlist, rejected outside it, one too many, and a
3xx without Location returned as the response; a declared content-length
past the cap; the lookup non-OK, unparseable, empty, failing, with every
field coerced, and with `results` not an array; two refused URLs, which
never reach the activity boundary; a re-sync through the fetch layer; and
two `scrapeInitialUrls` batches — one stopping at the first rate limit
with the rest reported as queued, one told to continue, which runs into
the cooldown the 429 just started and short-circuits every URL after it.

**What the port pins that the persist batch could not.** The error
diagnostics hints for HTTP statuses, timeouts and network failures; the
cooldown settings written on Apple's signal, with the reason's ISO
timestamp; and the throwaway `appleId` UUID, which Node mints once the
HTML is in hand — so a page that fetches but fails to parse consumes an
id before its error row, while a 404 does not.

Rust suite: 197 pass (187 + 10 new). Negative controls: treating 403 as a
plain HTTP error failed the 403 case on its stream, both tables and its
result, and dropping the post-fetch throwaway id failed the continuing
batch on its stream and both tables; nothing else moved, and both faults
were removed before the final passing run.

### Batch 3b — search and bundle-id lookup (no routes)

`core/src/scrape/search.rs` ports the two iTunes API calls the import flow
makes: `searchAppsByName` — query normalisation (strings and objects,
blank names dropped, blank developers forgotten), the search URL with an
`encodeURIComponent` port, the once-only retry after an empty result, and
the developer-hint reordering (exact 100, containment 50, twelve per
shared ASCII word to 40, ties by position) — and `lookupAppsByBundleId`:
trim and dedupe, chunks of a hundred over a 16 KiB URL allowance, the
5xx split-in-half retry that recurses, case-insensitive matching with the
last duplicate winning, and nulls for whatever a chunk cannot answer.
Both share the "search" cooldown a 429 records (seconds only, under ten
minutes, else 70 s; the raw header in the reason) and both return the
batch object as JSON, because the candidate shape is JavaScript's: a field
Apple did not send is absent, a `null` one stays null, `String(trackId)`
spells whatever was there, and the first `100x100bb` becomes `200x200bb`.

**Where the throws go.** Neither function throws to its caller. Inside a
query or a chunk, a transport failure, a non-OK status, malformed JSON, a
`results` that is not an array, a `null` entry, a non-string
`artworkUrl100` or `trackViewUrl`, or a non-string candidate developer
under a hint all land in Node's per-query `try` — empty candidates, or
null matches for the chunk — and the next query carries on. The oracle
pins each of those against its neighbours in one batch.

**The oracle — `core/scripts/extract-search-cases.mjs`.** Runs the REAL
functions over 31 scenarios with recorded iTunes replies and records every
raw fetch (URL and headers), every write, the app_settings rows and the
batch returned. `core/src/scrape/search_tests.rs` replays each through the
same transport loop the fetch batch introduced, with the request limits
asserted per call. Scenarios: candidate mapping with every field variant,
the developer reorder, a single candidate under a hint, query
normalisation, the storefront from the option and from the setting, the
empty-result retry (used, exhausted, and rate-limited on the retry), 429
on the first and on a later query with Retry-After honoured, at the cap
and as junk, the cooldown short-circuit, eight failure modes isolated in
one batch, URI encoding of spaces, ampersands, accents and CJK; and for
the lookup, input-order matching, dedupe and trim, empty input, 429 with
and without Retry-After, the cooldown, a non-OK chunk, the 5xx split with
and without a rate limit inside it, a 5xx on a single id, malformed JSON,
non-array results, 150 ids across two chunks, reply quirks (duplicate and
non-string bundle ids, absent fields) and the storefront from both
sources.

Rust suite: 199 pass (187 + 12 new). Negative controls: making the
Retry-After cap inclusive failed the at-the-cap case on its stream,
settings and batch, and skipping the empty-result retry failed the four
cases that consume a retry reply (unused replies, raw fetches, batch);
nothing else moved, and both faults were removed before the final passing
run.

### Batch 4 — historical import (no routes)

`core/src/scrape/history.rs` ports `importAppHistory` from
lib/historical-import.ts, the per-app Wayback back-fill, and
`core/src/scrape/wayback.rs` the archive.org client under it from
lib/wayback.ts. The import walks targets back from today by the cadence
(`setUTCMonth` semantics: the same day and time of day, a 31st rolling
into the next month) to the February 2021 floor, adds the install date
once it is older than the dedupe window, and answers each target from
the CDX index — the nearest capture, in tolerance or recorded as drift —
or, when the index is unusable, from availability-API probes at the
seven fallback offsets. A target already covered by a wayback row inside
the window, or whose capture URL is already stored (http and https
alike), is skipped; a capture that failed earlier in the run is reused
with its earlier verdict; a usable replay is parsed by the archive
parser (the modern chain as a whole — any throw inside it is "no
labels" — then the shoebox, then the identifier-deduping normalisation)
and split into no-labels against parse-failure by the product-page
sniff. The write is one transaction: the snapshot before the capture
from any source is the diff base, the back-dated row is inserted with
Node's SQL byte for byte, and a wayback row after it is re-diffed
against the new one. When the archive holds nothing within 45 days of
today, Save Page Now is asked once through the transport's new
manual-redirect, body-skipping mode (Location, then Content-Location,
on the replay host only) and the request is recorded as a live row
whose changes carry the attempt note. Throttling from the index, the
availability API or a replay is the import's error, not a quiet
quarter, with Retry-After in seconds or as an HTTP date; Save Page Now
failures are a skipped target.

**JavaScript arithmetic it reproduces.** `Date.UTC` overflow for the
padded Wayback timestamps (`2021` pads to December 00, which is
30 November), the `yyyymmdd` UTC probe dates, `Number()`-first
Retry-After parsing so `"0"` is zero, `Math.round` and `Math.ceil` in
the window and the message, and `URLSearchParams` form encoding for the
CDX query (`timestamp:8` is `timestamp%3A8`, spaces are `+`).

**The oracle — `core/scripts/extract-history-cases.mjs`.** Runs the REAL
`importAppHistory` over 26 scenarios with archive.org stubbed by recorded
replies routed by endpoint (CDX, availability by probe date, replay by
timestamp, Save Page Now), a frozen clock and counted ids, and records
every raw fetch (URL and headers), every write with its BEGIN/COMMIT
markers, the snapshot and app rows, and the result or the thrown error.
`core/src/scrape/history_tests.rs` replays each through the same
transport loop with the request limits asserted per endpoint. Scenarios:
index captures imported, unchanged and baseline; window and URL dedupe;
force re-probing; index 429 and 503; the probe fallback with drift and
no capture; availability 503 with an HTTP-date Retry-After; no-labels,
fetch-failure and parse-failure replays with a reused unusable capture;
replay 503 after earlier rows committed; the successor re-diff; a live
row as the diff base; Save Page Now via Location, via Content-Location,
rate-limited, server error, no snapshot URL, transport failure and a
Location on another host; the install anchor probed, too fresh, and
coinciding with a target; the monthly cadence; index parsing quirks;
index garbage; and the target walk from a month end.

Rust suite: 202 pass (187 + 15 new). Negative controls: skipping the
successor re-diff failed only that case (stream and rows), disabling the
product-page sniff failed only the no-labels case, dropping the HTTP-date
Retry-After branch failed only the availability 503 case, and removing the
Content-Location fallback failed only that Save Page Now case; nothing
else moved, and each fault was removed before the final passing run.

## Status — Phase 4 (writers, runners, health)

Phase 3 closed with the scraper, the diff, the persist path and the
Wayback import in Rust and 202 tests gating them. Phase 4 is the write
side of the API and the background work behind it, in five batches:
the settings-style writers and the plumbing every write shares (batch
1), the library writers (2), the import pipeline (3), the bulk runners
and the scheduler (4), and the health check, diagnostics, backup and
teardown routes (5). The cfgutil device actions belong with the desktop
cutover, and the AI routes with Phase 5.

**The gate changes shape.** Phase 2's reads were compared live against
Node by `read-parity.mjs`; Phase 3's modules were gated by Node oracles
replayed in the crate. The writes need both. `read-parity.mjs --mutate`
(`just parity-write`) now runs a second differ pass after every read
probe: the manifest's mutation entries for the write routes the core
implements (`WRITE_ROUTES`, kept by hand like `BATCH_1`), each compared
on its response and then on its `after` read, live against both servers.
It runs last because every mutation lands on both databases with each
server's own ids and clock. And each batch also records the real
handlers in an oracle so CI compares the write stream and the rows — the
differ only sees a write through its `after` read, and a write that
returns the right envelope but persists differently is exactly the bug a
port produces.

### Batch 1 — the settings-style writes (+20 handlers)

`core/src/server/writes.rs` ports the `POST`, `PUT` and `DELETE`
exports of seventeen route files: `/api/date-format`, `/api/locale`,
`/api/preferences`, `/api/settings`, `/api/settings/desktop`,
`/api/notification-prefs`, `/api/focus`, `/api/privacy-profile`,
`/api/accessibility-profile`, `/api/feature-flags/overrides` (set,
bulk import, clear all or a surface, clear one), `/api/dashboard/layout`
(save, reset, preset), `/api/coachmark-state`, `/api/dev-menu-state`,
`/api/welcomed-at` and `/api/migration-flow/consume`. Each handler is the
Node source in order: its guard, its body read with the route's own cap
and its own 400 phrasing, its validation branches, its writes with
Node's SQL byte for byte, and its response literal. Under them sit three
modules every later write batch reuses: `body.rs` (`readBoundedJson` —
the declared Content-Length refused first, the stream capped as it
arrives, empty and unparseable distinct, a 30 s clock), `guard.rs`
(`requireMutationGuard` — the inbound rate limit, then the admin token,
each refusal an audit row; and `recordAudit` with its column
truncation) and `activity_log.rs` (`recordActivity` with the
2000-row retention cap). `routes_writes.rs` wires them into axum: the
guard under the lock, the body read with the lock released, the handler
under the lock again.

**What the port has to get right that the route shapes do not show.**
Bodies are `any` in Node, so the handlers are JavaScript semantics over
`serde_json::Value`: a present key against an absent one (`null` is
present), truthiness for the boolean settings (`"no"` stores `true`),
`String()` and `Number()` coercions, `Object.keys` order for the audit
detail (a string body audits as `0,1`), and which routes throw on a
`null` body (Next's generic 500) against which check for an object
first. `/api/settings` writes as it validates, so a body with a valid
`sync_schedule` and an invalid `ai_provider` stores the schedule and
answers 400 with no audit row; its rate limit is a bare 429 without
Retry-After or audit, unlike the guard's. A provider switch clears the
API key; a masked webhook value round-trips untouched, and `configured`
with nothing stored is an invalid URL. The desktop route applies both
the short and the legacy key when a body carries both, and skips a value
it will not store rather than refusing. `/api/notification-prefs`
projects four booleans onto flag overrides and, when the resolver throws
on a garbage audience, answers from the legacy blob instead. The focus
write is one transaction of seven rows; the profile and layout writes
record an activity row only across a preset boundary, with the previous
state read before the write. The override clear with `?surface=` (empty)
clears everything and reports scope `""`. The locale cookie carries the
`Expires` Next derives from `Max-Age`.

**The oracle — `core/scripts/extract-writes-cases.mjs`.** Runs the REAL
handlers over 255 requests with a frozen clock, counted ids, a distinct
forwarded address per case behind `PRIVACYTRACKER_TRUST_PROXY=1` (so
Node's process-wide limiter keeps one bucket per case), the admin token
set per case, and a write recorder; it records the request, the setup
rows, every write with BEGIN/COMMIT markers, the `app_settings`,
`feature_flag_overrides`, `activity_log` and `audit_log` tables, and the
wire response with Retry-After and Set-Cookie. Every manifest mutation
body for these routes is among the cases. `core/src/server/writes_tests.rs`
replays each through `precheck` and `perform` exactly as the wrappers
call them, with a fresh limiter per case and limit+1 requests for the
twelve burst cases. Scenarios per route: the success paths and every
validation branch, the empty, unparseable, declared-too-large and
streamed-too-large bodies, the non-object and `null` bodies, the
admin-token refusal and acceptance, and the burst past the limit.

Live: `read-parity.mjs --mutate` against a seeded production Node server
— 178 read checks, then the 17 manifest mutations for these routes with
their `after` reads (29 checks), PARITY OK.

Rust suite: 205 pass (202 + 3 new). Negative controls: dropping the
API-key clear on a provider switch failed exactly the two cases that
switch providers; treating an empty `?surface=` as a surface failed only
that case; and dropping the layout activity row failed exactly the four
cases that cross a preset boundary; each fault was removed before the
final passing run.

### Batch 2 — the library writers (+23 handlers)

`core/src/server/library_writes.rs` ports the `POST`, `PUT`, `PATCH` and
`DELETE` exports of eighteen route files: `/api/annotations` and
`/api/annotations/[id]` (create, edit, soft-delete, restore inside the
30 s window), `/api/verdicts` and `/api/verdicts/bulk` (set, clear, the
one-transaction bulk), `/api/shortlist` (add or refresh by pair, remove
by id, pair or all), `/api/apps/[id]/acknowledge` and its undo,
`/api/notifications` (mark read, mark unread by ids capped at 200),
`/api/user-tasks` and `/api/user-tasks/visit`,
`/api/activity/queue-session`, `/api/devices` and `/api/devices/[id]`
(create or find by ECID, rename, ownership and the permission
acknowledgement, merge, delete with the orphan sweep),
`/api/device-scope` (save, reset) and `/api/manual-apps`,
`/api/manual-apps/[id]`, `/api/manual-apps/bulk` and
`/api/manual-apps/[id]/restore`. Each is the Node route in order over the
lib module it calls — `lib/annotations.ts`, `lib/verdicts.ts`,
`lib/shortlist.ts`, `lib/changelog.ts`'s review actions,
`lib/notifications.ts`, `lib/tasks-server.ts`, `lib/devices.ts`,
`lib/device-scope-server.ts`, `lib/manual-apps-server.ts` and
`lib/manual-app-history.ts` — with Node's SQL byte for byte, the
activity rows those modules write for user actions (`annotation_*`,
`verdict_set`, `verdict_cleared`, `bulk_verdict_set`,
`queue_session_completed`) and the audit rows the routes write.

**What this batch adds to the settings batch.** Rows read back after the
write (the annotation, the device, the shortlist entry with its profile
badge through the single-footprint path, where a tracked candidate with
no privacy rows still gets a badge). Transactions that answer `false`
without rolling back (the undo's missing action) and transactions that
roll back on a foreign-key refusal (the bulk verdict with an unknown app,
answered with the route's own 500; the review action on an unknown app,
answered with Next's generic one). The routes whose `catch` turns a
`TypeError` on a `null` body into a 400 carrying V8's message (`Cannot
read properties of null (reading 'sourceAppId')`). The task blob
re-emerging from its sanitiser in a fixed key order, and a `NaN` decided
count serialising as `null` in the activity detail. The device delete's
orphan sweep, which relies on the cascade (so foreign keys stay ON) and
on a probe Node gets wrong: its shortlist check queries a column the
table does not have, is swallowed, and so a shortlist entry never keeps
an app alive — reproduced, and pinned by a negative control that "fixes"
it. The pre-body checks a route makes after its guard: the device 404
and the manual-app id length answer before the body is read, so an
oversized body to a missing device is a 404, not a 413.

**The oracle — `core/scripts/extract-library-cases.mjs`.** Runs the REAL
handlers over 354 requests with foreign keys ON, a frozen clock, counted
ids (the `node:crypto` counter synced into the builtin ESM facade,
because `lib/devices.ts` imports `randomUUID` by name), a distinct
forwarded address per case and a write recorder; it records the request,
the setup rows, every write with BEGIN/COMMIT/ROLLBACK markers, the
fifteen tables a library write can touch, and the wire response.
`core/src/server/library_tests.rs` replays each through `precheck` and
`perform` exactly as the wrappers call them. Scenarios per route: the
success paths and every validation branch, the five body-reader
outcomes (empty, unparseable, whitespace, declared and streamed too
large), the non-object and `null` bodies, the admin-token refusal and
acceptance where the route has one, and the burst past the limit.

Live: `read-parity.mjs --mutate` — 178 read checks, then the 37 manifest
mutations for the batch-1 and batch-2 routes with their `after` reads (37
checks), PARITY OK. The runner's mutate pass now skips reads
(`parity-diff.mjs --skip-reads`), waits out the read rate window the
limiter probe spends, and resolves `{annotation}` per app, so the
per-id annotation and manual-app mutations are exercised rather than
skipped.

Rust suite: 206 pass (205 + 1 new). Negative controls: dropping the
rule that clears the permission acknowledgement when a device's owner
becomes self or none failed exactly the three cases that take that
path; mislabelling the annotation-edit activity failed exactly the five
edits; and "fixing" the orphan sweep's shortlist probe failed exactly
the one case where a shortlist entry would then have protected its app.
Each fault was removed before the final passing run — and one of them,
built into the server binary by a concurrent step, was caught by the
live gate on its first run.

### Batch 3 — the import pipeline (+12 handlers)

`core/src/server/imports_writes.rs` ports the `POST` and `DELETE` exports
of ten route files: `/api/imports` (create a session; delete it, with or
without its apps), `/api/imports/items` (the upsert that plans every
write from the reads first, then runs the plan in chunks of 200, then
recomputes the counters), `/api/imports/items/update`,
`/api/imports/queue` (the forced drain: clear the pause fence and every
row's backoff, take the running mutex or override a stale one, claim up
to ten rows untracked-first, scrape each until Apple says stop),
`/api/imports/complete` (counters, the completion stamp, the device
links, the activity row, the completion notification, then the route's
own manual-apps nudge with its one-a-day fence),
`/api/imports/items/retry` (the inline iTunes search for a
`pending_search` row, the scrape for anything with a URL, the error for
anything without), `/api/imports/items/change-match` (scrape first, then
rewire the row, garbage-collect the previous app when nothing else
references it, mark its notifications stale, relabel the row),
`/api/search` (bundle ids first, else rows, else names, each through the
`lib/app-import.ts` sanitisers), `/api/scrape` and
`/api/apps/[id]/import-history` (the per-app Wayback run with its audit
pair and activity row; the remove with its own). Under them sit
`lib/imports.ts`, `lib/import-queue.ts`, the two import notifications
in `lib/notifications.ts` and the name sanitisers, with Node's SQL byte
for byte. The network routes hand the Phase 3 scrape, search and
history entry points a `Fetcher`; the Phase 3 modules' writes land in
the same recorded stream as the route's own.

**What this batch adds to the library batch.** Ids that are not UUIDs:
`imp_`/`iti_` plus nine random bytes in base64url (`Ids::short_id`).
A counter that is a JavaScript number, not an integer — `total: 2.5` is
stored and read back as 2.5, and the counter recompute takes
`Math.max` over it. An upsert whose existence checks all run before its
first write, so two rows with one query in one batch both insert, and
whose tombstoned rows (`removed`) are returned untouched. Inline rate
limits with the route's own phrasing and a `Retry-After`
(`Guard::Rate`), one of them keyed per app. A body reader whose
unparseable case is a `null` body rather than a 400 (the Wayback
import). Routes that scrape and then read the fresh `apps` row for what
the scrape result lacks. The `| 0` clamp on every count in the
completion notification, and a source label that is trimmed for the
suffix but echoed blank rather than null. And the queue drain's `finally`
— the mutex release and the last-run stamp land whether the tick was
skipped, drained or threw.

**The lock is taken per section, never across a fetch.** The Phase 3
entry points — `fetch_and_parse_app`, `scrape_initial_urls`,
`search_apps_by_name`, `lookup_apps_by_bundle_id`, `import_app_history`
— no longer take a `&Connection`. They take a `DbAccess`
(`core/src/scrape/persist.rs`), whose one method runs a closure with a
`Writer` and nothing else: the route's implementation (`Locked`, handed
out by `AppState::db_access`) locks the mutex for the closure and drops
the guard when it returns, timing the wait into `sqlite.lockWait`
exactly as `AppState::db` does; the replay's is the same type over a
test mutex with the recording attached. A section is what Node runs
synchronously between two awaits, so the staging reproduces Node's
interleaving points rather than inventing its own. The scrape's
`prepare` (validation, the cooldown read, the storefront) is one section
and its `complete` — the commit or the error row, together with the
import-row update Node makes the moment `fetchAndParseApp` returns
(`settle_import_scrape`) — is another, with the pacer, the page fetch
and the version lookup between them and the lock released. The search
takes the lock for the storefront read, each cooldown read and each
cooldown record; the Wayback run for the two reads before the CDX
listing, each back-dated row's transaction and the Save Page Now attempt
entry; the queue drain for its fences, mutex and claim before the first
scrape and for its `finally` and status after the last. The handlers
that never fetch are one section each — the lock for exactly the
handler, as the batch-1 and batch-2 wrappers hold it. `Ids` gained a
`Send` bound so the id source rides across the awaits (an id is only
ever minted inside a section). The guard therefore never crosses an
await, the handler futures are `Send`, and `routes_writes::run` awaits
them on the runtime like every other route: the blocking-thread detour
and its `#[allow(clippy::await_holding_lock)]` are gone. The recorded
behaviour is unchanged by construction — the four replays drive the same
entry points through the same accessor over a mutex, and every fixture's
write stream, fetch calls and rows are byte-identical to before. Negative
control: holding the guard across the fetch (a `state.db()` guard kept
live over `perform`) no longer compiles, because the handler future stops
being `Send` and axum's `post()` refuses it — the check the allowance had
suppressed.

**What is not ported.** `summarizePolicies: true` on `/api/scrape` and
the deferred policy-source fetch a successful import or scrape arms
(`schedulePostAppUpdatePolicyFetch`) are the Phase 5 policy pipeline;
the flag is read and ignored, the hook is a no-op. The oracle holds the
`policy_sync_running` mutex in every case so Node's timer, when it
fires, finds the runner busy and writes nothing.

**The oracle — `core/scripts/extract-imports-cases.mjs`.** Runs the REAL
handlers over 167 requests with foreign keys ON, a frozen clock, counted
ids (now including `randomBytes(9)`: twelve base64url characters
round-trip to nine bytes, so a zero-padded counter decodes and re-encodes
to itself), the soft pacers reset per case, a distinct forwarded address
per case, and the network canned — each case lists its replies in the
order the handler asks for them (an App Store page then its version
lookup; an iTunes search or lookup; the CDX index, a replay, Save Page
Now), and a reply left unused fails the run. It records the request, the
setup rows, every raw fetch, every write with transaction markers, the
fourteen tables an import write can touch (abbreviated past 100 rows, as
the Rust dump is), and the wire response. `core/src/server/imports_tests.rs`
replays each through `precheck` and `perform_async` with the Phase 3
canned fetcher and compares the calls too. Scenarios: every route's
success paths and validation branches, the five body-reader outcomes,
the `null`, array and string bodies, tombstones and duplicates in one
batch, the two-chunk batch, the busy, stale and empty drains, a drain
that pauses on a 429 with the rest of the claim untouched, completion
across every status derivation and the notification headline each one
produces, searches by names, rows and bundle ids with their rate-limited
envelopes, a scrape batch that stops on a 429 with the tail queued, the
Wayback run forced and unforced, throttled by archive.org with and
without a `Retry-After`, and the bursts past every limit.

Live: `read-parity.mjs --mutate` — the five local import routes
(`/api/imports`, `/api/imports/items`, `/api/imports/items/update`,
`/api/imports/queue`, `/api/imports/complete`) join the mutate pass; the
routes that reach Apple or archive.org stay quarantined in the manifest
and are gated by the oracle alone.

Rust suite: 211 pass (206 + 5 new). Negative controls, each predicted
from the fixture before it ran: honouring a tombstoned row's upsert
failed exactly the one case that lands on one; de-duplicating queries
within a batch failed exactly the one case with two rows of one query;
dropping the untracked-first claim order failed exactly the one drain
that mixes tracked and untracked rows; and dropping the `Retry-After`
from the inline rate limits failed exactly the four bursts on those
routes. Each fault was removed before the final passing run.

