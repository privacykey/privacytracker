# privacytracker-core (Rust)

The server both shipped builds run. This crate replaced the Node/Next
*server* runtime while keeping the React frontend and the public API
contract byte-for-byte identical. Since Phase 6 the desktop app serves
from it inside its own process and the Docker image runs `pt-core serve`.
The Node server stays buildable as the rollback until 1.0 has shipped;
batch 7 then deletes it.

## Topology

One crate (`core/`) owning everything that is server-side: SQLite, the
App Store scraper, snapshot diffing, the Wayback importer, the three
crash-safe bulk runners, schedulers, the policy pipeline, and the HTTP
API. It is served two ways:

- **Docker**: `pt-core serve --host 0.0.0.0 --site /app/site`, serving
  the normal `pnpm build` output where the image used to run
  `next start`.
- **Desktop**: the same axum server embedded in the Tauri process on
  loopback, where the Node sidecar used to run. HTTP stays the only data
  interface: the same frontend build ships in both distributions, and
  Tauri IPC remains reserved for genuinely native calls (cfgutil, Touch
  ID, updater).

`core/` is a standalone crate, deliberately **not** a workspace root, and
`src-tauri/` keeps its own independent Cargo build.

## How it landed on `main`

The crate was built on `main` while it was inert: no shipped artifact
built, imported or ran it. The Docker image, the Tauri bundle and
`pnpm build` never compiled it; it declares its own empty `[workspace]` so
it cannot disturb `src-tauri`'s cargo build; and it adds no npm
dependency. That gave every phase continuous CI (`core-parity`) and small,
reviewable PRs. The first plan kept every phase on a long-lived
`rust-core` branch until the cutover, and three and a half weeks in, with
no Rust written yet, that branch was already 87 commits behind `main`:
the "two brains during the transition" debt the design study ranks
fourth.

That inertness was **enforced, not assumed**:
`tests/app/rust-core-inert.test.ts` failed if any shipping path (`app/`,
`lib/`, `proxy.ts`, `next.config.js`, `instrumentation.ts`,
`src-tauri/src/`, the Dockerfile, the standalone staging script) started
referencing the core. It runs in `pnpm test`, inside the required
`quality` job; `scripts/parity/**` is exempt, because those harnesses
exist to drive the core. Phase 6 narrowed it in the same commit as each
piece of wiring, so every change to it was visible in review. It now
keeps the core off the Node paths, so the rollback stays Node, and batch
7 deletes it along with them.

Phase 0 (page shells + the `scripts/parity/` and `scripts/bench/`
harnesses) landed on `main` for the same reason and remains there.

**Batches stack while the previous one is in review.** A batch that
depends on an unmerged batch branches from that batch's branch and targets
it, not `main`, and stays in draft. Merge the oldest first, rebase its
child onto the updated `main`, retarget the child and let its checks rerun
before marking it ready; repeat down the stack. Never merge a dependent PR
into an already-merged feature branch.

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
6. **(in progress)** The desktop cutover (embed axum, drop the Node
   sidecar), then the Docker cutover straight after, with no release
   between them; both have landed. What remains is the first release on the
   Rust backend, v0.3.0, and later batch 7, which deletes the Node paths:
   the desktop sidecar, the Node Docker stage, and the inert test with them.
   The first phase that was not inert; see "Status — Phase 6" below. Its
   binaries ship the third-party notice in `core/V8-LICENSE` (the
   `Date.parse` port in `jsdate` and the `JSON.parse` error port in
   `jsjson`) alongside `NOTICE`.

## The gates (how the two implementations are compared)

**Parity** — `scripts/parity/parity-diff.mjs --a <nodeURL> --b <rustURL>`
(on `main`): seeds both servers identically (focus, profiles, canned
sample data), replays the same request manifest against both, normalises
volatile fields (timestamps, UUIDs, durations), and fails on any
remaining byte difference. Self-test: two Node instances must diff to
zero, and the Rust server holds the same zero. Additionally, the whole
Playwright suite and the local visual net run against either backend
unchanged, because they only speak HTTP: CI runs the suite on Node in
the `quality` job and on the core in `e2e-rust`, on every PR.

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
  upgrade cleanly — and can roll *back* to the Node build, which stays
  buildable until a Rust release has shipped cleanly.
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
`pending_search` heal, the stuck-`running` reset, the repair of analyses an
audit-bundle import stored as `'ok'`, the `privacy_policy_versions`
seed). The big CREATE block is lifted verbatim from `db.ts` by
`core/scripts/extract-schema.mjs` into `core/src/schema_sql.rs` (generated,
checked in) so it cannot drift; the orchestration and short ALTER lists are
hand-ported in `core/src/db.rs` in db.ts's exact order.

**What the migrator leaves out:** the feature-flag data migration
(`lib/migrations/v1_feature_flags.ts`). It is instrumentation-driven, so it
belongs to the server's boot rather than to opening the database, and
Phase 6, batch 2b ported it there. The parity gate compares a
db.ts-opened database against a pt-core-opened one, neither having run
the feature-flag migration, so the comparison stays apples-to-apples.

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

**`?devices=` was missed here.** Every branch after the two `?id` ones
also runs under the request's device scope, and this port ignored it (and
kept the last of a repeated param, where Node keeps the first) until the
Playwright suite ran against the core in Phase 6, batch 3b.

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

Not ported here, because they are write routes: the `DELETE` that clears
the rings and the `POST` that toggles profiling. The writers phase ported
them (Phase 4 batch 5a, the maintenance writes).

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

- **Repeated slashes.** Next normalises `/api/health//` in its router before
  middleware, so Node answers a header-less 308 to `/api/health/` and needs
  a second hop. The Rust gate used to strip the whole run at once; since
  Phase 6, batch 3a the router's repeated-slash 308 comes first here too
  (`frontdoor.rs`), so both take the same two hops.

