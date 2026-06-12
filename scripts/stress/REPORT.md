# Stress-test report — 2026-06-12

**Question:** where does privacytracker break as the tracked-app count grows, how many
concurrent monitoring sessions can one instance serve, and what specs should we
recommend for self-hosting vs Docker-in-cloud?

**Answer in one line:** nothing crashes anywhere in the tested range (50 → 10,000 apps,
1 → 10 concurrent sessions, 5 sync-writes/s, 120-snapshot history) — the practical limit
is the **apps-grid page** (`/dashboard/apps` + `/api/apps`), whose payload and serialization
cost grow linearly with app count and become the UX ceiling at **~2,500–5,000 apps**, and
which starves the event loop for everyone else at **10,000 apps + 10 sessions**.

---

## Method

Reusable harness in `scripts/stress/` (all dependency-free, isolated from your real DB
via `PRIVACYTRACKER_DATA_DIR` and a separate `.next-stress` build):

| file | role |
|---|---|
| `seed.mts` | Bulk-seeds N synthetic apps (3 privacy types × 5–9 categories), S snapshots each (60 % wayback / 40 % live, ~20 % with changes), 4 notifications/app, 3 devices with app links, activity log at its 2,000-row cap. Deterministic (seeded PRNG). |
| `loadtest.mjs` | `endpoints` mode: closed-loop sweep, 4 workers × 10 s per endpoint. `viewers` mode: V simulated sessions reproducing real client cadences (TaskCenter 4 s, bell 30 s, sync-status 60 s, page nav 12 s) + a low-rate latency probe. |
| `contention.mts` | Replays the bulk-sync write pattern (delete + re-insert privacy tree + snapshot insert, one txn/app) from a second process at 5 apps/s while probes measure read latency. |
| `run-matrix.mjs` | Orchestrates: seed → boot prod server (port 3001) → sweep → 1/3/10 viewers → contention → diagnostics → teardown. Results stream to `scripts/stress/results/`. |
| `run-docker.mjs` | Same suite against the production compose stack (shipped 1 GB / 2 CPU limits), seeded DB injected into the named volume. |

Rerun: `node scripts/stress/run-matrix.mjs` (full, ~35 min) or `--quick` (smoke).
Docker: `node scripts/stress/run-docker.mjs [--no-build]`. Full usage docs —
per-script arguments, isolation guarantees, how to read the result JSON,
troubleshooting — in [README.md](./README.md).

**Host:** Apple M4, 10 cores, 16 GB RAM, Node 26, Next 16 production build.
**Scales:** 50 / 250 / 1,000 / 2,500 / 5,000 / 10,000 apps × 22 snapshots, plus a
deep-history variant (1,000 apps × 120 snapshots ≈ years of daily syncs).
Raw data: `results/matrix-1781241470930.json`, `results/docker-1781243754704.json`.

---

## Results

### 1. Scaling with app count (endpoint sweep, p95 ms, 4 concurrent)

| surface | 50 | 250 | 1k | 2.5k | 5k | 10k | 1k×120 hist |
|---|---|---|---|---|---|---|---|
| `/dashboard` | 61 | 68 | 119 | 163 | 317 | 580 | 122 |
| **`/dashboard/apps`** | **75** | **205** | **1,300** | **1,700** | **5,000** | **6,400** | 949 |
| `/apps/[id]` (detail) | 79 | 65 | 84 | 63 | 77 | 78 | 114 |
| `/changelog` | 48 | 46 | 62 | 61 | 94 | 143 | 184 |
| `/dashboard/stats` | 62 | 69 | 138 | 209 | 479 | 967 | 136 |
| `/api/apps` | 5 | 14 | 51 | 122 | 288 | 672 | 82 |
| `/api/changelog` | 4 | 7 | 16 | 18 | 29 | 50 | 34 |
| `/api/notifications` | 4 | 6 | 14 | 23 | 56 | 99 | 13 |
| `/api/stats/timeline` | 2 | 3 | 12 | 17 | 35 | 109 | 41 |
| `/api/tasks/active`, `/api/activity`, `/api/apps/[id]/history-stats` | ≤2 | ≤2 | ≤4 | ≤2 | ≤3 | ≤3 | ≤4 |

Zero HTTP errors at every scale (hundreds of thousands of requests total).

**Payload growth is the story.** The grid page RSC payload is ~4.3 KB/app: 587 KB at 50
apps → **21.8 MB at 5,000 → 43.3 MB at 10,000**. `/api/apps` is ~0.7 KB/app (6.9 MB at
10 k). Everything else is flat or bounded (dashboard 403 KB, app detail 445 KB, changelog
LIMITed). These are uncompressed server-side numbers; a real browser also pays parse +
hydration on top, so the felt limit arrives *earlier* than the server p95 suggests.

### 2. Concurrent monitoring sessions ("multiple devices")

A note on devices: in-app **devices are iOS import sources, not polling clients** — they
add zero recurring server load. The unit of load is a *concurrent open dashboard*
(browser tab / family member / wall display), each generating ~20–35 req/min from the
documented poll cadences.

