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

## Why the frontend work is NOT on this branch

For the eventual A/B test (`main`-built Node app vs `rust-core`-built
Rust app, Mac and Docker) to be a clean backend-only comparison, the
frontend must be identical on both sides. So Phase 0 — converting the
35 server-rendered pages to client-fetching shells, plus the parity and
benchmark harnesses (`scripts/parity/`, `scripts/bench/`) — lands on
`main` through normal PRs. This branch then differs from `main` by the
backend only.

## Phases

0. *(on main)* Pages → client-fetching shells; parity + bench harnesses.
1. `core/` crate: rusqlite + the exact `lib/db.ts` schema/migration
   contract, proven against real upgraded `privacy.db` files.
2. Read-only API in axum, gated by the parity harness.
3. Scraper + diff + persist, gated by golden HTML fixtures.
4. Writers, schedulers, the crash-safe runners, health check.
5. The AI policy pipeline.
6. Desktop cutover (embed axum, drop the Node sidecar), then Docker
   after burn-in.

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