Since batch 3a, too, the redirect carries what Next's does: `Refresh:
0;url=<loc>`, the location echoed as the body, the security headers and the
canonical page's CSP.

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
`classify_change` mirrors Node's `classifyChange`: only the five ChangeEntry
diff types are governed by a flag at all, and the two `added` shapes are
told apart by the `New privacy label: ` description prefix rather than by
`details`. Both rules changed in Node before this port was updated to
match; see the CHANGELOG's Unreleased "Fixed" entry.
Preferences answer the four resolved flags, then the nine camelCase types
Settings and the bell read: the legacy blob over the defaults, with label
changes and policy updates taken from their flags. They fall back to the
legacy stored booleans alone when the resolver throws.

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

Regenerate the 118 fixed-clock Node handler scenarios with:

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

**The unread count, streamed.** The pre-cutover load test (PR #313) put
`GET /api/notifications` at 2.4 times Node's latency, the only read that
far off. The page was not the cause; the unread count was.
`flag.notifications.types.policy_updates` is off by default, so every
fresh install takes `getUnreadCount`'s slow path: each unread row's
`change_summary` is parsed and run through the type filter, and the rows
it leaves something in are counted. The port did that with the page's
helpers, so each row became a `Value`, was renormalised to JavaScript's
numbers and key order, and had its surviving entries copied into a new
list, only to be counted. On the seeded 5,000-app fleet (20,000
notifications, 10,000 unread) that was about 17 of the handler's 21 ms,
where Node spends 2.2 ms in SQLite and 3.1 ms in `JSON.parse` over the
same rows. The query plans were not the difference: `EXPLAIN QUERY PLAN`
shows the same index scans on SQLite 3.46 (the core) and 3.53
(better-sqlite3).

`unread_count.rs` now borrows each row's text from SQLite and streams it
through serde_json with visitors that keep only what the filter reads, and
`classify` is shared by the page and the count. No tree is built and
nothing is copied, beyond serde_json's scratch buffer for a string with
escapes in it. Every value still goes through `deserialize_any`, so
strings, numbers and nesting depth are checked exactly as they are for a
`Value`; `IgnoredAny` would be faster, but it skips those checks and would
count rows the full parse rejects. Two differences are deliberate, and
both move toward Node. An object whose first key is serde_json's private
`RawValue` token is an ordinary object here, where a `Value` re-parses the
string it holds (axum turns on the `raw_value` feature). And invalid UTF-8
is replaced, as better-sqlite3 replaces it, where rusqlite's `Value`
conversion panicked.

Measured as the load test measured it: one Mac, one backend at a time,
each over its own fresh copy of the fleet, `PRIVACYTRACKER_RUNTIME=desktop`,
three warm-ups and then 20 sequential requests. Each figure is the median
of the p50s of 15 such runs, from three interleaved launches of each
server.

| `GET /api/notifications`, p50 | Before | After |
|---|---|---|
| Rust (`pt-core serve`, release) | 21.8 ms | 6.0 ms |
| Node (`next start`) | 7.8 ms | 7.8 ms |

All three servers returned byte-identical bodies (8,727 bytes). In
process the handler now takes 4.6 ms, of which SQLite's walk over the
unread rows is 1.8 ms. One thing noticed on the way and not changed here:
better-sqlite3 builds SQLite with a 16 MB page cache
(`DEFAULT_CACHE_SIZE=-16000`), while the core's bundled SQLite keeps the
2 MB default. That walk takes 1.4 ms with the larger cache instead of 1.9,
and the setting would apply to every read.

**Gates.** Five unit tests in `unread_count.rs` hold the stream to the old
parse-and-filter answer under all 16 combinations of the type flags: 76
hand-picked rows (the oracle's malformed shapes, `length` edge cases,
repeated keys, escapes, and every kind of input a `Value` refuses, each
beside an entry the filter can drop, so that a laxer parse would change
the answer), nesting around the depth limit, 4,000 generated rows (a third
of them damaged a character at a time), the `RawValue` token, and a walk
over real rows with a BLOB, invalid UTF-8, read rows and quiet hours. The
118 content cases, all 321 crate tests and the live gate
(`read-parity.mjs`: 196 checks and its content probes) pass. Eight
negative controls, each a single mutation, were all caught: skipping with
`IgnoredAny`, the first repeated key winning, -0 not counting as zero,
`null` entries ignored, no trailing-input check, non-object entries
dropped, the two categories swapped in the shared `classify` (which only
the Node oracle and the walk's fixed counts can see, since both paths
share it), and quiet hours dropped from the walk. Six of them also failed
tests beyond the ones predicted: the generated corpus caught five, and the
nesting test and the walk's fixed counts two each.

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
cutover (ported in Phase 6, batch 2a), and the AI routes with Phase 5.

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
projects four booleans onto flag overrides, reading `labelChanges` and
`policyUpdates` (what Settings sends) when the snake_case key is not a
boolean. It writes only the flags whose value the body changes, both
resolutions read before the first write: a change onto the flag's focus
default clears the override and any other change sets one, while a flag
the body leaves out is not touched. The camelCase keys are merged into
the legacy blob, a stored key keeping its place. When the resolver
throws on a garbage audience it sets every value the body carries and
answers from the legacy blob instead. The focus
write is one transaction of seven rows; the profile and layout writes
record an activity row only across a preset boundary, with the previous
state read before the write. The override clear with `?surface=` (empty)
clears everything and reports scope `""`. The locale cookie carries the
`Expires` Next derives from `Max-Age`.

**The oracle — `core/scripts/extract-writes-cases.mjs`.** Runs the REAL
handlers over 266 requests with a frozen clock, counted ids, a distinct
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

**What this batch left out.** `summarizePolicies: true` on
`/api/scrape` and the deferred policy-source fetch a successful import
or scrape arms (`schedulePostAppUpdatePolicyFetch`) are the policy
pipeline, ported in Phase 5 batch 4b (the policy triggers) with an oracle
of their own. This oracle still holds the `policy_sync_running` mutex in
every case, so Node's timer, when it fires, finds the runner busy and
writes nothing.

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

### Batch 4a — the sync runner and the scheduler (+4 handlers, 3 tickers)

`core/src/server/sync_runner.rs` ports `lib/sync-bulk-runner.ts` and
`lib/sync-bulk-state.ts`: the durable state blob under
`sync_bulk_state`, the `sync_running` mutex, `buildInitialSyncQueue`,
and `runBulkSync` — the per-app loop that marks each entry in flight and
persists it before any work, re-reads the app row at dequeue time,
resyncs it, and on Apple's first 429 marks that entry and every pending
peer as rate-limited and stops, still clearing the state and the mutex
so the next tick starts fresh; the no-op run over an empty fleet, the
summary row with `last_auto_sync` stamped only on a real completion, and
the outer catch that leaves the state and mutex for the next boot. Over
it, `runScheduledSync` (busy answers `skipped`) and the three callers
Node gives it: `POST /api/sync/trigger`, the scheduler's 30-minute
`check` with its in-memory failure backoff, and the boot-time
`resumeAppStoreSync` — a stale lock or a finished blob healed with a
`__sync_resume__` notification and an activity row, pending work resumed
with a resume notification and the run itself. Beside them, the boot
writes `register()` makes (the runtime marker, the stale import-queue
and health-check locks cleared) and the import-queue drain tick over
batch 3's `runImportQueueTick`. `core/src/server/runner_writes.rs` adds
`POST /api/dev/sync-stop`, `DELETE /api/rate-limit/status` and
`DELETE /api/apps` (import rows tombstoned and their imports recounted
inside the delete's transaction).

**What this batch adds.** A run that outlives its request: the runner
takes a `Clock` (live on the server, frozen in the replay) rather than
the request's instant, and takes the lock per section — the seed and the
mutex before the first scrape, one section per app for the in-flight
mark and the row lookup, the scrape's preparing reads, the network with
the lock released, then the commit and the state write together. A JSON
blob whose key order is pinned by the code that creates it: every entry
key is created, undefined or not, when the entry goes in flight, and
`JSON.stringify` omits the undefined ones, which is a struct of `Option`s
in that order (the rate-limit branch assigns `outcome` before `error`,
yet `error` serialises first — pinned by a unit test). Background work
on the server: `start_background` runs the boot writes before serving,
then spawns the resume check at 10 s, the scheduler check at 15 s and
every 30 minutes, and the drain at 20 s and every minute, each over the
same accessor the routes use.

**The oracle — `core/scripts/extract-runners-cases.mjs`.** Runs the REAL
handlers and, new here, the startup hook as itself: `setTimeout` and
`setInterval` are captured while `register()` runs, so the scheduler
check, the drain and the sync resume are Node's own closures, invoked
with the clock frozen; the resume spawns its run without awaiting it,
and the oracle waits for the mutex to clear before it dumps. Boot cases
run `register()` again inside the case. 52 cases: the trigger over a
busy mutex and a leftover blob, an empty fleet, a fleet with one changed
app, a failed app, Apple's 429 on the first and on the last app, an app
without a URL, and the burst; the stop with and without a configured
token; the cooldown clears and every body branch; the app delete with
tombstones, without import rows, on an unknown id, the id validation,
the token and the burst; and the boot and callback cases — nothing stuck,
the two stale locks, the schedule not due, due, due but busy and not yet
due, the drain, and the resume over nothing, a stale mutex, a finished
blob, a crashed run (the in-flight app redone) and a queue naming a
deleted app. `core/src/server/runners_tests.rs` replays each through the
same accessor.

Live: `read-parity.mjs --mutate` — 178 read checks, then 45 mutations
with the stop and the cooldown clear joining the pass, PARITY OK. The
trigger re-scrapes the fleet against Apple and stays quarantined, and
the app delete is a teardown entry the mutate pass never runs; both are
gated by the oracle alone. The tickers now run on the Rust server too,
so the import-queue fields the differ already treats as tick noise move
on both sides.

Rust suite: 214 pass (211 + 3 new). Negative controls, each predicted
from the fixture before it ran: not counting the pending peers on a 429
failed exactly the one run with peers left; stamping `last_auto_sync` on
a rate-limited exit failed exactly the two rate-limited runs; skipping
the health-check lock clear failed exactly the one boot with it stuck;
and silencing the resume notification failed exactly the four resume
cases that raise one. Each fault was removed before the final passing
run.

### Batch 4b — the bulk Wayback import (+3 handlers, 1 ticker)

`core/src/server/wayback_runner.rs` ports `lib/wayback-bulk-runner.ts`
and `lib/wayback-bulk-state.ts`: the `wayback_bulk_state` blob (v1 blobs
upgraded on read), the `wayback_import_running` mutex, `buildInitialQueue`,
and `runBulkWaybackImport` — each app marked in flight and persisted
before any work, its row re-read at dequeue time, the archive walk with
a `target` frame per outcome, the app row and frame on completion; on a
throttling archive the entry put back to pending and un-counted, one
backoff (the archive's Retry-After bounded to 1–120 s) and a retry of the
same app, a second strike parking the queue with `pauseCause:
"rate_limited"`; the pause and the cancel a PATCH wrote, read back from
disk at every app boundary; the clean completion with its summary frame,
row and audit; and the outer catch that leaves state and mutex for the
next boot. Over it, the routes in `runner_writes.rs` — `POST
/api/wayback/import-all` buffered and streamed, with `?force=1`
discarding a paused queue or a stale lock first; `PATCH` with `pause`
(requested while a run holds the mutex, immediate otherwise), `cancel`
(requested and the run told to stop, or the queue cleared) and `resume`
(the run spawned off the request); `DELETE` for every wayback row — and
the boot-time `resumeWaybackImport`: a paused queue left for the user (a
pending pause settled), a cancelled or finished queue cleared, a stale
lock healed with a `__wayback_resume__` notification, pending work
resumed with a resume notification and the run itself.

**What this batch adds.** A run that outlives its request and streams:
the streamed POST and the resumed run are spawned as tasks that own an
accessor, fetcher, id source and clock detached from the request's
(`DbAccess::detach`, `Fetcher::shared`, `Ids::detach`), and the frames go
down an unbounded channel the response body streams as NDJSON. Node
starts such a run synchronously inside the request up to its first
fetch, so the spawn yields once before the handler carries on — which is
also why the resume's response summarises the persisted blob rather than
the route's copy: Node summarises the very object the runner has begun
mutating. Cancellation as a token per run: the PATCH cancels it, and the
runner selects on it around the archive walk and the backoff sleep,
dropping the in-flight request the way the abort controller does. A state
blob Node mutates key by key, where `undefined` assignments create keys
that `JSON.stringify` omits: kept as a `Value` with an undefined sentinel
and stripped on write, so every path's key order — resumed blobs
included — falls out of the same operations. Progress frames from the
history import: `import_app_history` takes an optional sink fed from the
same array its result carries.

**A Node behaviour pinned rather than fixed.** A pause requested while an
app is in flight is written to disk, then overwritten by the runner's
own post-app state write before the boundary check reads it back, so the
run carries on; the pause that takes effect is one that lands during the
backoff sleep. The oracle records both, and the port reproduces both.

**The oracle — `core/scripts/extract-wayback-runner-cases.mjs`.** Runs
the REAL handlers and, as batch 4a did, the startup hook's own 8 s
closure. Cooperative control mid-run is exercised through the network
stub: a case's `hooks` name a fetch at which the stub first calls the
PATCH route — a cancel then aborts that request, reported the way `fetch`
reports an aborted one — or, with `afterMs`, a moment after the reply is
served, during the backoff sleep. 46 cases: the POST busy on the mutex
and on a leftover blob, over no apps, over two apps, throttled once
(backoff, retry) and twice (paused), with one app failing, forced over a
paused queue, a stale lock and a running one, cancelled mid-run, the
overwritten pause and the backoff-window pause, and the burst; the same
run streamed, streamed and cancelled, streamed and throttled; every PATCH
branch; the DELETE; and the resume over nothing, a paused queue, a
pending pause, a cancelled queue, a stale lock, a finished queue, a
crashed run (the in-flight app redone) and a queue naming a deleted app;
and, appended with the fix that records a resumed run's initiator, the
PATCH resume of a queue a restart had resumed, which is the user's run
again (`manual`, not `resume`).
`core/src/server/wayback_runner_tests.rs` replays each through a shared
id counter and a hooked fetcher that issues the same PATCH at the same
fetch (stalling a cancelled request as an aborted one never returns) and
yields once per fetch, as Node's stub resolves on the next turn.

Live: the POST is quarantined in the manifest (it crawls archive.org),
and the PATCH and DELETE have no manifest entries; all three are gated
by the oracle alone. The gate itself changed shape for this batch: the
core now boots the same healers Node does, and its first run against
the harness healed a "broken blob, held mutex" fixture the operations
probes plant — a row Node never writes, because its healer ran at its
own boot, before the fixture existed. `read-parity.mjs` therefore waits
for the core's boot timers (the import-queue drain's stamp at 20 s)
before seeding the simulated unfinished jobs, and seeds them on both
sides with one clock, as it already waited out Node's timers.

Rust suite: 217 pass (214 + 3 new). Negative controls, each predicted
from the fixture before it ran: dropping the frame for a target with no
capture failed exactly the one streamed run over an empty index; not
reading the control status back from disk failed exactly the three runs
a mid-run cancel or backoff-window pause controls; resuming a paused
queue at boot failed exactly the two boot cases with one; and pausing
on the archive's first strike instead of the second failed exactly the
four throttled runs. Each fault was removed before the final passing
run.

### Batch 5a — the health check and the maintenance writes (+13 handlers, 1 ticker)

`core/src/server/health_check.rs` ports `lib/health-check.ts`: the
`health_check_running` lock with its five-minute stale takeover; the
three bulk-job locks cleared only when provably dead — held, and with no
state blob, no pending work, or no progress in longer than the stale
margin, never a paused or cancel-requested queue — each release and
clear in one transaction; the import-queue lock cleared by its own age;
the PASSIVE WAL checkpoint past the configured cap and the reset of
policy runs stuck longer than the configured hours, both skipped while a
bulk job is active; the read-only figures (the database snapshot, the
opt-in size-gated integrity scan, the process, the row counts, the
orphan counts); the warnings and the status they derive; the persisted
result and its `health_check` activity row, written last so the row
count never includes it. Over it, `core/src/server/maintenance_writes.rs`
— the Node routes in order: `POST /api/diagnostics/health` with its
completion audit; `POST /api/diagnostics/database` running the integrity
scan and answering the snapshot with the cached outcome folded in;
`DELETE /api/diagnostics/errors`; `DELETE /api/diagnostics/runtime`
(the slow-query ring, the lag histograms and the HTTP timings cleared)
and `POST` (the profiling toggle, now live in the envelope and in the
profile hook); `DELETE /api/ai/debug-log`; `POST
/api/auth/admin-token/login` — same-origin, the global brute-force
backstop skipped for a caller already holding a valid token, the
per-address limit, the constant-time compare, the eight-hour HttpOnly
cookie marked Secure when the request arrived over HTTPS — and `logout`;
`POST /api/csp-report`, both the legacy and the Reporting API shapes
summarised into the ring, newest first, fifty kept; `POST
/api/dev/reset-changelog`, `seed-notification` (the quiet-hours deferral
included) and `wipe-apps`; `POST /api/reset` and `POST
/api/admin/start-over`. The server runs the 60 s tick and the daily
cadence `register()` arms, gated by `health_check_enabled` as the
scheduled run is and the manual one is not.

**What this batch adds.** The inline guard generalised: the batch-1
shape (a bare `Rate limit exceeded`, no audit on the 429) becomes one
case of a guard that carries the route's own window, message, optional
429 audit and 401 detail, which is how `/api/reset`'s inline pair —
audited on the 429, no `Retry-After` — sits in the same table as the
diagnostics routes'. The login and the CSP report run their guards in
`precheck`, where the headers are, and the request now carries its
headers and the process to the handler: the cookie takes the scheme the
request arrived on, and the two runtime writes answer this server's own
envelope. Figures that belong to the process and the file: the oracle
blanks them as it records, wherever they appear — the wire, the
persisted blob, the activity detail — so regenerating the fixture on
another machine is byte-identical, and the replay blanks the same keys
on its own side; the counts, the heals, the warnings that derive from
rows and the status are compared exactly. The runtime envelope the two
runtime writes answer is compared by status alone and is not recorded. Process state Node keeps in modules — the
integrity cache, the profiling flag, the login-failure window — lives in
the same globals, with test hooks that reset them per case as the oracle
reset Node's.

**The oracle — `core/scripts/extract-maintenance-cases.mjs`.** Runs the
REAL handlers and the startup hook's own 60 s closure captured from
`register()`, with the CSP and error rings, the login counter and the
event-loop monitor reset before each case and a distinct forwarded
address per case. 106 cases: the health check clean, over each dead lock
(orphaned, finished, silent for seven hours), over a live run, a paused
Wayback queue and a fresh import-queue lock, resetting stuck policy runs
while leaving the live and the never-started ones, with the integrity
scan enabled and size-refused, skipping its heals while a policy run is
live, warning on caps and orphans, under custom thresholds, busy on a
fresh lock and taking over a stale one, plus the admin and rate-limit
refusals; the database scan with its flag missing and the body refusals
every bounded reader shares; the error clear seeded and empty; the
runtime clear and both profiling toggles; the AI-log clear; the login
without and with a foreign origin, unconfigured, succeeding over HTTP and
HTTPS, with a wrong, blank and non-string token, and rate limited; the
logout; the CSP report in each shape, bare, bodiless, non-object,
unparseable, oversized and throttled; each dev helper over the corpus
and empty, without a configured token, and bursting; the reset and the
start-over over the corpus, during a sync, and refused. Every case
records the wire response with its `Set-Cookie`, the write stream,
nineteen tables and the CSP ring. `core/src/server/maintenance_tests.rs`
replays each under the oracle's timezone through a shared recording, a
process state built for the case, and the volatile-key blanking above.

Live: `read-parity.mjs --mutate` now covers the seed, the CSP report,
the four diagnostics writes, the AI-log clear, the login, the logout and
the changelog reset; the wipe, the start-over and the reset are teardown
entries in the manifest, gated by the oracle alone. The core now runs
the 60 s health tick Node runs, which would heal the operations probes'
"broken blob, held mutex" fixture the way the batch-4b resume did, so
the gate's boot-timer wait covers the health check's stamp as well as
the drain's — the same 65 s the Node side is given. And the stored
result the health GET serves is no longer the one blob copied to both
sides: the core's tick overwrites its copy with a run of its own, so the
gate primes a manual run on each side after the boot timers and before
the unfinished jobs go in, and compares the two results with each
process's own figures, its clock and its activity count blanked — the
verdict, heals, warnings and row counts must agree. Latest pass: PARITY
OK, 178 read and 55 mutation checks.

Rust suite: 218 pass (217 + 1 new). Negative controls, each predicted
from the fixture before it ran: clearing a paused Wayback queue as dead
failed exactly the one health check over a paused queue; never marking
the login cookie Secure failed exactly the one login over HTTPS; cutting
a CSP report's document URI at 64 characters failed exactly the one
report with a longer one; and leaving `app_settings` out of Start Over
failed exactly its four cases, the burst included. Each fault was
removed before the final passing run.

### Batch 5b — the backup routes (+6 handlers, 1 ticker)

`core/src/server/backup.rs` ports `lib/backup.ts`: the export — every
table of the insert order that exists, read in one transaction, the AI
key and the webhook destination blanked at the source — signed with the
install's key; `parseEnvelope` with its errors in Node's order and its
tolerance (an array for a payload or for `tables`, a table that is not
an object, columns derived from the first row); `summarizeBackup` with
unknown tables warned about and sorted last by `localeCompare`; and
`restoreBackup` — the signature verified before anything is touched, the
prior counts taken, foreign keys turned off AROUND one transaction that
wipes children-first and inserts parents-first, only the columns that
still exist, every row through the sanitiser whatever the envelope's
trust (the `flag.devopts.` and `AUDITOR_` settings dropped and counted,
every stored URL through `sanitizePolicyUrl`), `foreign_key_check`
vetoing the commit, enforcement put back as it was found.
`backup_snapshots.rs` grows the rest of `lib/backup-snapshots.ts`: the
settings save with its coercions and clamps, the snapshot written 0600
to a temp name and renamed into place, the collision suffix, the
last-run stamp, the prune past the retention count, the activity row,
and the "is one due yet?" check. Over them, `backup_writes.rs` — the
Node routes in order: `PUT` and `POST /api/backup/snapshots`, `GET
/api/backup/snapshots/[filename]`, `GET /api/backup/export` with its
audit row on every outcome, `POST /api/backup/preview`, and `POST
/api/backup/restore` with its own: rate limited, unauthorised, bad
request, untrusted, format error, failed, and the success row that
carries the prior counts. The server runs the 35 s snapshot tick and the
30-minute cadence `register()` arms.

**The signature is the contract.** An install changes backend and keeps
its data directory, `backup-signing.key` included, so a backup signed by
one server has to verify on the other or every existing backup turns
"untrusted" at the cutover. The MAC is HMAC-SHA256 over
`canonicalize(envelope)`: object keys in `Array.prototype.sort` order —
UTF-16 code units, which is not code-point order past the BMP — arrays
in place, every scalar as `JSON.stringify` spells it. The Rust side
feeds the same bytes to the MAC a row at a time, so a hundred-megabyte
backup is never copied whole, and spells numbers through the one
serializer every response already uses. The key file is read the way
`Buffer.from(s, "base64")` reads it (either alphabet, strays skipped,
the first `=` ends it) and minted from the OS CSPRNG, 0600, only when a
signature is actually about to be made or checked: an unsigned upload
mints nothing. `ring` is the one new direct dependency and adds no
crate — it is already the crypto provider under reqwest's rustls.

**What this batch adds.** A second serializer, because a person opens
these files: `JSON.stringify(v, null, 2)` is `serde_json`'s pretty
layout with the JavaScript number spelling, and the replay holds the
snapshot files to Node's bytes by SHA-256. better-sqlite3 binds every
JavaScript number as a DOUBLE, so a number restored into a TEXT column
reads `34.0` on Node; the restore binds doubles too, and an INTEGER
column takes an integral one back by affinity. Two places where uploaded
or requested text would otherwise reach a sink are written so that it
cannot: the download never joins the requested name onto a path — it
compares it with what `backups/` lists and opens the entry it found —
and the restore's INSERT is built from the live schema's own column
strings, the backup choosing only which and in what order. The restore's
"a sync is running" answer is a `precheck`, because Node gives it before
reading a body that may be a hundred megabytes. The data directory and
the key source come from `backup::env()`, which the replay points at a
directory of its own per case.

**The oracle — `core/scripts/extract-backup-cases.mjs`.** Runs the REAL
handlers and the startup hook's own 35 s closure. Unlike the other
oracles it does not wrap a case in a SAVEPOINT: `PRAGMA foreign_keys` is
a no-op inside a transaction, so under one the restore would run with
enforcement ON and a bad backup would fail on its INSERT instead of at
`foreign_key_check` — not what production does. Each case wipes every
table and the data directory instead, writes a fixed signing key (or
none, where minting it is the case, with `randomBytes(32)` counted), and
seeds snapshot files with fixed mtimes. 101 cases: the settings saved,
clamped both ways, rounded, from strings, junk, `null`, a boolean and an
array, partial, over a directory with a hand-named file and a stranger,
and the body refusals; the snapshot over an empty install and the
corpus, minting the key, replacing one too short, reading one with stray
whitespace, pruning, ranking a hand-named file by its mtime, colliding
within a millisecond, and bursting; the download, its attachment name
sanitised per UTF-16 unit, and each refusal including two traversals;
the export, its audit detail counting UTF-16 units; the preview over an
export, unknown and malformed tables, and each format error; the restore
trusted, tampered, unsigned, under another algorithm, with a MAC only
`Buffer.from` would read, signed elsewhere, allowed by query and by
header and not by another spelling, sanitising a hostile backup (signed
by the oracle, and asserted trusted by the real verifier), aborting on a
foreign-key violation, a missing column and a duplicate key, emptying
the install, refusing during a sync before it reads the body; and the
tick disabled, due, not yet due, due to the millisecond, and over an
unreadable last run. Every case records the wire response with its
download headers, the write stream, all twenty-eight tables, the
`backups/` directory afterwards by name, size and SHA-256, the key file,
and that enforcement is back on. `core/src/server/backup_tests.rs`
replays each. Two figures cannot be pinned and are handled on both
sides: the data directory is spelled `<DATA_DIR>`, and a snapshot named
by a collision lists by its real mtime.

Live: the snapshot settings write and the manual snapshot join
`read-parity.mjs --mutate`. The other four stay quarantined in the
manifest — they move files, and the restore replaces the database — and
are held by `scripts/parity/backup-probes.mjs` instead, after every
other pass because it is destructive. Node mints the signing key BEFORE
the data directory is copied, so both servers hold one key; then each
server's export is compared for headers, tables and columns, the Rust
bytes are held to `JSON.stringify(v, null, 2)` of themselves, each
export and seven hand-made uploads (one of them 3 MiB) are previewed on
both servers and must answer identically, a snapshot is created and
downloaded on each, and four missing and traversing names must be the
same 404. Then the restore, which allows three attempts in ten minutes,
so three is what the probe spends. The parity fixtures plant a
deliberate orphan — a verdict for an app that does not exist — so an
export of that install is a backup the restore must refuse: uploaded to
both, it has to get PAST the signature gate on each (an untrusted backup
is a 409 and never reaches the check) and abort identically at
`foreign_key_check`, with nothing written. With the orphan removed from
both databases, **each server's export is restored into both**, and must
come back `trusted` from the backend that did not sign it, with the same
per-table counts. Last, both servers export again and every table but
the audit log must hold the same rows. (The refusals of a tampered,
unsigned or foreign-signed backup are pure functions of the upload and
the key; the oracle holds those.) Latest pass: READ PARITY OK — 178
read, 57 mutation and 26 backup checks. The probe's first run is worth
recording: it failed, on BOTH servers alike, because nobody had asked
whether the parity install was restorable — Node's own restore refuses
its own export of it, for that orphan. And one live negative control,
because the fixture cannot show that the PROBE can fail: with the
canonical keys left unsorted in the core and nothing else changed, the
gate failed exactly the four checks predicted — the orphan check (Node
answered `untrusted_backup` to the core's export instead of reaching the
foreign-key check), both trusted restores (each backend refused the
other's signature and accepted its own) and the round trip — while all
178 reads, all 57 mutations and the other 23 backup checks passed.

Rust suite: 223 pass (218 + 5 new). Sixteen negative controls, each
predicted from the fixture before it ran. Leaving the canonical keys
unsorted failed the fifteen cases whose rows are not already in key
order — every signed export over the corpus and every trusted restore —
and none of the empty-install ones, whose only rows are `key`, `value`.
Binding restored numbers as integers, restoring the denied settings and
switching the URL sanitiser off each failed exactly the one hostile
restore; leaving foreign keys on failed exactly the foreign-key abort;
removing the precheck failed exactly the restore during a sync; a base64
reader that stops at a stray failed exactly the `Buffer.from` MAC;
minting a key for an unsigned upload failed exactly that case; accepting
any `allowUntrusted` failed exactly the other-spelling refusal; a
strictly-after due check failed exactly the to-the-millisecond tick;
replacing the attachment name per character failed exactly the download
with an emoji in its name; counting the export's bytes failed exactly
the three exports over the corpus, which holds an emoji and a snowman;
not blanking the secrets failed the six exports and snapshots over the
corpus; never pruning failed the four retention cases; not warning about
unknown tables failed the two previews that have one; and writing the
snapshot compact failed all fourteen cases that write one. Each fault
was removed before the final passing run. (One trap for whoever runs
these next: restoring a source file with an older mtime does not make
cargo rebuild, so the last control's binary survives until a file is
touched.)

**What CI found that the local runs did not.** Every replay sets
`PRIVACYTRACKER_BIND_HOST` to loopback and clears the admin token for as
long as it runs, under `trust::env_lock()`. The gate's own tests rely on
the bind host being UNSET — exposure then forces auth — and did not hold
that lock, so one that overlapped a replay saw a loopback server needing
no token and got a 200 where it expected a 401. Six replays had been
racing them already; the seventh made the overlap certain on CI's
four-core runner, twice out of twice, and never locally. The gate tests
now run under the lock (`scenario` in `gate.rs`). A new test module that
reads the environment owes the same.

**One divergence, chosen.** On a case-insensitive volume Node finds a
snapshot whose requested name differs from the file's only in case, and
serves it under the requested spelling; the core compares names exactly
and answers 404. Names are generated, upper-case `T` and `Z` included,
and the UI downloads the name the listing gave it.

### Batch 5c — the audit bundle and the support bundles (+4 handlers)

`core/src/server/audit_bundle.rs` ports `lib/audit-bundle.ts` and
`lib/audit-bundle-import.ts`. The export: every app with its labels, its
accessibility features and its policy summary, the annotations — private
notes excluded in the SQL itself, as on Node, with no path that includes
them — the verdicts, and the recommender's profile with the preset it
matches, under a file name slugged from the recommender's name and
stamped in LOCAL time. The import: `validateBundle` with its errors in
Node's order, the duplicate lookup, and one transaction that upserts
each app unless this install's copy was synced at least as recently,
replaces its labels, keeps an earlier policy summary where the bundle
has none (`COALESCE`), stores the analysis as `ready` when the row ends
up with a summary and `source_ready` when it holds only the excerpt,
adds the annotations, upserts the verdicts it
recognises, stashes the recommender's profile as a suggestion — never
applying it — and writes the import-history row. Every URL a bundle
carries goes through the same sanitisers as on Node before it is stored.
`bundle_writes.rs` is the four routes in order: `POST
/api/export/audit-bundle` (admin token, rate limited, allowed when the
flag resolves on OR the focus workflow is the hand-off one, the body
optional, `audit_bundle_last_exported_at` stamped), `POST
/api/import/audit-bundle` (a preview unless `?confirm=1`, a 409 naming
when the earlier import landed unless `allowDuplicate=1`, the
`bundle_imported` activity row), and the two reads a person attaches to
a bug report, `GET /api/diagnostics/bundle` and `GET
/api/deployment/support-bundle`.

**An upload is a form.** The real client posts the bundle as
`multipart/form-data`, which no route before this one took, so the body
reader grows `BodyOutcome::Raw` and `multipart.rs` parses it — by hand,
following the steps of the parser Node itself bundles (undici's), so
that the two agree on what a malformed form is: a preamble and an
epilogue ignored, a body that ends where the next boundary starts, a
part that is a file only if it says `filename`, a file's byte-order mark
dropped before it is read as JSON. No dependency was added for it.

**What this batch adds.** better-sqlite3's binding rules, where a bundle
can reach them: a bundle is a stranger's JSON, and the importer binds
its values as they come. A number binds as a DOUBLE, so
`"current_version": 3` reads `3.0` from its TEXT column on both;
`undefined` and `null` bind NULL;
a boolean is a `TypeError` and an object is read as named parameters —
each rolls the import back with Node's words, and the write stream
records the statement that was refused (`Writer::refuse`). The `Ids`
trait grows `hex_id`, the `randomBytes(n).toString("hex")` ids the
importer mints, counted in the replay like every other id. The 409's
sentence carries `toLocaleString()` of the earlier import, spelled here
as en-US writes it — `1/5/2026, 12:05:09 AM` — by hand, since nothing in
the crate formats a 12-hour clock. And the diagnostics bundle reports
each bulk job as the runners' own `describeCurrentRun()` does — the
whole state blob, not the trimmed projection the job routes serve
(`operations::describe_run`).

**The oracle — `core/scripts/extract-bundles-cases.mjs`.** Runs the REAL
handlers, each case in a SAVEPOINT, under a frozen clock, UTC and
counted ids. 96 cases. The export: refused under the default focus,
allowed for a loved one, a guardian, the hand-off workflow and a user
override, refused by an override; an empty install; no body, a
whitespace body, an array, a number, a string, `null` (a 500) and
invalid JSON; names plain, slugged, slugging to nothing, accented, empty
and `null`, and one that is not text (Node throws; an empty 500); the
profile left out, matching a preset, custom; the migration flag; the
size limit declared and streamed; the admin token; the sixth export in a
window. The import: previewed as JSON and as a form, over an earlier
import, of a bare version-1 bundle; committed onto an empty install, as
a form, merging by last sync, an excerpt merged over a stored summary
and over text never summarised, twice in a row, refused as a duplicate in
the morning and in the afternoon, allowed again (and not by
`allowDuplicate=true`); a bundle from a newer app refused, with and
without an app version, and forced past; eighteen validation errors; a
bundle crafted against the sanitisers — a `javascript:` store URL, a
link-local icon, an `ftp:` policy link and the summary that is dropped
with it, a date that is not one, a blank recommender, an empty profile,
a verdict that is not a verdict, and notes and verdicts for an app
nobody has; an earlier recommendation from the same person replaced; the
profile and the migration marker stashed; an app carrying only the
required fields; an object and a boolean where a value binds; numbers
where text was expected; and forms with no file field, a text field
named `file`, two files (the first wins), a file that is not JSON, a
byte-order mark, nothing but the closing boundary, no closing boundary,
no boundary parameter, another boundary, a quoted one, and one declared
too large. Each records
the wire response with its download headers, the write stream and the
rows of the eleven tables an import can touch. The two support bundles
are machine state, so the oracle records a PROJECTION of them — the
keys at every level, the jobs, the rate limits, the flag overrides, the
redacted errors — over a quiet install and a busy one: a sync mid-run
with its whole queue, one cooldown live and one expired, three
overrides of which one equals its default, failed activity rows whose
fetch diagnostics come back as six named fields with no URL and no
body, and ten failures of which the eight newest come back.
`bundles_tests.rs` replays all of
it; the two support bundles are called directly and projected the same
way.

Live: the two support bundles join `BATCH_1` as volatile reads — the
manifest blanks what is each process's own and compares the rest. The
export and the import stay quarantined, one a download stamped with the
clock and the other an upload, and are held by
`scripts/parity/bundles-probes.mjs` instead, between the mutation pass
and the backup probe: the export refused identically, then the flag
overridden on, each server's export compared for headers and — clock and
per-server ids aside — content, the Rust bytes held to
`JSON.stringify(v, null, 2)` of themselves; then **each server's bundle
is previewed, as JSON and as a form, and imported on both**, refused as
a duplicate in the same words with the clock masked, and imported again
on purpose, the summaries equal throughout; then seven uploads that are
not bundles, each refused identically. Latest pass: READ PARITY OK — 180
read, 57 mutation, 23 bundle and 26 backup checks.

The probe passed on its first run, which says nothing about whether it
can fail, so one live negative control: the core letting an equally new
bundle overwrite (`<=` made `<`) and nothing else changed. The first
prediction was six failed checks and the gate failed ONE, and the
prediction was what was wrong. The importer dates an app that has no
policy summary by the bundle's `exported_at`, not by a sync time of its
own, so an install importing its own fresh export legitimately UPDATES
those apps, on both servers alike, and only the re-import meets the
equal-timestamp rule. The other bundle never met it at all: the core had
answered the export first, its bundle was the older of the two, and
imported second every app in it was already older than what the first
had written. What the second import exercised depended on which server
was quicker. The probe now imports the OLDER export first, and holds
each import to the rule rather than to agreement alone: a bundle newer
than the last must update apps on both servers, and its re-import must
add nothing, update nothing and skip every app. Against that probe the
same fault failed exactly the two checks predicted — each bundle's
re-import — while all 180 reads, all 57 mutations, the other 21 bundle
checks and all 26 backup checks passed.

Rust suite: 229 pass (223 + 6 new). Eighteen negative controls, each
predicted from the fixture before it ran. Exporting private notes, and
cutting no policy excerpt, each failed the twenty-one exports over the
seeded install and none over the empty one. Binding integers failed
exactly the numbers case; letting an equally new bundle overwrite failed
exactly the import twice in a row; unsanitised icon URLs, unknown
verdicts kept, an empty profile stashed and words counted without the
empty ends each failed exactly the crafted bundle; a text field counted
as a file, the byte-order mark kept, `allowDuplicate=true` accepted and
a 24-hour duplicate message each failed exactly their one case; a gate
that ignores the workflow failed the hand-off and the guardian exports;
keeping a fetch's URL failed the busy support bundle; ten errors instead
of eight failed the eight-newest case; dropping overrides equal to their
default, and describing jobs by the routes' projection, each failed the
busy diagnostics bundle; and an export needing no admin token failed
exactly that refusal. Each fault was removed before the final passing
run.

**What the oracle found in Node.** The importer's policy-summary upsert
named a `generated_at` column `privacy_policy_analyses` never had, so
any bundle whose apps carried a summary and a policy URL — which is to
say this app's own export of a summarised library — rolled back with a
500. Fixed on the Node side first, with its own regression tests; the
port is of the fixed statement.

The same statement stored `status = 'ok'`, which is not an analysis
status, so every imported row hydrated as `analysis_error` and the AI
Policy tab reported a failed AI run that had never happened. Fixed on
the Node side as well, then re-recorded: the status follows the summary
the row ends up with, `ready` with one and `source_ready` with only the
excerpt, bound from the bundle on an insert and decided again in the
`ON CONFLICT` against the summary a merge keeps. Six cases change, in
that statement, its new status parameter and the stored status, and
nothing else; the two merge cases are appended last so no earlier case
changes its forwarded address. Rows already stored as `'ok'` are
repaired on open by both migrators (`db.rs` step 15b), and the
schema-parity gate counts statuses so the two cannot repair them
differently.

**Divergences, chosen.** An ARRAY where a value binds: better-sqlite3
spreads it into the parameter list, and what happens next depends on its
length; the core refuses it as it refuses an object. A
`recommender_name` that is not text: Node's `TypeError` wording belongs
to the engine build, so the core answers the same 500 in plain words.
The duplicate message: Node formats it in the HOST's locale and, by ICU
version, with a narrow no-break space before `AM`; the core always
writes en-US with a plain space, and the oracle pins Node to that.

### Batch 5d — the dev seed (+1 handler)

`core/src/server/seed_writes.rs` ports `POST /api/dev/seed-sample-data`,
the route that gives a fresh install something to look at, in its two
modes. **Canned** (`?source=canned`) writes the ten-app demo set in one
transaction: each app under an id derived from its slug (SHA-1, as Node
mints it, behind a leading 9 no real track id has), its declared
accessibility features resolved against the catalogue, its hand-written
policy summary stored as a real `ready` analysis — the source text, its
SHA-256, its word count, the lenses in canonical order — and, where the
fixture has an earlier summary, the two policy versions that make the
change banner render; then the labels, and a back-dated timeline walked
oldest first, each step diffed against the last by the same
`diff_snapshots` a scrape uses and saved as `triggered_by = 'sample'`,
Wayback steps as Wayback rows. All ten or none. **Live** asks the iTunes
top-free chart for a region — `?country=`, else a stored `app_country`
that was actually set, else `au` — and `?limit=` apps of it, read as
`parseInt` reads it, ten by default and twenty-five at most; drops the
entries with no track id or no product link; skips what is already
tracked; runs each of the rest through the `fetch_and_parse_app` an
import uses; adds two back-dated snapshots, sixty and thirty days ago,
with two and then one category trimmed off the FIRST type; and waits
250 ms before the next. Apple's rate limit stops the walk and keeps what
it has. Both modes close with the `reset` activity row and the audit
row. The guard is the strict one: an admin token has to be CONFIGURED
for the route to run at all, loopback or not.

**The demo set is data; what is done with it is ported.**
`core/src/server/sample_apps.json` is written by the oracle from
`lib/sample-apps.ts` — the ten apps, the accessibility catalogue, the
lens order and the lens sentences — and embedded, as `flag_rules.json`
is. CI regenerates it with the fixture and fails on a diff in either, so
a demo app added on the Node side cannot leave the core seeding a
different library. `ring`, already a dependency, supplies both hashes.

**The policy pipeline.** Node's live walk scrapes with
`summarizePolicies` on, so each new app then has its developer's policy
page fetched, hashed and summarised. This batch ported only the branch
of it that is a plain write (an app with NO policy link has its analysis
row deleted, Node's first line), and every page this oracle serves is
such a page. Phase 5 batch 4b replaced that stand-in with the whole
policy step, so a live seed from the core now fetches and summarises as
Node's does; the policy triggers oracle records a live seed whose app
has a link. The canned seed is unaffected: its analyses are fixture
rows, not fetches.

**The oracle — `core/scripts/extract-seed-cases.mjs`.** Runs the REAL
handler, each case in a SAVEPOINT, the network a stub that serves the
case's replies in order and refuses a run that leaves one unused. 55
cases. Canned: onto an empty install, twice, topping up a part-seeded
one, with the region from the query, from a stored setting, from a blank
one and from an unknown one, and failing part-way — a row already
holding the id the seed will mint for its first label, found by running
the seed once — which rolls back and answers 500 in SQLite's words;
`source=CANNED` is not canned. The guard: no token configured (with and
without one sent), none presented, the wrong one, and the thirty-first
seed in ten minutes. The chart request: the default ten, a limit from
the query, capped, zero, negative, not a number and `7.9apps`; the
region from the query, unknown, empty, and from the setting. What the
chart can answer: a rate limit with a `Retry-After`, without, not a
number, zero and fractional; a 503 and a 404; not JSON; no feed; no
entries; a refused connection; entries with no id or no link. The walk:
two apps with history; one category per type (no history); a first type
smaller than the second (trimmed to nothing); no labels; already
tracked, one and all; a chart id that differs from the link's (the
history is read back under the chart's id, finds nothing, writes
nothing); a 404 and a non-App-Store link, each an error row the walk
carries on past; Apple's rate limit mid-walk and a cooldown already
running; a page that cannot be parsed; another region. Each records the
wire response, the raw fetches, the write stream and twelve tables.
`seed_tests.rs` replays them through the same reader, guard and handler
the axum wrapper uses. The 250 ms wait is real time the recording never
sees, and the replay does not take it.

Live: the route stays quarantined in the manifest — its live mode
scrapes Apple — and its canned mode is held by
`scripts/parity/seed-probes.mjs`, which runs LAST because it begins with
a reset. Every other pass serves ONE seeded database, copied from Node,
so the core's own seed was the one write the gate had never watched run.
Here both servers are emptied and each seeds ITSELF. The two libraries
cannot match byte for byte — every label, feature, snapshot and version
has a random id and every app its own clock — so each is reduced to what
the seed DECIDED: every column that is not a random id, every timestamp
as its distance from the app's own `lastSynced`, every category under
its type's natural key. The probe checks the refusal without a token,
the reset, the two responses (the duration aside), that the core's seed
wrote a whole library and a timeline reaching back past thirty days —
two empty libraries would agree perfectly — that the two agree in all
seven tables, and that a second seed inserts nothing. Latest pass: READ
PARITY OK — 180 read, 57 mutation, 23 bundle, 26 backup and 6 seed
checks; 10 apps, 19 types, 52 categories, 40 features, 10 analyses, 2
versions and 25 snapshots on each side. It is also the first time the
gate has run `POST /api/reset` against the core, which until now only
the maintenance oracle held.

Rust suite: 233 pass (229 + 4 new). Fourteen negative controls, each
predicted from the fixture before it ran, and each failing exactly its
prediction. Walking the history newest first, and giving the canned
response a `stoppedEarly`, failed the seven canned cases that insert
(the second also the rate-limit burst, through its thirty activity
rows). Skipping the policy step failed the ten live cases with a
successful scrape. Trimming the last type failed the two cases whose
types differ in size; a walk that carries on past a rate limit failed
the two that stop; a skipped app that says nothing failed the two with
one; a guard that only wants a token when one is configured failed the
two unconfigured refusals. A cap of fifty, a `Retry-After` of zero
honoured, a blank region not defaulted, history read under the scraped
id, `source` matched without case, thirty-one seeds allowed and an entry
kept without its link each failed exactly their one case. And one live
control, the newest-first walk again: the gate failed exactly the one
check predicted — the library comparison, naming `privacy_snapshots`
alone — while the two responses still agreed (the counts do not change)
and all 180 reads, 57 mutations, 23 bundle, 26 backup and the other 5
seed checks passed. Each fault was removed before the final passing run.

**What the port found in Node, after it shipped.** Reading the port
back against the real feed rather than the fixture: Apple's legacy RSS
charts are an Atom feed converted to JSON, and a chart of exactly ONE
app carries its `entry` as a bare object, not a one-element array. The
first fixture for `?limit=1` had used an array — what the code expected,
not what Apple sends. On the real shape Node's `for…of` throws, so the
seed answered 502 (`entries is not iterable`) to every `limit=1`; and
the other reader of the same feed, `/api/related-apps`, threw inside its
`try` and told the Compare page a category had no candidates when it had
exactly one. The core, ported faithfully, did the same. Fixed on both
sides together, because the oracles tie them: `lib/itunes-rss.ts` and
`routes_discovery::rss_entries` normalise the entry, the seed oracle
gained a one-app chart (scraped, and already tracked) and entries that
are a string, a number and `null` — a string is not a list of its
letters — and the discovery oracle the same four shapes. The unported
core was the control: regenerating the fixtures first failed exactly the
two seed cases and the one discovery case predicted, and none of the
non-object shapes, which already agreed. A fixture records what the code
does with the reply it is given; whether Apple gives that reply is a
question only the feed answers.

**Batch 5 is complete.** What it left of Phase 4 is the batch below —
this section's first draft claimed the whole write side was done, and
webhook delivery, a write-side behaviour with no route of its own, was
not — and the two groups set aside at the start of the phase: the
cfgutil device actions, which belong with the desktop cutover, and the
AI routes, with the policy pipeline behind `summarizePolicies`, which
are Phase 5.

### Batch 6 — the outbound leftovers (+4 handlers, 2 tickers)

Four handlers the route count had not flagged as missing, and one
behaviour no route count could: `POST /api/notifications/webhook-test`,
`GET /api/update-status`, `GET /api/favicon`, `GET /api/preview`, and
the delivery of notification webhooks, which the core had read the
settings of and never sent.

`webhook_writes.rs` ports `lib/notification-webhooks.ts`. The config
read (a blank URL or `off` is no webhook; an unknown format is
`generic`, an unknown frequency `immediate`), the four payload shapes
(Slack and Discord a line of text, Discord's cut at 1,900 UTF-16 units,
Teams a MessageCard, generic the text and the rows), and the POST:
through the transport like every other fetch, so a webhook can no more
reach a private address than a scrape can, redirects not followed so
the body is delivered once, 64 KiB back at most, ten seconds. The three
call sites: `postImmediateWebhook` from `createNotification` — whose
ONE caller was then `POST /api/dev/seed-notification`, because a scrape
inserted its change notification itself and fired nothing, on either
backend (a label change posts it now: see the note closing this batch)
— detached from the response on the server and inline in the
replay; `maybePostSummaryWebhook` from the 30-minute tick, a day or a
week after the last, the fifty newest notifications since, the cursor
moved on an empty window and on a refused post but not on a failed
request; and the wizard's Test button, whose every failure is an
answer, never an error. `update_check.rs` ports `lib/update-check.ts`
and `lib/semver-compare.ts`: the cached status with the runtime detected
on every call (`DEPLOYMENT`, then `/.dockerenv` and the init cgroup, then
Homebrew's variables), the check with its day-long cache, its failure
backoff — fifteen minutes doubling to the day — and the forced path's
own five-minute throttle, the release written to settings only when its
tag is semver behind one `v`, the notes cut at four thousand; the 25 s
then 6-hour tick. `favicon.rs` ports the proxy: the host resolved as a
bare name, a full URL or `//host`, `favicon.ico` first with the type
checked and a bogus one accepted only if the bytes look binary, else the
site root read for the best `<link rel>` resolved against the root's
FINAL URL, hits kept a day and misses an hour in a five-hundred-host
cache halved when full. And `GET /api/preview` joins `routes_discovery`
beside the compare it shares a limiter bucket with.

