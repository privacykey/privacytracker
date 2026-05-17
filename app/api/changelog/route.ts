/**
 * GET /api/changelog
 *
 * Universal changelog feed across every tracked app. Each row is a
 * single ChangeEntry hoisted out of its parent privacy_snapshots row,
 * stamped with the app context (id, name, icon) and the snapshot
 * timestamp + trigger. Filters and pagination are query params:
 *
 *   ?from=<ms>     inclusive lower bound on snapshot scrapedAt
 *   ?to=<ms>       inclusive upper bound on snapshot scrapedAt
 *   ?appId=<id>    restrict to a single tracked app
 *   ?type=<csv>    comma-separated entry types: added,removed,modified,policy,wayback
 *   ?category=<csv> comma-separated entry categories: privacy-label,
 *                   privacy-policy,wayback-attempt,accessibility
 *   ?limit=<n>     page size (default 100, capped server-side at 500)
 *   ?offset=<n>    skip N rows from the start of the (sorted) result
 *
 * Type / category filters are OR-within-list, AND-across-lists — i.e.
 * `?type=added,removed&category=accessibility` returns adds + removes
 * within the accessibility category only. Filtering happens at the
 * entry level (a snapshot with mixed types contributes only its
 * matching entries) so the count in `total` reflects post-filter
 * cardinality.
 *
 * Returns `{ rows, total }`. The UI uses `total` to decide whether a
 * Load-more affordance is needed and to render an "N of M" footer.
 */

export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import {
  listUniversalChangelog,
  type UniversalChangelogFilters,
} from "../../../lib/changelog";
import type { ChangeEntry } from "../../../lib/changelog-types";

const VALID_TYPES = new Set<ChangeEntry["type"]>([
  "added",
  "removed",
  "modified",
  "policy",
  "wayback",
]);
const VALID_CATEGORIES = new Set<NonNullable<ChangeEntry["category"]>>([
  "privacy-label",
  "privacy-policy",
  "wayback-attempt",
  "accessibility",
]);

function parseCsv<T extends string>(
  raw: string | null,
  valid: Set<T>
): T[] | undefined {
  if (!raw) {
    return;
  }
  const out: T[] = [];
  for (const token of raw.split(",")) {
    const t = token.trim() as T;
    if (t.length > 0 && valid.has(t)) {
      out.push(t);
    }
  }
  return out.length > 0 ? out : undefined;
}

function parseInt32(raw: string | null): number | undefined {
  if (!raw) {
    return;
  }
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const sp = url.searchParams;

  const filters: UniversalChangelogFilters = {};
  const fromMs = parseInt32(sp.get("from"));
  if (fromMs !== undefined) {
    filters.fromMs = fromMs;
  }
  const toMs = parseInt32(sp.get("to"));
  if (toMs !== undefined) {
    filters.toMs = toMs;
  }

  const appIdRaw = sp.get("appId");
  if (appIdRaw && /^[A-Za-z0-9_-]+$/.test(appIdRaw)) {
    filters.appId = appIdRaw;
  }

  filters.types = parseCsv(sp.get("type"), VALID_TYPES);
  filters.categories = parseCsv(sp.get("category"), VALID_CATEGORIES);

  const limit = parseInt32(sp.get("limit"));
  if (limit !== undefined) {
    filters.limit = limit;
  }
  const offset = parseInt32(sp.get("offset"));
  if (offset !== undefined) {
    filters.offset = offset;
  }

  try {
    const data = listUniversalChangelog(filters);
    return NextResponse.json(data);
  } catch (e) {
    console.error("[/api/changelog] failed:", e);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  }
}
