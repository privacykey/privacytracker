# Spec §3·5 — Drive the delete-confirm modal's backup state from the server stamp

**Backlog ref:** §3·5 in [docs/ARCHITECTURE.md](../ARCHITECTURE.md#7--improvement-backlog) ·
**Size:** S (~150–250 LOC including tests) · **Area:** device actions (TypeScript only — no Rust)
· **Good first issue:** yes — single component + one new pure helper + tests, no hardware needed.

Read [AGENTS.md](../../AGENTS.md) first (commands, conventions), and skim
[docs/ARCHITECTURE.md §3](../ARCHITECTURE.md#3--back-up-then-delete-apps-off-the-phone)
for the flow this touches.

---

## Background

The review-and-act wizard (`app/components/ReviewRecommendationsView.tsx`) deletes apps off
a connected iPhone via cfgutil. Before running the bulk delete it shows two modals; the
second ("type DELETE") has two copy variants:

- **fresh-backup variant** — reassuring, shows device name + backup time;
- **no-backup variant** — louder "at your own risk" wording.

Which variant renders — and whether the per-app recording POSTs carry
`acknowledgeNoBackup: true` — is currently decided by **session-local component state**:

```ts
// ReviewRecommendationsView.tsx — Modal 2 confirm button
const acknowledgeNoBackup = backup.status !== "done";
```

`backup.status` only becomes `"done"` when a backup ran **in this mount of the wizard**.
The server, meanwhile, keeps its own durable stamp per device
(`cfgutil_last_backup_<ECID>` in `app_settings`, written by
`POST /api/device-actions/backup`, read by `checkUninstallGate()` in
`lib/device-actions.ts` with a 24h freshness window, `BACKUP_FRESHNESS_WINDOW_MS`).

The two sources of truth disagree in real scenarios:

1. **Backed up 2 hours ago, then reopened the wizard.** Server stamp is fresh; local state
   is `idle`. The user sees the scary no-backup modal and the audit log records
   `acknowledgedNoBackup: true` — over-reporting risk they didn't actually take.
2. **Backup succeeded but its recording POST failed.** Local state says `done`; the server
   has no stamp. The modal shows the reassuring variant, then the pre-flight gate
   (`GET /api/device-actions/uninstall`) refuses `backup_missing` — correct but confusing,
   because the modal just promised a backup existed.

The fix: make the **server stamp** the single source of truth for the modal variant, the
act-step banner, and the `acknowledgeNoBackup` flag. Session-local `backup.status` remains
the source of truth only for the backup step's own progress UI (running / done / error).

## Current behaviour — where to look

All in `app/components/ReviewRecommendationsView.tsx` (find by searching for the quoted
strings; line numbers drift):

| Spot | Search for | Current driver |
| --- | --- | --- |
| Act-step banner (✓ fresh / ⚠ missing) | `review-rec-backup-status` | `backup.status === "done"` |
| Modal 2 copy variant | `bulk-final-title` | `backup.status === "done" && backup.finishedAt` |
| Acknowledge flag | `backup.status !== "done"` | local state |
| Pre-flight gate (do NOT change) | `gate pre-flight` in `runBulkUninstall` | server GET, fail closed |

Server side:

- `GET /api/device-actions/uninstall?ecid=…` (`app/api/device-actions/uninstall/route.ts`)
  returns `checkUninstallGate(ecid)`: `{ allowed: true }` or
  `{ allowed: false, reason: "audience" | "flag" | "backup_missing" | "backup_stale", … }`.
- `getLastBackup(ecid)` (`lib/device-actions.ts`) returns
  `{ finishedAt: number, path: string } | null`. ECIDs are normalised (`normalizeEcid`)
  so cfgutil's `0x…` spellings round-trip.

## Desired behaviour

1. **Extend the GET response (additive).** `GET /api/device-actions/uninstall?ecid=…`
   additionally returns `lastBackup: { finishedAt, path } | null` alongside the existing
   gate fields. Additive only — existing fields and the POST contract must not change.

2. **New pure helper + shared types.** Create `lib/device-actions-shared.ts` (no
   `"server-only"` import — the existing server module `lib/device-actions.ts` cannot be
   imported from client components; follow the `lib/changelog-types.ts` precedent for
   client-safe shared types). Export:

   ```ts
   export type UninstallGateResponse = {
     allowed?: boolean;
     reason?: "audience" | "flag" | "backup_missing" | "backup_stale";
     lastBackup?: { finishedAt: number; path: string } | null;
   };

   export type ServerBackupState =
     | { kind: "fresh"; finishedAt: number }
     | { kind: "not_fresh" };  // missing, stale, unreadable, or fetch failed

   export function deriveServerBackupState(
     gate: UninstallGateResponse | null
   ): ServerBackupState;
   ```

   Rules: `allowed: true` **with** a `lastBackup` → `fresh` (use its `finishedAt`);
   `allowed: true` **without** `lastBackup` (acknowledge path / unexpected) → `not_fresh`;
   any denial, `null`, or malformed input → `not_fresh`. Never claim a backup exists that
   the server didn't report — conservative by construction.

3. **Wizard queries the stamp at the right moments.** In
   `ReviewRecommendationsView.tsx`, fetch
   `GET /api/device-actions/uninstall?ecid=<selectedEcid>` with `cache: "no-store"`:
   - when the act step becomes active with a selected ECID (one fetch per entry, in a
     `useEffect` keyed on `[step, selectedEcid]` — mirror the existing device-polling
     effect's cancellation pattern);
   - after `runBackup` completes successfully (so the banner flips to ✓ without a remount).
   Store the derived `ServerBackupState` in component state. Do **not** fetch on every
   render and do **not** touch the existing pre-flight inside `runBulkUninstall` — that
   stays exactly as is (it is the execution gate; this work is display/audit semantics).

4. **Three consumers switch to the derived state.**
   - Act-step banner: ✓ variant when `fresh` (time from `finishedAt`), ⚠ otherwise.
   - Modal 2: reassuring variant when `fresh` — reuse the existing
     `confirm_modal.final_body` copy; when the local `backup.device` name is unknown
     (cross-session case) the existing `fallback_device_name` string covers `{device}`.
     No new i18n keys are expected; if you do add any, add them to **both**
     `locales/en.json` and `locales/zh.json` and run `pnpm lint:i18n`.
   - Confirm button: `const acknowledgeNoBackup = serverBackupState.kind !== "fresh";`
   The backup step's own status text (running/done/error + saved-path line) stays on
   local state.

5. **Conservative on failure.** If the GET fails or returns junk, behave as `not_fresh`
   (scary variant, `acknowledgeNoBackup: true`). This is deliberately the opposite
   direction of the pre-flight (which fails **closed** by refusing) — here nothing is
   blocked, we just refuse to *reassure*.

## Tests (node:test — see `tests/app/uninstall-gate.test.ts` for style)

New file `tests/app/device-actions-shared.test.ts` covering `deriveServerBackupState`:
`allowed+lastBackup → fresh` (finishedAt passed through) · `allowed without lastBackup →
not_fresh` · each denial reason → `not_fresh` · `null` / `{}` / garbage → `not_fresh`.

Extend `tests/app/uninstall-gate.test.ts` (or a small new route-shaped test) to pin the
additive GET payload: after `recordBackup(...)`, the route module's GET handler for that
ECID includes `lastBackup.finishedAt`; for an unknown ECID `lastBackup` is `null`.

## Acceptance criteria

- [ ] `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm lint:i18n` all pass.
- [ ] GET response is a strict superset of today's; POST semantics untouched.
- [ ] `runBulkUninstall`'s pre-flight block is byte-identical (no behaviour change).
- [ ] With a fresh server stamp and a **freshly mounted** wizard: banner shows ✓, Modal 2
      shows the reassuring variant, recording POSTs carry `acknowledgeNoBackup: false`.
- [ ] With no/stale stamp (even right after a local backup whose recording POST failed):
      ⚠ banner, at-your-own-risk variant, `acknowledgeNoBackup: true`.
- [ ] Helper lives in a client-safe module; no client import of `"server-only"` code
      (this fails the build — see the five-module flag split in AGENTS.md for why).
- [ ] No polling loops added; at most one gate fetch per act-step entry + one after a
      completed backup.

## Out of scope

Backup verification on disk (§3·2), the `--backup-output` question (§3·1), Rust changes
(§3·3/§3·4), batching or copy redesign, and anything touching `run_cfgutil_remove_app`.

## Pitfalls

- `lib/device-actions.ts` is `"server-only"` — importing it from the component is the
  first thing that will fail the build. Hence the shared module.
- Biome (`pnpm lint`) enforces repo style; `useExhaustiveDependencies` is off, and the
  file uses eslint-disable-style comments for stable `t*` translators — mimic neighbours.
- The wizard already has `bulkGateError` / pre-flight state — don't conflate it with the
  new display state; they answer different questions ("may I run?" vs "should I reassure?").
- `matches` in tests: use a real-format ECID (`0x9118908BB6027`) at least once — the
  normalisation path is load-bearing (see tests already pinning it).