**The transport learns two things.** A method and a body: the webhook
is the first outbound POST the core makes, and `Request` carries
`method` and `body`, sent on every hop as Node's loop sends them, which
is why a body and a cross-origin redirect are refused together. And the
final URL: a `Reply` now says where the last hop landed, because the
favicon fallback resolves a relative `<link href>` against the page it
was actually read from. The canned fetcher records a POST's method and
body, and reads a `bodyBase64` reply, so the fixtures can hold both.

**The oracle — `core/scripts/extract-leftovers-cases.mjs`.** Runs the
REAL handlers of the four routes and the seed notification, and calls
the two ticks as the server calls them. 132 cases. The webhook test:
each format, the default, a 204, a 500, a redirect not followed, a
failed request, and eleven refusals answered before any fetch — a
loopback, metadata and `localhost` URL, one over 512 characters, `ftp:`,
credentials, a number, a missing, blank and untrimmed URL, an unknown
and a non-text format — and the body: invalid, empty, whitespace, `null`
(a thrown 500), an array, a string, declared and streamed too large. The
seed notification with a webhook configured for `immediate` (the POST
recorded with its method and body, the headline the first description
or the count when that is blank), for `daily`, `off`, no URL, garbage
format and frequency, a failed and a refused post survived, a trimmed
URL, a private URL posted to nobody. The summary tick: a daily and a
weekly digest, inside the window, an empty window, each frequency that
is not a summary, a failed post and a refused one, fifty of fifty-five,
one update, a Discord cut, a garbage cursor, a private URL. The update
status: never checked, newer, current, older and pre-release cached,
disabled, garbage, each runtime; and `?refresh=1`: disabled, throttled,
a newer release, past a fresh cache and a backoff, no releases (404),
a 500 with and without a body, a failed request, a pre-release, a draft,
a tag that is not semver, an empty and a missing tag, the notes cut, only
a tag, a stored error cleared; and the tick: a fresh cache, inside and
past the backoff, a stale cache, disabled, a failure recorded. The
favicon: six refusals, a direct hit, the cache, a port, `//host`, a bogus
and a missing type, the type's parameters, the root fallback four ways,
the rel preference, the root's final URL, another host's icon, five
misses, a private link, a hit refetched after a day and a miss after an
hour, `http://`, an oversized icon. The preview: no URL, empty, off the
store, not a URL, a page, Apple's 429 (a 429 with 70 s), a 500, no data
script, a failed request, the thirty-first request. Each records the
wire response with the three headers these routes set — the favicon's
bytes as base64 — the raw fetches with a POST's method and body, the
write stream and three tables. `package.json`'s version, which the
update status reports, is masked as `<APP_VERSION>` and substituted in
the replay, so a release bump does not fail CI. `leftovers_tests.rs`
replays it all; the favicon cases share one per-process cache, in order,
as the oracle's did.

Live: `/api/update-status` joins `BATCH_1` as a volatile read — each
server's own tick fetches GitHub after boot and stamps its own clock, so
everything that check fetched or timed is blanked and the version this
build reports, whether the check is enabled, the detected runtime and
the request's meta are compared. The other three stay quarantined, each
a fetch of a third party when it succeeds, and are held by
`scripts/parity/leftovers-probes.mjs`, between the bundle probe and the
backup one: eleven refusals both servers must spell alike, every one
answered before a fetch would be made. Latest pass: READ PARITY OK — 181
read, 57 mutation, 23 bundle, 11 leftovers, 26 backup and 6 seed checks.
One live control, the core's "url is required" reworded: exactly the
one check predicted failed and every other passed.

Rust suite: 242 pass (233 + 9 new). Eighteen negative controls, each
predicted from the fixture before it ran. A webhook that follows
redirects, a cut at two thousand, the immediate webhook ignoring the
frequency, the forced check ignoring its throttle, the tick ignoring the
backoff, notes cut at 4096, only a lowercase `v` stripped, a 404 read as
an error, `shortcut icon` preferred, hits kept two days, the link
resolved against the root rather than its final URL, a thirty-first
preview allowed, Apple's rate limit answered with sixty seconds, a null
body read as a missing URL, and a webhook URL allowed two thousand
characters each failed exactly their one case; the cursor moved on a
failed post, the headline never falling back to the count, and any 200
body taken for an icon failed exactly their two, two and three. Two
controls needed a second run and each taught something: the first cut
control moved the threshold and not the cut, so it changed nothing the
fixture could see — a control must change the output, not a number near
it — and the backoff control reported two failures for one case,
because the replay counted a tick's return value and its writes
separately; it counts one now.

