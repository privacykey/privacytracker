# Architecture & workflows, end to end

Every process the app runs — from typing an app name to deleting one off a plugged-in
iPhone — drawn as flow diagrams across the runtimes, with known weak points marked where
they live. Companion to the prose in [AGENTS.md](../AGENTS.md) and the hosted docs at
[privacytracker-docs.privacykey.org](https://privacytracker-docs.privacykey.org/develop/architecture).

**How to read the markers.** `⚠ §N·M` = open finding, `✅ §N·M` = fixed. Every marker is a
row in the [improvement backlog](#7--improvement-backlog) at the bottom. When you fix one,
update its row and the diagram label in the same PR.

*Findings audited against source on 2026-07-06 (branch `feat/eager-shannon-b87c90`).*

---

## 0 · System map

The desktop app is a Tauri shell that boots a private Next.js server (the "sidecar") on a
random localhost port, then points its webview at it. Everything privacy-critical happens
on this machine: scraping, diffing, AI calls, and the SQLite database. The Rust shell is
the only piece that can touch a connected iPhone. The web/Docker build is the same server
without the shell column.

```mermaid
flowchart LR
  subgraph mac["This Mac · Tauri desktop app"]
    shell["Rust shell (src-tauri/)<br/>tray · deep links · usb_watcher<br/>cfgutil bridge · Touch ID gate<br/>ACL: 14 allowed commands"]
    webview["Webview (Next.js UI)<br/>dashboard · onboarding wizard<br/>review-and-act wizard · TaskCenter"]
    sidecar["Node sidecar (Next server)<br/>app/api/* routes → lib/*<br/>9 boot timers · 3 bulk runners"]
    db[("SQLite data/privacy.db<br/>WAL · synchronous better-sqlite3<br/>apps → types → categories")]
  end
  phone["iPhone / iPad over USB<br/>list · installedApps · backup · remove-app"]
  apple["Apple<br/>iTunes Search API · App Store pages"]
  archive["archive.org<br/>availability · replay · Save Page Now"]
  ai["AI provider (optional)<br/>OpenAI / Anthropic / local"]

  shell -->|"spawns · reveals window when /api/apps responds"| sidecar
  webview <-->|"HTTP 127.0.0.1:&lt;port&gt;"| sidecar
  webview -.->|"invoke() IPC · ACL + Touch ID"| shell
  shell -.->|"cfgutil subprocess"| phone
  sidecar --> db
  sidecar -.-> apple
  sidecar -.-> archive
  sidecar -.-> ai
```

Boot handshake: `sidecar::boot()` binds `127.0.0.1:0` for a free port, spawns Node with
`PORT`/`PRIVACYTRACKER_DATA_DIR`, polls `GET /api/apps` (≤60s), then navigates the webview
and reveals the window (optionally behind a Touch ID unlock). Files:
`src-tauri/src/main.rs`, `src-tauri/src/sidecar.rs`.

---

## 1 · Add & track an app (the core loop)

The pipeline every other flow feeds into. A name becomes an App Store URL, the URL becomes
parsed privacy labels, and every re-sync diffs against the previous snapshot to produce
the change timeline and notifications. Re-syncs run the same path with `resync=true`.
Files: `lib/scraper.ts`, `lib/changelog.ts`, `lib/privacy-policy.ts`.

```mermaid
sequenceDiagram
  autonumber
  participant UI as Webview UI
  participant API as Sidecar API
  participant LIB as lib/ pipeline
  participant DB as SQLite
  participant EXT as Apple / AI

  UI->>API: POST /api/search — names · bundleIds · country
  API->>EXT: iTunes Search API
  EXT-->>UI: candidates — user picks the right match
  UI->>API: POST /api/scrape — urls · resync flag
  API->>LIB: fetchAndParseApp(url)
  LIB->>EXT: GET App Store page HTML
  Note over LIB: ⚠ §1·1 parse fallback chain<br/>shelfMapping → privacyHeader → shelves → shoebox
  LIB->>LIB: capture previousSnapshot BEFORE the write
  LIB->>DB: saveToDb tx — apps → privacy_types → privacy_categories
  LIB->>DB: buildSnapshot → diffSnapshots → saveSnapshot
  DB-->>DB: notification row · changeCount bump
  Note over LIB: ⚠ §1·2 policy fetch + hash —<br/>regenerate summary_json only when hash changed
  LIB->>EXT: AI summarisation (optional, chunked for local models)
  DB-->>UI: timeline · bell · pending-changes dot
```

---

## 2 · Import your apps from a device (cfgutil)

Onboarding (`OnboardWizard.tsx`, five steps: choose method → import & reconcile → confirm
matches → import progress → policy summaries) accepts four sources: screenshots (OCR),
CSV/TXT upload, manual typing, and — on macOS with Apple Configurator — a live `cfgutil`
export. The cfgutil path is **read-only against the device**. There is no scheduled device
re-sync: a USB plug-in event (IOKit watcher → `DeviceConnectedToast`) re-opens this flow
on demand. Files: `src-tauri/src/cfgutil.rs`, `lib/desktop.ts`, `src-tauri/src/usb_watcher.rs`.

```mermaid
sequenceDiagram
  autonumber
  participant WIZ as Onboard wizard
  participant SH as Rust shell
  participant PH as iPhone (USB)
  participant API as Sidecar API
  participant AP as Apple

  WIZ->>SH: invoke check_cfgutil — PATH + app-bundle probes, cached 5 min
  WIZ->>SH: poll list_connected_devices (5s while on the step)
  SH->>PH: cfgutil list · get name/model
  PH-->>WIZ: devices (ECID · name · iOS version)
  WIZ->>SH: invoke run_cfgutil_export(ecid)
  SH->>PH: cfgutil get installedApps (90s cap, read-only)
  PH-->>WIZ: rows — displayName · bundleIdentifier · version
  WIZ->>WIZ: step 2 — dedupe by bundleId, diff-preview
  WIZ->>API: POST /api/search with bundleIds
  API->>AP: iTunes lookup — canonical track per bundle id
  WIZ->>WIZ: step 3 — name-search fallback for unlisted/sideloaded
  Note over API: ⚠ §2·1 step 4 — scrape each URL (§1 flow) ·<br/>Apple 429s park rows in the import queue (60s drain)
  WIZ->>API: step 5 — optional policy summaries (flag-gated)
```

Non-Mac alternative: `scripts/ios-app-import/export_ios_apps.py` (stdlib-only) produces a
`.txt`/`.csv` the user feeds back into the CSV path (⚠ §2·2 — manual round-trip).

---

## 3 · Back up, then delete apps off the phone

The only destructive flow in the product, so it runs the deepest gate stack: audience must
be `self`, an off-by-default Developer Options flag, a fresh backup (≤24h) or an explicit
typed acknowledgement, two confirm modals, a server-side pre-flight, and finally a native
Touch ID prompt per app that JavaScript cannot bypass. One cfgutil call per app — there is
deliberately no batch primitive. Files: `app/components/ReviewRecommendationsView.tsx`,
`lib/device-actions.ts`, `app/api/device-actions/*`, `src-tauri/src/cfgutil.rs`,
`src-tauri/src/touch_id.rs`.

```mermaid
sequenceDiagram
  autonumber
  participant WIZ as Review wizard
  participant API as Sidecar (gates + audit)
  participant SH as Rust shell
  participant PH as iPhone (USB)

  Note over WIZ: ◆ entry gate — audience=self ∧ flag on ∧ desktop build
  WIZ->>WIZ: steps 1–3 — own "uninstall" verdicts only ·<br/>imported recommendations never execute
  WIZ->>WIZ: step 4 — pick device · warn when ECID ≠ app's source device
  WIZ->>SH: invoke run_cfgutil_backup(ecid, destDir)
  Note over SH: ⚠ §3·1 --backup-output unverified on real cfgutil<br/>⚠ §3·2 success = exit code only, no on-disk check<br/>⚠ §3·4 dest allowlist is lexical (symlinks not resolved)
  SH->>PH: cfgutil backup (300s ceiling)
  WIZ->>API: POST /api/device-actions/backup
  Note over API: ✅ §3·6 normalizeEcid (0x-prefixed ECIDs) → stamp + activity row
  WIZ->>WIZ: step 5 — "Delete N apps" → modal 1 (list) → modal 2 (type DELETE)
  Note over WIZ: ⚠ §3·5 modal variant keys off session-local backup state
  WIZ->>API: GET gate pre-flight — audience ∧ flag ∧ backup ≤24h (or acknowledged)
  Note over API: ✅ §3·7 pre-flight BEFORE first removal, fail closed
  loop one app at a time
    WIZ->>SH: invoke run_cfgutil_remove_app(ecid, bundleId)
    Note over SH: ◆ Touch ID / password per app — native LAContext,<br/>JS cannot bypass · fails closed without biometrics+password
    SH->>PH: cfgutil remove-app (45s timeout)
    Note over PH: ⚠ §3·3 timed-out child is orphaned, not killed —<br/>removal may still complete after a reported failure
    WIZ->>API: POST record outcome — cfgutil_uninstall row (ok/error + ack flag)
  end
```

---

## 4 · Background jobs & crash-safe resume

Server boot (`instrumentation.ts`) arms nine timers. Three bulk runners (App Store sync,
Wayback import, policy sync) share one crash-safety pattern: a mutex key plus a state blob
in `app_settings`, rewritten at every app boundary — a process kill loses at most one
app's work, and boot-time healers resume or clear what's left.

| When | What | Then every |
| --- | --- | --- |
| t=0 | watchdog · error ring · diagnostics · feature-flag migration · clear `import_queue_running`/`health_check_running` stale locks | — |
| +8s / +10s / +12s | resume healers: wayback → sync → policy (resume pending run, or clear a stale mutex) | on boot |
| +15s | scheduler tick — `getSchedulerStatus().isDue` (daily/weekly/manual) → `runBulkSync` | 30 min |
| +20s | import-queue drain (rows parked by onboarding 429s) | 60 s |
| +25s | update check (GitHub, 24h response cache) | 6 h |
| +35s | whole-DB backup snapshots (`lib/backup.ts`, signed JSON — distinct from device backups) | 30 min |
| +60s | health check — PASSIVE WAL checkpoint, clear provably-dead locks, report-only memory/orphan checks | 24 h |

The resume healers are staggered *before* the 60s health check so a freshly-resumed run is
never mistaken for a dead lock.

```mermaid
flowchart TD
  acquire["◆ acquire mutex<br/>sync_running · wayback_import_running · policy_sync_running"]
  blob["state blob in app_settings<br/>runId · queue · totals · initiator"]
  work["process app N<br/>blob rewritten at every app boundary"]
  r429["429 from Apple (sync)<br/>bail + partial activity row<br/>clear state cleanly"]
  done["clean finish<br/>clear blob + mutex · summary row"]
  crash["process killed mid-run<br/>blob + mutex survive on disk"]
  heal["◆ boot resume healers (+8/10/12s)<br/>resume run · or clear stale lock"]
  resume["runner restarts, initiator: resume<br/>per-target dedup skips done work"]
  ui["TaskCenter polls /api/tasks/active every 4s<br/>resumed-run pill · per-job progress GETs"]

  acquire --> blob --> work
  work -->|"⚠ §4·1 whole run restarts next tick"| r429
  work -->|all apps done| done
  work -.->|kill -9 / power loss| crash
  crash --> heal --> resume --> work
  resume -.->|"⚠ §4·2 three separate pollers"| ui
```

Apple 429 handling is deliberate: an expected, recoverable condition clears state cleanly
(unlike a crash) so the next 30-minute tick retries fresh.

---

## 5 · Wayback: back-filling label history to 2021

Reconstructs an app's privacy-label history from archive.org — one target per quarter back
to Q1 2021 plus an "install anchor" at `apps.firstSeen`, so the since-install diff has a
real baseline. Read-only against the archive except one Save-Page-Now request per app when
a quarter has no usable capture. Files: `lib/historical-import.ts`, `lib/wayback-bulk-runner.ts`.

```mermaid
flowchart TD
  entry["per-app or bulk entry<br/>POST import-history · import-all (NDJSON stream)"]
  targets["computeHistoricalTargets<br/>quarters to 2021-Q1 + anchor at firstSeen"]
  avail["archive.org availability API<br/>closest capture per target"]
  walk{"◆ tolerance walk<br/>±14/28/42d probes<br/>drop if >45d drift"}
  spn["⚠ §5·1 no capture anywhere →<br/>Save-Page-Now for the live page<br/>once per app per run"]
  fetch["fetch replay (id_ URL)<br/>clean original HTML"]
  parse["parse — shoebox extractor for old<br/>Ember pages · modern chain for 2025+"]
  pipe["same §1 pipeline<br/>source='wayback' · backdated scrapedAt<br/>no changeCount bump"]
  tl["timeline: purple wayback rows<br/>'Matches live sync' badge · since-install baseline"]

  entry --> targets --> avail --> walk
  walk -->|miss| spn
  walk -->|hit| fetch --> parse --> pipe --> tl
```

---

## 6 · The gate chain every surface answers to

Whether any card, step, or destructive action exists at all is resolved through one
layered chain — later stages override earlier ones, user override always wins. The §3 flow
adds two hard gates on top (backup freshness, Touch ID) that no flag can soften.

```mermaid
flowchart LR
  hd["hard default<br/>HARD_DEFAULTS"] --> aud["audience<br/>self / loved_one / guardian"]
  aud --> goal["goals<br/>monitor · cleanup · minimal"]
  goal --> a11y["accessibility<br/>modifier bundle"]
  a11y --> rt["runtime<br/>Tauri-only off on web"]
  rt --> dep["dependency<br/>flags requiring flags"]
  dep --> ovr(["user override — final word"])
```

Kill-switch: `flag.devopts.feature_flag_system.enabled=off` collapses everything to hard
defaults without a code rollback. The delete flow's `flag.devopts.cfgutil_uninstall`
defaults to **off**, and the audience gate is enforced in code — flipping the flag on
under `guardian` still shows nothing. Modules: `lib/feature-flag-rules.ts`,
`lib/feature-flags*.ts` (see AGENTS.md for the five-module split).

---

## 7 · Improvement backlog

Point-in-time (2026-07-06). Refs match the `⚠`/`✅` markers in the diagrams above. Prune or
flip rows as they land, and update the diagram label in the same PR.

| Ref | Area | Status | Finding → candidate improvement | Effort |
| --- | --- | --- | --- | --- |
| §3·1 | Device backup | **open · high** | `cfgutil backup --backup-output` appears in no public cfgutil docs (canonical: `backup` takes no options, writes to MobileSync). Verify `cfgutil help backup` on a Mac with Configurator; if rejected, run plain `backup` and resolve the real path via `list-backups`. | S–M |
| §3·2 | Device backup | **open · high** | Backup success is exit-code only. Verify on disk (dir non-empty / `Manifest.db`) before stamping; never record a fallback path that wasn't observed. | S |
| §3·3 | Device delete | open | `run_with_timeout` orphans the cfgutil child on timeout — "failed" can silently become "succeeded later". Kill the process group, or re-check installed state after timeout and correct the audit row. | S |
| §3·4 | Device backup | open | `resolve_backup_dest` claims symlink protection but checks lexically. Canonicalise the existing ancestor, or fix the comment. | S |
| §3·5 | Delete UX / audit | open | Final modal's backup variant + acknowledge flag key off session-local state. Drive both from the server stamp (GET gate) so audit rows stop over-reporting "no backup acknowledged". Spec ready: [docs/specs/3-5-server-stamp-backup-variant.md](specs/3-5-server-stamp-backup-variant.md). | S |
| §3·6 | Device actions | ✅ fixed | ECID normalisation (`0x`-prefixed) across stamp store, gate, and routes; pinned by tests with real-format ECIDs. | — |
| §3·7 | Device actions | ✅ fixed | Server gate pre-flights before the first removal (fail closed); recording failures surface in the UI. | — |
| §1·1 | Scraper | open | No parser canary. Add fixture tests against recorded App Store HTML + an alert/activity row when a scrape parses zero privacy types for an app that previously had them. | M |
| §1·2 | AI summaries | idea | Summarisation silently degrades without a provider; chunking for local models is heuristic. Consider a visible "summary stale/unavailable" state. | S |
| §2·1 / §4·1 | Rate limiting | open | On 429 the bulk sync abandons the run and restarts the whole fleet next tick. Resume from the state blob's cursor instead; consider shared per-app backoff with the import queue. | M |
| §2·2 | Cross-platform import | idea | Python export needs a manual round-trip. Drag-drop hint or watch-folder hand-off. | M |
| §4·2 | Polling | idea | Three pollers (TaskCenter 4s, notification watcher, per-job GETs) → one SSE stream from the sidecar. | L |
| §5·1 | Wayback | idea | Track quarters skipped for lack of captures and offer "retry skipped" once Save-Page-Now requests have had time to land. | S–M |

Suggested order: §3·1 and §3·2 first (they decide whether "we back up before deleting" is
true at all), then §1·1 (protects the core product), then §3·3/§3·4/§3·5 as one small
hardening PR, then the rate-limit resume (§2·1/§4·1).

---

## Keeping this document honest

- Diagrams are Mermaid — edit them in place; GitHub renders them natively.
- The backlog is point-in-time by design. When a finding is fixed, flip its row to ✅ and
  update the matching `⚠` label in the diagram in the same PR (or delete both once stale).
- Timings (boot delays, poll intervals, timeouts) were read from source on the date above;
  if you change one in code, grep this file for the old value.
