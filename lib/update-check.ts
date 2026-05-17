/**
 * Server-safe update detection. One GET to GitHub's
 * `releases/latest`, cached in `app_settings` for 24h. Used by Docker,
 * Tauri desktop, Homebrew, and local Node deployments.
 *
 * Side-effect free. Startup tick: `instrumentation.ts`. Route:
 * `app/api/update-status/route.ts`. UI: `app/components/UpdateBanner.tsx`.
 */

import pkg from "../package.json";
import { getSetting, setSetting } from "./scheduler";

// ─── Constants ──────────────────────────────────────────────────────────

/** Canonical GitHub repo. Mirrors GITHUB_REPO in app/privacy-policy/page.tsx. */
const GITHUB_REPO_OWNER = "privacykey";
const GITHUB_REPO_NAME = "privacytracker";

/** GitHub REST endpoint. Returns the latest non-prerelease. */
const RELEASES_URL = `https://api.github.com/repos/${GITHUB_REPO_OWNER}/${GITHUB_REPO_NAME}/releases/latest`;

/** How long a successful check is considered fresh. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Minimum gap between live checks even when forced via ?refresh=1. */
const FORCE_REFRESH_MIN_GAP_MS = 5 * 60 * 1000;

/** Hard cap on the request. */
const FETCH_TIMEOUT_MS = 8000;

/** UA string. GitHub asks for one and uses it for abuse heuristics. */
const USER_AGENT = `privacytracker-update-check/${pkg.version} (+${RELEASES_URL.replace("/releases/latest", "")})`;

// ─── Settings keys ──────────────────────────────────────────────────────
const KEY_ENABLED = "update_check_enabled"; // 'true' | 'false'
const KEY_LAST_CHECKED = "update_last_checked"; // unix ms
const KEY_LATEST_VERSION = "update_latest_version"; // semver string, no leading 'v'
const KEY_LATEST_NOTES = "update_latest_notes"; // markdown release body, truncated
const KEY_LATEST_URL = "update_latest_url"; // html_url of the release
const KEY_LATEST_PUBDATE = "update_latest_pub_date"; // ISO 8601
const KEY_LAST_ERROR = "update_last_error"; // human-readable, optional
const KEY_LAST_FORCED = "update_last_forced_check"; // unix ms, throttle for ?refresh=1

// Notes are stored as a preview only — full body is on GitHub.
const NOTES_PREVIEW_MAX_CHARS = 4000;

// ─── Types ──────────────────────────────────────────────────────────────

export type DeploymentRuntime =
  | "docker"
  | "tauri"
  | "homebrew"
  | "node"
  | "unknown";

/** What every consumer (banner, API route, settings UI) reads. */
export interface UpdateStatus {
  /** Version baked into this build. Read from package.json at compile time. */
  currentVersion: string;
  /** Whether the user has the check turned on. */
  enabled: boolean;
  /** Last successful check, unix ms. 0 if never checked. */
  lastChecked: number;
  /** Last error string (if a check failed). Cleared on next success. */
  lastError: string | null;
  /** Truncated markdown body of the release. */
  latestNotes: string | null;
  /** ISO 8601 publish date of the latest release. */
  latestPublishedAt: string | null;
  /** HTML URL of the release on GitHub. */
  latestUrl: string | null;
  /** Latest release tag (without leading 'v'), or null if never checked. */
  latestVersion: string | null;
  /** Detected deployment surface — affects which CTA the banner shows. */
  runtime: DeploymentRuntime;
  /** True iff latest > current per semver. */
  updateAvailable: boolean;
}

// ─── Public API ─────────────────────────────────────────────────────────

/** Returns the version string from package.json. */
export function getCurrentVersion(): string {
  return pkg.version;
}

/**
 * Detects the server-side deployment. Tauri detection happens client-side
 * via `window.__TAURI__`; UpdateBanner upgrades the label when present.
 *
 * Detection rules:
 *   - DEPLOYMENT env var explicitly set → use that
 *   - /.dockerenv exists OR cgroup mentions docker → 'docker'
 *   - HOMEBREW_PREFIX or HOMEBREW_FORMULA_PATH set → 'homebrew'
 *   - Otherwise → 'node'
 */