**Divergences, chosen.** A GitHub body that is not JSON: Node's
`res.json()` fails in the engine's words, the core in plain ones. A
check that times out: Node's `AbortError` says "This operation was
aborted", the transport here says why. Two callers racing one check:
Node hands the second the first's promise; the core has it wait and
answer from what the first wrote, without the first's error. None of
the three is reachable from the fixture.

**Later: label changes post the immediate webhook (2026-09-19).** A
scrape that records changes now fires the fan-out once its commit has
landed, on both backends; the bell row stays inside the commit, so the
write stream is unchanged. In Node, `commitScrapedAppToDb` calls
`fireWebhookIfConfigured`, which now imports `postImmediateWebhook`
statically: the dynamic import cost twelve microtask ticks, enough for
`scrapeInitialUrls` to request its next app's page before the POST, an
order the core could only have copied by firing in the middle of the
next scrape. In the core, the commit hands back what it owes on
`Outcome::immediate`, and `scrape::fetch::fire_change_webhook` fires it
as the committing section closes, in `fetch_and_parse_app`, the import
queue's drain, retry and change-match, and the bulk sync. `fire_immediate`
reads the config in place and detaches only the POST whenever the
fetcher can be shared: the background ticks reach a scrape through
`Locked`, which cannot be detached, and would otherwise have posted
inline and waited (dropping the POST, under `now_or_never`). Twenty cases
are appended across the fetch, imports, runners and seed oracles: the
POST on every path that scrapes, after its own commit and before the
next app; quiet hours deferring the bell and not the POST; a summary
frequency and an unchanged resync posting nothing; a failed POST and a
refused URL never failing the scrape; a Wayback import that writes a
changed row and posts nothing. Dropping the fire failed exactly the
sixteen cases that expect a POST; restoring the old spawn rule failed
exactly the new unit test.


## Status — Phase 5 (the AI policy pipeline)

Phase 4 closed with the write side of the API in Rust, outside the
cfgutil device actions (the desktop cutover's, ported in Phase 6, batch
2a) and the AI routes. Phase 5
is the AI routes and everything behind them: `lib/privacy-policy.ts`
(5,043 lines, the largest module in the port) and the eight modules
around it — the policy source, its store and versions, the summariser and
its providers, the bulk runner with its resume, and the two triggers that
start a fetch after a scrape or an import. Four batches:

1. **The policy source (on main).** `fetchPrivacyPolicySource`: from a
   policy URL to a validated text. No routes, no database.
2. **The store and its reads (on main).** `fetchAndStorePolicySource` with the
   kill-switch, the throttle, the first/same/changed/error classification,
   the version rows, the archive lookup, the History row and the
   notification; `GET /api/policy/status/[appId]`, `/version/[id]`,
   `/version/[id]/diff`, the manual-app policy version, and
   `POST /api/manual-apps/[id]/scrape`.
3. **The summariser**, in two parts. **3a, the engine:** the prompts,
   chunking, the OpenAI, Anthropic and custom providers, the timeouts and
   their notification, the AI debug log, the sample summary and the
   prompt preview, with no routes. **3b, the routes:**
   `POST /api/policy/regenerate`, `/api/ai/policy-sample`, `/api/ai/test`
   and `/api/ai/models`, with a loopback fake provider for the live gate.
4. **The bulk runner, its resume and the triggers**, in two parts. **4a,
   the runner:** `runBulkPolicySync`, `POST /api/policy/sync-all` and the
   12 s startup resume. **4b, the triggers (this batch):** the deferred
   post-update policy fetch after an import or a sync, and
   `summarizePolicies` on a scrape and the dev seed.

Everything stays inert: no shipping path calls the policy module, and
`rust-core-inert.test.ts` is unchanged.

### Batch 1 — the policy source (no routes)

`core/src/policy/` is `fetchPrivacyPolicySource` end to end: the locale
rewrite of the URL and its fallback, and the Google locale pin
(`url.rs`); the three-tier ladder — direct with the Safari UA, the
Chrome-desktop header bundle, the newest Wayback snapshot — with its
block codes and retryable errors, the HTML-level redirects (meta refresh,
script location) and the Google consent wall with its bypass, the
policy-link second hop, and validation (`source.rs`); HTML to text with
the chrome strip, the block pass, entity decoding and whitespace
normalisation (`text.rs`); and the structured failure with its status
hints and network classification (`diag.rs`). Every trace event Node
logs is emitted in the same order with the same wording, because batch 2
persists them as the run log the AI Policy tab renders. Nothing fetches
outside the transport, and nothing touches the database.

**The oracle — `core/scripts/extract-policy-source-cases.mjs`.** Runs the
REAL `fetchPrivacyPolicySource` over 60 scenarios with the raw `fetch`
stubbed by recorded replies, never the network, and records every raw
fetch Node made (URL and headers, one entry per hop), every trace event,
and the validated source or the error with its diagnostics.
`core/src/policy/source_tests.rs` replays every case through the same
transport loop, so redirects and caps run for real on both sides; CI
regenerates the fixture and fails on drift ("Policy-source oracle is
current"). The cases: plain text (ready, too short, no policy clauses, a
byte order mark); the `<main>`, `<article>` and `<body>` fallbacks and a
document with no body; chrome stripped by tag, by role and by class, with
a nested container, an unclosed one and a closing tag carrying an
attribute; the second pass picking the longest policy-looking container
and skipping a chrome-classed one; block tags, entities and whitespace;
an entity past U+10FFFF (a `RangeError` on Node, spelled the same here);
an empty, an unsupported and an XHTML content type; meta-refresh and
script-location hops, the three-hop cap, a loop, a hop to non-HTML and a
failed hop; the Google locale pin and the consent wall through its
`continue`, to a non-Google host, on a Google host without one, with a
non-HTML bypass and with a failed bypass; the locale rewrite of a path
with and without a region, of a query (which `URLSearchParams`
re-serialises), of an unlisted code and of a three-letter one; the
ladder — a final 404, a 401 and a 403 into the retry, both blocked into
the snapshot, no snapshot, an availability body that is not JSON, a
failed snapshot fetch, a retryable and a timed-out first attempt, a
declared length over the cap, six redirects, an HTTP redirect followed, a
failed retry, and two URLs refused before any fetch; and the policy link
followed, shorter, on another host, failing, rejected as too long,
locale-normalised, absent, and pointing at the current page.

**Two things the oracle taught about Node.** A reply without a
Content-Type is read as plain text, not as HTML: `wrapResponse` puts the
fetched bytes into a new `Response` as a string, and undici stamps
`text/plain;charset=UTF-8` on a string body, so the "empty content type
looks like HTML" branch never runs. The core reads such a reply the same
way, on purpose. And a body is decoded as `Response.text()` decodes it —
UTF-8 with a leading byte order mark removed — except on the policy-link
hop, which reads the buffer directly and keeps one; both are mirrored.
The stub had to learn two things for the recording to be true to
production: a synthetic `Response` has an empty `url` where undici's
carries the hop's request URL (which is what `finalUrl` reads after a
redirect), and a string body gets that stamped type where a byte body
does not.

**Two of Node's patterns use a backreference** (`</\1>`) to pair a
container with its own closing tag, which the `regex` crate does not
support. Those two are scanners: the opening tag is matched by regex,
the first closing tag of the same name is searched from the end of the
opening tag, and on a miss the scan resumes one character after the
opening `<` — what a backtracking engine does with a global regex — so
nested, unclosed and oddly closed containers behave as they do on Node,
and the fixture holds one of each.

**Negative controls, predicted before running.** A missing Content-Type
read as HTML: exactly the one case that has none. The browser bundle's
`Referer` changed: exactly the fourteen cases that retry, take the
snapshot or follow a link. Four HTML hops instead of three: exactly the
capped chain. Source restored byte-for-byte after each, fixed tree
green.

**Divergences, chosen.** JavaScript's `i` flag folds case through
`toUpperCase` and Rust's `(?i)` through Unicode simple folding; they
agree on every ASCII tag and attribute these patterns look for. A
surrogate code point in a numeric entity is a lone surrogate on Node and
U+FFFD here; no fixture can record the former, since JSON cannot carry
it. A hex entity past 2^53 rounds differently. None is reachable from a
policy page anyone has published.

### Batch 2 — the store and its reads (+5 handlers)

`core/src/server/policy_store.rs` is `syncPrivacyPolicyAnalysis` with
`phase: "fetch"`: the run marker (a placeholder row when the app has no
analysis yet), the run log persisted as it grows, and
`fetchAndStorePolicySource` — the kill-switch, the throttle, the fetch
through batch 1's source layer, the failure branches, the
first/same/changed classification, the version backfill and upsert
(`lib/policy-versions.ts`), the archive lookup, the History row and the
notification, the cache hit and the source-ready write — then the
activity row. A fetch error keeps the last good source, an unusable body
keeps the last good hash, and only a changed text, with the
policy-updates toggle on, flags its History row for review and raises a
bell notification: #271's rules, recorded from the fixed Node. With
policy scraping switched off, a first run drops the placeholder, returns
no analysis and logs a skip rather than a failure, as the fixed Node
does. The kill-switch over a stored analysis and the throttle return the
row as it stands after their own log line, read again if their write is
refused. Both used to return it as read before that line, with the
previous run's log, so batch 4a's bulk runner counted an app skipped
after a fetch as a success; Node and the core were fixed together.
The activity row tells those two skips apart by the same line, the
last in the run's own log, before it reads the stored status, which
describes an earlier run: a throttled skip is "Policy skipped:
throttled" and the kill-switch over a stored analysis "Policy skipped:
scraping disabled", both partial like every other skip. A throttled
skip used to read "Policy source fetched (cached)" (or, for a fetch and
summary, "Policy summary ready"), and the kill-switch over a stored
fetch error a fresh "Fetch failed" at error status. Node and the core
were fixed together.
Nothing outside the replay calls the store yet. Batch 3 routes
`POST /api/policy/regenerate`, and batch 4 the bulk runner and the
triggers.

**What Node fires and forgets starts where Node starts it.** Save Page
Now and the immediate webhook are fired and forgotten in Node: the
request goes out at once and finishes after the sync has returned. On
the server each is a task of its own, spawned at that point. In the
replay, whose canned hop answers at once, the request is made there
too, and only Save Page Now's link to the capture is handed back, to be
written after the sync. (Batch 2 first ran both after the sync; batch
3a's `all` phase, where the summary's AI call follows them, showed the
difference.)

**The routes** (`core/src/server/routes_policy.rs`):
`GET /api/policy/status/[appId]`, the AI Policy tab's polling subset of
the analysis; `GET /api/policy/version/[id]`, one captured text, 120 a
minute; `GET /api/policy/version/[id]/diff`, that text against the
latest earlier different one, 60 a minute;
`GET /api/manual-apps/[id]/policy-version/[versionId]`, refused across
apps and sharing the manual-app read bucket with the app detail; and
`POST /api/manual-apps/[id]/scrape`, which fetches the manual app's
policy through the source layer, folds identical text into one version
row (`lib/manual-app-history.ts`), and appends a scrape event and an
audit row. The scrape's limit is the write framework's rate guard, which
gains a `retry_after` switch because this route's 429, unlike that of
every route already behind the guard, carries no `Retry-After`. The
scrape takes the runner clock rather than the dispatcher's `now`: Node
reads the time before the fetch for the event and the version, and again
after it for the audit row.

**The diff** (`core/src/policy/diff.rs`) ports `diffPolicyTexts` as
fixed in #273: a line diff by longest common subsequence, each paired
run of removed and added lines refined word by word. Node's common-suffix
trim used to count from the start of both arrays instead of the end, so
the History tab reported real changes as unchanged. The port follows the
fixed code, which `tests/app/policy-diff.test.ts` pins on the Node side.

**`JSON.parse` in V8's words** (`core/src/jsjson.rs`, beside `jsdate`,
`jsnum` and `jsstr`). serde_json decides what a valid document is, but
it cannot fail the way V8 fails, and Node stores the words: the store
logs the History write's parse failure of a corrupt snapshot in the run
log the AI Policy tab renders, and batch 3's summariser stores the
message of a provider reply that is not JSON. `parse_error` walks the
text as V8's `JsonParser` does, far enough to find the first failure,
and words it with V8's `kJsonParse*` templates: position, line and
column in UTF-16 units with `\r\n` as one break, and ten units of
context either side once the source is longer than twenty-one.
`roundtrip` is `JSON.stringify(JSON.parse(s))`, with integers past 2^53
spelled as JavaScript spells them and integer-like keys first. The
attribution is in `core/V8-LICENSE`.

