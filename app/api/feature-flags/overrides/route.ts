/**
 * /api/feature-flags/overrides — write/clear flag overrides.
 *
 *   POST   { key, value }              — set or upsert a single override
 *   POST   { flags: [{ key, override }] }
 *                                      — bulk import: WIPE every existing
 *                                        non-quarantined override and replay
 *                                        only the rows whose `override` is
 *                                        non-null. Mirrors the shape produced
 *                                        by the panel's "Export current flag
 *                                        state as JSON" download so a round-
 *                                        trip just works. Unknown keys are
 *                                        skipped (counted in the response).
 *   DELETE                             — clear ALL non-quarantined overrides
 *   DELETE ?surface=<prefix>           — clear overrides for one surface (e.g. ?surface=dashboard)
 */

import { type NextRequest, NextResponse } from "next/server";
import { requireMutationGuard } from "@/lib/api-guards";
import {
  type FlagKey,
  type FlagValue,
  HARD_DEFAULTS,
} from "@/lib/feature-flag-rules";
import {
  clearAllOverrides,
  clearSurfaceOverrides,
  setOverride as storeOverride,
} from "@/lib/feature-flag-storage";
import { readBoundedJson } from "@/lib/security";

export const dynamic = "force-dynamic";

const VALID_VALUES: readonly FlagValue[] = ["on", "off", "collapsed"];

interface PostBody {
  /**
   * Bulk-import payload. When present, the server wipes every existing
   * override (using the same code path as DELETE without a surface) and
   * then replays each row whose `override` is non-null. This is the path
   * the Dev Options "Import flag state" button hits — the export blob's
   * top-level shape is `{ flags: [...] }`, where each row carries an
   * `override` of `'on' | 'off' | 'collapsed' | null`.
   */
  flags?: Array<{
    key?: unknown;
    override?: unknown;
  }>;
  key?: string;
  value?: string;
}

export async function POST(request: NextRequest) {
  // Flag flips can unlock other destructive surfaces (e.g.
  // `flag.devopts.cfgutil_uninstall` enables the iPhone-uninstall
  // wizard, and `flag.settings.admin.export.audit_bundle` exposes the
  // audit-bundle export route). Treat them as a guarded mutation:
  // admin token required when configured, rate-limited per-IP.
  const guard = requireMutationGuard(request, {
    action: "feature_flag.override",
    rateLimit: {
      keyPrefix: "feature_flag.override",
      limit: 30,
      windowMs: 60_000,
    },
  });
  if (!guard.ok) {
    return guard.response;
  }

  let body: PostBody;
  try {
    body = await readBoundedJson<PostBody>(request, 64 * 1024);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // Bulk import path. We treat the presence of an array `flags` as the
  // signal to use the wipe-then-replay flow rather than a single-key
  // upsert, so callers don't need a separate URL.
  if (Array.isArray(body.flags)) {
    let applied = 0;
    let skipped = 0;
    const skippedKeys: string[] = [];
    try {
      // Wipe first so any flag the user is dropping (`override === null`
      // in the imported file) really goes back to its computed default.
      // `clearAllOverrides` only touches non-quarantined rows so the
      // quarantine table is preserved — same guarantee the standalone
      // DELETE handler gives.
      clearAllOverrides();

      for (const row of body.flags) {
        if (!row || typeof row !== "object") {
          skipped++;
          continue;
        }
        const key = row.key;
        const override = row.override;

        // Only persist rows whose `override` is one of the valid string
        // values. `null` (cleared) and unknown / malformed entries fall
        // through to the post-wipe default state.
        if (typeof key !== "string" || !(key in HARD_DEFAULTS)) {
          skipped++;
          if (typeof key === "string") {
            skippedKeys.push(key);
          }
          continue;
        }
        if (override === null || override === undefined) {
          // Imported file says "no override" — already covered by the wipe.
          continue;
        }
        if (
          typeof override !== "string" ||
          !VALID_VALUES.includes(override as FlagValue)
        ) {
          skipped++;
          continue;
        }
        storeOverride(key as FlagKey, override as FlagValue);
        applied++;
      }
    } catch (e) {
      console.error("[/api/feature-flags/overrides POST bulk] failed:", e);
      return NextResponse.json(
        { error: "Failed to import overrides" },
        { status: 500 }
      );
    }
    return NextResponse.json({
      ok: true,
      applied,
      skipped,
      // Truncate so a malformed file with thousands of unknown keys
      // doesn't bloat the response. Callers get the count + a sample.
      skippedKeys: skippedKeys.slice(0, 20),
    });
  }

  if (
    !body.key ||
    typeof body.key !== "string" ||
    !(body.key in HARD_DEFAULTS)
  ) {
    return NextResponse.json({ error: "unknown flag key" }, { status: 400 });
  }
  if (!(body.value && VALID_VALUES.includes(body.value as FlagValue))) {
    return NextResponse.json(
      { error: `value must be one of: ${VALID_VALUES.join(", ")}` },
      { status: 400 }
    );
  }

  try {
    storeOverride(body.key as FlagKey, body.value as FlagValue);
  } catch (e) {
    console.error("[/api/feature-flags/overrides POST] failed:", e);
    return NextResponse.json(
      { error: "Failed to set override" },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true, key: body.key, value: body.value });
}

export async function DELETE(request: NextRequest) {
  const guard = requireMutationGuard(request, {
    action: "feature_flag.override.clear",
    rateLimit: {
      keyPrefix: "feature_flag.override.clear",
      limit: 10,
      windowMs: 60_000,
    },
  });
  if (!guard.ok) {
    return guard.response;
  }

  const surface = request.nextUrl.searchParams.get("surface");

  try {
    if (surface) {
      clearSurfaceOverrides(surface);
    } else {
      clearAllOverrides();
    }
  } catch (e) {
    console.error("[/api/feature-flags/overrides DELETE] failed:", e);
    return NextResponse.json(
      { error: "Failed to clear overrides" },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true, scope: surface ?? "all" });
}
