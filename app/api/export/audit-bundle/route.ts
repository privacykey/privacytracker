/**
 * /api/export/audit-bundle — POST returns a downloadable audit bundle.
 *
 * Body: { recommenderName?, includeRecommenderProfile? (default true),
 *   migrationFlow? }
 *
 * Returns a JSON file with `Content-Disposition: attachment; filename=…`.
 * Private annotations (visibility='private') are unconditionally excluded
 * by the SQL filter in `buildAuditBundle()` — no force-include escape hatch.
 */

import { type NextRequest, NextResponse } from "next/server";
import { requireMutationGuard } from "@/lib/api-guards";
import { buildAuditBundle, buildBundleFilename } from "@/lib/audit-bundle";
import {
  getActiveFocus,
  getActiveFocusWorkflow,
} from "@/lib/feature-flag-storage";
import { resolveFlagFromDb } from "@/lib/feature-flags-server";
import { workflowAllowsAuditBundle } from "@/lib/focus-workflow";
import { setSetting } from "@/lib/scheduler";
import { readOptionalBoundedJson } from "@/lib/security";

export const dynamic = "force-dynamic";

interface ExportBody {
  includeRecommenderProfile?: boolean;
  /**
   * When true, the produced bundle carries `migration_flow: true`. The
   * receiving install treats the import as a same-user migration (no
   * provenance banner) and records a one-shot marker in
   * app_settings.migration_flow_pending so the next dashboard load can
   * redirect to /dashboard/review-recommendations.
   */
  migrationFlow?: boolean;
  recommenderName?: string | null;
}

export async function POST(request: NextRequest) {
  // Direct admin-token gate in addition to the feature-flag gate below.
  // The flag alone isn't enough: an attacker who can flip flags via
  // /api/feature-flags/overrides could otherwise enable the export and
  // exfiltrate every tracked app. Gate the route on AUDITOR_ADMIN_TOKEN
  // when configured (Tauri/local installs without the token still pass
  // through; the proxy's CSRF check covers them).
  const guard = requireMutationGuard(request, {
    action: "export.audit_bundle",
    rateLimit: {
      keyPrefix: "export.audit_bundle",
      limit: 5,
      windowMs: 60_000,
    },
  });
  if (!guard.ok) {
    return guard.response;
  }

  let body: ExportBody = {};
  try {
    body = await readOptionalBoundedJson<ExportBody>(request, 4 * 1024, {});
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid JSON body" },
      { status: 400 }
    );
  }

  const focus = (() => {
    try {
      return getActiveFocus();
    } catch {
      return null;
    }
  })();
  const workflow = focus ? getActiveFocusWorkflow(focus) : null;

  // Gate: callable when the bundle export flag is on OR the purpose workflow
  // says the user is preparing a handoff bundle. Client surfaces hide the
  // button when off, but the API is the authoritative gate.
  try {
    if (
      resolveFlagFromDb("flag.settings.admin.export.audit_bundle") !== "on" &&
      !workflowAllowsAuditBundle(workflow)
    ) {
      return NextResponse.json(
        { error: "Audit-bundle export is not enabled for your focus" },
        { status: 403 }
      );
    }
  } catch (e) {
    console.warn("[/api/export/audit-bundle] flag resolution failed:", e);
    // Fail closed when we can't confirm the gate.
    return NextResponse.json(
      { error: "Could not check export permission" },
      { status: 500 }
    );
  }

  let bundle: ReturnType<typeof buildAuditBundle> | undefined;
  try {
    bundle = buildAuditBundle({
      recommenderName: body.recommenderName ?? null,
      includeRecommenderProfile: body.includeRecommenderProfile !== false,
      exportedByAudience: focus?.audience ?? "self",
      migrationFlow: body.migrationFlow === true,
    });
  } catch (e) {
    console.error("[/api/export/audit-bundle] build failed:", e);
    return NextResponse.json(
      { error: "Failed to build audit bundle" },
      { status: 500 }
    );
  }

  const filename = buildBundleFilename(body.recommenderName ?? null);
  const json = JSON.stringify(bundle, null, 2);
  setSetting("audit_bundle_last_exported_at", String(Date.now()));

  return new NextResponse(json, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Content-Disposition": `attachment; filename="${filename}"`,
      // Discourage caching — bundles are point-in-time exports.
      "Cache-Control": "no-store",
    },
  });
}