export function getDeploymentRuntime(): DeploymentRuntime {
  const explicit = (process.env.DEPLOYMENT ?? "").toLowerCase().trim();
  if (
    explicit === "docker" ||
    explicit === "tauri" ||
    explicit === "homebrew" ||
    explicit === "node"
  ) {
    return explicit as DeploymentRuntime;
  }

  // Docker probes: /.dockerenv first, cgroup fallback for stripped images.
  try {
    // Inline require keeps this tree-shakeable on edge runtime.
    const fs = require("node:fs") as typeof import("fs");
    if (fs.existsSync("/.dockerenv")) {
      return "docker";
    }
    try {
      const cgroup = fs.readFileSync("/proc/1/cgroup", "utf8");
      if (/docker|containerd|kubepods/.test(cgroup)) {
        return "docker";
      }
    } catch {
      /* /proc unavailable, e.g. on macOS — ignore */
    }
  } catch {
    /* fs unavailable in some runtimes — ignore */
  }

  // Homebrew env vars — set in shell sessions and re-exported by brew services.
  if (process.env.HOMEBREW_PREFIX || process.env.HOMEBREW_FORMULA_PATH) {
    return "homebrew";
  }

  return "node";
}

/**
 * Synchronous read of whatever the last `checkForUpdate` call wrote.
 * Cheap — safe to call on every request. `runtime` is computed fresh
 * each call so a moved DB picks up the new environment.
 */
export function getCachedUpdateStatus(): UpdateStatus {
  const currentVersion = getCurrentVersion();
  const latestVersion = getSetting(KEY_LATEST_VERSION, "") || null;
  const lastChecked =
    Number.parseInt(getSetting(KEY_LAST_CHECKED, "0"), 10) || 0;
  const enabled = getSetting(KEY_ENABLED, "true") !== "false";
  const lastError = getSetting(KEY_LAST_ERROR, "") || null;
  const latestNotes = getSetting(KEY_LATEST_NOTES, "") || null;
  const latestUrl = getSetting(KEY_LATEST_URL, "") || null;
  const latestPublishedAt = getSetting(KEY_LATEST_PUBDATE, "") || null;

  return {
    currentVersion,
    latestVersion,
    updateAvailable:
      latestVersion !== null &&
      compareVersions(latestVersion, currentVersion) > 0,
    lastChecked,
    latestPublishedAt,
    latestNotes,
    latestUrl,
    lastError,
    enabled,
    runtime: getDeploymentRuntime(),
  };
}

/** Result of a `checkForUpdate` invocation. */
export interface CheckResult {
  /** Error message if the network call failed. Cache is left in place. */
  error?: string;
  /** True if we actually went out to the network. False = used cache. */
  performed: boolean;
  /** Reason we didn't run (cache fresh / disabled / throttled / error). */
  skipReason?: "disabled" | "cache_fresh" | "force_throttled" | "in_progress";
  /** Status snapshot after the check (or unchanged cache). */
  status: UpdateStatus;
}

// In-process guard against two callers racing the same check.
let inflight: Promise<CheckResult> | null = null;

/**
 * Performs an update check, honouring the cache TTL unless `force` is set.
 * The DB is updated in place. Force throttling: even with `force: true`
 * we won't hit the network if the last forced check was <5 min ago.
 */
export async function checkForUpdate(
  options: { force?: boolean } = {}
): Promise<CheckResult> {
  const status0 = getCachedUpdateStatus();

  if (!status0.enabled) {
    return { performed: false, skipReason: "disabled", status: status0 };
  }

  const now = Date.now();
  const cacheAge = now - status0.lastChecked;
  const cacheFresh = status0.lastChecked > 0 && cacheAge < CACHE_TTL_MS;

  if (!options.force && cacheFresh) {
    return { performed: false, skipReason: "cache_fresh", status: status0 };
  }

  if (options.force) {
    const lastForced =
      Number.parseInt(getSetting(KEY_LAST_FORCED, "0"), 10) || 0;
    if (now - lastForced < FORCE_REFRESH_MIN_GAP_MS) {
      return {
        performed: false,
        skipReason: "force_throttled",
        status: status0,
      };
    }
    setSetting(KEY_LAST_FORCED, String(now));
  }

  // De-dup concurrent checks — both callers share the same promise.
  if (inflight) {
    return inflight.then((r) => ({ ...r, skipReason: "in_progress" as const }));
  }

  inflight = (async (): Promise<CheckResult> => {
    try {
      const release = await fetchLatestRelease();
      writeReleaseToSettings(release, now);
      const status = getCachedUpdateStatus();
      return { performed: true, status };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Persist the error so the UI can surface it; don't clobber the cache.
      setSetting(KEY_LAST_ERROR, msg.slice(0, 500));
      const status = getCachedUpdateStatus();
      return { performed: true, status, error: msg };
    } finally {
      inflight = null;
    }
  })();

  return inflight;
}

