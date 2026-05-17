export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getPolicyVersion } from "../../../../../lib/policy-versions";
import {
  checkRateLimit,
  rateLimitKeyForRequest,
} from "../../../../../lib/security";

// Returns the captured policy source text for a single version row.
// Used by the History timeline: clicking a privacy-policy changelog entry
// fetches its linked policy_version_id so the user can preview the text
// we had at that point in time.
//
// This endpoint is NOT admin-gated — the text came from a public URL the
// user already provided, and the route only serves rows that belong to an
// app currently tracked in the local DB. We still rate limit to keep a
// same-origin loop from blasting the server.

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const rate = checkRateLimit({
    key: rateLimitKeyForRequest(request, "policy.version.read"),
    limit: 120,
    windowMs: 60_000,
  });
  if (!rate.allowed) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429 });
  }

  // Next 14/15 params is a plain object; Next 16 hands a Promise. Supporting
  // both keeps the handler portable across the major upgrade.
  const params = await Promise.resolve(context.params);
  const id = (params?.id ?? "").toString();

  // Guard against absurd ids so we don't hit SQLite with arbitrary strings.
  if (!id || id.length > 128) {
    return NextResponse.json({ error: "Invalid id" }, { status: 400 });
  }

  const row = getPolicyVersion(id);
  if (!row) {
    return NextResponse.json({ error: "Version not found" }, { status: 404 });
  }

  return NextResponse.json({
    id: row.id,
    app_id: row.app_id,
    content_hash: row.content_hash,
    first_fetched_at: row.first_fetched_at,
    last_fetched_at: row.last_fetched_at,
    policy_url: row.policy_url,
    source_final_url: row.source_final_url,
    source_title: row.source_title,
    source_content_type: row.source_content_type,
    source_origin: row.source_origin,
    source_word_count: row.source_word_count,
    source_text: row.source_text,
    archive_url: row.archive_url,
    archive_submitted_at: row.archive_submitted_at,
  });
}
