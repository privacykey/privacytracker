/**
 * Shortlist of candidate alternative apps per tracked "source app".
 *
 * The user flow this supports:
 *   1. User opens Compare view with Slot A = a tracked app they currently use
 *      (e.g. Uber).
 *   2. In Slot B they browse App Store candidates (e.g. Didi, Bolt, Lyft).
 *   3. When a candidate looks worth remembering as an alternative, the user
 *      clicks "+ Shortlist". We capture the candidate's store metadata here
 *      without committing to track it.
 *   4. Later on the /dashboard/shortlist page the user can preview each
 *      candidate (fresh scrape via compare-scrape), remove entries, and
 *      export a Markdown or print-friendly list with direct App Store links.
 *
 * Data-layer design:
 *   - All reads/writes are synchronous (better-sqlite3).
 *   - Multi-step writes get wrapped in db.transaction(() => {…})() to mirror
 *     the rest of the codebase.
 *   - The unique index on (source_app_id, candidate_apple_id) does the
 *     dedupe work, so addShortlistEntry uses INSERT … ON CONFLICT UPDATE
 *     to make the operation idempotent and also let callers refresh the
 *     captured metadata / note when the user re-shortlists.
 */
import crypto from 'crypto';
import db from './db';
import type {
  ShortlistEntry,
  ShortlistGroup,
  ShortlistMode,
} from './shortlist-types';
import type {
  AppProfileBadge,
  AppProfileFootprint,
  PrivacyProfile,
} from './privacy-profile';
import { computeProfileMismatch, summariseBadge } from './privacy-profile';
import {
  buildAllFootprints,
  buildAppFootprint,
  getPrivacyProfile,
} from './privacy-profile-server';
import { buildSnapshot } from './changelog';

// Re-export so existing server callers can keep importing from ./shortlist
// directly. Client components should import from ./shortlist-types instead,
// which is free of better-sqlite3 / fs / crypto dependencies.
export type { ShortlistEntry, ShortlistGroup, ShortlistMode };

/** All permitted ShortlistMode values — keep in sync with the type union. */
const VALID_MODES: ShortlistMode[] = ['privacy', 'accessibility'];

/**
 * Normalise a raw mode string (stored as comma-separated in SQLite) into a
 * deduplicated, canonically-ordered ShortlistMode[]. Unknown tokens are
 * dropped so schema drift or a hand-edited DB never crashes the UI. If
 * nothing survives, we fall back to ['privacy'] — the historical default
 * and the safer interpretation ("at least this was shortlisted for *some*
 * reason") vs an empty list.
 */
function parseModes(raw: string | null | undefined): ShortlistMode[] {
  if (!raw) return ['privacy'];
  const tokens = raw
    .split(',')
    .map(t => t.trim().toLowerCase())
    .filter((t): t is ShortlistMode => (VALID_MODES as string[]).includes(t));
  if (tokens.length === 0) return ['privacy'];
  // Canonical order: privacy first, then accessibility, so '[privacy,accessibility]'
  // always serialises the same way — important for equality comparisons
  // and for making the DB contents readable when debugging.
  return VALID_MODES.filter(m => tokens.includes(m));
}

/** Inverse of parseModes — used when writing to the DB. Caller should have
 *  already run the modes through the normaliser. */
function serialiseModes(modes: ShortlistMode[]): string {
  if (modes.length === 0) return 'privacy';
  return VALID_MODES.filter(m => modes.includes(m)).join(',');
}

/**
 * Merge the new mode(s) into an existing stored list. Returns the merged
 * list in canonical order. Used by the INSERT … ON CONFLICT path so a user
 * who shortlists the same candidate from both compare views ends up with
 * *both* badges attached rather than clobbering the earlier one.
 */
function mergeModes(
  existing: ShortlistMode[],
  incoming: ShortlistMode[],
): ShortlistMode[] {
  const set = new Set<ShortlistMode>([...existing, ...incoming]);
  return VALID_MODES.filter(m => set.has(m));
}

/**
 * Resolve the per-candidate profile badge, reusing a pre-built footprint
 * map so a bulk call (e.g. listShortlistGroups → dozens of entries) doesn't
 * hammer the DB with one query per row.
 *
 * Returns `null` when:
 *   - no profile is set,
 *   - the candidate isn't a tracked app (so we have no footprint for it), OR
 *   - the saved profile is empty (`profileActive === false`).
 * Any of those three should make the UI hide the pill entirely.
 */
