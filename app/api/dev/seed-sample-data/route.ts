/**
 * /api/dev/seed-sample-data — POST seeds the DB with the current top 10
 * apps from the App Store (default region AU; falls back to the
 * `app_country` setting if one is configured) so devs spinning up a
 * fresh DB have realistic data to play with end-to-end.
 *
 * Each app is run through the existing `fetchAndParseApp` pipeline so
 * the privacy + accessibility + policy summaries are real, not canned.
 * After the live snapshot lands, we synthesise 1–2 back-dated snapshots
 * per app (60 + 30 days ago, with progressively trimmed categories) so
 * the changelog/timeline UI has visible history to render.
 *
 * Idempotent — apps already tracked are skipped, so re-running just
 * tops up whatever's missing without duplicating rows. Apple's iTunes
 * Search caps callers at ~20 req/min; if we're throttled mid-batch we
 * stop cleanly and report the partial result instead of erroring.
 *
 * Query params:
 *   - `country=<iso2>` — override the region just for this call
 *   - `source=canned`  — fall back to the legacy SAMPLE_APPS canned set
 *                        (offline / rate-limit recovery)
 *   - `limit=N`        — cap the number of apps (default 10, max 25)
 */

import crypto from "node:crypto";
import { NextResponse } from "next/server";
import { recordActivity } from "@/lib/activity";
import {
  type MutationGuardContext,
  requireMutationGuard,
} from "@/lib/api-guards";
import {
  buildSnapshot,
  diffSnapshots,
  type PrivacyTypeSnapshot,
  saveSnapshot,
} from "@/lib/changelog";
import db from "@/lib/db";
import { CATEGORY_META } from "@/lib/privacy-meta";
import { normalizeCountry } from "@/lib/region";
import {
  SAMPLE_APPS,
  type SampleApp,
  type SampleAppPrivacyType,
  type SampleHistoryStep,
} from "@/lib/sample-apps";
import { getSetting } from "@/lib/scheduler";
import { AppleRateLimitError, fetchAndParseApp } from "@/lib/scraper";
import { recordAudit, safeFetch } from "@/lib/security";

export const dynamic = "force-dynamic";

// Default region when no `app_country` setting is configured. Per the
// dev request — Australia is the most useful default for the local
// dev/test loop because the team is AU-based, so the App Store data
// matches what they'd see opening a real device.
const DEFAULT_DEV_REGION = "au";

// Hard ceiling on how many apps the seed can write in one call. Each
// app is one full live scrape (HTML + privacy + a11y + optional policy
// summary), so unbounded values would chew through Apple's rate limit
// in a hurry.
const SEED_MAX_LIMIT = 25;
const SEED_DEFAULT_LIMIT = 10;

// Polite gap between live scrapes so we don't trip Apple's per-IP
// throttle. iTunes Search rate-limits at roughly 20 req/min; the App
// Store HTML side is more forgiving, but a small spacer keeps us well
// under any plausible cap.
const PER_APP_DELAY_MS = 250;

interface RssEntry {
  // The legacy /rss/topfreeapplications/limit=N/json shape is wordy:
  // every field is wrapped in a { label, attributes } envelope. We type
  // the bits we actually read; everything else stays `unknown`.
  id?: { label?: string; attributes?: { "im:id"?: string } };
  "im:artist"?: { label?: string };
  "im:name"?: { label?: string };
  link?: Array<{ attributes?: { rel?: string; href?: string } } | undefined>;
}

interface SeedAppResult {
  id: string;
  message?: string;
  name: string;
  snapshotsWritten: number;
  source: "live" | "canned";
  status: "inserted" | "skipped" | "error";
}

interface RssFetchOutcome {
  /** Track-id → product URL pairs in chart order. */
  apps: Array<{ id: string; name: string; url: string; developer: string }>;
  rateLimited: boolean;
  retryAfterMs?: number;
}