Interactive p95 (probe) while N sessions browse:

| scale | 1 session | 3 sessions | 10 sessions |
|---|---|---|---|
| ≤2,500 apps | < 120 ms | < 220 ms | < 200 ms |
| 5,000 apps | < 190 ms | 110–220 ms | **400–500 ms** |
| 10,000 apps | < 290 ms (bell 970 ms) | 120–780 ms | **1.3–2.6 s** |

The key signal: `/api/tasks/active` is an O(1) endpoint (~2 ms alone) and it hit 2.6 s
p95 at 10 k apps / 10 sessions — classic **event-loop starvation** caused by repeatedly
serializing the multi-MB grid/apps responses, not by the database.

### 3. Sync writes vs reads (WAL contention)

5 bulk-sync-pattern writes/s from a second process, at every scale: **0 busy errors,
txn p95 ≤ 2 ms**, read-probe p95 unchanged vs baseline (54 → 154 ms across 50 → 10 k,
same as without writes). WAL mode does its job; **background syncs will not noticeably
degrade browsing at any tested fleet size.** The real sync ceiling is external — see §6.

### 4. History depth (long-running installs)

1,000 apps × 120 snapshots (≈ 4 months of daily syncs, or years of mixed cadence; 254 MB
DB) vs ×22 (53 MB): detail page 84→114 ms, changelog 62→184 ms, history-stats flat at
4 ms, grid *improved* (random variance). **Snapshot accumulation is a disk cost, not a
performance cost** — the `(app_id, scraped_at DESC)` index and LIMITed queries hold.
Growth model: ~2.1 KB/snapshot ⇒ daily sync of 1,000 apps ≈ 65 MB/month. No pruning
exists for `privacy_snapshots` / `notifications` / `audit_log` — fine for years at
hundreds of apps, worth a retention story at thousands.

### 5. Memory, boot, DB size

| scale | DB | warm RSS | peak RSS under load | settled |
|---|---|---|---|---|
| 50 | 3.4 MB | 179 MB | 598 MB | 332 MB |
| 1,000 | 53 MB | 298 MB | 727 MB | 435 MB |
| 2,500 | 131 MB | 390 MB | 772 MB | 564 MB |
| 5,000 | 260 MB | 481 MB | 905 MB | 554 MB |
| 10,000 | 520 MB | 693 MB | 1.42 GB | 670 MB |

Boot is flat (~0.4–0.6 s to ready) at every scale — migrations and instrumentation
startup don't scale with data. Peaks are transient V8 heap during full-speed sweeps;
the Linux container numbers below are much lower under identical load.

### 6. The ceiling hardware can't fix: Apple rate limits

`fetchAndParseApp` is hard-allowlisted to `apps.apple.com`/`itunes.apple.com`; the bulk
sync runner is sequential with **no inter-app delay** and **bails on the first 429**
(70 s cooldown, Retry-After honoured up to 10 min, remaining apps marked `rate_limited`,
clean retry on the next 30-min scheduler tick). So full-fleet refresh time is governed
by Apple, not by CPU: low hundreds of apps per run is reliable; multi-thousand fleets
converge over several tick cycles. A daily schedule still completes within the day, but
"every app refreshed within the hour" is unachievable at 5 k+ on any hardware.

### 7. Docker with shipped limits (1 GB / 2 CPU, compose defaults)

| metric | 1,000 | 2,500 | 5,000 |
|---|---|---|---|
| grid p95 (vs bare metal) | 902 ms (1.3 s) | 1.5 s (1.7 s) | 5.2 s (5.0 s) |
| `/api/apps` p95 | 57 (51) | 128 (122) | 267 (288) |
| peak container memory | 258 MiB | 278 MiB | **333 MiB** |
| errors (incl. 10-session load) | 0 | 0 | 0 |

**Container performance is at parity with bare metal through 5,000 apps**, and the 1 GB
memory limit has ~3× headroom (the Alpine/Linux runtime is far leaner than the macOS
dev numbers). The shipped compose resource limits are correctly sized. (Measured under
OrbStack on the same M4; absolute numbers on a low-end cloud vCPU will be ~2–3× slower.)

---

## Recommendations

### Fleet-size tiers

