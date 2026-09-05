export const dynamic = "force-dynamic";

import { type NextRequest, NextResponse } from "next/server";
import { requireMutationGuard } from "@/lib/api-guards";
import { consumeMigrationFlowMarker } from "@/lib/audit-bundle-import";

/**
 * POST /api/migration-flow/consume — one-shot read-and-clear of the
 * `migration_flow_pending` marker that the audit-bundle importer stashes
 * when a bundle came from the desktop migration wizard.
 *
 * Added for Rust-core Phase 0: /dashboard consumed the marker in its
 * server component and redirect()ed to the target. The read and the
 * clear MUST stay one server-side operation (never a GET-then-DELETE
 * pair — a refresh between the two would re-trigger the redirect), and
 * it is a POST because it mutates. Callers must only hit this once they
 * know the install has apps: the page gated the consume on
 * `totalApps > 0`, and firing it on an empty install burns the marker
 * before the user ever reaches the Review wizard.
 *
 * Returns `{ targetPath, recommenderName }` when a marker was pending,
 * otherwise `{ pending: false }`.
 */
export async function POST(request: NextRequest) {
  const guard = requireMutationGuard(request, {
    action: "migration-flow.consume",
    rateLimit: {
      keyPrefix: "migration-flow.consume",
      limit: 60,
      windowMs: 60_000,
    },
    requireAdminToken: false,
  });
  if (!guard.ok) {
    return guard.response;
  }
  try {
    const marker = consumeMigrationFlowMarker();
    return NextResponse.json(marker ?? { pending: false });
  } catch (error) {
    console.warn("[migration-flow/consume] failed:", error);
    return NextResponse.json({ pending: false });
  }
}