**The oracle — `core/scripts/extract-policy-store-cases.mjs`.** Runs the
REAL fetch phase of `syncPrivacyPolicyAnalysis` over 37 scenarios and
the REAL five route handlers over 35 requests, against a scratch
database with a frozen clock, counted ids and the raw `fetch` stubbed by
recorded replies, never the network. Recorded per case: every raw fetch
(a POST's method and body too), every write in order with transaction
markers, eight tables, and the result or the wire response. It also
records V8's answer for 68 `JSON.parse` inputs: every message template,
the whole and the truncated context, positions across `\n`, `\r\n` and a
bare `\r`, astral and accented characters, a byte order mark, and two
shapes a model reply takes (prose before the object, a fenced block).
`core/src/server/policy_store_tests.rs` replays all three sets; CI
regenerates the fixture and fails on drift ("Policy store oracle is
current").

The store cases: no policy URL, with and without a stored analysis; the
first capture; an unchanged rescrape, a cache hit over a summary and not
without one; a changed text with the toggle off and on, the latter
posting the immediate webhook, and quiet hours holding its
notification; a revert reusing its version; an upgrading install
seeding its stored text as a version, with the fallback to
`updated_at`; `forceResummarise` skipping the cache hit; the older
summary chain kept; an HTML policy behind a redirect; a failed archive
lookup, which is not an error; an app the library does not track, which
throws on the foreign key before any write; a corrupt latest snapshot
(V8's message in the run log and no History row); a 404, a refused URL,
a reset connection with its hint and an out-of-range entity; an
unusable body and an unsupported content type; the kill-switch on a
first fetch, over a stored summary, and overridden by `bypassThrottle`;
the throttle skipping, rounding its minutes, honouring its setting, off
for minutes that are not positive and when disabled, holding only a
ready analysis, elapsed, and facing a fetch time in the future; and the
kill-switch and the throttle with their write refused, which a trigger
does while the run log's own update lands. The route cases cover each
read found, missing and refused, each rate limit, the diff of a
one-word edit, an appended line, a changed last line, a long policy
truncated and a first version with nothing before it, a manual version
asked for under another app, and the scrape's first capture, same text,
changed text, unusable page, fetch failure, refused URL, missing URL,
unknown app, long id and limit.

When the activity row learned to tell a skip by its log line, six store
cases moved, only in that row: the kill-switch over a stored summary,
the three throttle skips and the two refused writes. One store case was
appended after the routes, so no other recording moved: the kill-switch
over a stored fetch error. Negative controls, predicted before running:
the previous `policy_store.rs` and `policy_runner.rs` against the new
fixtures failed exactly the seven store cases, the four runner cases
(batch 4a), one AI routes case (batch 3b) and two of the three
summariser cases appended in batch 3a, not the one that summarises; a
skip read from a `disabled` line anywhere in the log instead of the last
failed exactly that one. Source restored byte for byte after each.

**The clock moves with the network.** Each fetch the code awaits
advances the frozen clock one second, so a timestamp Node takes before a
fetch and one it takes after differ, and the port has to take each
where Node does. The two fetches nothing awaits, Save Page Now and the
webhook, are free. Save Page Now's reply is held until the sync has
returned, as production's 10 to 30 second archive always is, so what it
writes lands in a separate `late` stream in a fixed order.

**The live gate.** `scripts/parity/policy-fixture.mjs` writes policy
rows into the Node database before it is copied for the core: two
analyses (one idle after a run whose log mixes well-formed and
malformed entries, one ready with no run recorded), three versions of
one app's policy (the second with an archive link, the third with CRLF
line endings), and three manual apps. None of its analyses is running.
Both backends flip running analyses to idle when they open the
database, which Node did before the fixture was written and the core
does after the copy, so the running state is read from the operations
fixture's app, primed on both sides after boot. The first gate run
caught exactly that, and an app id the discovery fixture already owned.
The four reads join the live read list over fifteen requests, six of
them refusals.
`scripts/parity/policy-probes.mjs` holds the scrape under `--mutate`:
an id too long, an unknown app and an app with no policy URL are refused
identically, and the eleventh request in a minute is the first refused
on both, with no `Retry-After` on either. A scrape that passes its
checks fetches the developer's site, which a parity run must not depend
on; the oracle holds that path.

**Node's behaviour, kept.** The analysis the sync returns says the run
is still `running`, because Node clears the marker in a `finally` after
building the value. It is the row as written, so a log event written
after it is on the stored row but not in the value: the error branches
return no History event. The backfill's "Seeded previous policy text"
note is logged on every changed rescrape, including when the earlier
text already had its version and the upsert only touched it.

**Negative controls, predicted before running.** The fetch-error branch
hydrating a fresh read instead of the row it wrote: exactly the four
fetch-error cases. The throttle's minutes floored instead of rounded:
exactly the two cases that round. The pre-#273 suffix trim put back into
the diff: predicted the four diffs whose texts share an ending, got
five, because the truncated diff fails too, at the word level, which
refines through the same routine. A JSON context of nine units instead
of ten: exactly the five truncated contexts. Live, with two independent
faults in one run: the scrape's 429 given a `Retry-After` failed
exactly the probe's check for its absence, and the diff refining no
pair past four tokens failed exactly the two diff reads that succeed.
Source restored byte-for-byte after each, fixed tree green.

**Divergences, chosen.** Where V8 would quote one half of a surrogate
pair, as context or as the offending character, the core renders U+FFFD,
since a Rust string cannot hold the lone half; and a `\uD800`-style
escape of a lone surrogate, which V8 accepts and serde_json refuses,
fails here in serde_json's words. Neither is reachable from text a
JavaScript writer produced.

Rust suite: 259 pass (252 + 7 new: the three replays and four unit
tests of the diff and the JSON port).

### Batch 3a — the summariser engine (no routes)

`syncPrivacyPolicyAnalysis` now runs all three of its phases
(`core/src/server/policy_store.rs`): `fetch` as before, `summarise`
over the stored source, and `all`, which summarises only when the fetch
landed a clean new source. The summarise phase is
`core/src/server/policy_summary.rs`: `summariseStoredPolicy` skips a
summary that is current, an audit-bundle excerpt or anything but a clean
source, writes the needs-config row when no provider is set, and
otherwise stores the summary with the one it replaces, or the error it
failed with beside the summary it was replacing. `buildPolicySummary`
sends a policy that fits the model's
direct limit in one call (40,000 characters, or 8,000 for a model that
needs chunks) and otherwise cuts it into chunks, stores each chunk's
notes the moment they arrive, reuses them when a retried run finds them
matching the text and the chunk count, and merges them. The sample
summary, which batch 3b's sample route serves, is here too, and so is
the prompt preview, which Node exports but no route calls.

`core/src/policy/ai.rs` is `lib/ai-config.ts`: the providers, their
defaults, which models need chunks, the per-phase timeouts with their
clamp, and the base-URL rules. `core/src/policy/prompts.rs` is what a
model is sent: the system prompt, the preamble and the nonce-marked
blocks every scraped value is wrapped in, the keyword digest, the
direct, chunk and merge prompts, the schemas and the skeleton a
`json_object` endpoint gets instead, the built-in sample policy, and the
chunker. `core/src/server/policy_ai.rs` makes the calls: OpenAI with a
strict `json_schema`, a custom endpoint with `json_object` and a
streamed reply, Anthropic as a forced tool call; one retry on a timeout
or an abort; the debounced "raise the timeout" notification with its
run-log line; and the AI debug log with its fifty-row cap.

**The transport learned what the AI calls need**
(`core/src/outbound.rs`). A request can allow private hosts, the local
model's case: loopback and LAN addresses pass, while a metadata address
never does, whether named, written or resolved, and such requests use a
connection pool of their own. It can refuse redirects, as
`redirect: "error"` does, where any redirect status is a network error.
And `Fetcher::fetch_stream`, `safeFetchStream`, returns the response
head with the body unread, under one deadline that covers the request
and every read, as `AbortSignal.timeout` keeps running while undici's
body stream is read. The redirect loop also now checks each target
against the caller's URL-length cap and private-host setting, as
`safeFetch` does; it used a fixed 2,048.

**The recording held the port to Node's reading of a reply.** A streamed
reply is read chunk by chunk as the transport delivers it and decoded as
a `TextDecoder` fed with `{ stream: true }` and never flushed: a
character cut by a chunk boundary waits for the next chunk, one still
incomplete at the end is dropped, and a leading byte order mark goes. A
non-streamed reply is decoded as `Buffer.toString("utf8")`. Both stop at
two megabytes, counted before the chunk that crosses the line is
decoded, so a stream cut off there hands the debug log exactly what came
before it. Prompt nonces come from `Ids::nonce`, the system's random
bytes in production and the oracle's counter in the replay.

**The oracle — `core/scripts/extract-policy-summary-cases.mjs`.** Runs
the REAL summarise and `all` phases over 88 scenarios, the sample
summary over four and the prompt preview over two, against a scratch
database with a frozen clock, counted ids and nonces, and every provider
reply canned: an OpenAI completion, a custom endpoint's event stream in
the recorded chunks, an Anthropic message. The shapes are the providers'
documented formats; there is no key to capture live ones with. Recorded
per case: every raw fetch with its headers and body, every write in
order, seven tables, and the result or the thrown message.
`core/src/server/policy_summary_tests.rs` replays all 91, each body
reaching the reader in the recorded chunks. CI regenerates the fixture
and fails on drift ("Policy summariser oracle is current").

The cases cover the gates (no provider, no key, a blank model, a current
summary, an imported excerpt, a failed fetch with and without its
message, a too-short and an unsupported fetch, an app with nothing
stored, no policy URL); OpenAI's summary, a forced resummarise with the
summary it replaces, a refusal, an error status, a reply that is not
JSON, content parts, empty content, content that is not JSON, a fence,
odd lenses and ratings, an array, a guardian's safety summary, a missing
developer and the debug log's cap; the timeouts (retried once, twice,
the notification suppressed and repeated, a clamped and an unreadable
budget, an abort, an error status that mentions a timeout, a network
failure, a redirect, two megabytes); the custom endpoint (a streamed
summary with multibyte text across chunks, a whole message at the end,
a stream cut off by the timeout, a stream that breaks, an empty stream,
CRLF frames, a stream ending inside a character, an error status, two
megabytes, base URLs with and without a scheme or a path, a metadata
address, the legacy `ollama` name); Anthropic (the tool, text in a
fence, a reply that is not JSON, no text, an error status, a body cut
off by the timeout); chunking (a long policy, reused notes, stale
notes, a chunk that fails, notes the model left empty, a paragraph
longer than a chunk, a guardian's merge, OpenAI and Anthropic models
that need chunks); and the `all` phase (fetch then summarise, a cache
hit, a failed fetch, the kill-switch).

A summarise that meets a failed fetch declines the text the fetch kept,
an earlier capture, and logs a skip ("Policy skipped: latest fetch
failed") rather than a new fetch failure, as the fixed Node does. A
too-short or unsupported fetch was already logged as a skip.

A clean source is also one whose last summary run failed
(`analysis_error`) or found no provider (`needs_ai_config`): only the
summarise phase writes those two, over a capture it accepted, and any
later fetch replaces them, so their text is still the latest clean
capture. A summarise summarises it, forced or not, as the fixed Node
does; Node used to decline it and log the earlier failure again
("Summary failed: ...", or "AI not configured" with a provider set up).
The cases: a failed AI summary summarised again, forced and unforced,
and failing again with its own error; one that met no provider,
summarised once one is set up, and an unforced run that still finds
none; and a summary with scraping disabled, which does not stop it.

A summary run that fails replaces nothing: the error is stored beside
the summary the run was replacing, with the mode and model that made
it, as the fixed Node does. Node used to store no summary and keep only
the older previous one, so a failed Summarise lost the summary on the AI
Policy tab. With no summary to keep, the row still names the model that
failed. And the summary a run replaces now becomes the previous one even
when an older one is stored, the fetch phase's rule: a forced
resummarise, and the first run to work after a failure, used to keep
the older one and drop the summary the tab showed. A failed run's
status still asks for a summary, so the next summarise makes one,
forced or not, and a later fetch that finds the text unchanged is a
cache hit that makes the kept summary ready again. The cases: a failed
forced resummarise, a forced resummarise over an older previous
summary, the next summary after a failure, forced and unforced, and an
unchanged fetch after a failure.

An `all` run that a gate skipped is logged as the skip (batch 2), not
as "Policy summary ready" or a fresh fetch failure, as the fixed Node
logs it. The skip is the run log's last line: the kill-switch over a
clean capture still hands it to the summary, which logs more, and that
run is logged as the summary it made. Three cases are appended, so no
other recording moved: a throttled fetch and summary, the kill-switch
over a stored fetch error, and the kill-switch before a summary of the
stored text. One earlier case moves, by design: a
source waiting for a summary that held both a summary and an older one
kept the older one as the previous (it was "a stored previous summary
is kept over the current one"). It now records the summary it
replaces, and is renamed for it. The control on the previous summary's
time below now fails five cases, not one: every run that replaces a
summary of its own.

A summary run that finds no usable AI provider (none chosen, or a blank
key or model) replaces nothing either: the needs-config row keeps the
summary the run was replacing, with its mode and model, as the fixed
Node does. Node used to store no summary there, so a Summarise with an
incomplete provider lost the summary on the tab, and the next summary
that worked compared itself with the older one. With no summary to
keep, the row stores none and no model, as before. The cases, appended
after every other: a forced resummarise with a blank key and with a
blank model, a kept summary kept again while there is still no
provider, the kept summary becoming the previous one once a provider is
set up, and an unchanged fetch that is a cache hit on the kept summary
with the key still blank. All 86 earlier cases are byte-identical in
place. The old needs-config write fails exactly three: the three that
write it over a summary.

**Node's behaviour, kept.** A refusal is caught by the `try` it is
thrown in, so it is logged twice and its debug row is inserted twice,
the second insert failing on the id. The retry judges an error by its
words, so an error status whose body says "timeout" is retried. An
Anthropic body cut off by the timeout goes up unwrapped, with no debug
row and no notification, and is retried. A chunked run's `summarising`
phase is closed as a matter of course when the first chunk starts, so
its "Summary ready" note lands on no phase. The stored `updated_at` is
the time before the first AI call. The chunk slicer, a backtracking
`[\s\S]{1,n}(?:\s|$)` scan, never matches the head of an unbroken run
longer than a slice, so those characters are summarised by no chunk.

**Negative controls, predicted before running.** The stream decoder
flushing a trailing partial character: exactly the stream that ends
inside one. No retry after a timeout or an abort: exactly the ten
cases that retry. The slicer keeping the head of an unbroken run:
exactly the sliced paragraph. The previous summary's time not taken
from `updated_at`: exactly the forced resummarise. Source restored
byte-for-byte after each, fixed tree green.

**Divergences, chosen.** `toLowerCase` and Rust's lowercasing agree on
everything but special casings, which only matter to where a keyword
excerpt starts; a slice that splits a surrogate pair is U+FFFD here and
a lone surrogate in Node; a stream frame escaping a lone surrogate is
skipped here and read by V8; and the debug log's opt-in console mirror
(`ai_debug_console_mirror`) is not ported, since it writes only to
Node's console. None of these is reachable from a policy text or a
provider reply of the documented shapes.

Rust suite: 266 pass (259 + 7 new: the replay, and unit tests of the
configuration, the prompts, the stream decoder and the frame reader).

### Batch 3b — the AI routes (+4 handlers)

`core/src/server/routes_ai.rs` routes what 3a built, with the two
model-list routes that sit beside it:

- `POST /api/policy/regenerate`: the ten-a-minute limit with its
  `Retry-After`; the body read inside the route's `try`, so an empty,
  unparseable or oversized body is a 500 carrying the reader's message,
  with a failure audit row; the app id (one to twenty digits once
  trimmed); the phase (`fetch`, `summarise`, and anything else as
  `all`); the scraping kill-switch refusing any phase that fetches; the
  app and its policy link; then `syncPrivacyPolicyAnalysis` with
  `forceResummarise`. Answered whole with the analysis, or, when `stream`
  is the boolean `true`, as NDJSON: a line for each phase record the run
  logger opens, closes or logs, then `done` with the analysis or `error`
  with the message, each with its audit row. On the server the streamed
  run is spawned off the request with an owned accessor, id source,
  fetcher and clock, and its lines go out as they come. A client that
  goes away does not stop the run, as in Node. The run passes the scrape
  throttle only when the body's `bypassThrottle` is the boolean `true`,
  which the AI Policy tab sends and onboarding's policy step does not;
  the kill-switch refuses a fetch either way.
- `POST /api/ai/policy-sample`: six a minute; the provider; the model
  (trimmed, at most 200 UTF-16 units); the key, where Settings' mask
  `__SET__` stands for the stored one; the base URL normalised and
  checked with loopback allowed and a metadata address never; then 3a's
  sample summary, an activity row either way, and a 502 carrying a
  failure in friendlier words.
- `POST /api/ai/test` and `POST /api/ai/models`: ten a minute, then the
  admin token wherever one is needed, since both fetch a URL the caller
  supplies, each refusal leaving an audit row. The test fetches the
  provider's model list (Anthropic's `/v1/models?limit=1`) and reports
  reachability, the meaning of the status and how many models are
  listed, never the endpoint's body. The model list keeps OpenAI's chat
  models, pages through Anthropic's list (five pages at most, while the
  cursor moves, the query rewritten as `URLSearchParams` rewrites it),
  and for a custom endpoint falls back to Ollama's own tag list when the
  OpenAI-compatible one fails or is empty. Neither follows a redirect.

The run logger gained its phase stream: `PolicyPhaseStream.emit` is a
sink told of each record as it stands when it is opened, closed or
logged, and `sync_policy_analysis_streamed` threads it through the run.
The transport now reports a body read that times out with the timeout's
message rather than `terminated`, as the streamed read already did; the
recording caught it.

**The oracle — `core/scripts/extract-ai-routes-cases.mjs`.** Runs the
four REAL route handlers over 128 requests built as the browser sends
them (32 regenerate, 22 sample, 42 test, 32 models), with 3a's harness:
provider replies canned in the documented formats, a frozen clock that
each awaited fetch moves on, counted ids and nonces, and Save Page Now
held until the response is complete. Recorded per case: the response
as it went over the wire (status, Content-Type, Retry-After,
Cache-Control and the body text, or the throw Next answers with a bare
500), every raw fetch, every write, the writes that land after the
response, and nine tables. `core/src/server/routes_ai_tests.rs` replays
all of them through `precheck` and `respond` as the axum wrapper calls
them. A streamed regenerate runs in place there, since a replay's
accessor cannot be detached, and its lines are the body. CI regenerates
the fixture and fails on drift ("AI routes oracle is current").

The cases cover every refusal in each route's own words and order (body
errors, a null body, the limits, the admin token and its order against
the limit, providers, keys and the mask, a model's length in UTF-16
units, base URLs blocked, unparseable, too long or carrying
credentials); the connection test's answers (each status, a redirect
reported rather than followed, the singular, a reply that is not JSON or
holds no list, a timeout, a network failure, a body cut off or stalled,
a declared and a real reply over the cap, base URLs with and without a
scheme, a `/v1`, an upper-case `/V1` or a path); the model lists
(OpenAI's filter over twenty ids, an error status, a page that is not
JSON, Anthropic's paging and its three stops, a query-string base URL
and an odd cursor encoded as `URLSearchParams` encodes it, the custom
fallbacks); the sample summary on each provider with its activity rows,
failures, two timeouts with their notification, a network failure and a
redirect; and regenerate refused, summarised, fetched, both, streamed (a
summary, a failed fetch, a capture and its summary, a chunked summary,
two timeouts) and failing where the run marker is refused, whole and
streamed.

Four cases cover the scrape throttle, on a policy fetched ten minutes
ago: a `bypassThrottle` that is not the boolean `true` keeps it; the AI
Policy tab's rescrape passes it, answered whole, and so does its
rescrape and summary, streamed; and the kill-switch refuses a fetch
that bypasses it. The first is logged as a skip, "Policy skipped:
throttled" (batch 2); it was "Policy summary ready", and it is the one
case here that moved when the store's activity row changed.

One case, appended last, covers the tab's Summarise over a summary while
the provider's key is blank: the answer carries the summary the run was
replacing, credited to the model that made it, under `needs_ai_config`.

**The live gate.** `scripts/parity/ai-probes.mjs`, under `--mutate`,
starts a fake provider on loopback that answers the OpenAI-compatible
model list, Ollama's tag list and a streamed chat completion, points
both servers at it, and sends each request to Node and then to the
core, so its log says which server asked for what. It compares, byte for
byte with only clocks masked, the connection test (custom and
Anthropic), the model lists (custom, OpenAI's filter and the Ollama
fallback), the sample summary, and regenerate's summarise phase for a
new policy-fixture app, whole and streamed, where the core's stream is
the spawned run the replay cannot reach. It compares what each server
sent the provider too, prompts included, once the one random part, the
nonce, is masked. The bundle probe's imports mark that app's analysis as
an imported excerpt, which neither server will summarise, so the probe
first writes the row back on both sides, as the operations fixture
primes its running analyses. The first run caught exactly that: both
servers skipped the summary identically, which only the stream check's
count of phase lines noticed, so the probe now also checks that the
provider was asked.

