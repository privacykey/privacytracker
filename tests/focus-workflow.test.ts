import assert from "node:assert/strict";
import test from "node:test";
import { GET, POST } from "../app/api/focus/route";
import { activeGoalsFrom } from "../lib/feature-flag-rules";
import {
  inferFocusWorkflow,
  isFocusWorkflow,
  workflowAllowsAuditBundle,
} from "../lib/focus-workflow";
import { getSetting, setSetting } from "../lib/scheduler";

test("focus workflow validation and inference are conservative", () => {
  assert.equal(isFocusWorkflow("self_monitor"), true);
  assert.equal(isFocusWorkflow("other_handoff"), true);
  assert.equal(isFocusWorkflow("unknown"), false);
  assert.equal(
    inferFocusWorkflow({
      audience: "self",
      understand: true,
      declutter: false,
      minimal: false,
    }),
    "self_monitor"
  );
  assert.equal(
    inferFocusWorkflow({
      audience: "self",
      understand: false,
      declutter: true,
      minimal: false,
    }),
    "self_cleanup"
  );
  assert.equal(
    inferFocusWorkflow({
      audience: "loved_one",
      understand: true,
      declutter: true,
      minimal: false,
    }),
    "custom"
  );
  assert.equal(workflowAllowsAuditBundle("other_handoff"), true);
  assert.equal(workflowAllowsAuditBundle("other_monitor"), false);
});

test("/api/focus infers workflow when omitted and returns explicit workflow when provided", async () => {
  const keys = [
    "flag.focus.audience",
    "flag.focus.goal.understand",
    "flag.focus.goal.declutter",
    "flag.focus.goal.minimal",
    "flag.focus.goal.accessibility",
    "flag.focus.workflow",
  ];
  const prior = new Map(keys.map((key) => [key, getSetting(key, "")]));
  try {
    for (const key of keys) {
      setSetting(key, "");
    }

    const inferred = await POST(
      new Request("http://127.0.0.1/api/focus", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          audience: "self",
          declutter: true,
        }),
      }) as Parameters<typeof POST>[0]
    );
    assert.equal(inferred.status, 200);
    const inferredBody = await inferred.json();
    assert.equal(inferredBody.workflow, "self_cleanup");
    assert.equal(getSetting("flag.focus.workflow", ""), "self_cleanup");

    const explicit = await POST(
      new Request("http://127.0.0.1/api/focus", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          audience: "guardian",
          understand: true,
          declutter: true,
          workflow: "other_monitor",
        }),
      }) as Parameters<typeof POST>[0]
    );
    assert.equal(explicit.status, 200);
    const explicitBody = await explicit.json();
    assert.equal(explicitBody.workflow, "other_monitor");

    const getRes = await GET();
    const getBody = await getRes.json();
    assert.equal(getBody.workflow, "other_monitor");
    assert.deepEqual(
      activeGoalsFrom({
        understand: getBody.understand,
        declutter: getBody.declutter,
        minimal: getBody.minimal,
        accessibility: getBody.accessibility,
      }),
      new Set(["understand", "declutter"])
    );
  } finally {
    for (const [key, value] of prior) {
      setSetting(key, value);
    }
  }
});
