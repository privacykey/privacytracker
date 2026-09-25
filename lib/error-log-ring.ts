/**
 * Bounded in-memory ring buffer for `console.error` / `console.warn`
 * output, surfaced by the diagnostics page and support-bundle export.
 * Capped at 200 entries; messages clipped at 4 KB. Original console
 * output is preserved (chained through). Restart wipes the ring.
 *
 * Kept on `globalThis`, like the CSP report ring. `instrumentation.ts`
 * installs the patches through its copy of this module and the
 * diagnostics routes read theirs, and a production build gives the two
 * separate module instances. With the ring in module state, the one the
 * patches wrote to was never the one the routes read, so the Diagnostics
 * error log stayed empty under `next start` whatever the server logged.
 */

const MAX_ENTRIES = 200;
const MAX_MESSAGE_LEN = 4 * 1024;

export type ErrorLogLevel = "error" | "warn";

export interface ErrorLogEntry {
  /** ms since epoch when the entry was captured. */
  at: number;
  level: ErrorLogLevel;
  /** Single-line message (newlines preserved). Truncated to 4 KB. */
  message: string;
  /** True when the original was longer than `MAX_MESSAGE_LEN`. */
  truncated: boolean;
}

interface RingState {
  entries: ErrorLogEntry[];
  /** The process that installed the patches, or null before install. */
  installedPid: number | null;
}

const state: RingState = ((globalThis as any).__pt_error_log_ring ??= {
  entries: [],
  installedPid: null,
});

function pushEntry(level: ErrorLogLevel, args: unknown[]): void {
  const raw = args
    .map((a) => {
      if (a instanceof Error) {
        return a.stack ?? `${a.name}: ${a.message}`;
      }
      if (typeof a === "string") {
        return a;
      }
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(" ");

  const truncated = raw.length > MAX_MESSAGE_LEN;
  const message = truncated
    ? `${raw.slice(0, MAX_MESSAGE_LEN)}… (truncated)`
    : raw;

  const ring = state.entries;
  ring.push({ at: Date.now(), level, message, truncated });
  if (ring.length > MAX_ENTRIES) {
    ring.splice(0, ring.length - MAX_ENTRIES);
  }
}

/**
 * Install the console.error / console.warn interceptors. Idempotent —
 * calling twice (e.g. under hot-reload, or from another copy of this
 * module) is a no-op. Returns the patched functions, or null if already
 * installed in this process.
 */
export function installErrorLogRing(): {
  error: typeof console.error;
  warn: typeof console.warn;
} | null {
  if (state.installedPid === process.pid) {
    return null;
  }
  state.installedPid = process.pid;

  const originalError = console.error;
  const originalWarn = console.warn;

  console.error = function patchedError(...args: unknown[]) {
    pushEntry("error", args);
    return originalError.apply(console, args);
  };

  console.warn = function patchedWarn(...args: unknown[]) {
    pushEntry("warn", args);
    return originalWarn.apply(console, args);
  };

  return { error: console.error, warn: console.warn };
}

/**
 * Snapshot the current ring contents. Returns a copy so callers can
 * safely sort / filter without mutating the ring. Newest first —
 * the ring is reversed directly (rather than sorting by `at`) to
 * keep ordering correct on sub-ms timestamp ties.
 */
export function snapshotErrorLog(opts: { limit?: number } = {}): {
  entries: ErrorLogEntry[];
  capacity: number;
} {
  const limit = Math.max(1, Math.min(MAX_ENTRIES, opts.limit ?? MAX_ENTRIES));
  // .slice() copies, .reverse() mutates the copy — leaves the ring intact.
  const reversed = state.entries.slice().reverse();
  return { entries: reversed.slice(0, limit), capacity: MAX_ENTRIES };
}

/** Drop every entry. */
export function clearErrorLog(): void {
  state.entries = [];
}