**Node's behaviour, kept.** The regenerate route reads its body inside
its `try`, so a body error is a 500 carrying the reader's message where
other routes give a 400, 413 or 408; its `stream` flag must be the
boolean `true`; its audit rows carry the id it trimmed while the run
takes the app's own. The connection test and the model list word the
same failures differently ("Hostname not found — check the base URL."
against "Hostname not found."). The model list reads any failure that
mentions a timeout as one, a JSON parse error quoting the body included.
A custom endpoint's list failures are never reported: an empty list is
the answer. And the streamed response's `Cache-Control: no-store,
no-transform` reaches the browser as the gate's `no-store`, on both
servers.

**Negative controls, predicted before running.** OpenAI's realtime
models let through: exactly the filter case. A numeric cursor never
equal to itself: exactly the numeric-cursor case, which pages on. The
logger not streaming the record it closes: exactly the five streamed
runs that log phases. The admin token checked before the limit: exactly
the case that pins their order. Live, the core's spawned stream dropping
its phase lines failed exactly the probe's stream check, which the
replay cannot see. Source restored byte for byte after each, fixed tree
green.

**Divergences, chosen.** As in 3a, the chat-model filter lowercases with
Rust's rules, which differ from `toLowerCase` only in special casings no
model id uses.

Rust suite: 267 pass (266 + the replay).

### Batch 4a — the bulk policy runner and its resume (+1 handler, 1 ticker)

`core/src/server/policy_runner.rs` ports `runBulkPolicySync` with its
state (`lib/policy-bulk-state.ts`): the queue of every app with a policy
link, by name; the `policy_bulk_state` blob and the `policy_sync_running`
lock, persisted before and after each app; each app's
`syncPrivacyPolicyAnalysis` in the run's phase (`all` forces a fresh
summary, as `force` does, and `force` also bypasses the throttle); an app
that has lost its link or gone since the queue was built skipped with the
reason; the outcome buckets; and the NDJSON frames (`batch-start`,
`app-start`, each app's `phase` records through batch 3b's run-logger
sink, `app-done`, `summary`, `error`). A clean run writes its activity
and audit rows and clears the state and the lock; a failure outside an
app's own run leaves both for the next boot, as Node's outer catch does.

`POST /api/policy/sync-all` (`runner_writes.rs`) keeps the route's order:
the four-a-minute limit with its `Retry-After`, the body (every reader
failure a 400 carrying its message), the kill-switch, a run already under
way (the lock, or a blob that reads), no apps to sync, the start audit,
then the run, buffered or streamed. A streamed run is spawned off the
request on the server. The server arms the 12 s resume beside the Wayback
and sync ones: nothing to do, the kill-switch dropping the queue, a stale
lock or a finished queue healed with a notification, or the notification,
the activity row and the resumed run.

**The oracle — `core/scripts/extract-policy-runner-cases.mjs`.** Runs the
REAL runner over 34 cases: 18 requests to the route (every refusal, then
buffered and streamed runs across a fleet with a first capture, a fetch
error and a throttled app, `force`, the `all` phase with a model and
without one, and a state write refused mid-run); 7 direct runs as the
deferred post-update fetch starts them (an automatic fetch, the
kill-switch skipping what was never stored, no apps, the outer catch, a
resumed queue naming why it skips, a sync that throws, scraping switched
off mid-run); and 9 runs of the
resume closure captured from `register()`. Each app goes through the real
policy pipeline with the network canned and Save Page Now held until the
run is over. `core/src/server/policy_runner_tests.rs` replays all of them
and CI regenerates the fixture ("Policy runner oracle is current"). The
replay passed on its first run. Two cases were then appended: why a run
skips an app, and a sync that throws, are visible only in frames, which
no case had recorded.

**The live gate.** `probePolicySyncRoute` in
`scripts/parity/policy-probes.mjs` holds, on both servers, everything the
route answers before a run: an unparseable and an empty body, a run
already under way and the kill-switch (each written into both databases
for the request and taken out again), and the fifth request in a minute
refused with a `Retry-After` on both. A run itself would fetch every
tracked app's developer site, which a parity run must not depend on, so
it stays with the oracle.

A throttled app counts as throttled, as the fixed Node does. The runner
tells one by the last line of the returned run log, and the store used
to return the row as read before its own `throttled` line (batch 2),
with the previous run's log: an app skipped after a fetch counted as
succeeded, and only a second skip in a row counted as throttled. The
buffered and streamed fleet runs are re-recorded: charlie Chat's
`app-done` says `throttled: true`, and the totals, the state blob, the
activity row and the audit row count one success and one throttled app
where they counted two successes. The runner itself is unchanged.

An app the kill-switch skipped counts as skipped whatever it stored, as
the fixed Node counts it: the runner reads a `disabled` last line as it
reads a `throttled` one. It used to count the stored status, so
scraping switched off during a run counted a stored fetch error as
failed and a stored summary as a success, although nothing was fetched.
Three cases moved: the two fleet runs, in charlie Chat's activity row
only ("Policy skipped: throttled", batch 2), and the kill-switch run,
whose stored Bravo Maps now counts as skipped (0 ok, 2 skipped where it
was 1 ok, 1 skipped). One case is appended: scraping switched off
mid-run, by a trigger as the first app's new version lands, where
Bravo Maps' stored fetch error and charlie Chat's summary both count as
skipped.

**Node's behaviour, kept.** A blob that does not parse is left in place
when the resume heals a stale lock, since it is not a state.

**Negative controls, predicted before running.** The two skip reasons
swapped: exactly the resumed-queue case. No `attempted` count: exactly
the fifteen cases that reach an app. The kill-switch checked after the
stale-lock heal in the resume: predicted the two kill-switch cases, got
one, because the other has pending work and takes the kill-switch branch
in either order; only the lock-only case tells the orders apart. The
outer catch's audit detail without its phase: exactly the three
refused-state-write cases. Live, the core's "already running" refusal
reworded failed exactly the probe's check for it. Source restored byte
for byte after each, fixed tree green.

Rust suite: 268 pass (267 + the replay).

### Batch 4b — the policy triggers

`core/src/server/policy_triggers.rs` ports the two ways Node starts policy
work on its own, and wires them where Node calls them.

**The policy after a scrape.** `fetchAndParseApp(url, resync, true)` runs
the app's policy through `syncPrivacyPolicyAnalysis` once the scrape has
committed: its link and developer as the page gave them, and no link
clears the analysis. The scrape's `Outcome` now carries both, and
`scrape_initial_urls` runs the step after each app, before the next URL,
when `POST /api/scrape` asks with `summarizePolicies: true`. The dev
seed's live walk always asks; its stand-in, which only cleared the
analysis of an app with no link, is gone. A failure is logged and never
fails the scrape.

**The deferred fetch.** `schedulePostAppUpdatePolicyFetch` is called
where Node calls it: a successful scrape without that flag (`sync` for a
resync, `import` otherwise), an import completion that brought apps in,
and a bulk App Store sync that synced any. Requests coalesce behind a
two-second timer. The drain skips while scraping is off; while another
policy run holds the lock or a readable blob is left, it waits five
minutes, at most three times; otherwise it runs batch 4a's runner as
`automatic`, fetch only. The queue is process state, as Node's module
state is, and the server installs a factory at startup that hands the
timer an owned accessor, fetcher, id source and clock. Under `cfg(test)`
the queue is per thread and no timer is armed: a replay drains the queue
itself, as Node's oracle calls `__drainForTests`.

**The oracle — `core/scripts/extract-policy-triggers-cases.mjs`.** 19
cases, each a list of steps through the REAL scrape, import completion,
sync trigger and seed routes, with drain steps and unrecorded database
changes between them: the policy after a scrape (a page with a link,
without one, a policy page that fails, two apps in turn, a scrape that
fails, the live seed); who asks for the deferred fetch and who does not;
and what the drain decides (scraping off, a busy run then a run, three
waits then giving up, a request that arrives during the waits, a leftover
blob). The clock is frozen, since the scrape paths read the time once per
request. `core/src/server/policy_triggers_tests.rs` replays them through
`precheck` and `perform_async` and CI regenerates the fixture ("Policy
triggers oracle is current"). The replay passed on its first run.

**Checked on the real server.** Neither the replay nor the live gate can
reach the timer, so it was checked by hand: pt-core on a scratch database,
an import completed with one app whose policy link is a loopback address,
and about two seconds later the automatic run had fetched (and been
refused) and written "Bulk policy scrape: 0 ok, 1 failed". The live gate
passes unchanged; every path this batch adds fetches Apple or a developer
site, so it has no probe of its own.

**Node's behaviour, kept.** After three waits the drain gives up and
drops everything queued, a request that arrived during the waits
included, so an import finished while a long policy run is going can get
no policy fetch at all.

**Negative controls, predicted before running.** The import completion
not asking: exactly the import case. Two waits instead of three: exactly
the case whose new request lands after the waits (giving up at once ends
the same). No policy step after a scrape: exactly the six cases whose
scrape succeeds with the flag on, the no-link delete included. No
kill-switch in the drain: exactly the case with scraping off. Source
restored byte for byte after each, fixed tree green.

Rust suite: 269 pass (268 + the replay).

## Status — Phase 6 (the cutover)

The desktop app moved first: the Tauri shell runs this server inside its
own process instead of spawning Node, and the Docker image followed
straight after, with no release between them. The batches that touched
only `core/` came first, so every shipped build stayed on Node until the
shell was wired.

### Batch 1 — an embeddable server (no routes)

`core/src/server/lifecycle.rs` and `core/src/host_env.rs` make the server
something a host can run inside its own process and stop again.

**The entry point.** `server::serve_with(listener, ServeConfig)` serves on
a listener the host bound. It opens and migrates the database, runs the
boot writes and starts the timers, then serves on the runtime it was
called from and hands back a `ServerHandle`. Binding is the host's job so
it can pick the address: the shell will bind loopback, on its last port
when that is free, so the page's origin (and with it local storage)
survives a relaunch. `pt-core serve` is now a thin caller: it binds, calls
`serve_with`, prints the same readiness line, and stops on SIGINT or
SIGTERM.

**The environment.** Every setting the server reads (the data directory,
the bind host, the allowed hosts, the admin token, the runtime,
`NODE_ENV`, `DEPLOYMENT`, the Homebrew variables, `HOME`) goes through
`host_env::var`. `pt-core` still reads the process environment. A host
that passes `ServeConfig { env: Some(map) }` makes that map the server's
whole environment for the rest of the process, which is what the shell's
`env_clear()` did for the Node sidecar: a stray `AUDITOR_ADMIN_TOKEN` or
`PRIVACYTRACKER_NETWORK_EXPOSED` in the desktop app's own environment
cannot change who may call the API. One server per process: a second,
different environment is refused, and so is a data directory resolved
before the environment was fixed.

**Shutdown.** `ServerHandle::shutdown(grace)` stops accepting, wakes every
timer so its loop ends (the deferred policy fetch's included), gives
requests in flight up to `grace`, then drops their connections and
returns once the listener is closed. `server::SHUTDOWN_GRACE` is three
seconds, the gap the shell left between SIGTERM and SIGKILL. What it does
not stop is work already started off a request, a spawned bulk run or a
Save Page Now post: that ends with the runtime, which the host drops as it
exits. A bulk run cut off that way resumes on the next start, as after a
crash, and a write is committed or rolled back, never torn.

**Panics.** In a sidecar a panic killed one child process; in process the
same bug would leave the app open with a backend that fails every
request. Now:

- a handler that panics answers Next's bare 500, and the error ring
  records it (`catch_panic`, the innermost layer, so timing and the gate
  see an ordinary response);
- a panic while a section holds the database connection no longer poisons
  it for good (`lock_db`): the `Transaction` guard has already rolled
  back, the poison is cleared, and a transaction left open outside a guard
  is rolled back too;
- the shared rings, caches and registries take the same tolerant lock
  (`lock_state`);
- a timer tick that panics is logged and its loop carries on (`isolate`),
  as a thrown error in a `setInterval` callback ends that call and not the
  interval.

**Logging.** The library logs through the `log` facade instead of
printing. `diag::log_warn` and `log_error` still feed the error ring, then
go to `log::warn!` and `log::error!`, and the four informational lines are
`log::info!`. `pt-core` installs a small logger that prints this crate's
lines, warnings and errors to stderr and the rest to stdout, as before.
The shell's log plugin will write them to the desktop log file, which the
sidecar's output never reached.

**The gate.** Unit tests for each piece: the poisoned connection
recovered with its transaction rolled back; a transaction left open
rolled back on recovery; a poisoned state lock still usable; a panicking
tick that leaves its loop running; a stop that wakes a sleeping timer;
and a panicking route under exactly the layers `app` applies (`layered`)
answering a bodiless 500 while the next request succeeds.
`core/tests/embed.rs` is a test binary of its own, because the environment
is fixed once per process. It runs `serve_with` end to end on a host
environment while the PROCESS environment asks for a token, marks the
deployment network-exposed and points the data directory at a decoy:

- a same-origin POST succeeds with no token;
- the database lands in the host's directory with 0700/0600 permissions,
  and nothing lands in the decoy;
- the boot writes record the desktop runtime;
- a second, different environment is refused;
- a shutdown with a request stuck reading its body waits out the grace
  (0.6 s) and no longer, after which nothing accepts on the port.

Every replay passes unchanged, and the live gate (`read-parity.mjs
--mutate`, 476 checks) passes through the new `pt-core serve`.

**Negative controls, predicted before running.** The database lock back
to `expect`: exactly the two recovery tests. No `catch_panic` layer:
exactly the route test. `host_env::var` ignoring the host environment:
exactly the embed test (its POST answered 401). `isolate` awaiting the
tick without catching: exactly the tick test. Source restored byte for
byte after each, fixed tree green.

Rust suite: 278 lib tests pass (270 + 8), plus the embed test.

### Batch 2a — the device routes (+5 handlers)

`core/src/server/device_writes.rs` ports the five routes Phase 4 set
aside as host dependent, with `lib/device-actions.ts`,
`lib/device-backup-verification.ts` and `lib/device-sync.ts` under them.
None of them touches hardware: cfgutil runs in the Tauri shell, and these
routes record what it did, decide what it may do next, and diff and apply
a device's app list.

**The backup record.** `POST /api/device-actions/backup` refuses any
audience but `self` before it reads the body, then wants an ECID
(trimmed, one `0x` dropped, 8 to 24 hex digits) and a path, and verifies
the backup in Node's order: an absolute path, Apple's MobileSync root
present, the path not a symlink, its real path a direct child of the
root's, a directory, and in it a `Manifest.db` that is not a symlink,
resolves inside it, is a regular file, is not empty and was last
modified at a positive time no later than now. Each refusal is a 422
naming the check. A verified backup is stamped under
`cfgutil_last_backup_<ECID>`, upper case, dated by the manifest when that
is older than now (a time the client sends is ignored), and logged as a
`cfgutil_backup` activity row.

**The uninstall gate.** `GET /api/device-actions/uninstall` answers the
gate and the stamp it read, and writes nothing. `POST` logs an uninstall
the shell performed, once the same gate allows it. The gate runs in
Node's order: whose device it is (a recorded owner audience must match
the focus, and a device that is not the user's own also needs the
permission acknowledgement; no owner, or no device with that ECID, falls
back to audience `self`), then `flag.devopts.cfgutil_uninstall`, then,
unless the caller acknowledged going without, a stamp whose backup still
verifies and is no more than a day old, counting from the older of the
stamp and the manifest.

**The re-sync.** `POST /api/device-sync/preview` cleans the client's list
(at most 2,000 entries; anything without a string app id skipped; the
first of a repeated id kept), fills in a missing bundle id from the
library, and diffs the list against the device's links: the adds, the
removes (each saying whether unlinking would orphan the app), the
unchanged count, and the bundle-id merges, where a new app id carries the
bundle id of an app already on the device. `POST /api/device-sync/commit`
applies a selection in one transaction: the merges first, keeping only
the client's pairs the diff would propose, all judged before the first
one runs (the old app on the device, the new one in the library and not
on it, the same non-empty bundle id on both); for each, the old id's
annotations, verdicts, shortlist entries and snapshots moved to the new
one, whose own conflicting verdicts and shortlist entries are dropped
first, then the old id's links copied and the old app deleted; then the
adds, the removes with the orphan sweep, and the device's sync time;
then the `device_resync.last_committed_at` setting and a
`device_sync.commit` audit row. The two keep their limits (30 and 15 a
minute) and their body caps (512 KiB and 256 KiB).

**The oracle — `core/scripts/extract-device-routes-cases.mjs`.** 149
cases through the REAL handlers: 43 for the backup, 27 for the gate's
GET, 29 for its POST, 23 for the preview and 27 for the commit, each
POST with the five body-reader outcomes and its non-object bodies, and
the two limited routes with the burst past the limit. The backup check
reads the disk, so the oracle builds a MobileSync-shaped tree of 15
entries (two fresh backups, and one each stale, empty, from the future
and without a manifest; a directory and a symlink where the manifest
should be; a symlinked backup, a file, a nested backup, one outside the
root, a manifest beside `Backup/` and one in it), sets every manifest
time against the frozen clock, writes the tree into the fixture as data
and spells its scratch directory `<BASE>` everywhere.
`core/src/server/device_writes_tests.rs` builds the same tree, swaps the
real directory in and back out, runs each case through `precheck` and
`perform` (the GET through its own handler) and compares the wire, the
write stream and the ten tables. CI regenerates the fixture ("Device
routes oracle is current"). The replay passed on its first run.

**The live gate.** `probeDeviceRoutes` in
`scripts/parity/device-probes.mjs`, run by `read-parity.mjs --mutate`,
holds what both servers answer on the same host over the same fixture
library: the gate with and without an ECID; the backup's refusals, the
artifact one included, since a path that is not there reads the same
host folder from both; the uninstall log refused while its flag is off;
the preview's refusals and a real diff over a fixture device; and the
commit's refusals. A commit that lands is left to the oracle, because it
stamps the device with each server's own clock. The four routes stay in
the differ's quarantine, with their reasons rewritten in
`scripts/parity/manifest.mjs`: none of them drives hardware, but the
backup and the gate read the host's MobileSync folder, and the re-sync
pair act on a list the client sends.

**The merge check, fixed in Node and the core together.** The commit used
to merge any two apps the client named: nothing checked that the preview
had proposed the pair, so a crafted, buggy or stale request could fold
one app into another and delete it. It now keeps only the pairs the diff
would propose for the device, read from the library by one query that
Node and the core share word for word, and judges them all before the
first merge runs, so a merge that links its new app to the device cannot
qualify a follow-up pair from that app. One difference from the diff is
deliberate: with two same-bundle rows on the device, the diff proposes a
merge for the last one its read returns, and the commit accepts a pair
for each, since they are all the same app. `merged` counts only the
pairs applied. In the oracle, the case that pinned the bug (an app with
no bundle id folded into Instagram) now records the refusal under a new
name, and the merge that moves the user's data keeps its request with a
setup the preview would propose (Signal not on the device, both rows on
the iPad, so copying the links still collides there). Six cases follow
every other: a merge across two bundle ids, beside an add and a remove
that still apply; an old app not on the device; a new app already on
it; empty bundle ids on both rows; a chain whose second pair only
qualifies after the first merge; and two same-bundle rows on the device
merged into one app. The other 138 cases are byte-identical in place.
Negative controls, predicted before running: the core's commit from
before the fix fails exactly six cases, the five refusals and the chain,
whose second pair it merged; judging each pair inside the loop fails
exactly the chain and the two same-bundle rows; and the verdict-conflict
control below, run again, fails exactly the three cases that now apply a
merge. Source restored byte for byte after each, fixed tree green.

**Node's behaviour, kept.** The two bugs this batch filed are fixed,
each in Node and the core together: the merge check above and the
root's parent below. Kept as Node has it: a
shortlist entry never stops a remove from reading as orphaning its app,
through the same failing probe as Phase 4's orphan sweep; the uninstall
log binds the client's app id as better-sqlite3 does, a number as a REAL
and a boolean or an object refused (the statement recorded, no row
written, the route still answering `ok`); and a `null` body to that log
is Next's bare 500.

**Negative controls, predicted before running.** The direct-child test
refusing `..`: exactly the root's-parent case. No permission check:
exactly the two cases with another person's device and no
acknowledgement (none recorded, and a stamp of zero). No bundle-id
backfill: exactly the four preview cases whose answer uses a bundle id
the library filled in. No verdict-conflict delete in a merge: exactly the
cases that apply a merge (two when the batch landed, three since the
merge check). A numeric app id bound as an integer:
exactly the case that sends one. Live, two faults at once (the backup's
ECID refusal reworded, and an add's `iconUrl` key renamed) failed
exactly the probe's two checks for them, 484 of 486 passing. Source
restored byte for byte after each, fixed tree green.

**The root's parent, refused.** Node's `isDirectChild` and the core's
`is_direct_child` now refuse a relative form of `..` and also require
the candidate's dirname to be the root, so the MobileSync folder's
parent no longer records as a backup, and so can no longer stand in for
one at the uninstall gate. The oracle's case for it is renamed "the
root's parent is not a child" and records the 422 with no writes, where
it used to record a stamp and an activity row. Three cases appended
after every other hold the same refusal for the parent spelled
`Backup/..`, the root itself and a dot-dot path back to it, and the
tree gains a `Manifest.db` in the root so that only the direct-child
test refuses the root. The 139 other earlier cases are byte-identical in
place. Negative controls: the old `is_direct_child` fails exactly two
replay cases, the renamed one and the parent spelled with a dot-dot, and
the old `isDirectChild` moves exactly those two in the recording.

Rust suite: 281 lib tests pass (278 + 2 unit tests + the replay), plus
the embed test.

### Batch 2b — the feature-flag migration (no routes)

`core/src/server/flag_migration.rs` ports `runFeatureFlagMigration` from
`lib/migrations/v1_feature_flags.ts`. Node's startup hook runs it before
anything else writes, and `start_background` now runs it in the same
place, ahead of the boot writes. A failure is logged and the server comes
up anyway, as Node's does.

**What it does.** Nothing once `feature_flag_migration_version` reads as
2 or more by `Number.parseInt`, so `"2.5"` and `"\t 2"` count and `"0x2"`
does not. Otherwise six steps, each between a "started" and a
"completed" `migration` activity row:

- a check that `feature_flag_overrides` and `annotations` exist;
- the legacy `user_intent` (`curious`, `cleanup`, `hygiene`, `family`)
  becomes a focus through `setActiveFocus` and goes; any other intent,
  an inherited name such as `toString` included, is dropped with a
  warning;
- the legacy `notification_prefs` blob becomes one override per type it
  names, `on` for `true`, `"on"` or `"true"` and `off` for anything else,
  and goes; a blob that is not JSON, or is JSON but not an object, is
  dropped with a warning;
- the four retired callout overrides are dropped;
- overrides whose key the flag registry knows leave quarantine, and the
  rest enter it, each statement binding all 222 registry keys in
  `Object.keys(HARD_DEFAULTS)` order;
- the old goal keys (`understand`, `declutter`) move to `monitor` and
  `cleanup` unless those are already set.

Then the version marker and a closing row with each step's duration. A
step that fails writes a "failed" row and ends the run without the
marker, so the next boot runs it again. There is no transaction around
the run, so the steps before a failure keep what they wrote. Where Node
nests one transaction in another (`setActiveFocus` inside step 2), the
port nests them as better-sqlite3 does, through savepoints.

**The oracle — `core/scripts/extract-flag-migration-cases.mjs`.** Runs
the REAL migration over 45 cases: the version gate (11 cases), each step
over the legacy state it migrates, every step at once on a legacy
install, and the failures (a table missing, and a later step failing
after an earlier one wrote). A frozen clock makes every duration 0 ms,
and a case may drop a table or add a trigger inside its savepoint.
`core/src/server/flag_migration_tests.rs` replays it, comparing what the
run returned or threw, the write stream and three tables, and CI
regenerates the fixture ("Flag migration oracle is current"). The replay
passed on its first run. A unit test boots twice over a database missing
a table: no marker, and one failed row per boot. The embed test now
checks that a fresh database gets the marker and the 13 rows at boot.

**The live gate, and both real servers.** The gate's first run on this
batch failed five flag checks, and the cause was the wiring working: the
seed's `/api/reset` deletes the marker after Node's boot, Node's running
process never reads it again, and the core's boot then migrated the copy.
`read-parity.mjs` now puts the marker back on Node's side before the copy
(`restoreMigrationMarker`), as it already guards the unknown-device
backfill, and the gate passes (486 checks). The migration itself was then
checked on both real servers. A seeded database had legacy state planted
in every step's path (an intent, a prefs blob, a retired callout, an
unknown override, a quarantined known one, the old goal keys). It was
booted once by the Node production server and once by `pt-core`, each
stopped before its first timer. The two boots wrote the same settings,
overrides and 13 activity rows; only ids, the boots' own timestamps and
the durations were normalised.

**Node's behaviour, kept, and one bug filed and since fixed.** Two
stored values failed a step on every boot for good, so the marker was
never written and the steps after the failure never ran: a
`notification_prefs` of JSON `null` (`Object.hasOwn(null, …)` threw), and
a `user_intent` naming an inherited property such as `toString` or
`__proto__` (the lookup found the inherited member, whose audience is
`undefined`, and better-sqlite3 bound that as NULL into a NOT NULL
column). The app never writes either value, but a restored or edited
database can hold them. The follow-up fixed Node and the core together.
A blob that parses to anything but an object (`null`, an array, a
number, a string) is dropped with a warning and no transaction, as one
that does not parse already was; before, all but `null` went through a
transaction that wrote nothing and deleted the blob. The intent is
looked up with `Object.hasOwn(INTENT_MAP, …)`, so an inherited name is an
unknown intent, warned about and dropped. The oracle's five cases for
the two values were re-recorded under names for what they now do (the
`toString`, `__proto__` and version-1 `valueOf` intents dropped as
unknown; `null` prefs dropped, alone and ahead of the later steps), and
the two failure properties two of them carried moved to cases that still
fail: a run from version 1 over a missing table leaves version 1, and a
trigger refusing the prefs step's override write keeps step 2's focus
while step 6 never runs. Of the other 38 cases, 35 re-recorded byte for
byte, and the array, number and string prefs lost only the BEGIN and
COMMIT around their delete. The fix's controls, predicted before
running: the old inherited-intent write failed exactly the three cases
with one; `null` prefs failing their step again, exactly the two with
them; only `null` dropped, exactly the array, number and string cases;
the marker written after a failure, exactly the four failure cases and
the boot test. Source restored byte for byte after each. Also kept: an
intent must match exactly (`"Curious "` is unknown), and an empty
`notification_prefs` is left in place rather than deleted.

**Negative controls, predicted before running.** The version gate
comparing the string to `"2"`: exactly the three cases that skip by
`parseInt` without being `"2"`. Inherited intent names read as unknown:
exactly the three cases with one. Prefs of `null` not failing their
step: exactly the two cases with them (these two are the port's
behaviour since the fix above). The workflow inferred as if the
audience were `self`: exactly the two `family` intents. The string
`"true"` not switching a type on: exactly the case that sends it. An old
goal key overwriting a new one already set: exactly the kept-key case
and the legacy install, whose step 2 had already written the cleanup
goal. Source restored byte for byte after each, fixed tree green.

Rust suite: 283 lib tests pass (281 + the replay + the boot test), plus
the embed test.

### Batch 3a — the frontend, from the normal build (no API routes)

`pt-core serve --site <dir>`, or `ServeConfig { site }` for a host,
serves the frontend too: the normal `next build` output under `<dir>`,
the directory `next start` runs in. The build stays exactly the one
Node serves, which is what the rollback window needs; a static export
can replace it once the Node server code is deleted.

**What is served (`core/src/server/site.rs`).** Every page is
prerendered, so the server answers from the build's files as `next
start` does:

- the 38 documents, each with its `.meta` status and headers, Next's
  `Vary`, `x-nextjs-*` headers and ETag (`fnv1a52` over the UTF-16
  string), and a 304 for a matching `If-None-Match`;
- the RSC payload a client navigation fetches and the segment files a
  prefetch asks for, behind Next's `_rsc` cache-busting check (a hash of
  the four router headers; a mismatch is a 307 to the right one);
- `/_next/static` and `public/` through a port of the `send` Next
  bundles: validators, conditional requests, byte ranges, its MIME
  table, and its Cache-Control (immutable for static, `max-age=0` for
  public);
- the three metadata icons, the two rewrites to the view shells, the
  not-found page for every other path (an unknown `/api` path included),
  and a 405 for a page asked to do anything but GET or HEAD.

The build is indexed once, at startup, as Next indexes its folders. A
request only looks a file up by name in that index, so a path a client
sends never reaches the filesystem.

**What is around it.** `frontdoor.rs` does what `next start` does
around its router, wrapped around the whole router rather than each
route (axum's `Router::layer` runs after routing):

- the repeated-slash 308 and the WHATWG resolution of dot segments,
  before routing, so `/api/x/../health` reaches the health route;
- next.config's five security headers on every response;
- the `compression` middleware (gzip or deflate, never brotli, from
  1 KiB, `Vary: Accept-Encoding`), which Next's route handlers bypass,
  and so do this server's API routes and icons.

`gate.rs` gains the rest of `proxy.ts`:

- its matcher (static assets skip every step);
- the page branch of the auth step (a 307 to `/login`, not a 401);
- its CSP on every response it handles (`csp_policy.rs`, from
  `csp-hashes.json` and `cspRouteKey`);
- Next's own Cache-Control, which replaces the proxy's `no-store` where
  Next sets one after it.

The API changed in three visible ways, each towards Node: every response
carries the security headers, the CSP and the router `Vary`; an unknown
path gets the not-found page; and a 405 names no `Allow`.

**How it was mapped.** Before the port was written, `next start` was
asked 200 requests across every response class, with and without
the token, and each answer recorded; the rules are in the code's
comments. The ETag, `fresh`, `range-parser`, `negotiator`, the `_rsc`
hash and `normalizeRepeatedSlashes` are ported from Next's own source
(`nexthttp.rs`), each pinned by a unit test against values Node
produced.

**Node's behaviour, kept.**

- A byte range that cannot be satisfied, a failed precondition, or a
  POST to a static file answers 500, not 416, 412 or 405.
- A page answers 304 to `If-None-Match` even with `Cache-Control:
  no-cache`, while a static file does not.
- A page name spelled with escapes (`/%64ashboard`) is the not-found
  page, keeping the proxy's `no-store`.
- `/_global-error` asked for by name answers 500, while its segments
  answer 200.

**The gate.**

- Unit tests: the helpers in `nexthttp.rs`, the CSP route keys, and
  the `Vary` merge. `site_tests.rs` runs the handler over a small
  synthetic build, so CI covers it without a build of its own.
- The page-parity probe (`scripts/parity/page-probes.mjs`), run by
  `read-parity.mjs`, which now starts the core with `--site` on its own
  working directory. On both servers and the same build it compares 404
  requests on the status, the body (decompressed when compressed) and
  every header by name:
  - every page as a document, a HEAD, an RSC request, a prefetch and
    each of its segments;
  - the rewrites and the not-found page;
  - a sample of `/_next/static`, every public file and the icons;
  - 67 edges: conditionals, ranges, encodings, methods, redirects,
    encoded and dot-segment paths, and no token.

  All 404 are identical. The whole live gate passes with it (487
  checks).

**Negative controls, predicted before running.** In the unit tests:

- Pages honouring a request's `no-cache`: exactly the document test.
- Two byte ranges answered with the first: exactly the file test.
- The not-found page without its own Cache-Control: exactly the
  not-found test.
- The ETag counting UTF-8 bytes: predicted the document test, which
  stayed green. It compared against `generate_etag` itself, so it could
  never disagree with a broken port. It and the helper test now pin
  Node's literal ETag, and the control then failed exactly those two.

Live:

- Segment status always the page's: exactly the 7 segment checks of
  the two error pages.
- The CSP route key without the rewrites: exactly the 9 checks on the
  rewritten paths.

Source restored byte for byte after each, fixed tree green.

Rust suite: 296 lib tests pass (283 + 13), plus the embed test.

### Batch 3b — the browser suite against the core (one route fixed)

The Playwright suite now runs against the core as well as against `next
start`. `playwright.config.ts` takes `PLAYWRIGHT_CORE_BIN`: when it is
set, the suite's web server is `pt-core serve --site .` over the same
`next build` output, in place of `pnpm start`. CI's new `e2e-rust` job
runs the suite that way on every push. It is not a required check yet;
it becomes one after a week green.

**What the suite found.** One port gap, in `GET /api/apps`: the core
ignored `?devices=`. Node runs every branch after the two `?id` ones
under the request's device scope, and the grid asks for its pages with
the param. After picking a device, the grid still drew the right cards
(it also filters in the browser) but counted the whole library: "3 of
10 apps" where Node says "3 apps tracked". The read gate could not see
it, because every manifest read of `/api/apps` is unscoped. The
route now takes the scope as the stats reads do (`Scope::from_request`),
and the page, count and grouped queries take it with Node's SQL:

- the scope goes inside `page_apps`, before `LIMIT` and `OFFSET`, so the
  offsets page through the scoped set;
- the total is the scope's, not the fleet's;
- the grouped view filters its category rows through the same scope, so
  a category whose only apps are out of scope disappears;
- export stays unscoped.

The route also kept the LAST of a repeated param (a `HashMap`), where
`URLSearchParams.get` returns the first; it now reads its params as the
later routes do.

The first run's two other failures were knock-ons. Each failed test
restarts the Playwright worker, and the restarts' extra seeds hit the
dev seed's rate limit (30 in 10 minutes).

**The gate.**

- Unit tests in `apps.rs` and `routes_apps.rs`: a device with no apps,
  paging inside a scope, the unattached scope, an unknown device, the
  grouped view, and a repeated param.
- The live gate: the device probe gains 8 checks on scoped `/api/apps`
  and the stats probe one on the scoped grouped view. 496 checks pass.
- The whole suite against the core, through the new switch: 73 passed
  and 22 skipped, as against Node. Pointing the switch at a missing
  binary stops the run before any test, so the pass is the core's.
- The visual net, with its baselines captured from `next start`: all 20
  shots match the core, as they match a second `next start` run.

**Negative controls, predicted before running.** In the unit tests:

- the route ignoring `?devices=`: exactly the two route tests that
  scope;
- a repeated param keeping its last value: exactly the repeated-param
  test;
- the scope applied after `LIMIT`: exactly the paging test and the
  route test that pages the unattached scope;
- the grouped view scoping its app map but not its rows: exactly the
  grouped test.

The route ignoring `?devices=` again, live and in the visual net:

- the gate: exactly the 7 predicted checks (6 device, 1 stats). The
  unknown device and the repeated empty `devices` still pass, because
  both servers answer with the whole fleet;
- the visual net: exactly the 2 predicted shots, the scoped grid and the
  focus-switch prompt drawn over it. The other 18 pass: every other
  shot starts unscoped, and the two other scoped shots read nothing
  from `/api/apps`.

Source restored byte for byte after each, fixed tree green.

Rust suite: 301 lib tests pass (296 + 5), plus the embed test.

### The remaining repeated-key readers (no new routes)

Batch 3b moved `GET /api/apps` off `Query<HashMap<String, String>>` after
the browser suite caught it counting the whole library for a scoped grid.
Five handlers still had that extractor, and the same gap with it: a
`HashMap` keeps the LAST value of a repeated key where
`URLSearchParams.get` returns the FIRST, so `?x=a&x=b` answered
differently on the two backends.

| handler | key | what Node answers when the FIRST value is empty |
|---|---|---|
| `routes_imports::imports` | `id` | falsy, so the list rather than one import |
| `routes_status::verdicts` | `appId` | falsy, so `400 appId is required` |
| `routes_runtime::errors` | `limit` | the whole ring, not the last value's slice |
| `routes_app::app_changelog` | `before`, `limit` | `Number("")` is 0, an empty page; `parseInt("")` is NaN, a 400 |
| `routes_manual::audit_bundle_recent` | `withinMs` | present and NaN, so a 400 |

All five now take `routes_stats::Params` — a `Vec` of pairs read
first-match through `get` — as every query-reading route in this server
does. A derived struct is still the wrong answer, and that is the reason
the `errors` comment gives: axum refuses a repeated key with its own 400,
where Node takes one value and answers 200.

**Why no read had caught it.** Every path in the manifest names each key
once, and no oracle-fixture URL repeats one either. The class was outside
the gate, not passing it.

**The gate.**

- A unit test per handler, calling it directly with `State` and `Query`
  as the `routes_apps.rs` tests do. Each asserts twice: that the repeated
  answer is the FIRST value's, and that the last value ALONE answers
  otherwise, so no test can pass on data too thin to tell them apart.
  The `errors` test holds `trust::env_lock()` and drives the handler with
  `block_on` from a plain `#[test]`, because the ring it measures is
  process state that `maintenance_tests` clears per case.
