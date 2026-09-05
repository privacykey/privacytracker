export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getAccessibilityProfile } from "@/lib/accessibility-profile-server";
import { isValidAgeBand } from "@/lib/age-rating";
import { normalizeAiProvider } from "@/lib/ai-config";
import {
  getChangelog,
  getUnacknowledgedChanges,
  type UnacknowledgedChanges,
} from "@/lib/changelog";
import { getActiveFocus } from "@/lib/feature-flag-storage";
import { getAppImportProvenance } from "@/lib/imports";
import { getRecentPolicyChange } from "@/lib/policy-versions";
import { getPrivacyProfile } from "@/lib/privacy-profile-server";
import { getSetting } from "@/lib/scheduler";
import { getAppWithPrivacy } from "@/lib/scraper";
import { checkRateLimit, rateLimitKeyForRequest } from "@/lib/security";

/**
 * GET /api/apps/[id]/detail — everything the app-detail page renders, in
 * one payload.
 *
 * Added for Rust-core Phase 0. `/apps/[id]` did seventeen server reads;
 * three of them (unacknowledged changes, the recent-policy-change hint,
 * import provenance) had no route at all and the rest were scattered
 * across six. The page also has cross-read invariants that two client
 * fetches could not keep:
 *
 *   - `policyDiffAlertDays` is parsed here with the page's `>= 0` guard
 *     (0 is meaningful — it disables the banner) and `recentPolicyChange`
 *     is computed from that SAME number in the same request, so the
 *     banner can never disagree with the window it deep-links into.
 *   - `childAgeBand` is validated with isValidAgeBand before it leaves
 *     the server; an unknown band reaching the client would hit
 *     next-intl as a missing key inside the hero.
 *
 * Failure shape matches the page it replaces: only a missing/unreadable
 * app is a 404. Every other read degrades independently to the default
 * the page used, so a schema drift in one table can't blank the page.
 *
 * Do NOT reach for /api/changelog?appId= for the timeline — it returns
 * per-entry UniversalChangelog rows, not the ChangelogRow[] snapshot
 * rows ChangelogTimeline consumes. getChangelog(id) is the right read.
 */

const ID_RE = /^\d{1,20}$/;

const EMPTY_UNACKNOWLEDGED: UnacknowledgedChanges = {
  since: 0,
  events: [],
  totalCount: 0,
  addedCount: 0,
  removedCount: 0,
  snoozedUntil: 0,
};

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const rate = checkRateLimit({
    key: rateLimitKeyForRequest(request, "apps.detail"),
    limit: 120,
    windowMs: 60_000,
  });
  if (!rate.allowed) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const { id } = await params;
  if (!ID_RE.test(id)) {
    return NextResponse.json({ error: "Invalid app id" }, { status: 400 });
  }

  const safe = <T>(fn: () => T, fallback: T, label: string): T => {
    try {
      return fn();
    } catch (error) {
      console.warn(`[apps/${id}/detail] ${label} failed:`, error);
      return fallback;
    }
  };

  // The app row is the one read whose failure IS a 404 — same as the
  // page, where getAppWithPrivacy throwing left `app` null.
  const app = safe(
    () => getAppWithPrivacy(id) as any,
    null,
    "getAppWithPrivacy"
  );
  if (!app) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Parsed once, guarded once, used for both fields below.
  let policyDiffAlertDays = 90;
  const rawDays = Number.parseInt(
    safe(() => getSetting("policy_diff_alert_days", "90"), "90", "alert days"),
    10
  );
  if (Number.isFinite(rawDays) && rawDays >= 0) {
    policyDiffAlertDays = rawDays;
  }

  const rawBand = safe(
    () => getSetting("guardian_child_age_band", ""),
    "",
    "child age band"
  );

  return NextResponse.json({
    app,
    changelog: safe(() => getChangelog(id), [], "getChangelog"),
    unacknowledged: safe(
      () => getUnacknowledgedChanges(id),
      EMPTY_UNACKNOWLEDGED,
      "getUnacknowledgedChanges"
    ),
    recentPolicyChange: safe(
      () => getRecentPolicyChange(app.id, policyDiffAlertDays),
      null,
      "getRecentPolicyChange"
    ),
    importProvenance: safe(
      () => getAppImportProvenance(app.id),
      null,
      "getAppImportProvenance"
    ),
    aiProvider: safe(
      () => normalizeAiProvider(getSetting("ai_provider", "disabled")),
      "disabled",
      "ai provider"
    ),
    policyDiffAlertDays,
    privacyProfile: safe(() => getPrivacyProfile(), null, "getPrivacyProfile"),
    a11yProfile: safe(
      () => getAccessibilityProfile(),
      null,
      "getAccessibilityProfile"
    ),
    waybackShowImportedDefault: safe(
      () => getSetting("wayback_show_imported", "true") !== "false",
      true,
      "wayback_show_imported"
    ),
    trackAccessibility: safe(
      () => getSetting("track_accessibility_labels", "true") !== "false",
      true,
      "track_accessibility_labels"
    ),
    childAgeBand: isValidAgeBand(rawBand) ? rawBand : null,
    audience: safe(() => getActiveFocus().audience, "self", "getActiveFocus"),
  });
}
