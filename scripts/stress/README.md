# Stress-test harness

Measures where privacytracker degrades as the tracked-app count, snapshot
history, concurrent viewer sessions, and sync-write load grow. Findings from
the 2026-06-12 run live in [REPORT.md](./REPORT.md); this file documents how
to run the harness yourself.

## Safety / isolation guarantees

The harness **never touches your real data or build**:

- Every run seeds an isolated SQLite DB under `/tmp/pt-stress/<label>` and
  points the server at it via `PRIVACYTRACKER_DATA_DIR`. The seeder hard-refuses
  to write into the repo's `./data` directory.
- The server is built into and served from a separate dist dir (`.next-stress`,
  gitignored) on **port 3001**, so a `next dev` on :3000 is unaffected.
- Seeded `app_settings` pin `sync_schedule=manual` and
  `policy_scrape_disabled=true`, so the boot tickers never try to scrape Apple
  for the synthetic apps. (`health_check_enabled=false` keeps the 60s health
  tick from perturbing measurement windows; the orchestrator still triggers one
  manual health check at the end of each scale for diagnostics.)
- No external traffic is generated apart from the app's own boot-time GitHub
  update check.

Results land in `scripts/stress/results/` (gitignored): one JSON per run plus
a `server-<label>.log` per scale for debugging.

## Prerequisites

```bash
pnpm install                                # tsx is a devDependency
NEXT_DIST_DIR=.next-stress pnpm build       # one-time production build for the harness
```

Rebuild `.next-stress` whenever app code changes, or you'll measure stale code.
Docker phase additionally needs a running Docker daemon (OrbStack/Docker Desktop).

## The one command most people want

```bash
node scripts/stress/run-matrix.mjs
```

Runs the full local matrix (~35 min): for each scale it seeds → boots a prod
server → sweeps every hot endpoint (4 workers × 10 s each) → simulates 1/3/10
concurrent viewer sessions (45 s each) → runs a sync-write contention pass →
captures RSS, DB/WAL size, and a manual health check → tears down.

Variants:

```bash
node scripts/stress/run-matrix.mjs --quick                  # 1 small scale, short phases (~2 min) — harness smoke test
node scripts/stress/run-matrix.mjs --scales 5000:22         # one scale: 5000 apps × 22 snapshots/app
node scripts/stress/run-matrix.mjs --scales 1000:22,1000:120 # compare shallow vs deep history at the same app count
```

`--scales` takes comma-separated `apps:snapshotsPerApp` pairs. Defaults:
`50:22,250:22,1000:22,2500:22,5000:22,10000:22,1000:120` (22 ≈ quarterly
wayback history since 2021; 120 ≈ months of daily syncs, labelled `-deep`).

## Docker phase

```bash
node scripts/stress/run-docker.mjs                          # builds image, then 1000:22,2500:22
node scripts/stress/run-docker.mjs --no-build --scales 5000:22
```

Runs the endpoint sweep + 3/10-viewer phases against the production compose
stack with its shipped resource limits (1 GB / 2 CPU), on **port 3000** (the
compose binding). It seeds locally, injects the DB into the named volume via a
helper container (`chown 100:101` to match the non-root `audit` user), and
captures `docker stats` after each phase. Ends with `docker compose down -v` —
don't run it against a compose stack whose volume you care about.

## Individual tools

All print a single JSON object to stdout (logs go to stderr), so they compose
with `jq` and the orchestrators.

### `seed.mts` — bulk-seed an isolated DB

```bash
pnpm exec tsx scripts/stress/seed.mts --data-dir /tmp/pt-stress/mine \
  --apps 1000 [--snapshots 22] [--unread 2] [--read 2] [--devices 3]
```