- `scripts/parity/repeated-key-probes.mjs`, five live checks. Each sends
  the repeated key, the first value alone and the last value alone to
  BOTH servers, and passes only when the two agree on all three, the
  repeated answer is the first value's, and the last value's differs.
- `/api/diagnostics/errors` cannot be held that way: its answer is a
  slice of a per-process ring, and Node's was empty in production at the
  time, for the reason the error-ring probe's own note gives. Its
  first-wins assertion went there instead, against the Rust ring's own
  length, replacing a repeated case that asserted only HTTP 200 on both
  sides. Node's ring has since been fixed (it lives on `globalThis` now),
  and that probe holds both servers to the first value.

**Negative controls, predicted before running.** Reverting all five
handlers to the last value of a repeated key — the reads, not the
extractor type, since changing the type stops the tests compiling and so
cannot show which assertions move:

- the unit tests: exactly the five new ones. The other 301 pass.
- the live gate: exactly the six predicted checks, the new probe's five
  and the error ring's, out of 501. Every other check passes, which is
  the same statement as above: the class had no other coverage to
  disturb. Each failure names the reason, the core answering the last
  value where Node answered the first, and reports the two single-key
  controls agreeing on both sides.

Source restored byte for byte after each, fixed tree green.

Rust suite: 306 lib tests pass (301 + 5), plus the embed test.
### Batch 4a — the desktop app on this server, behind a feature

The Tauri shell can now serve the app from this crate instead of
spawning the Node sidecar. It is a cargo feature that is off by default
(`rust-backend`), so every shipped build still runs Node until the
cutover release, and CI compiles the shell both ways.

`just tauri-dev-rust` runs it. That needs no `fetch-node-sidecar` and no
standalone tarball: it builds the frontend and the app serves it.

**The shell's three files.** `backend.rs` is what the rest of the shell
talks to (where the backend is, how it stops, and `post`, its one way to
send a mutating request). `sidecar.rs` is the Node implementation,
compiled unless the feature is on. `embedded.rs` is this one, compiled
only when it is. Nothing else in the shell knows which it got.

**What the embedded backend does with what the sidecar did:**

- **the same data directory**, resolved once in `backend.rs`, so either
  build opens what the other wrote;
- **the environment as a map**, not variables set on this process:
  setting them inside a running GUI process is unsound, and the server
  must see exactly what `env_clear()` gave Node — the data directory, a
  loopback bind, `PRIVACYTRACKER_RUNTIME=desktop`, and no admin token
  (the desktop relies on the loopback bind, and no token is also what
  keeps the server from demanding one);
- **the same `next build` output**, served from where it is staged
  rather than extracted into the data directory;
- **three seconds** for requests in flight when the app quits, the grace
  the sidecar had between SIGTERM and SIGKILL;
- **no readiness poll**: the listener is bound and the router built
  before `boot` returns, where the sidecar had to be waited for.

**The port is remembered.** The sidecar takes a fresh random port every
launch, and a page's origin includes its port, so everything the app
keeps in local storage — the accessibility quick toggles among them — is
lost on every relaunch. The embedded backend reuses the last port when it
is still free. That is the Rust build's alone, as decided.

**Unchanged:** the window, the tray, the menu, the notifications
watcher, deep links, the updater, the capability and its remote URL, all
16 commands, and the shell's own POSTs with the Origin the CSRF gate
wants.

**The gate.**

- The shell's tests, both ways: 24 on the Node path, 28 with the
  feature. The four extra include a **boot test** that starts the server
  for real over a temporary data directory and a small build, asks for a
  page and an API read, checks the page carries the desktop CSP (which
  is how the environment map is proved to have arrived), and stops it,
  leaving the port free.
