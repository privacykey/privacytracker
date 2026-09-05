"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import CompareAppsView from "@/app/components/CompareAppsView";
import Nav from "@/app/components/Nav";
import RecordTaskVisit from "@/app/components/RecordTaskVisit";
import RequireFlagGate from "@/app/components/RequireFlagGate";

/**
 * Validate that a spec string from the query string is one of the two shapes
 * CompareAppsView / /api/compare already accept: `id:<appId>` or
 * `url:<https://...>`. Anything else is dropped back to `undefined` so the
 * page simply boots with empty slots instead of crashing downstream.
 *
 * We keep this intentionally permissive: the heavy validation (tracking ID
 * existence, URL scheme, storefront country) happens inside /api/compare.
 * This wrapper just guards against obviously malformed query strings.
 */
function sanitizeSpec(raw: string | string[] | undefined): string | undefined {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") {
    return;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 500) {
    return;
  }

  if (trimmed.startsWith("id:")) {
    const id = trimmed.slice(3);
    // Apple track IDs are numeric, but we allow alphanumerics + a handful of
    // safe characters to match whatever the DB already stores.
    if (/^[A-Za-z0-9_-]{1,40}$/.test(id)) {
      return trimmed;
    }
    return;
  }

  if (trimmed.startsWith("url:")) {
    const url = trimmed.slice(4);
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "https:" || parsed.protocol === "http:") {
        return trimmed;
      }
    } catch {
      /* fall through */
    }
  }
}

function readSingle(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

export default function CompareContent() {
  // Query params come from the URL on the client now (Rust-core Phase 0):
  // the page is static, so there is no server searchParams to await.
  const searchParams = useSearchParams();
  const params = {
    a: searchParams.get("a") ?? undefined,
    b: searchParams.get("b") ?? undefined,
    from: searchParams.get("from") ?? undefined,
  };
  const specA = sanitizeSpec(params.a);
  const specB = sanitizeSpec(params.b);
  const fromReview = readSingle(params.from) === "review";
  const tCompare = useTranslations("compare");

  // Origin-aware back link. When the user came from the review wizard,
  // we keep them in that flow — the review page still shows their
  // decisions in progress, and a "Back to Apps" link would break the
  // mental thread of "I'm choosing a replacement for THIS app".
  // Round 3 v1.2 — when entering from the review wizard, return the user
  // to Step 2 (Compare) rather than the wizard's default Step 1 landing.
  // The wizard reads `?step=compare` off useSearchParams() on mount and
  // jumps straight to the Compare panel, so the user lands back exactly
  // where they were when they clicked "Find alternatives". Without the
  // hint, the wizard rebooted at Step 1 and the back-link felt like it
  // had thrown away their progress.
  const backHref = fromReview
    ? "/dashboard/review-recommendations?step=compare"
    : "/dashboard/apps";
  const backLabel = fromReview
    ? tCompare("back_to_review")
    : tCompare("back_to_apps");

  return (
    <>
      <Nav />
      <RequireFlagGate flag="flag.page.compare">
        {/* First-visit marker for the `compare_two_apps` checklist item;
            same first-write-wins semantics as the server version. */}
        <RecordTaskVisit surface="compare" />
        <div className="page-container">
          <div className="page-header">
            <div>
              <h1 className="page-title">{tCompare("page_title")}</h1>
              <p className="page-subtitle">
                {fromReview ? (
                  tCompare("page_subtitle_from_review")
                ) : (
                  <>
                    {tCompare("page_subtitle_default_lead")}{" "}
                    <Link
                      className="definitions-inline-link"
                      href="/dashboard/apps"
                    >
                      {tCompare("page_subtitle_default_link")}
                    </Link>
                    {tCompare("page_subtitle_default_after")}{" "}
                    <kbd className="kbd kbd-inline">
                      {tCompare("page_subtitle_default_kbd")}
                    </kbd>{" "}
                    {tCompare("page_subtitle_default_close")}
                  </>
                )}
              </p>
            </div>
            <Link className="btn btn-secondary" href={backHref}>
              {backLabel}
            </Link>
          </div>

          {/* Seed either/both slots from the URL. CompareAppsView handles the
            empty case itself (empty-state copy + two pickers). */}
          <CompareAppsView
            fromReview={fromReview}
            initialSpec={specA}
            initialSpecOther={specB}
            lockPinned={false}
            pinnedSlot="A"
          />
        </div>
      </RequireFlagGate>
    </>
  );
}
