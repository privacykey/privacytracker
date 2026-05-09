/**
 * Parent-process watchdog for the Tauri-spawned Node sidecar. Polls the
 * parent PID (passed via `PRIVACYTRACKER_PARENT_PID`) and `process.exit(0)`s
 * when the parent is gone, so unclean parent deaths (Force Quit, kill -9,
 * Tauri panic) don't leave an orphaned Node sidecar holding the SQLite WAL
 * and listening port. The Rust side handles the clean path via SIGTERM in
 * `src-tauri/src/sidecar.rs::SidecarHandle::shutdown`.
 */

const INITIAL_DELAY_MS = 5_000;
const POLL_INTERVAL_MS = 3_000;

/** Idempotency latch so dev hot-reload / tests don't stack timers. */
let installed = false;

/**
 * Read and validate the parent-PID env var. Returns null when unset, when
 * the value isn't a positive finite integer, or when it matches our own
 * PID — null disables the watchdog entirely.
 */
function readParentPid(): number | null {
  const raw = process.env.PRIVACYTRACKER_PARENT_PID;
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) return null;
  if (parsed === process.pid) return null;
  return parsed;
}

/**
 * Returns true when the process exists or we hit EPERM (different uid —
 * parent is alive but unsignallable). Returns false only on ESRCH.
 * Other errors fall to "alive" so transient probe failures don't self-kill.
 */
function isAlive(pid: number): boolean {
  try {
    // Signal 0 doesn't deliver — it's the canonical liveness probe.
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    return true;
  }
}

/**
 * Install the parent-watchdog timer. Idempotent. The timer is `unref()`'d
 * so it never holds the event loop open on its own.
 */
export function installParentWatchdog(): { active: boolean; parentPid: number | null } {
  if (installed) return { active: true, parentPid: readParentPid() };

  const parentPid = readParentPid();
  if (parentPid === null) {
    return { active: false, parentPid: null };
  }
  installed = true;

  const tick = () => {
    if (isAlive(parentPid)) return;
    console.log(
      `[parent-watchdog] parent PID ${parentPid} is gone — exiting Node sidecar (PID ${process.pid})`,
    );
    // exit(0) so SQLite WAL checkpointing and other shutdown hooks run
    // through the normal clean-exit path.
    process.exit(0);
  };

  const handle = setTimeout(() => {
    tick();
    const interval = setInterval(tick, POLL_INTERVAL_MS);
    interval.unref();
  }, INITIAL_DELAY_MS);
  handle.unref();

  console.log(
    `[parent-watchdog] watching parent PID ${parentPid} (interval ${POLL_INTERVAL_MS}ms after ${INITIAL_DELAY_MS}ms initial delay)`,
  );
  return { active: true, parentPid };
}

/** Reset the install latch. Test-only. */
export function __resetForTests(): void {
  installed = false;
}
