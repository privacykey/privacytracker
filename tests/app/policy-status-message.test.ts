/**
 * What the AI Policy tab says about an analysis's status.
 *
 * A run that makes no summary can keep the one it was replacing: a failed
 * fetch, a failed AI call and a run that found no usable AI provider all
 * do. The tab then shows that summary with a note under it. For a run
 * that found no provider the only note was "AI summaries are disabled
 * until an AI provider is configured", which reads wrongly under a summary
 * an AI provider made. These tests pin the message for every status, with
 * and without a summary, and that each message exists in every locale.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import {
  describePolicyStatus,
  POLICY_ANALYSIS_STATUSES,
} from "../../lib/policy-summary-meta";

const STATUSES = [...POLICY_ANALYSIS_STATUSES, null];

for (const hasSummary of [false, true]) {
  test(`the message for each status (hasSummary: ${hasSummary})`, () => {
    const byStatus = Object.fromEntries(
      STATUSES.map((status) => [
        String(status),
        describePolicyStatus(status, hasSummary),
      ])
    );
    assert.deepEqual(byStatus, {
      // A ready analysis, or one with a status the tab does not know, shows
      // its stored error or the generic "not available" line instead.
      ready: null,
      source_ready: "status_source_ready",
      needs_ai_config: hasSummary
        ? "status_needs_ai_config_with_summary"
        : "status_needs_ai_config",
      fetch_error: hasSummary
        ? "status_fetch_error_with_summary"
        : "status_fetch_error",
      unsupported_content_type: "status_unsupported_content_type",
      too_short: "status_too_short",
      analysis_error: hasSummary
        ? "status_analysis_error_with_summary"
        : "status_analysis_error",
      null: null,
    });
  });
}

test("every status message exists in every locale", () => {
  const keys = new Set(
    STATUSES.flatMap((status) =>
      [false, true].map((hasSummary) =>
        describePolicyStatus(status, hasSummary)
      )
    ).filter((key) => key !== null)
  );
  const localesDir = new URL("../../locales/", import.meta.url);
  const files = readdirSync(localesDir).filter((f) => f.endsWith(".json"));
  assert.ok(files.includes("en.json"));
  for (const file of files) {
    const messages = JSON.parse(
      readFileSync(new URL(file, localesDir), "utf8")
    ) as { app_detail: { policy_meta: Record<string, unknown> } };
    for (const key of keys) {
      const value = messages.app_detail.policy_meta[key];
      assert.equal(typeof value, "string", `${file}: policy_meta.${key}`);
      assert.ok((value as string).trim(), `${file}: policy_meta.${key}`);
    }
  }
});