/** Fetch the iTunes top-free-apps RSS for a given country code. */
async function fetchTopFreeApps(
  country: string,
  limit: number
): Promise<RssFetchOutcome> {
  const url = `https://itunes.apple.com/${country}/rss/topfreeapplications/limit=${limit}/json`;

  const { response: res, body: bodyBuf } = await safeFetch(url, {
    allowedHosts: ["itunes.apple.com"],
    headers: { Accept: "application/json" },
    timeoutMs: 8000,
    maxBytes: 1 * 1024 * 1024,
    redirect: "follow",
  });

  if (res.status === 429) {
    const retryAfterHeader = res.headers.get("retry-after");
    const parsed = retryAfterHeader
      ? Number.parseInt(retryAfterHeader, 10) * 1000
      : Number.NaN;
    return {
      rateLimited: true,
      retryAfterMs: Number.isFinite(parsed) && parsed > 0 ? parsed : 70_000,
      apps: [],
    };
  }
  if (!res.ok) {
    throw new Error(
      `iTunes RSS returned HTTP ${res.status} for country=${country}`
    );
  }

  let data: { feed?: { entry?: RssEntry[] } };
  try {
    data = JSON.parse(bodyBuf.toString("utf8"));
  } catch {
    throw new Error("iTunes RSS returned non-JSON body");
  }

  const entries = data.feed?.entry ?? [];
  const apps: RssFetchOutcome["apps"] = [];
  for (const entry of entries) {
    const trackId = entry.id?.attributes?.["im:id"] ?? "";
    const productUrl = entry.id?.label ?? "";
    const name = entry["im:name"]?.label ?? "";
    const developer = entry["im:artist"]?.label ?? "";
    if (!(trackId && productUrl)) {
      continue;
    }
    apps.push({ id: trackId, name, url: productUrl, developer });
  }
  return { rateLimited: false, apps };
}

/**
 * Synthesise 1–2 back-dated snapshots that sit BEFORE the live one so
 * the timeline UI has visible history. Each step trims one category off
 * the FIRST privacy type — same shape as a real Apple change-log entry
 * ("removed `Search History` from Data Linked to You"). We don't bump
 * `apps.changeCount` for these rows because they're history, not fresh
 * drift the user should be alerted on.
 */
function backfillFakeHistory(
  appId: string,
  currentSnapshot: PrivacyTypeSnapshot[]
): number {
  if (currentSnapshot.length === 0) {
    return 0;
  }
  // No types with at least 2 categories → nothing meaningful to trim.
  if (!currentSnapshot.some((t) => t.categories.length >= 2)) {
    return 0;
  }

  const now = Date.now();
  let written = 0;
  let prev: PrivacyTypeSnapshot[] = [];

  // Two back-dated steps: 60 days ago (most-trimmed) and 30 days ago
  // (slightly less trimmed). The current live row stays as the "today"
  // entry on the timeline because fetchAndParseApp already wrote it.
  const STEPS = [
    { daysAgo: 60, trim: 2 },
    { daysAgo: 30, trim: 1 },
  ];

  for (const step of STEPS) {
    const synthesised = currentSnapshot.map((t, idx) => ({
      ...t,
      categories:
        idx === 0 && step.trim > 0
          ? t.categories.slice(0, Math.max(0, t.categories.length - step.trim))
          : t.categories,
    }));
    const changes = diffSnapshots(prev, synthesised);
    saveSnapshot(appId, synthesised, changes, {
      scrapedAt: now - step.daysAgo * 24 * 60 * 60 * 1000,
      skipChangeCountBump: true,
      // Always 'sample' — the changelog timeline renders a purple
      // SAMPLE pill on these rows so devs can tell synthesised
      // history apart from real syncs at a glance.
      triggeredBy: "sample",
    });
    written++;
    prev = synthesised;
  }
  return written;
}