- **The app itself, run on this backend.** It boots, opens its database
  at `0600`, answers `/api/health`, the home page with the CSP and the
  five security headers, a rewritten page and an API read; the Tauri
  webview loads it (six connections from WebKit's networking process);
  the shell's own settings read comes back; and a relaunch takes the same
  port.
- **CI**: `rust-check` compiles the shell with and without the feature
  and runs its tests with it, so "off by default" is checked rather than
  claimed.
- **The inert guard** (`tests/app/rust-core-inert.test.ts`), narrowed
  rather than deleted: the shell may name the core from `embedded.rs`,
  which starts with the feature's `#![cfg]`, and declare it in its
  manifest as an optional dependency reached only through the feature.
  Everything else keeps the flat ban, the Dockerfile above all.

**Negative controls, predicted before running.** Four behaved as
predicted at once: an unwired dependency, a dropped
`PRIVACYTRACKER_RUNTIME`, a remembered port trusted whatever it says, and
a frontend that cannot be found (the app refuses to start and says where
it looked, rather than opening a window onto a server with no pages).

Two disagreed, and both taught something:

- Removing `embedded.rs`'s `#![cfg]` was predicted to stop the default
  build compiling. It did not: the module declaration in `main.rs` is
  gated too, so the file was never compiled.
- Removing that declaration's gate instead was then predicted to stop
  it. It did not either: the file's own attribute empties the module.

So the two gates are independent, and either alone keeps the core out —
which means either could be dropped silently, leaving the invariant on
one line. The guard now checks both, a third control proves the pair is
what the compiler actually enforces (removing both stops the build), and
the guard's own comment says so.

Source restored byte for byte after each, fixed tree green.

### Batch 4b — the site inside the bundle, and the database handed over

Two things a packaged Rust build needs, and one the rollback does.

**The site is staged into the bundle.** `scripts/stage-site.mjs` copies
the four things the core serves and nothing else: the prerendered pages
with their metadata, RSC payloads and segments (`.html`, `.meta`,
`.rsc`, `.body`), `.next/static`, `.next/csp-hashes.json` and
`public/`. Not the route modules a build writes beside the pages, not
the cache, not a standalone tree, not `node_modules`: the desktop app
never runs that code, and what is not shipped cannot be loaded. The
result is about 9 MB, against the Node path's ~200 MB tarball, and it
sits read-only inside the signed bundle instead of being extracted into
the data directory.

It refuses what it should: a build with no not-found page (the core
would refuse to load it), a missing build (naming the command that makes
one), and any database file (a bundle must ship no user data). It wipes
its destination first, so a page deleted since the last staging cannot
be served from a stale copy.

`src-tauri/tauri.rust.conf.json` is the overlay that bundles it:
`pnpm tauri:build:rust`, or `just tauri-build-rust`. The base config
stays the Node one, so a default build is untouched. Tauri merges the
two, so the Rust bundle still lists the Node tarball as a resource; on a
machine that has never staged one that is the 0-byte stub, and dropping
it belongs with the rest of release engineering (batch 5).

**Verified by building one.** A debug bundle carries
`Contents/Resources/site` at 9.8 MB, and the packaged app, launched from
outside the repository so nothing could fall back to it, served its
pages from there.

**The handoff test** (`scripts/parity/handoff.mjs`, `just handoff`, and
CI's `core-parity` job) is what the rollback rests on: a Node build has
to open the database a Rust build left behind. Each backend seeds its
own fresh data directory, replays the manifest's mutations over it and
answers a set of reads; it stops, the other backend opens **the same
directory** and has to be ready and answer identically. Then the two
swap. That covers what `read-parity.mjs` structurally cannot: it always
compares over a COPY of a database Node wrote, one way round, with the
WAL already checkpointed. Here it is the directory as the other process
left it, `-wal` and all, in both directions, across two SQLite versions
(rusqlite 3.46, better-sqlite3 3.53). 40 checks pass.

**Negative controls, predicted before running.** Three on the staging
script: copying everything under `server/app`, not wiping the
destination, and staging a database. Each failed exactly its own test.

Two live, and both taught something:

- **The receiving backend opens a different directory.** Predicted: the
  fleet checks and six compared reads. Two of those six did not fail:
  `/api/shortlist` and the universal `/api/changelog` were EMPTY on
  either side, so they were proving nothing. Nothing in the replayable
  mutation set adds a shortlist entry, and the universal changelog lists
  changes, of which a seeded install has none. The script now writes a
  shortlist entry and compares the per-app timeline, and the control then
  fails exactly the fleet checks and nine reads per direction.
- **The mutations are not replayed.** Predicted: the two count guards.
  They failed, and so did `/api/devices` and the grid's `meta=grid` in
  both directions. The cause is real: a database with apps and no devices
  gains a placeholder device the next time EITHER backend opens it (the
  unknown-device backfill), which would make a handover look wrong. The
  script now asserts the writes left a device behind, so what it compares
  is the handover rather than the backfill.

Source restored byte for byte after each, fixed tree green.

### Batch 5a — releasing a build on the Rust backend

`macos-release.yml` takes a `backend` input. `node` is the default and is
what every release still ships. `rust` builds the app on this crate:

- no Node is fetched, GPG-verified or bundled, and the better-sqlite3
  load check does not apply (SQLite is compiled into the binary);
- no staging keychain, because nothing inside the bundle is code that
  needs signing before the app is sealed: `stage-site.mjs` stages pages,
  assets and the CSP hashes, and the bundler signs the app itself;
- `pnpm build` and `pnpm stage:site` in place of `build:standalone`, and
  therefore no `STANDALONE_PRE_BUILT` guard;
- the build runs with the feature, the config overlay and cargo's
  `--no-default-features` after the separator, which is the one spelling
  the tauri CLI accepts;
- `.nvmrc` decides the build's Node, since nothing pins it to a shipped
  runtime any more.

`Prepare verified release draft` calls the workflow without the input, so
tagged releases stay on Node until the cutover flips that one line. A Rust
build is rehearsed by dispatching the workflow on a reviewed tag with
`backend=rust` and `dry_run=true`.

**The entitlements shrink to nothing.** `entitlements-rust.plist` grants
none of the three the Node build needs: `allow-jit`,
`allow-unsigned-executable-memory` and `allow-dyld-environment-variables`
all exist for V8, and there is no V8 here. The webview still JITs, but
WebKit does that in its own process, which Apple entitles. That is a claim
worth testing rather than believing, so it was: a bundle signed with the
hardened runtime and an EMPTY entitlements dict runs, and its webview loads
the app (six connections from WebKit's networking process, the home page
answering 200).

**The verifier gained a backend.** `verify-macos-bundle.mjs <app> <arch>
[backend]` checks the same things about any bundle (version, OS minimum,
architecture, signature, notarisation, Gatekeeper) and then what belongs to
the backend. For `rust`:

- nothing of Node ships: no helper bundle, no interpreter, and a tarball
  only if it is the 0-byte stub cargo needs to exist;
- the staged site is complete (both pages, the CSP hashes, chunks and
  public files);
- the binary carries none of the three entitlements;
- and the packaged app itself is driven over HTTP.

**The packaged app drives itself.** `--smoke-server <dir>` (`embedded.rs`)
serves over the directory it is given and waits, with no window and no
tray. It exists because the only thing worth verifying at release time is
what was signed and notarised: `pt-core` is not in the bundle, and a window
would need someone to look at it. The directory is a command-line argument,
never the environment, so a shipped app cannot be pointed at a user's data
this way. `smoke-packaged-rust.mjs` then runs the Node smoke's checks over
it — a v0.1.2 database opens and migrates, a backup exports with every
table, a restore is trusted, the data survives a restart — plus two that
belong to this build: the pages come from inside the bundle, and a read
needs no token, which is the desktop's posture.

**What was run.** A bundle was built with the overlay, signed ad-hoc with
the hardened runtime, and the verifier run against it end to end: 98 static
and 7 public files staged, entitlements empty, and the packaged smoke
passing. `actionlint` is clean on the changed workflows.

**Negative controls, predicted before running.** Each breaks the built
bundle, re-signs it so the verifier reaches the backend checks, and fails
exactly its own assertion: signing with the Node entitlements, a page
missing from the staged site, and a Node interpreter in the Resources. The
restored bundle passes.

One thing is recorded rather than explained: the very first verifier run
against a freshly signed bundle failed inside the packaged smoke, and no
re-run has reproduced it, including immediately after re-signing. It is
noted here rather than given a cause it has not earned.

**Still owed by batch 5b:** the third-party notices for the Rust crates and
the entry on `/legal`, and the hosted docs' desktop page.

### Batch 5b — what the app discloses

The Node build's disclosures come from `package.json`, which `/legal`
reads directly. A Rust build ships compiled crates instead, which
`package.json` knows nothing about, so the list comes from cargo.

**Generated, not written.** `scripts/generate-rust-notices.mjs`
(`pnpm notices:rust`) walks `cargo metadata` for the shell built with
`--features rust-backend`, filtered to one macOS target, and writes:

- `src-tauri/THIRD-PARTY-RUST.md`: every crate that can end up in the
  binary, with version, licence and repository. 342 of them, and the
  licence breakdown at the top;
- `lib/rust-crates.json`: the summary `/legal` renders, small because a
  client component imports it.

Only NORMAL dependencies are walked. Build dependencies run at compile
time and their own code does not ship, and dev dependencies are tests;
including them would inflate the list by 19 crates and make it describe
something other than the app. The file says which it lists.

**Four files travel with the app**, staged by
`scripts/stage-notices.mjs` into `Contents/Resources/third-party/`:
`NOTICE`, `LICENSE`, `V8-LICENSE` (for the ports of V8's date parser and
JSON error messages in `jsdate` and `jsjson`, which `core/README.md` asks
for by name) and the generated crate list. A notice that exists only in
the repository is not shipped with anything, so the release verifier
refuses a bundle that is missing one or carries an empty one.

**`/legal` gained a section.** It names the 37 crates chosen directly,
gives the licence breakdown as the crates spell it (`MIT OR Apache-2.0`
and `MIT/Apache-2.0` are the same choice written two ways, and rewriting
either would be paraphrasing someone else's licence), and says the
complete list ships with the app. The page renders it from the generated
summary, so it cannot drift from what is built. The prose is translated
like the rest of the page chrome, in both shipped locales; the rows are
not, because a crate name, a version and an SPDX identifier are the
upstream's own spelling.

**The gate.** CI's `rust-check` job regenerates the two files and fails on
a difference: a crate added, removed or bumped without regenerating is a
disclosure that no longer matches what ships. That job already has the
dependency graph, which is why it lives there rather than in the parity
job. The verifier's bundle checks cover the shipped copies.

**Negative controls, predicted before running.** A stale checked-in list,
a generator that counts build dependencies (342 becomes 361), a notice
missing from the bundle, and a notice that ships empty. Each failed
exactly its own check.

The first run of the stale-list control reported a pass, and the fault was
in the control rather than the gate: it compared the regenerated file with
a pristine copy, which can only catch a generator change, where CI
compares it with what is committed. Fixed, it fails as predicted. Worth
recording because a control that cannot fail is worse than no control.

**Not in this batch:** the hosted docs' desktop page, which lives in
`privacykey/docs-privacytracker` and describes the app as shipped. It is
filed as its own task, to land with the cutover release rather than
before it.

### The desktop cutover — Rust by default

Batches 1 to 5 built the Rust desktop path behind a feature. This step
makes it the default, with no version bump and no release: the plan has
no release between the desktop and Docker cutovers, so the next desktop
release (1.0) is the first to ship it.

**What flips.** `release.yml` passes `backend: rust` to **macOS desktop
release**, whose own default (for a dispatch) is `rust` as well, and
`verify-macos-bundle.mjs` defaults to checking a Rust bundle. For
contributors, `pnpm tauri:dev` / `pnpm tauri:build` and `just tauri-dev` /
`just tauri-build` build the Rust backend; the Node build moved to
`:node` / `-node` names. The old `just tauri-dev-rust` and
`just tauri-build-rust` remain as aliases. Cargo's default feature set is
unchanged on purpose: a build without `rust-backend` is still the pure Node
sidecar, which is the rollback.

**The rollback.** Set `backend: node` in `release.yml` and release a new
patch version (the updater never installs an older one). The handoff test
already proves either backend serves the database the other wrote. The
inert test was narrowed again rather than deleted, although its header said
to delete it once Rust shipped: it now guards the two Node builds that
remain, the Docker image and the desktop rollback, which would stop being
Node the moment either wired in the core. Batch 6 narrows it for Docker and
batch 7 deletes it.

**An upgraded install is tidied.** A Node build extracted its server,
about 200 MB, into `<data>/standalone`, with a freshness marker beside it.
Once the Rust server is serving, `start` removes both, on its own thread.
It touches only those names, leaves a symlink and whatever it points at
alone, leaves a directory that merely shares the name (no `server.js`, no
`node_modules`), and renames the tree before deleting it, so `standalone`
is only ever whole or gone: an interrupted delete leaves
`.standalone-removing` for the next launch, and a rollback build that
finds no `standalone/server.js` extracts its tarball again whatever its
marker says. Launching the app (`pnpm tauri:dev`, the renamed script) over
a data directory holding a database a Node server had written, WAL
included, plus a Node tree and marker: both were gone within a second of
the server listening, and the database was served untouched. The packaged
bundle's smoke mode does the same over its own directory.

**A dev launch served a stale frontend.** That same launch served
`target/debug/site`, a copy an earlier debug bundle build had left there,
instead of the `pnpm build` just run: the staged site always won. Now a
binary inside an app bundle serves the site staged in it, and one run
straight from `target/` serves the repository's build first, falling back
to a staged copy only when there is none. The packaged verifier confirms
the bundle still serves its own.

**The measurement the plan asked for.** The core has one database
connection behind a mutex, where Node commits its bulk writes on a worker
thread, so the plan called for a load test on a large fleet before the
flip. Same machine, one backend at a time, a release `pt-core` against
`next start` (both with `PRIVACYTRACKER_RUNTIME=desktop`), each over its
own copy of a seeded 5,000-app fleet (110,000 history rows, 20,000
notifications, 261 MB). A probe polled `/api/tasks/active` every 10 ms
around each heavy operation; the stall is its worst response while the
operation ran.

| Measure | Node | Rust |
|---|---|---|
| Cold start (spawn to `/api/ready`) | 428 ms | 556 ms |
| Server memory, idle / after the run | 138 / 263 MB | 12 / 110 MB |
| `/api/tasks/active`, p50 | 1.3 ms | 0.4 ms |
| `/dashboard`, p50 | 1.3 ms | 0.6 ms |
| `/api/apps` page of 250 with grid meta, p50 | 9.6 ms | 12.3 ms |
| `/api/apps`, all 5,000, p50 | 62.8 ms | 69.1 ms |
| `/api/stats`, p50 | 111 ms | 126 ms |
| `/api/notifications`, p50 | 7.8 ms | 18.5 ms |
| Five whole-fleet reads at once: took / probe stall | 326 / 313 ms | 367 / 361 ms |
| 10,000 import items in two requests: took / stall | 1,324 / 1,230 ms | 1,501 / 1,364 ms |
| Deleting 65,000 archived rows: took / stall | 551 / 539 ms | 642 / 634 ms |

The worry does not survive it. Node's worker did take both import writes
(17 and 21 ms of SQL, none inline), and Node still stalled 1.2 s, on the
parsing and planning around them on its main thread; its long delete runs
on the main thread outright. The core's stalls are 10 to 17% longer than
Node's on the same operations, at under half the memory. What it did
surface is `/api/notifications` at 2.4 times Node's latency: 18.5 ms is not
something a person notices on a 30-second poll, but it is the one route
that moved that much, and it is recorded as a follow-up rather than fixed
here. The harness is not committed. The table is one run of each backend;
an earlier Node run, identical but for one route, agreed within 10%. (The
follow-up has since landed, at 6.0 ms against Node's 7.8: see **The unread
count, streamed**, under User content.)

**Negative controls, predicted before running.** Six, each a one-line
mutation of `embedded.rs`, and each failed exactly the one test predicted:
reading the tree through a symlink, treating any `standalone` as the
sidecar's, never finishing an interrupted removal, keeping stale markers,
starting the server without tidying (the wiring check, which only the boot
test covers), and preferring a staged copy over the repository's build in
a dev binary.

**Checked:** the shell's tests on both backends (34 with the feature, 24
without), both built without warnings; a debug bundle built through the
overlay, signed with the hardened runtime and `entitlements-rust.plist`,
passing `verify-macos-bundle.mjs` with no backend argument (on the
dry-run path: an ad hoc signature cannot be notarised); and the two real
launches above.

**Next: batch 6, the Docker cutover.**

### Batch 6a — the server, ready for a network

The Docker image is to run `pt-core serve` where it ran `next start`,
listening on every interface behind a published port. A survey of what
the image relies on found the core already doing nearly all of it: the
whole login flow, the trust-proxy handling, the timers, the file
permissions, the health endpoints and every API route. This batch is the
rest, in the core. The image itself is 6b.

**Listening where it is told.** `pt-core serve` took `--port` and `--site`
and bound 127.0.0.1 whatever else it was given. An unknown option was
ignored, so `--hostname 0.0.0.0` ran a server on loopback that no
published port could reach, while the in-container healthcheck, which
probes loopback, still passed. It now takes `--host <ip>` (loopback by
default, so the desktop app and every harness are unchanged), reads `PORT`
as `next start` does when `--port` is absent, and refuses anything else
with its usage line. With `--host`, the server's environment is the
process's own with `PRIVACYTRACKER_BIND_HOST` set to that host, as
`scripts/start-next.mjs` does for Node: the security checks classify the
bind from that variable, so it cannot disagree with where the server
listens. `read-parity.mjs` now passes `--port 0`, so a `PORT` in the
caller's shell cannot move it.

**Slow clients.** The core served through `axum::serve`, which builds each
hyper connection without a timer, and without one hyper's header-read
timeout never fires: a client could hold a connection open indefinitely
by sending its headers a byte at a time. Node's HTTP server gives up
after 60 s (`headersTimeout`, read from a running Node rather than from
memory; `next start` leaves it alone). The accept loop is now axum's own,
rebuilt step for step (the accept-error handling, `ConnectInfo`, the
graceful shutdown), with the timer set and the timeout at Node's 60 s.
In hyper the same timer also closes a keep-alive connection left idle
waiting for its next request, after the same 60 s, where Node's
`keepAliveTimeout` is 5 s; the test pins that behaviour rather than
calling it a match. The dependency features are axum's own. hyper-util's
`server-auto`, the obvious choice, also switches on HTTP/2 and pulls in
the h2 crate, where this server speaks HTTP/1 as Node's does: the
lockfile gaining two crates is what showed it, and it was backed out.
Naming hyper, hyper-util and tower directly does change one generated
file: the desktop's notices now list 40 crates chosen directly, where
they listed 37. The total stays at 342, since all three were already in
the build, and batch 5b's gate is what asked for the regeneration.

**What Node says at boot.** Two lines Node prints that the core did not:
the `[security] … network-exposed but no AUDITOR_ADMIN_TOKEN is set`
warning (production, no token, exposed; it warns and does not refuse,
because requests already fail closed), and proxy.ts's `[proxy]
csp-hashes.json not found` error for a build without its hashes. Both now
go to the log and the diagnostics tail, word for word, so an operator's
search finds the same line on either server.

**Checked.** Unit tests for the options (five) and for the warning's
condition (every combination of environment, token and exposure). A new
test binary, `tests/network_serving.rs`, serves the Docker configuration
with the token forgotten, over loopback and with a 300 ms timeout: both
boot lines logged once each, `/api/health` 200, `/api/apps` 401, a client
that stops mid-headers cut off after the timeout, and an idle keep-alive
connection closed after it too. Then, over the new accept loop: the core's
suite, the handoff (40 of 40), the live read and write gate (196 read
checks and 57 write checks, none failed) and the Playwright suite against
the core (73 passed, none failed).

**Negative controls, predicted before running.** Seven, each a one-line
mutation, and each failed exactly the test predicted, with the predicted
message where it was an assertion in the network test: no header timeout
(the slow client is never cut off), the warning never logged, the
warning's condition ignoring `NODE_ENV` (caught only by the truth table,
which is why it has one), the CSP-hashes line never logged, unknown
options ignored again, `PORT` not read, and `--host` not reaching the
security checks.

### Batch 6b — the Docker image on the Rust server

**The image.** One Dockerfile, two runtimes, chosen by a `BACKEND` build
argument whose default is `rust`. The build stage is shared: it installs,
builds and now also stages the site with `scripts/stage-site.mjs --into
/app/site` (the same allowlist the desktop bundle stages). `rust` adds a
toolchain stage (`rust:1.96.1-alpine3.24`, pinned by digest like the Node
image) that compiles `pt-core` statically for musl with `cargo auditable`,
and a runtime on `alpine:3.24.2` holding the binary, the staged site, the
notices and `tzdata`, and nothing else. `node` is the previous runner stage,
byte for byte, kept as the rollback until 1.0. The Rust image is 56 MB; the
Node one is 1.36 GB.

**The contract stays where it was,** so no compose file changed beyond an
optional build argument: `/app` as the working directory, the `/app/data`
volume, port 3000, the same environment, the same busybox `wget`
healthcheck, and the `audit` user, now pinned to 100:101 rather than left
to `adduser -S`, because an existing volume is owned 100:101 and a
different id could not open what the Node image wrote. The staged site is
owned by root, so the server cannot rewrite what it serves. Compose reads
`PRIVACYTRACKER_BACKEND` for its build argument, so a self-hoster's
rollback is one line in `.env`; published images take a `backend` input on
**Build & Push Docker image**, and `release.yml` passes `rust`.

**Found on the way.**

- *Time zones.* The core leaves `TZ` to the C library, and a bare Alpine
  has no zone database: `TZ=Australia/Sydney` read as `UTC +0000`, where
  the Node image answers it from Node's built-in ICU data. The runtime
  installs `tzdata`, and CI now asserts the zone resolves.
- *The two Linux targets link different crates.* x86_64 links
  `cpufeatures` and aarch64 does not, which the notices generator caught
  the first time it walked both. `core/THIRD-PARTY-RUST.md`, the image's
  list, is the union, with the one crate marked x86_64 only.
- *What the list claims against what the binary holds.* Trivy reads the
  dependency list `cargo auditable` embeds (138 crates on arm64, the core
  itself included). Every crate in the binary is on the notices list; the
  list's only extras are four procedural-macro crates (`serde_derive`,
  `tokio-macros`, `thiserror-impl`, `futures-macro`), which run at compile
  time and do not ship. The desktop list has the same four; over-disclosure
  is the safe direction, and it is noted rather than changed here.
- *Three `libc::time_t` deprecation warnings* in the date-parser port, on
  musl only: the libc crate warns about a 32-bit change, and both targets
  the image is built for are 64-bit. Left as they are rather than editing
  the V8 port for a lint.

**CI.** `container-smoke` checks the default image carries no Node and no
`node_modules`, ships its four notices, and resolves a `TZ` zone name; logs
in over TLS through the Caddy example and expects a `Secure` cookie (the
proxy's `X-Forwarded-Proto`, trusted, is what makes it Secure: the one
thing the survey found untested on the core); and builds and boots the
`BACKEND=node` image, since the rollback has to keep working until 1.0.
`compose-smoke`'s authentication check ran `node -e` inside the container;
it now makes the same two requests from the runner, through the published
port. The inert test no longer lists the Dockerfile: it keeps guarding the
Next.js server and the desktop rollback.

**Checked locally, on arm64.** Built both images. The Rust one: no Node,
the four notices, `audit` at 100:101, `/api/ready` 200 without a token,
`/api/apps` 401, the network-exposed warning logged once, Docker's own
healthcheck healthy, 7.7 MiB idle. Compose with a named volume: the fonts
and the brand icon served, pages redirecting to `/login`, the API 401
without the token and 200 with it. Caddy over TLS: a 200 login with a
`Secure; HttpOnly; SameSite=strict` cookie. Traefik: ready. Then a volume
handed from the Node image to the Rust one and back: Node seeded it
(196 MiB), Rust served `/api/apps` and `/api/stats` byte for byte as Node
had (3 MiB), wrote a shortlist entry, and Node read it back identically,
the directory still `0700` and the database files `0600`, owned by
`audit`. Trivy: no HIGH or CRITICAL finding in either the 17 Alpine
packages or the binary's crates.

**Negative controls, predicted before running.** Each rebuilt the image
with one mutation and ran CI's own step against it, after the unmutated
image passed that step: the notices left out ("missing or empty: NOTICE"),
the runtime built on the Node base ("node is in the image"), and `tzdata`
dropped ("resolved to UTC"). Two more outside the image: the Dockerfile
back on the inert test's list fails that test, naming the Dockerfile for
the `pt-core` binary, the core's build output and its `COPY` of `core/`
(I predicted two of those three signals; the build output is the cache
path); and a row deleted from the image's crate list fails the notices
gate on that file alone.

**Next:** the UX tests and the cleanup (done: #328 to #336), then the
first release on the Rust backend, v0.3.0, which the user cuts.