// ─── Implementation ─────────────────────────────────────────────────────

interface GitHubReleaseResponse {
  body?: string;
  draft?: boolean;
  html_url?: string;
  name?: string;
  prerelease?: boolean;
  published_at?: string;
  tag_name?: string;
}

async function fetchLatestRelease(): Promise<GitHubReleaseResponse> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(RELEASES_URL, {
      headers: {
        // X-GitHub-Api-Version pins the response shape.
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": USER_AGENT,
      },
      signal: ctrl.signal,
      cache: "no-store",
    });
    if (res.status === 404) {
      // No releases published yet — treat as "no update available".
      return {};
    }
    if (!res.ok) {
      throw new Error(
        `GitHub API ${res.status}: ${await res.text().catch(() => "")}`
      );
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function writeReleaseToSettings(
  release: GitHubReleaseResponse,
  now: number
): void {
  // Defensive: GitHub already excludes drafts/prereleases from /releases/latest.
  if (release.draft || release.prerelease) {
    return;
  }

  const tag = (release.tag_name ?? "").trim();
  if (!tag) {
    // Empty release — mark as checked, leave the cached version untouched.
    setSetting(KEY_LAST_CHECKED, String(now));
    setSetting(KEY_LAST_ERROR, "");
    return;
  }

  const version = stripVPrefix(tag);
  if (!isValidSemver(version)) {
    throw new Error(`Latest release tag is not valid semver: ${tag}`);
  }

  setSetting(KEY_LATEST_VERSION, version);
  setSetting(
    KEY_LATEST_NOTES,
    (release.body ?? "").slice(0, NOTES_PREVIEW_MAX_CHARS)
  );
  setSetting(KEY_LATEST_URL, release.html_url ?? "");
  setSetting(KEY_LATEST_PUBDATE, release.published_at ?? "");
  setSetting(KEY_LAST_CHECKED, String(now));
  setSetting(KEY_LAST_ERROR, "");
}

// ─── Version helpers ────────────────────────────────────────────────────

function stripVPrefix(tag: string): string {
  return tag.replace(/^v/i, "");
}

/** Permissive semver check: `MAJOR.MINOR.PATCH` with optional pre-release/build. */
function isValidSemver(v: string): boolean {
  return /^\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(v);
}

// `compareVersions` lives in lib/semver-compare.ts so client-side
// modules (e.g. lib/tauri-updater.ts) can call it without pulling
// this file's server-only transitive dependencies (notifications →
// feature-flags-server) into the browser bundle. Re-exported here
// so existing imports of `compareVersions` from `lib/update-check`
// keep working.
import { compareVersions } from "./semver-compare";

export { compareVersions };

// ─── Test hooks ─────────────────────────────────────────────────────────
// Exported for tests, not part of the public API.
export const __test = {
  RELEASES_URL,
  CACHE_TTL_MS,
  FORCE_REFRESH_MIN_GAP_MS,
  isValidSemver,
  stripVPrefix,
  KEYS: {
    enabled: KEY_ENABLED,
    lastChecked: KEY_LAST_CHECKED,
    latestVersion: KEY_LATEST_VERSION,
    latestNotes: KEY_LATEST_NOTES,
    latestUrl: KEY_LATEST_URL,
    latestPubdate: KEY_LATEST_PUBDATE,
    lastError: KEY_LAST_ERROR,
    lastForced: KEY_LAST_FORCED,
  },
};