Per app: 3 privacy types × 5–9 categories, `--snapshots` history rows (oldest
60 % wayback-sourced, rest live; ~20 % flagged as changes), 15 % of apps with
pending unacknowledged changes, notifications (`change_summary` is a JSON
`ChangeEntry[]` — the bell 500s on plain text), device links, and an activity
log at its 2,000-row cap. Deterministic: same args ⇒ byte-identical data.

To browse a seeded DB manually:

```bash
PRIVACYTRACKER_DATA_DIR=/tmp/pt-stress/mine NEXT_DIST_DIR=.next-stress \
  node_modules/.bin/next start -p 3001
```

### `loadtest.mjs` — load generator

```bash
# Latency/payload per endpoint (closed loop, C workers × D seconds each):
node scripts/stress/loadtest.mjs --mode endpoints --base http://127.0.0.1:3001 \
  --apps 1000 --duration 10 --concurrency 4 [--timeout 120000]

# Simulate N "devices" (concurrent dashboards) + a low-rate latency probe:
node scripts/stress/loadtest.mjs --mode viewers --base http://127.0.0.1:3001 \
  --apps 1000 --viewers 10 --duration 45

# Probe only (pair it with contention.mts or a real bulk sync):
node scripts/stress/loadtest.mjs --mode probe --base http://127.0.0.1:3001 \
  --apps 1000 --duration 30
```

`--apps` must match the seeded count — it's how rotating app-detail /
history-stats URLs resolve to real ids (`1000000000 + i`). Each simulated
viewer reproduces the real client cadences: `/api/tasks/active` every 4 s,
`/api/notifications` every 30 s, `/api/sync/status` every 60 s, page
navigation every 12 s. Output: `requests`, `errors`, `p50/p95/p99/max` (ms),
`meanBytes` per endpoint. Statuses outside 200–399 (including timeouts) count
as errors.

### `contention.mts` — sync-write pressure

```bash
pnpm exec tsx scripts/stress/contention.mts --data-dir /tmp/pt-stress/mine \
  --apps 1000 --rate 5 --duration 30
```

Replays the bulk-sync write pattern (delete + re-insert an app's privacy tree,
append a snapshot, touch `lastSynced` — one transaction per app) from a second
process against the same WAL file while the server serves. Reports write-txn
percentiles and `SQLITE_BUSY` counts. Run a `--mode probe` loadtest alongside
to see the read-side impact.

## Reading the results

Top-level JSON per scale: `seed` (row counts, `dbBytes`, `seedMs`), `bootMs`
(spawn → `/api/ready` 200), `rssAfterWarmupMb` / `rssMaxMb` / `rssFinalMb`
(process-tree RSS; max is sampled every 2 s across all phases),
`phases.endpoints`, `phases.viewers.{1,3,10}` (`viewerTraffic` = the sessions'
own requests, `probe` = interactive latency under that load — the number that
tells you what a user would feel), `phases.contention`, `dbDiagnostics`
(PRAGMA snapshot: `fileBytes`, `walBytes`, `utilisationPct`), and
`healthCheck` (manual run; note its event-loop histogram starts at collection
time, so `eventLoopP99Ms` won't reflect earlier load phases — use the probe
percentiles on cheap endpoints like `api:tasks-active` as the saturation
signal instead).

## Troubleshooting

- **`EADDRINUSE` / weird 500s on :3001** — a stale server from an interrupted
  run. Next renames its process, so pkill-by-name misses it:
  `lsof -nP -tiTCP:3001 -sTCP:LISTEN | xargs kill -9`. The orchestrator does
  this automatically before each boot.
- **Every request to one endpoint errors** — check
  `scripts/stress/results/server-<label>.log`; it's usually a seeded-data
  shape mismatch (see the `change_summary` note above).
- **Numbers look too good after a code change** — you forgot to rebuild:
  `NEXT_DIST_DIR=.next-stress pnpm build`.
- **Docker phase can't find the volume** — the helper looks for a volume name
  containing `privacytracker-data`; if you renamed the compose project, adjust
  `run-docker.mjs`.
