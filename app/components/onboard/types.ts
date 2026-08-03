/**
 * Types shared between OnboardWizard and its extracted pieces.
 *
 * Same rule as ../settings/types.ts: only things that genuinely cross the
 * boundary belong here. A piece's own local types stay in its own file.
 */

export interface AppCandidate {
  appleId: string;
  bundleId: string;
  developer: string;
  iconUrl: string;
  name: string;
  searchQuery: string;
  url: string;
}

/**
 * Shape we need for duplicate detection. /api/apps returns a superset, but
 * the wizard only cares about how to identify an already-tracked app: by
 * Apple track id (same as the candidate's appleId) for post-match detection,
 * by bundle id (catches the legacy-import duplicate where a name-search
 * import + a cfgutil bundle-ID import landed on different track IDs for
 * the same physical app), and by lowercase name for pre-match duplicate
 * warnings on Step 2.
 */

export interface TrackedApp {
  bundleId: string | null;
  developer: string;
  id: string;
  name: string;
}

/**
 * One row in the step-2 imported-apps table. Replaces the old
 * `namesText: string` + `bundleIdHints: Map` + `developerHints: Map`
 * trio with a single structured array so bundle IDs and developer
 * hints can't silently drift away from their names when the user
 * edits the list. Each row gets a stable client-side `id` so React
 * keys stay stable across renders even with duplicate names.
 *
 * `source` is a UX-facing pill: which import path produced this row.
 * Used to colour the source chip and to drive the "+ developer hint
 * present" / "+ bundle ID present" badges in the table.
 *
 * `likelyWebClip` propagates from the CSV parser so the search
 * fallback can suggest the manual-apps editor for rows that look like
 * home-screen web clips rather than App Store apps.
 */

export interface SearchResult {
  candidates: AppCandidate[];
  matchSource?: "bundle" | "name" | "manual";
  note?: string | null;
  query: string;
  searchedCountry?: string;
  sourceBundleId?: string | null;
  sourceDeveloper?: string | null;
  status?: "pending" | "matched" | "unmatched" | "skipped";
}

/**
 * Thrown when /api/search is rejected by the security gate rather than
 * failing on its own — proxy.ts returns 401 when a non-local host is
 * missing the admin token, 403 for cross-origin mutations. These are
 * deterministic per-request (every subsequent chunk fails the same way),
 * so the search loop bails out immediately and `handleSearch` surfaces a
 * distinct "API access is blocked" message instead of letting every row
 * fall through to "Not in the App Store".
 */

export interface ScrapeStatus {
  changesDetected?: boolean;
  error?: string;
  name: string;
  query?: string;
  /** How many seconds the row is expected to wait before the worker retries. */
  retryAfterMs?: number;
  /**
   * 'queued' here mirrors the server-side import_items status: Apple rate-
   * limited us mid-batch, so this row is parked for the background worker
   * to pick up later. The UI shows a "Queued for background import" pill.
   */
  status: "pending" | "scraping" | "success" | "error" | "queued";
  url: string;
}

export type PolicyPhaseStatus =
  | "pending"
  | "working"
  | "done"
  | "error"
  | "skipped";

export interface PolicyPhaseResult {
  detail?: string;
  finishedAt?: number;
  startedAt?: number;
  status: PolicyPhaseStatus;
}

export interface PolicyRegenerateStatus {
  appId: string;
  name: string;
  scrape: PolicyPhaseResult;
  summarise: PolicyPhaseResult;
}

export type PolicyRunPhase = "fetch" | "summarise" | null;