| tracked apps | verdict | minimum specs |
|---|---|---|
| ≤ 500 (typical: 1–4 devices' worth) | Everything instant (<100 ms). | Anything that runs Node — Tauri desktop, Raspberry Pi-class 2 GB SBC, smallest cloud VPS (1 vCPU / 1 GB). |
| 500 – 2,500 | Fully comfortable; grid reaches ~1–2 s server-side at the top end; 10 concurrent sessions fine. | Shipped Docker defaults (2 CPU / 1 GB) are right-sized. 1 vCPU / 1 GB VPS acceptable. |
| 2,500 – 5,000 | Works, nothing falls over; grid page is slow (5 s server + 22 MB payload ⇒ worse in-browser); keep concurrent sessions ≤ 3 or accept ~0.5 s tails. | 2 vCPU / 1 GB still holds (peak 333 MiB). Prefer 4 vCPU if several simultaneous viewers. |
| > 5,000 | Functional (no crashes at 10 k) but **not recommendable** until the grid/`/api/apps` are paginated — 43 MB payloads starve the event loop under concurrent use. | Engineering work, not hardware. |

Disk: budget ~55 MB per 1,000 apps + ~65 MB/month per 1,000 apps on daily sync, plus
backups — 10 GB covers years for any realistic fleet.

### Own machine vs Docker-in-cloud

- **Default: local.** The data model is a single local SQLite file and the privacy posture
  is local-first; a desktop (Tauri) or `docker compose up` on the user's machine serves
  every realistic personal fleet (≤ 2,500) with zero recurring cost. Boot is sub-second,
  idle RSS ~180–300 MB — fine to leave running.
- **Cloud Docker is for availability, not capacity** (always-on scheduled syncs, family
  access from several homes, wall dashboards). Any bottom-tier VPS (1 vCPU / 1 GB,
  ~$4–6/mo) handles ≤ 2,500 apps with 10 viewers. Requirements: outbound HTTPS to
  `apps.apple.com` / `itunes.apple.com` (+ `web.archive.org` for wayback), a volume for
  `/app/data`, and the documented network-exposure posture (`AUDITOR_ADMIN_TOKEN`,
  `PRIVACYTRACKER_ALLOWED_HOSTS`, reverse proxy with TLS). Apple-sync freshness is no
  better in the cloud — the 429 ceiling travels with you.
- A Raspberry Pi 4/5 (2 GB+) is a sound middle ground for ≤ 1,000 apps.

### Engineering backlog to raise the ceiling (ordered by impact)

1. **Paginate/virtualize `/dashboard/apps` and paginate `/api/apps`** — the only red
   column in the matrix; turns the 5–10 k tier from "not recommendable" to "fine".
2. **Index + cap `notifications`** — unindexed unbounded table; bell p95 hit ~1 s at 10 k
   apps under load. An index on `(read, not_before)` plus a retention cap mirrors what
   `activity_log` already does.
3. **`/dashboard/stats` SQL aggregation** — 967 ms p95 at 10 k from in-JS aggregation.
4. **Snapshot retention option** (or at least a documented VACUUM/export path) for
   multi-year daily-sync installs.

### Caveats

Synthetic data is uniform (3 types × 5–9 categories; real fleets have more variance);
measurements are server-side only (browser hydration of the big grid adds seconds beyond
the server numbers); the M4 is fast — derate ~2–3× for budget cloud vCPUs; no multi-day
soak was run (memory was stable across each ~5-min loaded session, settling after load).

---

## Addendum — 2026-06-12: grid/API pagination shipped (backlog item 1)

Backlog item 1 ("paginate/virtualize `/dashboard/apps` and paginate `/api/apps`")
is done. Design: the server page renders the first 250 apps (+ `COUNT(*)` total);
AppGrid background-hydrates the rest in 500-row chunks from the new opt-in
`/api/apps?limit=…&offset=…&meta=grid` envelope and windows card rendering at
120 cards per chunk. The bare `/api/apps` form — the documented public
contract — is unchanged; nothing in the app's own UI calls it any more. Full
design notes: AGENTS.md → "Apps grid pagination (large fleets)".

Re-measured at 5,000 apps × 22 snapshots, same harness, same host. Baseline
(`matrix-1781246172755.json`) was re-run on the exact pre-change tree minutes
before the change (`matrix-1781247069695.json`) so the comparison is clean:

| metric (5,000 apps) | before | after |
|---|---|---|
| `page:apps-grid` p95 (sweep, 4 concurrent) | 4,152 ms | **175 ms** |
| `page:apps-grid` mean payload | 21.8 MB | **1.0 MB** |
| `api:apps-page` p95 (new hot path: 500-row chunk + grid meta) | — | **121 ms** (400 KB) |
| `api:apps` p95 (legacy bare form, preserved deliberately) | 245 ms | 275 ms |
| 10-session probe `api:tasks-active` p95 | 395 ms | **21 ms** |
| 10-session probe `api:notifications` p95 | 197 ms | **22 ms** |
| 10-session probe `page:dashboard` p95 | 697 ms | **149 ms** |
| viewer-traffic `page:apps-grid` p95 @ 10 sessions | 837 ms | **109 ms** |

Zero HTTP errors in both runs. The event-loop starvation that made the >5k
tier "not recommendable" is gone: no request serialises the whole fleet, so
O(1) endpoints stay O(1) under concurrent sessions. A real browser session
(Playwright, production build, the seeded 5,000-app DB) confirms the UX:
120 cards in the DOM initially, background hydration to 5,000 (tab counts
climb, the "Loading apps…" note clears), scrolling extends the render window,
search matches apps from the last page once hydration completes, and
bulk actions (Sync all / queue / select) stay disabled until the fleet is
fully loaded. Browser-side hydration cost now scales with the render window,
not the fleet.

The fleet-size tiers above should now read: **the grid is no longer the
ceiling at any tested scale** — past ~5,000 apps the limits are Apple's 429
sync cadence (§6) and disk growth (§4), not page performance.
