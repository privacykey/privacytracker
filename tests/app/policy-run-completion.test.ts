/**
 * What the AI Policy tab's task tray says when a run ends.
 *
 * A run that summarises returns an analysis whether or not it made a
 * summary, and the tray said "Summary updated" for all of them: after a
 * failed AI call, with no AI provider, after a failed fetch and after a
 * declined run. It now reads the returned status. A fetch-only run
 * ("Rescrape policy") said "Policy re-fetched" whatever it returned,
 * including a fetch that failed; it reads the status too. These tests pin
 * the message for every status, and that each message the tray can show
 * exists in every locale.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import {
  describePolicyRunCompletion,
  POLICY_ANALYSIS_STATUSES,
} from "../../lib/policy-summary-meta";

const PHASES = ["fetch", "summarise", "all"] as const;
const STATUSES = [...POLICY_ANALYSIS_STATUSES, null];

test("a fetch-only run says the policy was re-fetched only when it was", () => {
  const byStatus = Object.fromEntries(
    STATUSES.map((status) => {
      const completion = describePolicyRunCompletion("fetch", status);
      return [String(status), `${completion.status}: ${completion.messageKey}`];
    })
  );
  assert.deepEqual(byStatus, {
    ready: "done: completion_fetch",
    source_ready: "done: completion_fetch",
    needs_ai_config: "error: completion_fetch_failed",
    fetch_error: "error: completion_fetch_failed",
    unsupported_content_type: "error: completion_fetch_unusable",
    too_short: "error: completion_fetch_unusable",
    analysis_error: "error: completion_fetch_failed",
    null: "error: completion_fetch_failed",
  });
});

for (const phase of ["summarise", "all"] as const) {
  test(`phase "${phase}": the tray says the summary was updated only when it was`, () => {
    const byStatus = Object.fromEntries(
      STATUSES.map((status) => {
        const completion = describePolicyRunCompletion(phase, status);
        return [
          String(status),
          `${completion.status}: ${completion.messageKey}`,
        ];
      })
    );
    assert.deepEqual(byStatus, {
      ready: "done: completion_summarise",
      source_ready: "error: completion_summary_not_updated",
      needs_ai_config: "error: completion_summary_not_updated",
      fetch_error: "error: completion_summary_not_updated",
      unsupported_content_type: "error: completion_summary_not_updated",
      too_short: "error: completion_summary_not_updated",
      analysis_error: "error: completion_summary_failed",
      null: "error: completion_summary_not_updated",
    });
  });
}

test("every message the tray can show exists in every locale", () => {
  const keys = new Set(
    PHASES.flatMap((phase) =>
      STATUSES.map(
        (status) => describePolicyRunCompletion(phase, status).messageKey
      )
    )
  );
  const localesDir = new URL("../../locales/", import.meta.url);
  const files = readdirSync(localesDir).filter((f) => f.endsWith(".json"));
  assert.ok(files.includes("en.json"));
  for (const file of files) {
    const messages = JSON.parse(
      readFileSync(new URL(file, localesDir), "utf8")
    ) as { app_detail: { policy_run: Record<string, unknown> } };
    for (const key of keys) {
      const value = messages.app_detail.policy_run[key];
      assert.equal(typeof value, "string", `${file}: policy_run.${key}`);
      assert.ok((value as string).trim(), `${file}: policy_run.${key}`);
    }
  }
});