// ─────────────────────────────────────────────────────────────────────
// Canned fallback path — kept reachable via ?source=canned so devs can
// still seed an offline / rate-limited environment from the SAMPLE_APPS
// in-memory set. Same shape as the previous endpoint.
// ─────────────────────────────────────────────────────────────────────

function syntheticIdFor(slug: string): string {
  const hash = crypto.createHash("sha1").update(slug).digest("hex");
  const numeric = Number.parseInt(hash.slice(0, 6), 16) % 9_000_000;
  return `9${String(numeric).padStart(7, "0")}`;
}

function appUrlFor(sample: SampleApp): string {
  const slug = encodeURIComponent(sample.name);
  return `https://apps.apple.com/us/app/${slug}/id${syntheticIdFor(sample.id)}`;
}

function sampleStepToSnapshot(
  types: SampleAppPrivacyType[]
): PrivacyTypeSnapshot[] {
  // Each `t.categories` entry is a canonical CATEGORY_META key (e.g.
  // 'CONTACT_INFO'), not a human title. Look up the human label from
  // CATEGORY_META so the snapshot's `title` matches what the live
  // scraper would produce; fall back to the key when an unknown
  // category slips in (defensive — shouldn't happen with the typed
  // fixture, but keeps the seeder running rather than throwing).
  return types.map((t) => ({
    identifier: t.identifier,
    title: t.title,
    categories: t.categories.map((key) => ({
      identifier: key,
      title: CATEGORY_META[key]?.label ?? key,
    })),
  }));
}

