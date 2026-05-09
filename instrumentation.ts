export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // Parent-process watchdog. When the Tauri shell launches us it sets
    // PRIVACYTRACKER_PARENT_PID to its own PID; this watcher polls that
    // PID every few seconds and self-exits if it disappears. Closes the
    // gap left by SIGKILL / Force-Quit / runtime-panic of the parent —
    // those paths skip Tauri's RunEvent::ExitRequested handler, and
    // because the child is `setsid()`'d the kernel won't send SIGHUP
    // either, so without this hook the Node sidecar would survive an
    // unclean parent quit indefinitely. No-op when the env var isn't
    // set (Docker, `npm run dev`, CI). See `lib/parent-watchdog.ts`
    // for the full failure-mode rationale. Runs first because it has
    // zero dependencies on the rest of the boot path and we want it
    // active as early as possible.
    try {
      const { installParentWatchdog } = await import('./lib/parent-watchdog');
      installParentWatchdog();
    } catch (e) {
      console.error('[parent-watchdog] install failed:', e);
      // Never fatal — the cleanup-on-exit Rust path still works for
      // graceful quits even if the watchdog can't start.
    }

    // Error / warning ring buffer. Patches console.error + console.warn
    // before any other lib starts emitting so the very first complaint
    // about a missing migration / unreachable upstream / etc. is
    // captured into the ring the diagnostics page reads from.
    // Idempotent under hot-reload — see lib/error-log-ring.ts.
    try {
      const { installErrorLogRing } = await import('./lib/error-log-ring');
      installErrorLogRing();
    } catch (e) {
      // Best-effort: never block boot just because the ring couldn't
      // install. The original console.error/warn still work; we just
      // won't have a tail to render on the diagnostics page.
      console.error('[error-log-ring] install failed:', e);
    }

    // Runtime diagnostics: start the event-loop-delay histogram and patch
    // the singleton `better-sqlite3` `prepare()` so every prepared
    // statement is wrapped for slow-query timing. Runs FIRST (before
    // migrations or background tickers) so the very first DB call we
    // make is already instrumented — otherwise the migration runner's
    // queries would silently miss the slow-query log on a freshly-booted
    // process. Idempotent; safe under hot reload. See
    // `lib/runtime-diagnostics.ts` for the full design notes.
    try {
      const { default: db } = await import('./lib/db');
      const { installRuntimeDiagnostics } = await import('./lib/runtime-diagnostics');
      installRuntimeDiagnostics(db);
    } catch (e) {
      console.error('[Diagnostics] install failed:', e);
      // Never fatal — diagnostics are observability, not correctness.
    }

    // Round 3 PR 1: feature-flag migration. Runs first (synchronously, before
    // any background tickers are scheduled) so the resolver and downstream
    // tickers see consistent state. Idempotent — safe to retry. On failure
    // the runner throws MigrationError; we catch + log here so the rest of
    // the server still comes up; the in-app error UI surfaces the failure
    // when the user opens the app.
    try {
      const { runFeatureFlagMigration } = await import('./lib/migrations/v1_feature_flags');
      const results = runFeatureFlagMigration();
      if (results.length > 0) {
        const totalMs = results.reduce((sum, r) => sum + r.durationMs, 0);
        console.log(
          `[Migration] feature-flag v1 complete — ${results.length} steps in ${totalMs}ms`,
        );
      }
    } catch (e) {
      console.error('[Migration] feature-flag v1 failed:', e);
      // Don't rethrow — let the rest of the server come up so the user can
      // see the error UI rendered by app/layout.tsx (PR 1 adds that surface).
    }

    const { getSchedulerStatus, runScheduledSync, setSetting } = await import('./lib/scheduler');
    try {
      setSetting(
        'runtime_environment',
        process.env.PRIVACYTRACKER_RUNTIME === 'desktop' ? 'desktop' : '',
      );
    } catch (e) {
      console.error('[Runtime] Failed to persist runtime environment:', e);
    }
    const { runImportQueueTick } = await import('./lib/import-queue');
    const { runScheduledBackupSnapshotIfDue } = await import('./lib/backup-snapshots');
    const {
      readBulkState,
      isBulkMutexHeld,
      releaseBulkMutex,
      clearBulkState,
      hasPendingWork,
      summariseState,
    } = await import('./lib/wayback-bulk-state');
    const { runBulkWaybackImport } = await import('./lib/wayback-bulk-runner');
    const {
      readSyncBulkState,
      isSyncBulkMutexHeld,
      releaseSyncBulkMutex,
      clearSyncBulkState,
      hasSyncPendingWork,
      summariseSyncState,
    } = await import('./lib/sync-bulk-state');
    const { runBulkSync } = await import('./lib/sync-bulk-runner');
    const {
      readPolicyBulkState,
      isPolicyBulkMutexHeld,
      releasePolicyBulkMutex,
      clearPolicyBulkState,
      hasPolicyPendingWork,
      summarisePolicyState,
    } = await import('./lib/policy-bulk-state');
    const { runBulkPolicySync } = await import('./lib/policy-bulk-runner');
    const { recordActivity } = await import('./lib/activity');
    const {
      createWaybackResumeNotification,
      createSyncResumeNotification,
      createPolicyResumeNotification,
    } = await import('./lib/notifications');

    const CHECK_INTERVAL_MS = 30 * 60 * 1000; // check every 30 min
    const IMPORT_QUEUE_INTERVAL_MS = 60 * 1000; // drain queue every 60s
    const MAX_CONSECUTIVE_FAILURES = 3;
    const BACKOFF_STEPS_MS = [15 * 60_000, 60 * 60_000, 6 * 60 * 60_000]; // 15m → 1h → 6h

    // Rudimentary exponential-ish back-off: after three sync failures in a
    // row we pause auto-sync for a longer interval. If iTunes is rate-
    // limiting us or we've lost connectivity, the last thing we want is to
    // keep hammering the endpoint and earn a ban for the host IP.
    let consecutiveFailures = 0;
    let pauseUntil = 0;

    const check = async () => {
      if (Date.now() < pauseUntil) {
        return;
      }
      try {
        const { isDue } = getSchedulerStatus();
        if (isDue) {
          console.log('[AutoSync] Starting scheduled sync…');
          const result = await runScheduledSync();
          if (!result.skipped) {
            console.log(
              `[AutoSync] Done — ${result.synced} apps synced, ${result.changes} changed`,
            );
          }
          // Any successful run resets the backoff window.
          consecutiveFailures = 0;
        }
      } catch (e) {
        consecutiveFailures += 1;
        console.error(
          `[AutoSync] Error during sync (${consecutiveFailures} in a row):`,
          e,
        );
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          const step = BACKOFF_STEPS_MS[Math.min(
            consecutiveFailures - MAX_CONSECUTIVE_FAILURES,
            BACKOFF_STEPS_MS.length - 1,
          )];
          pauseUntil = Date.now() + step;
          console.warn(
            `[AutoSync] Pausing auto-sync for ${Math.round(step / 60_000)}m after repeated failures`,
          );
        }
      }
    };

    // Initial check 15s after server start, then every 30 min
    setTimeout(check, 15_000);
    setInterval(check, CHECK_INTERVAL_MS);
    console.log('[AutoSync] Scheduler initialised');

    // ── Stale import-queue mutex clear ──────────────────────────────
    //
    // Boot-time safety: if a previous app instance died mid-tick (Tauri
    // process force-quit, OOM, debugger killed, etc.), `import_queue_running`
    // is left at 'true' in app_settings. The runImportQueueTick code has
    // a 90s stale-lock timeout (was 20m, now 90s) but that's still 90
    // seconds of "tick skipped — busy" before users can drain anything.
    // A fresh process knows for certain that no tick is currently
    // running (we just started!), so we can clear the lock unconditionally
    // here and start with a clean slate. Same pattern the wayback / sync /
    // policy bulk runners already use for their own mutexes.
    try {
      const { getSetting, setSetting } = await import('./lib/scheduler');
      const wasStuck = getSetting('import_queue_running', 'false') === 'true';
      if (wasStuck) {
        const stuckSince = Number.parseInt(getSetting('import_queue_running_since', '0'), 10) || 0;
        const stuckFor = stuckSince > 0 ? Date.now() - stuckSince : 0;
        setSetting('import_queue_running', 'false');
        console.warn(
          `[ImportQueue] Cleared stale running lock from previous process${
            stuckFor > 0 ? ` (held for ${Math.round(stuckFor / 1000)}s before this boot)` : ''
          }`,
        );
      }
    } catch (e) {
      console.error('[ImportQueue] Failed to clear stale running lock at startup:', e);
    }

    // Independent ticker for the import queue. Runs on a tight 60s cadence
    // so 429-queued rows clear fast once Apple's rolling window resets.
    // `runImportQueueTick` itself no-ops when the queue is empty, when a
    // prior tick is still in flight, or when a recent 429 is still cooling
    // down, so the cost of an idle tick is a single `SELECT COUNT(*)`.
    const drainImportQueue = async () => {
      try {
        const result = await runImportQueueTick();
        if (result.processed > 0 || result.rateLimited > 0) {
          console.log(
            `[ImportQueue] Tick — processed ${result.processed}, succeeded ${result.succeeded}, failed ${result.failed}, rate-limited ${result.rateLimited}`,
          );
        }
      } catch (e) {
        console.error('[ImportQueue] Tick failed:', e);
      }
    };
    setTimeout(drainImportQueue, 20_000); // first kick shortly after boot
    setInterval(drainImportQueue, IMPORT_QUEUE_INTERVAL_MS);
    console.log('[ImportQueue] Worker initialised');

    // Automatic local backup snapshots. The helper owns the user-configured
    // interval + retention policy, so this ticker only needs to wake up
    // occasionally and ask "is one due yet?".
    const tickBackupSnapshots = async () => {
      try {
        const result = runScheduledBackupSnapshotIfDue();
        if (result) {
          console.log(
            `[BackupSnapshots] Created ${result.snapshot.filename}; pruned ${result.pruned.length}`,
          );
        }
      } catch (e) {
        console.error('[BackupSnapshots] Tick failed:', e);
      }
    };
    setTimeout(tickBackupSnapshots, 35_000);
    setInterval(tickBackupSnapshots, CHECK_INTERVAL_MS);
    console.log('[BackupSnapshots] Scheduler initialised');

    // Wayback bulk-import resume. Runs exactly once per server boot, a few
    // seconds after startup so we don't compete with Next's initial
    // compile/JIT work. Three outcomes:
    //
    //   1. No leftover state and no held mutex → nothing to do.
    //   2. Stale mutex (held but no state blob with pending work) → clear
    //      it so future manual runs aren't blocked, fire a "stuck lock
    //      cleared" notification + terse activity row.
    //   3. State blob with pending work → spawn `runBulkWaybackImport`
    //      with `initiator: 'resume'` in the background, file a "Sync
    //      resumed" activity row, and raise a bell notification so the
    //      user sees what's happening without having to open Settings.
    //
    // This runs fire-and-forget inside a setTimeout — we never want a
    // Wayback resume crash to prevent the rest of the server from coming
    // up. All failure modes are recorded to activity_log / audit_log.
    const resumeWaybackImport = async () => {
      try {
        const state = readBulkState();
        const mutexHeld = isBulkMutexHeld();

        // Case 1 — clean state, nothing to do.
        if (!state && !mutexHeld) return;

        // Case 2 — stale lock with no pending work. Heal it.
        if (!hasPendingWork(state)) {
          if (mutexHeld) {
            console.warn('[WaybackResume] Clearing stale bulk-import mutex');
            releaseBulkMutex();
          }
          if (state) {
            clearBulkState();
          }
          try {
            createWaybackResumeNotification({
              appsRemaining: 0,
              totalApps: 0,
              staleHealed: true,
            });
          } catch (e) {
            console.warn('[WaybackResume] Failed to raise stale-heal notification:', e);
          }
          recordActivity({
            type: 'wayback_import',
            status: 'ok',
            summary: 'Cleared stuck Wayback import lock from a previous server run',
            detail: { mode: 'bulk-stale-healed' },
            startedAt: Date.now(),
          });
          return;
        }

        // Case 3 — resume the run. `state` is guaranteed non-null here
        // because hasPendingWork(null) returns false.
        const summary = summariseState(state!);
        const remaining = summary.remaining;
        const total = summary.total;

        console.log(
          `[WaybackResume] Resuming bulk import — ${remaining} of ${total} apps remaining`,
        );

        try {
          createWaybackResumeNotification({
            appsRemaining: remaining,
            totalApps: total,
          });
        } catch (e) {
          console.warn('[WaybackResume] Failed to raise resume notification:', e);
        }

        recordActivity({
          type: 'wayback_import',
          status: 'ok',
          summary:
            `Wayback import resumed after server restart — ` +
            `${remaining} of ${total} app${total === 1 ? '' : 's'} left`,
          detail: {
            mode: 'bulk-resume-start',
            runId: state!.runId,
            remaining,
            total,
          },
          startedAt: Date.now(),
        });

        // Spawn the runner in the background. We intentionally do NOT
        // await it — this keeps the startup hook snappy and lets the
        // Next.js request loop start serving traffic immediately. The
        // runner handles its own logging + state cleanup; we only need
        // to catch stray rejections so they don't become unhandled.
        runBulkWaybackImport({
          initiator: 'resume',
          streamRequested: state!.streamRequested,
          resumeState: state!,
        }).catch(e => {
          console.error('[WaybackResume] Resumed run failed:', e);
        });
      } catch (e) {
        console.error('[WaybackResume] Startup check failed:', e);
      }
    };
    // Delay a touch longer than the other tickers so the first DB hits
    // land after better-sqlite3 finishes its initial page-cache warmup.
    setTimeout(resumeWaybackImport, 8_000);
    console.log('[WaybackResume] Startup check scheduled');

    // Bulk App Store sync resume. Same three-case structure as the
    // wayback resume above — see that block's comment for the full
    // rationale. The notable difference is that a resumed sync is
    // *always* tagged `initiator: 'resume'` regardless of whether the
    // original run was manual or scheduled; we don't know which one was
    // killed and the activity log already records both equally.
    const resumeAppStoreSync = async () => {
      try {
        const state = readSyncBulkState();
        const mutexHeld = isSyncBulkMutexHeld();

        if (!state && !mutexHeld) return;

        if (!hasSyncPendingWork(state)) {
          if (mutexHeld) {
            console.warn('[SyncResume] Clearing stale bulk-sync mutex');
            releaseSyncBulkMutex();
          }
          if (state) {
            clearSyncBulkState();
          }
          try {
            createSyncResumeNotification({
              appsRemaining: 0,
              totalApps: 0,
              staleHealed: true,
            });
          } catch (e) {
            console.warn('[SyncResume] Failed to raise stale-heal notification:', e);
          }
          recordActivity({
            type: 'scheduled_sync',
            status: 'ok',
            summary: 'Cleared stuck App Store sync lock from a previous server run',
            detail: { mode: 'bulk-stale-healed' },
            startedAt: Date.now(),
          });
          return;
        }

        const summary = summariseSyncState(state!);
        const remaining = summary.remaining;
        const total = summary.total;

        console.log(
          `[SyncResume] Resuming bulk App Store sync — ${remaining} of ${total} apps remaining`,
        );

        try {
          createSyncResumeNotification({
            appsRemaining: remaining,
            totalApps: total,
          });
        } catch (e) {
          console.warn('[SyncResume] Failed to raise resume notification:', e);
        }

        recordActivity({
          type: 'scheduled_sync',
          status: 'ok',
          summary:
            `App Store sync resumed after server restart — ` +
            `${remaining} of ${total} app${total === 1 ? '' : 's'} left`,
          detail: {
            mode: 'bulk-resume-start',
            runId: state!.runId,
            remaining,
            total,
          },
          startedAt: Date.now(),
        });

        runBulkSync({
          initiator: 'resume',
          resumeState: state!,
        }).catch(e => {
          console.error('[SyncResume] Resumed run failed:', e);
        });
      } catch (e) {
        console.error('[SyncResume] Startup check failed:', e);
      }
    };
    setTimeout(resumeAppStoreSync, 10_000);
    console.log('[SyncResume] Startup check scheduled');

    // Bulk privacy-policy sync resume. Same shape again. The runner
    // reads `phase` + `force` off the state blob so a "Summarise all"
    // resume doesn't silently degrade to a cheap re-fetch.
    const resumePolicySync = async () => {
      try {
        const state = readPolicyBulkState();
        const mutexHeld = isPolicyBulkMutexHeld();

        if (!state && !mutexHeld) return;

        if (!hasPolicyPendingWork(state)) {
          if (mutexHeld) {
            console.warn('[PolicyResume] Clearing stale bulk-policy-sync mutex');
            releasePolicyBulkMutex();
          }
          if (state) {
            clearPolicyBulkState();
          }
          try {
            createPolicyResumeNotification({
              appsRemaining: 0,
              totalApps: 0,
              staleHealed: true,
            });
          } catch (e) {
            console.warn('[PolicyResume] Failed to raise stale-heal notification:', e);
          }
          recordActivity({
            type: 'policy_summary',
            status: 'ok',
            summary: 'Cleared stuck privacy-policy sync lock from a previous server run',
            detail: { mode: 'bulk-stale-healed' },
            startedAt: Date.now(),
          });
          return;
        }

        const summary = summarisePolicyState(state!);
        const remaining = summary.remaining;
        const total = summary.total;

        console.log(
          `[PolicyResume] Resuming bulk policy sync — ${remaining} of ${total} apps remaining`,
        );

        try {
          createPolicyResumeNotification({
            appsRemaining: remaining,
            totalApps: total,
          });
        } catch (e) {
          console.warn('[PolicyResume] Failed to raise resume notification:', e);
        }

        recordActivity({
          type: 'policy_summary',
          status: 'ok',
          summary:
            `Privacy-policy sync resumed after server restart — ` +
            `${remaining} of ${total} app${total === 1 ? '' : 's'} left`,
          detail: {
            mode: 'bulk-resume-start',
            runId: state!.runId,
            remaining,
            total,
            phase: state!.phase,
            force: state!.force,
          },
          startedAt: Date.now(),
        });

        runBulkPolicySync({
          initiator: 'resume',
          phase: state!.phase,
          force: state!.force,
          streamRequested: state!.streamRequested,
          resumeState: state!,
        }).catch(e => {
          console.error('[PolicyResume] Resumed run failed:', e);
        });
      } catch (e) {
        console.error('[PolicyResume] Startup check failed:', e);
      }
    };
    setTimeout(resumePolicySync, 12_000);
    console.log('[PolicyResume] Startup check scheduled');

    // Update check. Polls GitHub Releases on a daily cadence and caches
    // the result in `app_settings`. The UI reads from cache via
    // /api/update-status — this ticker exists purely so a long-running
    // server discovers new releases without anyone having to hit refresh.
    //
    // Cadence: first probe 25s after boot (after migrations + sync resume
    // have settled), then re-check every 6h. The 6h ticker doesn't *force*
    // a fetch — it just calls `checkForUpdate()`, which short-circuits
    // when the 24h cache is still fresh. So the *actual* GitHub call
    // happens roughly once per 24h regardless of restart cadence.
    //
    // Failures are logged but never escalated. A failed update check is
    // a non-event: the cached version stays put, the banner keeps
    // showing whatever it was already showing, and the next tick tries
    // again. We intentionally do NOT trip the auto-sync backoff here —
    // GitHub being down shouldn't pause the App Store sync.
    const { checkForUpdate } = await import('./lib/update-check');
    const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h tick, 24h actual cache
    const tickUpdateCheck = async () => {
      try {
        const result = await checkForUpdate();
        if (result.performed) {
          if (result.error) {
            console.warn('[UpdateCheck] Check failed:', result.error);
          } else if (result.status.updateAvailable) {
            console.log(
              `[UpdateCheck] Update available — ${result.status.currentVersion} → ${result.status.latestVersion}`,
            );
          }
        }
      } catch (e) {
        // Belt-and-braces: checkForUpdate already swallows errors into
        // result.error, but a misbehaving DB or a missing settings table
        // could throw out of the cache read. Don't let it climb the stack.
        console.warn('[UpdateCheck] Tick threw:', e);
      }
    };
    setTimeout(tickUpdateCheck, 25_000);
    setInterval(tickUpdateCheck, UPDATE_CHECK_INTERVAL_MS);
    console.log('[UpdateCheck] Ticker initialised (6h cadence, 24h cache)');
  }
}
