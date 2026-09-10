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
   `tests/app/rust-core-inert.test.ts`.

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

## Status — Phase 2, batch 1 (the read API)

The crate now also serves HTTP:

```
pt-core serve <path/to/privacy.db> [--port N]   # port 0/omitted = OS-assigned
just parity-read http://127.0.0.1:3001 <nodeDataDir>
```

**Routes implemented (9).** `/api/health`, `/api/auth/admin-token/status`,
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

**What the parity gate cannot see.** It authenticates every request, so a
route that forgot its auth gate still answers 200 and passes. The runner
therefore probes the gate directly (a gated route with no token must 401, a
public one must still 200), and `trust.rs` / `auth.rs` carry unit tests. Treat
"parity green" as a statement about response bytes only.

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

**Still deferred:** `/api/apps/[id]/since-install`. It needs `diffSnapshots`
ported — real snapshot-diffing business logic, closer to Phase 3 than to a
read shim — and it deserves its own batch rather than being bolted on here.