function resolveCandidateBadge(
  candidateAppleId: string,
  candidateIsTracked: boolean,
  profile: PrivacyProfile | null,
  footprints: Map<string, AppProfileFootprint>,
): AppProfileBadge | null {
  if (!profile || !candidateIsTracked) return null;
  const footprint = footprints.get(candidateAppleId);
  if (!footprint) return null;
  const result = computeProfileMismatch(profile, footprint);
  if (!result.profileActive) return null;
  return summariseBadge(result);
}

export interface AddShortlistEntryInput {
  sourceAppId: string;
  candidateAppleId: string;
  candidateName: string;
  candidateDeveloper?: string;
  candidateIconUrl?: string;
  candidateStoreUrl: string;
  candidateBundleId?: string;
  note?: string;
  /**
   * Which compare mode(s) the user was in when they saved this candidate.
   * Optional — defaults to ['privacy'] when omitted to preserve the
   * historical behaviour. When a row already exists for (source, candidate)
   * we merge this list into the stored modes rather than overwrite, so
   * re-shortlisting from the other tab adds a badge rather than flipping it.
   */
  modes?: ShortlistMode[];
}

interface ShortlistRow {
  id: string;
  source_app_id: string;
  candidate_apple_id: string;
  candidate_name: string;
  candidate_developer: string | null;
  candidate_icon_url: string | null;
  candidate_store_url: string;
  candidate_bundle_id: string | null;
  note: string | null;
  added_at: number;
  candidate_is_tracked: number;
  mode: string | null;
  /**
   * Phase 2 — price + IAP joined from the candidate's apps row when
   * tracked. Null on every column when the candidate isn't tracked
   * yet (the LEFT JOIN returns no apps row to read from). UI hides
   * the price chip in that case.
   */
  candidate_price_formatted: string | null;
  candidate_price_currency: string | null;
  candidate_has_iap: number | null;
}

function rowToEntry(
  row: ShortlistRow,
  profile: PrivacyProfile | null,
  footprints: Map<string, AppProfileFootprint>,
): ShortlistEntry {
  const candidateIsTracked = row.candidate_is_tracked === 1;
  return {
    id: row.id,
    sourceAppId: row.source_app_id,
    candidateAppleId: row.candidate_apple_id,
    candidateName: row.candidate_name,
    candidateDeveloper: row.candidate_developer ?? '',
    candidateIconUrl: row.candidate_icon_url ?? '',
    candidateStoreUrl: row.candidate_store_url,
    candidateBundleId: row.candidate_bundle_id ?? '',
    note: row.note ?? '',
    addedAt: row.added_at,
    candidateIsTracked,
    modes: parseModes(row.mode),
    profileBadge: resolveCandidateBadge(
      row.candidate_apple_id,
      candidateIsTracked,
      profile,
      footprints,
    ),
    candidatePriceFormatted: row.candidate_price_formatted,
    candidatePriceCurrency: row.candidate_price_currency,
    candidateHasIap: row.candidate_has_iap,
  };
}

/**
 * Add (or refresh) a shortlist entry. Idempotent: if the same source +
 * candidate pair already exists, the stored metadata and note are updated
 * to the latest values and added_at is preserved. Returns the persisted row.
 */
