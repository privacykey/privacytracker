export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { diffPolicyTexts } from "../../../../../../lib/policy-diff";
import {
  getPolicyVersion,
  getPreviousPolicyVersion,
} from "../../../../../../lib/policy-versions";
import {
  checkRateLimit,
  rateLimitKeyForRequest,
} from "../../../../../../lib/security";

// GET /api/policy/version/[id]/diff
//
// Returns a line+word diff between the given version and the version
// immediately preceding it for the same app. Consumed by the History
// timeline's "Show diff from previous version" toggle and by the AI
// Policy tab's recent-change banner.
//
// Response shape:
//   {
//     previous: { id, first_fetched_at, last_fetched_at, source_word_count },
//     current:  { id, first_fetched_at, last_fetched_at, source_word_count },
//     stats:    { added, removed, unchanged, truncated },
//     lines:    PolicyDiffLine[]
//   }
//
// 404 when the given id is unknown, or when it has no earlier peer (i.e.
// the version is the first scrape for its app — there is nothing to diff
// against and the caller should render an empty state instead).

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const rate = checkRateLimit({
    key: rateLimitKeyForRequest(request, "policy.version.diff"),
    limit: 60,
    windowMs: 60_000,
  });
  if (!rate.allowed) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  const params = await Promise.resolve(context.params);
  const id = (params?.id ?? "").toString();
  if (!id || id.length > 128) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }

  const current = getPolicyVersion(id);
  if (!current) {
    return NextResponse.json({ error: "Version not found" }, { status: 404 });
  }

  const previous = getPreviousPolicyVersion(id);
  if (!previous) {
    // No predecessor — return 404 so the UI can render "first-ever scrape,
    // nothing to compare against" without a special-case status code.
    return NextResponse.json(
      { error: "No previous version to diff against" },
      { status: 404 }
    );
  }

  const result = diffPolicyTexts(
    previous.source_text ?? "",
    current.source_text ?? ""
  );

  return NextResponse.json({
    previous: {
      id: previous.id,
      first_fetched_at: previous.first_fetched_at,
      last_fetched_at: previous.last_fetched_at,
      source_word_count: previous.source_word_count,
    },
    current: {
      id: current.id,
      first_fetched_at: current.first_fetched_at,
      last_fetched_at: current.last_fetched_at,
      source_word_count: current.source_word_count,
    },
    stats: result.stats,
    lines: result.lines,
  });
}