function seedFromCanned(): SeedAppResult[] {
  const results: SeedAppResult[] = [];
  const seedTx = db.transaction(() => {
    for (const sample of SAMPLE_APPS) {
      const appId = syntheticIdFor(sample.id);
      const existing = db.prepare("SELECT 1 FROM apps WHERE id = ?").get(appId);
      if (existing) {
        results.push({
          id: appId,
          name: sample.name,
          status: "skipped",
          source: "canned",
          snapshotsWritten: 0,
        });
        continue;
      }
      const now = Date.now();
      db.prepare(
        `INSERT INTO apps (
           id, name, url, iconUrl, bundleId, developer,
           firstSeen, lastSynced, changeCount,
           changes_acknowledged_at, changes_snoozed_until,
           hasPrivacyDetails, hasAccessibilityLabels
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        appId,
        sample.name,
        appUrlFor(sample),
        "",
        `com.sample.${sample.id.replace(/^sample-/, "")}`,
        sample.developer,
        now - 14 * 24 * 60 * 60 * 1000,
        now,
        0,
        0,
        0,
        sample.hasPrivacyDetails ? 1 : 0,
        sample.hasAccessibilityLabels ? 1 : 0
      );
      for (const type of sample.privacyTypes) {
        const typeRowId = crypto.randomUUID();
        db.prepare(
          `INSERT INTO privacy_types (id, app_id, identifier, title)
           VALUES (?, ?, ?, ?)`
        ).run(typeRowId, appId, type.identifier, type.title);
        // `type.categories` entries are canonical CATEGORY_META keys
        // (e.g. 'CONTACT_INFO'). Use the key as the DB identifier so
        // privacy-profile mismatch detection (which keys off these
        // canonical strings) lights up correctly, and pull the human
        // label from CATEGORY_META for the title column. Falls back
        // to the key when an unknown category sneaks through.
        for (const categoryKey of type.categories) {
          const meta = CATEGORY_META[categoryKey];
          const catId = crypto.randomUUID();
          db.prepare(
            `INSERT INTO privacy_categories (id, type_id, identifier, title)
             VALUES (?, ?, ?, ?)`
          ).run(catId, typeRowId, categoryKey, meta?.label ?? categoryKey);
        }
      }
      const currentSnapshot = buildSnapshot(appId);
      let snapshotsWritten = 0;
      if (currentSnapshot.length > 0) {
        const history: SampleHistoryStep[] = [...(sample.history ?? [])].sort(
          (a, b) => b.daysAgo - a.daysAgo
        );
        let prevSnapshot: PrivacyTypeSnapshot[] = [];
        for (const step of history) {
          const stepSnapshot = sampleStepToSnapshot(step.privacyTypes);
          const changes = diffSnapshots(prevSnapshot, stepSnapshot);
          saveSnapshot(appId, stepSnapshot, changes, {
            scrapedAt: now - step.daysAgo * 24 * 60 * 60 * 1000,
            skipChangeCountBump: true,
            // Always 'sample' — see the live-path comment above.
            // Wayback rows still set source: 'wayback' so the timeline
            // dot/badge stays visually correct; the trigger pill is
            // suppressed for wayback rows in the renderer anyway.
            triggeredBy: "sample",
            source: step.waybackUrl ? "wayback" : "live",
            waybackUrl: step.waybackUrl ?? null,
            appVersion: step.version ?? null,
          });
          snapshotsWritten++;
          prevSnapshot = stepSnapshot;
        }
        const todaysChanges = diffSnapshots(prevSnapshot, currentSnapshot);
        saveSnapshot(appId, currentSnapshot, todaysChanges, {
          scrapedAt: now,
          skipChangeCountBump: true,
          triggeredBy: "sample",
        });
        snapshotsWritten++;
      }
      results.push({
        id: appId,
        name: sample.name,
        status: "inserted",
        source: "canned",
        snapshotsWritten,
      });
    }
  });
  seedTx();
  return results;
}

// ─────────────────────────────────────────────────────────────────────
// POST handler
// ─────────────────────────────────────────────────────────────────────

export async function POST(request: Request) {
  const startedAt = Date.now();
  const guard = requireMutationGuard(request, {
    action: "dev.seed_sample_data",
    rateLimit: {
      keyPrefix: "dev.seed_sample_data",
      // Limit lifted from 6 to 30 per 10 min for the same reason as
      // /api/reset's: the E2E suite calls this from ~7 specs per run
      // (see e2e/*.spec.ts), and the original cap was tight enough
      // that adding a single new spec tipped the suite into cascade
      // failures. Same-origin + the audit log are the actual
      // guardrails; this limiter is just defence-in-depth against a
      // runaway loop, and a runaway loop trips any threshold instantly.
      limit: 30,
      windowMs: 10 * 60_000,
      message: "Rate limit exceeded for dev sample seeding. Try again later.",
    },
  });
  if (!guard.ok) {
    return guard.response;
  }

  const url = new URL(request.url);

  // Parse query params.
  const sourceParam = url.searchParams.get("source");
  const useCanned = sourceParam === "canned";
  const limitParam = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
  const limit = Math.min(
    SEED_MAX_LIMIT,
    Number.isFinite(limitParam) && limitParam > 0
      ? limitParam
      : SEED_DEFAULT_LIMIT
  );
  const requestedCountry = url.searchParams.get("country");

  // Region resolution:
  //   1. Explicit ?country=<iso2> wins (lets devs test other regions
  //      without changing their saved setting).
  //   2. Otherwise read app_country from app_settings — but only honour
  //      it when it's been EXPLICITLY set. A blank value (fresh install)
  //      falls through to DEFAULT_DEV_REGION ('au'), per the dev request.
  //   3. normalizeCountry() guards against typos / unknown codes by
  //      collapsing them onto the system DEFAULT_COUNTRY ('us'); we want
  //      'au' for unset, so we check for blank ourselves before calling.
  let country: string;
  let regionSource: "query" | "setting" | "default";
  if (requestedCountry) {
    country = normalizeCountry(requestedCountry);
    regionSource = "query";
  } else {
    const stored = (getSetting("app_country", "") ?? "").trim();
    if (stored) {
      country = normalizeCountry(stored);
      regionSource = "setting";
    } else {
      country = DEFAULT_DEV_REGION;
      regionSource = "default";
    }
  }

  // ── Canned fallback path ────────────────────────────────────────────
  if (useCanned) {
    let results: SeedAppResult[] = [];
    try {
      results = seedFromCanned();
    } catch (e) {
      console.error("[/api/dev/seed-sample-data] canned seed failed:", e);
      recordAudit({
        action: "dev.seed_sample_data.failed",
        actorIp: guard.actorIp,
        userAgent: guard.userAgent,
        success: false,
        detail: e instanceof Error ? e.message : String(e),
      });
      return NextResponse.json(
        { error: e instanceof Error ? e.message : "Canned seed failed" },
        { status: 500 }
      );
    }
    return finishResponse({
      startedAt,
      results,
      regionSource,
      country,
      mode: "canned",
      auditContext: guard,
    });
  }

  // ── Live top-10 path ────────────────────────────────────────────────
  let rss: RssFetchOutcome;
  try {
    rss = await fetchTopFreeApps(country, limit);
  } catch (e) {
    console.error("[/api/dev/seed-sample-data] RSS fetch failed:", e);
    recordAudit({
      action: "dev.seed_sample_data.failed",
      actorIp: guard.actorIp,
      userAgent: guard.userAgent,
      success: false,
      detail: e instanceof Error ? e.message : String(e),
    });
    return NextResponse.json(
      {
        error: e instanceof Error ? e.message : "Top-charts fetch failed",
        hint:
          "Try `?source=canned` to seed the canned SAMPLE_APPS instead, " +
          "or pick a different `?country=<iso2>`.",
        country,
        regionSource,
      },
      { status: 502 }
    );
  }

  if (rss.rateLimited) {
    recordAudit({
      action: "dev.seed_sample_data.rate_limited_upstream",
      actorIp: guard.actorIp,
      userAgent: guard.userAgent,
      success: false,
      detail: `country=${country} retryAfterMs=${rss.retryAfterMs}`,
    });
    return NextResponse.json(
      {
        error: "Apple iTunes RSS rate-limited the request",
        retryAfterMs: rss.retryAfterMs,
        hint: "Wait a minute and retry, or use `?source=canned` to seed offline data.",
        country,
        regionSource,
      },
      {
        status: 429,
        headers: {
          "Retry-After": String(Math.ceil((rss.retryAfterMs ?? 60_000) / 1000)),
        },
      }
    );
  }

  if (rss.apps.length === 0) {
    recordAudit({
      action: "dev.seed_sample_data.failed",
      actorIp: guard.actorIp,
      userAgent: guard.userAgent,
      success: false,
      detail: `iTunes RSS returned zero entries for country=${country}`,
    });
    return NextResponse.json(
      {
        error: `iTunes RSS returned zero entries for country=${country}`,
        hint: "The country code may be valid but unsupported by the chart feed.",
        country,
        regionSource,
      },
      { status: 502 }
    );
  }

  // Walk the chart in order. fetchAndParseApp is async + writes to the
  // DB itself, so we do this sequentially (Apple gets unhappy with
  // bursts anyway). On the first AppleRateLimitError we bail and return
  // whatever we've managed to seed.
  const results: SeedAppResult[] = [];
  let stoppedEarly: { reason: "rate-limited"; retryAfterMs: number } | null =
    null;

  for (const entry of rss.apps) {
    // Skip apps that are already tracked — no re-scrape, no fake history.
    const existing = db
      .prepare("SELECT 1 FROM apps WHERE id = ?")
      .get(entry.id);
    if (existing) {
      results.push({
        id: entry.id,
        name: entry.name,
        status: "skipped",
        source: "live",
        message: "already tracked",
        snapshotsWritten: 0,
      });
      continue;
    }

    try {
      // `fetchAndParseApp` does the full pipeline — HTML scrape, privacy
      // tree write, accessibility labels, snapshot, optional policy
      // summary (we let it run because seeding a real app should look
      // like a real onboarding). Throws AppleRateLimitError on 429s.
      await fetchAndParseApp(entry.url, false, true);

      // Layer in synthetic back-dated history so the changelog UI has
      // something to render. Best-effort — if anything goes wrong the
      // app is still usable, just with one timeline entry.
      let snapshotsWritten = 1; // the live row we just wrote
      try {
        const liveSnapshot = buildSnapshot(entry.id);
        snapshotsWritten += backfillFakeHistory(entry.id, liveSnapshot);
      } catch (e) {
        console.warn(`[seed] backfillFakeHistory failed for ${entry.id}:`, e);
      }

      results.push({
        id: entry.id,
        name: entry.name,
        status: "inserted",
        source: "live",
        snapshotsWritten,
      });
    } catch (e) {
      if (e instanceof AppleRateLimitError) {
        stoppedEarly = { reason: "rate-limited", retryAfterMs: e.retryAfterMs };
        break;
      }
      results.push({
        id: entry.id,
        name: entry.name,
        status: "error",
        source: "live",
        message: e instanceof Error ? e.message : String(e),
        snapshotsWritten: 0,
      });
    }

    // Polite spacer — lets Apple's per-IP counters relax between hits.
    if (PER_APP_DELAY_MS > 0) {
      await new Promise((resolve) => setTimeout(resolve, PER_APP_DELAY_MS));
    }
  }

  return finishResponse({
    startedAt,
    results,
    regionSource,
    country,
    mode: "live",
    stoppedEarly,
    auditContext: guard,
  });
}

function finishResponse({
  startedAt,
  results,
  regionSource,
  country,
  mode,
  stoppedEarly,
  auditContext,
}: {
  startedAt: number;
  results: SeedAppResult[];
  regionSource: "query" | "setting" | "default";
  country: string;
  mode: "live" | "canned";
  stoppedEarly?: { reason: "rate-limited"; retryAfterMs: number } | null;
  auditContext?: MutationGuardContext;
}): NextResponse {
  const insertedCount = results.filter((r) => r.status === "inserted").length;
  const skippedCount = results.filter((r) => r.status === "skipped").length;
  const errorCount = results.filter((r) => r.status === "error").length;

  // Activity row so the seed shows up in the dev log alongside scrape /
  // resync events. Best-effort — never fail the response on log issues.
  try {
    recordActivity({
      type: "reset",
      status: errorCount > 0 || stoppedEarly ? "partial" : "ok",
      summary:
        mode === "live"
          ? `Dev seed (live, ${country}/${regionSource}) — inserted ${insertedCount}, skipped ${skippedCount}${
              errorCount ? `, ${errorCount} errored` : ""
            }${stoppedEarly ? `, stopped early (${stoppedEarly.reason})` : ""}`
          : `Dev seed (canned) — inserted ${insertedCount}, skipped ${skippedCount}`,
      detail: {
        mode: `dev-seed-${mode}`,
        country,
        regionSource,
        results,
        stoppedEarly,
      },
      startedAt,
    });
  } catch (e) {
    console.warn("[/api/dev/seed-sample-data] activity-log failed:", e);
  }
  if (auditContext) {
    recordAudit({
      action:
        stoppedEarly || errorCount > 0
          ? "dev.seed_sample_data.partial"
          : "dev.seed_sample_data.success",
      actorIp: auditContext.actorIp,
      userAgent: auditContext.userAgent,
      success: errorCount === 0 && !stoppedEarly,
      detail: `mode=${mode} country=${country} inserted=${insertedCount} skipped=${skippedCount} errored=${errorCount}`,
    });
  }

  return NextResponse.json({
    ok: true,
    mode,
    country,
    regionSource,
    inserted: insertedCount,
    skipped: skippedCount,
    errored: errorCount,
    stoppedEarly,
    results,
    durationMs: Date.now() - startedAt,
  });
}
