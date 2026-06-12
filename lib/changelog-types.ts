/**
 * Pure types and constants for the changelog / change-review system.
 * No server-side imports — safe to import from Client Components.
 * Server-only DB reads/writes live in lib/changelog.ts.
 */

export interface PrivacyCategorySnapshot {
  identifier: string;
  title: string;
}

export interface PrivacyTypeSnapshot {
  categories: PrivacyCategorySnapshot[];
  identifier: string;
  title: string;
}

export interface ChangeEntry {
  /**
   * Drives the icon. `privacy-policy` for privacy-policy text changes,
   * `wayback-attempt` for historical-import Save Page Now outcomes,
   * `accessibility` for Apple's accessibility-labels shelf changes,
   * `age-rating` for App Store age-rating tier changes.
   */
  category?:
    | "privacy-label"
    | "privacy-policy"
    | "wayback-attempt"
    | "accessibility"
    | "age-rating";
  description: string;
  details?: string[];
  /**
   * Sub-classification for `privacy-policy` entries:
   *   first   — first-ever successful scrape
   *   same    — rescrape, content unchanged
   *   changed — rescrape, content differs from previous
   *   error   — fetch failed
   */
  policy_event?: "first" | "same" | "changed" | "error";
  /** For `privacy-policy` entries: the `privacy_policy_versions.id`. */
  policy_version_id?: string;
  /** For `requested_snapshot` entries: the Save Page Now URL. */
  save_now_url?: string;
  /** For `wayback-attempt` entries: the calendar quarter target (epoch ms). */
  target_date?: number;
  type: "added" | "removed" | "modified" | "policy" | "wayback";
  /**
   * Sub-classification for `wayback-attempt` entries:
   *   requested_snapshot — Save Page Now accepted the request
   *   no_capture         — archive.org has no capture near the target quarter
   *   save_now_failed    — Save-Now was attempted but failed (reason in `description`)
   */
  wayback_event?: "requested_snapshot" | "no_capture" | "save_now_failed";
}

/**
 * One row on the Change History timeline. Interleaves `privacy_snapshots`
 * with `change_review_actions` rows so the timeline shows when/how the user
 * acknowledged change sets. The `kind` discriminator drives client rendering.
 */
export interface SnapshotChangelogRow {
  /** App Store version string at capture time, e.g. "7.22.0". Null on legacy rows. */
  app_version?: string | null;
  /** Epoch ms of `currentVersionReleaseDate` at capture time. */
  app_version_updated_at?: number | null;
  changes_detected: number;
  changes_summary: ChangeEntry[];
  id: string;
  kind: "snapshot";
  /**
   * True on `source: 'wayback'` rows whose snapshot is byte-identical to an
   * adjacent `source: 'live'` row. Drives the "Matches live sync" tag.
   */
  matches_live_sync?: boolean;
  scraped_at: number;
  /**
   * Raw snapshot_json string. Used server-side to detect wayback rows whose
   * content exactly matches an adjacent live row (see `matches_live_sync`).
   * Null on very old rows. Not for rendering — prefer `changes_summary`.
   */
  snapshot_json?: string | null;
  /**
   * Provenance:
   *   'live'    — real-time scrape of apps.apple.com (default)
   *   'wayback' — back-dated snapshot reconstructed from a Wayback capture;
   *               does not contribute to `apps.changeCount`.
   */
  source?: "live" | "wayback";
  /**
   * What caused the scrape. Normalised server-side; legacy NULL rows get an
   * inferred label.
   *   'scheduled' — background 30-minute sync tick
   *   'manual'    — user clicked "Sync now"
   *   'import'    — initial scrape when an app was added
   *   'wayback'   — back-filled from the Internet Archive
   *   'sample'    — dev-only seed-sample-data endpoint
   */
  triggered_by?:
    | "scheduled"
    | "manual"
    | "import"
    | "wayback"
    | "sample"
    | null;
  /** For `source: 'wayback'` rows: the `https://web.archive.org/web/…` capture URL. */
  wayback_snapshot_url?: string | null;
}

export interface ReviewChangelogRow {
  action: ReviewAction;
  covered_count: number;
  /**
   * IDs of the privacy_snapshots rows pending when this action was recorded,
   * newest-first. Empty/omitted on legacy rows that predate the column.
   */
  covered_snapshot_ids?: string[];
  /** The change_review_actions.id — prefixed so it can't collide with a snapshot uuid. */
  id: string;
  kind: "review";
  note: string | null;
  /** Populated from change_review_actions.acted_at for sort/formatting parity. */
  scraped_at: number;
  /** For `snoozed` rows only; null for everything else. */
  snooze_until: number | null;
}

export type ChangelogRow = SnapshotChangelogRow | ReviewChangelogRow;

/**
 * A single sync event that detected changes the user has not yet acknowledged.
 * Events are newest first.
 */
export interface UnacknowledgedChangeEvent {
  changes: ChangeEntry[];
  id: string;
  scraped_at: number;
}

export interface UnacknowledgedChanges {
  /** Count of added entries across all events. */
  addedCount: number;
  /** Sync events with detected changes since `since`, newest first. */
  events: UnacknowledgedChangeEvent[];
  /** Count of removed entries across all events. */
  removedCount: number;
  /** Timestamp of the last acknowledgement (0 if never acknowledged). */
  since: number;
  /**
   * Snooze bookkeeping. `snoozedUntil > Date.now()` collapses the review
   * panel into a "Snoozed until …" state. 0 when not snoozed or elapsed.
   */
  snoozedUntil: number;
  /** Flat count of ChangeEntry items across all events — what the UI surfaces. */
  totalCount: number;
}

/**
 * Review-panel actions. Names match the `action` column on
 * `change_review_actions` and the API body keys.
 *   reviewed   — user acknowledged; clears the badge
 *   dismissed  — user explicitly ignored; clears the badge, recorded distinctly
 *   snoozed    — hide the review panel for N days
 *   unsnoozed  — user clicked "Resume reminders now"
 */
export type ReviewAction = "reviewed" | "dismissed" | "snoozed" | "unsnoozed";

/** Preset snooze durations offered by the UI. */
export const SNOOZE_DAYS_OPTIONS = [1, 7, 30] as const;
export type SnoozeDays = (typeof SNOOZE_DAYS_OPTIONS)[number];

export interface ReviewActionRecord {
  acted_at: number;
  action: ReviewAction;
  app_id: string;
  covered_count: number;
  /** Snapshot ids pending at the moment of the action. Empty on legacy rows. */
  covered_snapshot_ids?: string[];
  id: string;
  note: string | null;
  /**
   * Snapshot of the apps-row columns the action mutated, captured BEFORE
   * the write. Returned only on the action's response (not persisted) so
   * the client can stash it for the acknowledge/undo route.
   */
  pre_state?: {
    changeCount: number;
    changesAcknowledgedAt: number;
    changesSnoozedUntil: number;
  };
  /** Only set for `snoozed` rows. */
  snooze_until: number | null;
}
