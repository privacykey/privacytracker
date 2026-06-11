import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  isRegistered,
  REGISTERED_CAPTIONS,
  renderVignette,
  type VignetteSeverity,
} from "../app/components/vignettes/registry";
import { CATEGORY_META, SEVERITY_CONFIG } from "../lib/privacy-meta";

// The registry powers every <DataLabelHint> in the app — most visibly the
// per-row hover hints in the privacy profile editor, where the severity
// follows the tier the user selects. These tests pin the contract so
// that adding a new Apple category (or severity) to the app without also
// wiring its vignette fails CI rather than silently rendering no hint.

// Source of truth for "which categories/severities the app knows about"
// lives in privacy-meta, NOT in the registry — so cross-referencing here
// catches drift in either direction.
const CATEGORIES = Object.keys(CATEGORY_META);
const SEVERITIES = Object.keys(SEVERITY_CONFIG) as VignetteSeverity[];

// The not-linked tier renders a self-contained full-stage scene (raw log
// → strike → aggregate) with its own capture, so it deliberately has no
// shared left-hand motif. The other two tiers pair a capture motif with
// a destination.
const MOTIF_LESS_SEVERITY: VignetteSeverity = "DATA_NOT_LINKED_TO_YOU";

test("privacy-meta exposes the expected 14 categories × 3 severities", () => {
  assert.equal(
    CATEGORIES.length,
    14,
    `expected 14 Apple privacy categories, got ${CATEGORIES.length}`
  );
  assert.equal(
    SEVERITIES.length,
    3,
    `expected 3 severity tiers, got ${SEVERITIES.length}`
  );
});

test("every category × severity resolves to a renderable vignette", () => {
  for (const category of CATEGORIES) {
    for (const severity of SEVERITIES) {
      const scene = renderVignette(category, severity);
      assert.ok(
        scene,
        `renderVignette(${category}, ${severity}) returned null — missing registry entry`
      );
      assert.ok(
        scene.destination,
        `renderVignette(${category}, ${severity}) has no destination node`
      );
    }
  }
});

test("motif is present for track + linked and absent for not-linked", () => {
  for (const category of CATEGORIES) {
    for (const severity of SEVERITIES) {
      const scene = renderVignette(category, severity);
      assert.ok(scene);
      if (severity === MOTIF_LESS_SEVERITY) {
        assert.equal(
          scene.motif,
          null,
          `${category}/${severity} should be a full-stage scene with motif=null`
        );
      } else {
        assert.ok(
          scene.motif,
          `${category}/${severity} should pair a capture motif with its destination`
        );
      }
    }
  }
});

test("isRegistered agrees with renderVignette for every known pair", () => {
  for (const category of CATEGORIES) {
    for (const severity of SEVERITIES) {
      assert.equal(
        isRegistered(category, severity),
        Boolean(renderVignette(category, severity)),
        `isRegistered and renderVignette disagree for ${category}/${severity}`
      );
    }
  }
});

test("REGISTERED_CAPTIONS covers exactly the app's categories — no gaps, no extras", () => {
  const registeredKeys = Object.keys(REGISTERED_CAPTIONS).sort();
  assert.deepEqual(
    registeredKeys,
    [...CATEGORIES].sort(),
    "REGISTERED_CAPTIONS keys must match CATEGORY_META exactly"
  );
  for (const category of CATEGORIES) {
    const set =
      REGISTERED_CAPTIONS[category as keyof typeof REGISTERED_CAPTIONS];
    assert.ok(set, `REGISTERED_CAPTIONS missing ${category}`);
    for (const severity of SEVERITIES) {
      assert.ok(
        set?.has(severity),
        `REGISTERED_CAPTIONS[${category}] missing ${severity}`
      );
    }
  }
});

test("every registered pair has a non-empty caption in en.json", () => {
  const en = JSON.parse(
    readFileSync(join(process.cwd(), "locales/en.json"), "utf8")
  ) as {
    data_label_hint: { captions: Record<string, Record<string, string>> };
  };
  const captions = en.data_label_hint.captions;
  for (const category of CATEGORIES) {
    const catKey = category.toLowerCase();
    assert.ok(captions[catKey], `en.json missing captions.${catKey}`);
    for (const severity of SEVERITIES) {
      const sevKey = severity.toLowerCase();
      const text = captions[catKey]?.[sevKey];
      assert.equal(
        typeof text,
        "string",
        `en.json missing captions.${catKey}.${sevKey}`
      );
      assert.ok(
        (text ?? "").trim().length > 0,
        `en.json captions.${catKey}.${sevKey} is empty`
      );
    }
  }
});

test("unknown identifiers and severities resolve to null / unregistered", () => {
  assert.equal(renderVignette("NOT_A_CATEGORY", "DATA_LINKED_TO_YOU"), null);
  assert.equal(renderVignette("LOCATION", "DATA_SHARED_WITH_ALIENS"), null);
  assert.equal(isRegistered("NOT_A_CATEGORY", "DATA_LINKED_TO_YOU"), false);
  assert.equal(isRegistered("LOCATION", "DATA_SHARED_WITH_ALIENS"), false);
});