export function addShortlistEntry(input: AddShortlistEntryInput): ShortlistEntry {
  const sourceAppId = input.sourceAppId.trim();
  const candidateAppleId = input.candidateAppleId.trim();
  const candidateName = input.candidateName.trim();
  const candidateStoreUrl = input.candidateStoreUrl.trim();

  if (!sourceAppId) throw new Error('sourceAppId is required');
  if (!candidateAppleId) throw new Error('candidateAppleId is required');
  if (!candidateName) throw new Error('candidateName is required');
  if (!candidateStoreUrl) throw new Error('candidateStoreUrl is required');

  // Defensive: the source app must exist — otherwise the CASCADE contract is
  // meaningless and the shortlist page will render an orphan group. We
  // surface a clear error rather than silently inserting.
  const sourceExists = db
    .prepare('SELECT 1 FROM apps WHERE id = ? LIMIT 1')
    .get(sourceAppId) as { 1: number } | undefined;
  if (!sourceExists) {
    throw new Error(`Source app not found: ${sourceAppId}`);
  }

  if (sourceAppId === candidateAppleId) {
    throw new Error('Candidate cannot be the same app as the source');
  }

  const now = Date.now();
  const id = crypto.randomUUID();
  const developer = (input.candidateDeveloper ?? '').trim();
  const iconUrl = (input.candidateIconUrl ?? '').trim();
  const bundleId = (input.candidateBundleId ?? '').trim();
  const note = (input.note ?? '').trim();
  // Parse incoming modes through the normaliser so callers can pass sloppy
  // input (e.g. a stray capital, or a mode we don't support yet) without
  // poisoning the stored list.
  const incomingModes = parseModes(
    (input.modes && input.modes.length ? input.modes.join(',') : 'privacy'),
  );

  // SQLite's ON CONFLICT syntax can't run arbitrary JS to merge comma-
  // separated lists, so we do the read/merge/write inside a transaction:
  //   - pre-existing row → merge the stored modes with the incoming ones
  //     (two-way so re-shortlisting from the Accessibility tab adds a badge
  //     to a row originally saved under Privacy, and vice versa) and update
  //     the captured metadata. `added_at` stays untouched so the group
  //     ordering doesn't jump around.
  //   - no row → fresh INSERT with the incoming modes as-is.
  const writeTx = db.transaction(() => {
    const existing = db
      .prepare(
        'SELECT id, mode FROM shortlist_entries WHERE source_app_id = ? AND candidate_apple_id = ?',
      )
      .get(sourceAppId, candidateAppleId) as { id: string; mode: string | null } | undefined;

    if (existing) {
      const mergedModes = mergeModes(parseModes(existing.mode), incomingModes);
      db.prepare(
        `UPDATE shortlist_entries SET
           candidate_name      = ?,
           candidate_developer = ?,
           candidate_icon_url  = ?,
           candidate_store_url = ?,
           candidate_bundle_id = ?,
           note                = ?,
           mode                = ?
         WHERE id = ?`,
      ).run(
        candidateName,
        developer || null,
        iconUrl || null,
        candidateStoreUrl,
        bundleId || null,
        note || null,
        serialiseModes(mergedModes),
        existing.id,
      );
    } else {
      db.prepare(
        `INSERT INTO shortlist_entries (
           id, source_app_id, candidate_apple_id, candidate_name,
           candidate_developer, candidate_icon_url, candidate_store_url,
           candidate_bundle_id, note, added_at, mode
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id, sourceAppId, candidateAppleId, candidateName,
        developer || null, iconUrl || null, candidateStoreUrl,
        bundleId || null, note || null, now,
        serialiseModes(incomingModes),
      );
    }
  });
  writeTx();

  const row = db
    .prepare(
      `SELECT s.*,
              CASE WHEN t.id IS NULL THEN 0 ELSE 1 END AS candidate_is_tracked,
              t.priceFormatted AS candidate_price_formatted,
              t.priceCurrency  AS candidate_price_currency,
              t.hasIap         AS candidate_has_iap
         FROM shortlist_entries s
         LEFT JOIN apps t ON t.id = s.candidate_apple_id
        WHERE s.source_app_id = ? AND s.candidate_apple_id = ?`,
    )
    .get(sourceAppId, candidateAppleId) as ShortlistRow;
  // Only the one candidate in play — single-app footprint fetch is cheaper
  // than a full library scan for this one-shot insert path.
  const profile = getPrivacyProfile();
  const footprints = new Map<string, AppProfileFootprint>();
  if (profile && row.candidate_is_tracked === 1) {
    footprints.set(row.candidate_apple_id, buildAppFootprint(row.candidate_apple_id));
  }
  return rowToEntry(row, profile, footprints);
}

/**
 * Remove a shortlist entry by id. Returns true if a row was deleted.
 */
export function removeShortlistEntry(id: string): boolean {
  const info = db.prepare('DELETE FROM shortlist_entries WHERE id = ?').run(id);
  return info.changes > 0;
}

/**
 * Remove the shortlist entry for a specific (source_app_id, candidate) pair.
 * Handy for the "untoggle" button when the user only has the pair reference.
 */
export function removeShortlistEntryByPair(sourceAppId: string, candidateAppleId: string): boolean {
  const info = db
    .prepare('DELETE FROM shortlist_entries WHERE source_app_id = ? AND candidate_apple_id = ?')
    .run(sourceAppId, candidateAppleId);
  return info.changes > 0;
}

/**
 * Wipe every shortlist entry. Returns the number of rows removed so callers
 * can show a confirmation ("Cleared 12 alternatives") without re-listing.
 * Used by the "Reset shortlist" footer on /dashboard/shortlist.
 */
export function removeAllShortlistEntries(): number {
  const info = db.prepare('DELETE FROM shortlist_entries').run();
  return info.changes;
}

/**
 * All shortlist entries grouped by source app, ordered by most-recently-used
 * source first, and within each group most-recently-added first. Only
 * returns groups that have at least one entry (ON DELETE CASCADE guarantees
 * orphan rows can't exist, but the join will return an empty group if an
 * app row with zero entries sneaks in, so we filter those out here too).
 */
export function listShortlistGroups(): ShortlistGroup[] {
  const rows = db
    .prepare(
      `SELECT s.*,
              CASE WHEN t.id IS NULL THEN 0 ELSE 1 END AS candidate_is_tracked,
              t.priceFormatted AS candidate_price_formatted,
              t.priceCurrency  AS candidate_price_currency,
              t.hasIap         AS candidate_has_iap,
              a.name AS source_name,
              a.iconUrl AS source_icon,
              a.developer AS source_developer,
              a.priceFormatted AS source_price_formatted,
              a.priceCurrency  AS source_price_currency,
              a.hasIap         AS source_has_iap
         FROM shortlist_entries s
         JOIN apps a ON a.id = s.source_app_id
         LEFT JOIN apps t ON t.id = s.candidate_apple_id
        ORDER BY s.added_at DESC`,
    )
    .all() as (ShortlistRow & {
      source_name: string;
      source_icon: string | null;
      source_developer: string | null;
      source_price_formatted: string | null;
      source_price_currency: string | null;
      source_has_iap: number | null;
    })[];

  // One SQL scan for every tracked app's footprint — cheaper than N one-shot
  // queries when the shortlist has multiple tracked candidates (the common
  // case, since the user mostly shortlists apps they've added to track).
  const profile = getPrivacyProfile();
  const footprints = profile ? buildAllFootprints() : new Map<string, AppProfileFootprint>();

  const byApp = new Map<string, ShortlistGroup>();
  for (const row of rows) {
    let group = byApp.get(row.source_app_id);
    if (!group) {
      // Build the source app's current privacy snapshot once per group so
      // the detailed shortlist view can render "what YOUR app collects"
      // alongside each alternative. buildSnapshot is a flat DB read (two
      // statements per app) — cheap enough to do inline; callers that
      // don't care about the field just ignore it. Left undefined if the
      // snapshot is empty (scrape pending, or Apple lists no labels) so
      // the client can decide between "no data yet" and "render block".
      let privacyTypes: ShortlistGroup['sourceApp']['privacyTypes'];
      try {
        const snap = buildSnapshot(row.source_app_id);
        if (snap.length > 0) privacyTypes = snap;
      } catch {
        /* DB hiccup — we'd rather render the group without the block
           than fail the whole list. */
      }
      // Profile mismatch tells the user *why* they're looking for
      // alternatives in the first place: the source app collects more
      // than their saved profile allows. Only populated when a profile
      // is active AND we have at least one mismatched category — the UI
      // hides the banner otherwise (no banner if nothing's actually
      // wrong). Re-uses the footprints map built above so we don't
      // re-query the DB per group.
      let profileMismatch: ShortlistGroup['sourceApp']['profileMismatch'];
      if (profile) {
        const fp = footprints.get(row.source_app_id);
        if (fp) {
          const result = computeProfileMismatch(profile, fp);
          if (result.profileActive && result.count > 0) {
            profileMismatch = result;
          }
        }
      }
      group = {
        sourceApp: {
          id: row.source_app_id,
          name: row.source_name,
          iconUrl: row.source_icon ?? '',
          developer: row.source_developer ?? '',
          privacyTypes,
          profileMismatch,
          priceFormatted: row.source_price_formatted,
          priceCurrency: row.source_price_currency,
          hasIap: row.source_has_iap,
        },
        entries: [],
      };
      byApp.set(row.source_app_id, group);
    }
    group.entries.push(rowToEntry(row, profile, footprints));
  }

  // Groups come out in most-recently-touched-first order because the inner
  // rows are already sorted added_at DESC and we build the Map in that
  // insertion order. Map iteration preserves insertion order in JS.
  return [...byApp.values()];
}

/**
 * Return every (sourceAppId, candidateAppleId) pair on the shortlist.
 * Small payload designed for the Compare view to render "already shortlisted"
 * state on its candidate rows without fetching the full groups.
 */
export function listShortlistPairs(): { sourceAppId: string; candidateAppleId: string }[] {
  const rows = db
    .prepare(
      'SELECT source_app_id, candidate_apple_id FROM shortlist_entries',
    )
    .all() as { source_app_id: string; candidate_apple_id: string }[];
  return rows.map(r => ({
    sourceAppId: r.source_app_id,
    candidateAppleId: r.candidate_apple_id,
  }));
}

/**
 * Total count — cheap sanity check for the nav badge.
 */
export function countShortlistEntries(): number {
  const row = db
    .prepare('SELECT COUNT(*) AS n FROM shortlist_entries')
    .get() as { n: number };
  return row.n;
}

/**
 * Fetch a single entry. Used by the preview drawer to hydrate its context.
 */
export function getShortlistEntry(id: string): ShortlistEntry | null {
  const row = db
    .prepare(
      `SELECT s.*,
              CASE WHEN t.id IS NULL THEN 0 ELSE 1 END AS candidate_is_tracked
         FROM shortlist_entries s
         LEFT JOIN apps t ON t.id = s.candidate_apple_id
        WHERE s.id = ?`,
    )
    .get(id) as ShortlistRow | undefined;
  if (!row) return null;
  const profile = getPrivacyProfile();
  const footprints = new Map<string, AppProfileFootprint>();
  if (profile && row.candidate_is_tracked === 1) {
    footprints.set(row.candidate_apple_id, buildAppFootprint(row.candidate_apple_id));
  }
  return rowToEntry(row, profile, footprints);
}

/**
 * Render the full shortlist as a Markdown document suitable for download or
 * copy-paste into a notes app. Groups by source app, one bullet per entry
 * linking out to the App Store.
 */
export function exportShortlistMarkdown(): string {
  const groups = listShortlistGroups();
  if (groups.length === 0) {
    return '# App alternatives shortlist\n\n_No alternatives shortlisted yet._\n';
  }

  const lines: string[] = [];
  lines.push('# App alternatives shortlist');
  lines.push('');
  lines.push(`_Exported ${new Date().toISOString().split('T')[0]} from privacytracker._`);
  lines.push('');

  for (const group of groups) {
    const dev = group.sourceApp.developer ? ` · ${group.sourceApp.developer}` : '';
    lines.push(`## Alternatives to ${group.sourceApp.name}${dev}`);
    lines.push('');
    for (const entry of group.entries) {
      const devSuffix = entry.candidateDeveloper ? ` — ${entry.candidateDeveloper}` : '';
      const trackedSuffix = entry.candidateIsTracked ? ' _(tracked)_' : '';
      // Surface which comparison lens(es) the user saved this candidate
      // under so a printed/exported shortlist carries the reason with it.
      // Only emitted when the row carries a non-default mode set — a plain
      // 'privacy' entry (the overwhelming majority of legacy rows) stays
      // unadorned so the export reads the same as it always did.
      const modes = entry.modes ?? ['privacy'];
      const isDefaultPrivacyOnly = modes.length === 1 && modes[0] === 'privacy';
      const modeSuffix = isDefaultPrivacyOnly
        ? ''
        : ` _(saved for ${modes.map(m => m === 'accessibility' ? 'accessibility' : 'privacy').join(' + ')})_`;
      lines.push(`- [${entry.candidateName}](${entry.candidateStoreUrl})${devSuffix}${trackedSuffix}${modeSuffix}`);
      if (entry.note) {
        lines.push(`  - ${entry.note}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}
