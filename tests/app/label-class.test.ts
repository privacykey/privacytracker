/**
 * Apple's privacy-label classes have one vocabulary, one colour and one
 * chip. This pins the contract behind `LabelClassChip`:
 *
 *   - `lib/label-class.ts` maps every identifier the UI meets onto one of
 *     the four classes, and the change-review severities onto three;
 *   - every class has its short word, its count form and its hover
 *     sentence in BOTH locale bundles, plus the full Apple name under
 *     `severity.*` (the chip's `title`);
 *   - every class's `severity-*` colour rule exists in globals.css, and
 *     nothing else in the stylesheet colours a class chip (the old
 *     per-surface chip families stay gone).
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  LABEL_CLASS_META,
  LABEL_CLASSES,
  labelClassFromChangeSeverity,
  labelClassFromIdentifier,
} from "../../lib/label-class";
import { TIER_META } from "../../lib/privacy-profile";

const root = process.cwd();
const en = JSON.parse(
  readFileSync(path.join(root, "locales", "en.json"), "utf8")
) as Record<string, Record<string, string>>;
const zh = JSON.parse(
  readFileSync(path.join(root, "locales", "zh.json"), "utf8")
) as Record<string, Record<string, string>>;
const globalsCss = readFileSync(path.join(root, "app", "globals.css"), "utf8");

test("every Apple identifier maps onto exactly one class", () => {
  assert.equal(labelClassFromIdentifier("DATA_USED_TO_TRACK_YOU"), "tracking");
  assert.equal(labelClassFromIdentifier("DATA_LINKED_TO_YOU"), "linked");
  assert.equal(
    labelClassFromIdentifier("DATA_NOT_LINKED_TO_YOU"),
    "not_linked"
  );
  assert.equal(labelClassFromIdentifier("DATA_NOT_COLLECTED"), "not_collected");
  assert.equal(labelClassFromIdentifier("SOMETHING_ELSE"), null);
  assert.equal(labelClassFromIdentifier(null), null);
  for (const cls of LABEL_CLASSES) {
    assert.equal(
      labelClassFromIdentifier(LABEL_CLASS_META[cls].identifier),
      cls
    );
  }
});

test("the change-review severities map onto three classes and none", () => {
  assert.equal(labelClassFromChangeSeverity("track"), "tracking");
  assert.equal(labelClassFromChangeSeverity("linked"), "linked");
  assert.equal(labelClassFromChangeSeverity("unlinked"), "not_linked");
  assert.equal(labelClassFromChangeSeverity("none"), null);
});

test("both locales carry the short word, count form and hover sentence", () => {
  for (const bundle of [en, zh]) {
    for (const cls of LABEL_CLASSES) {
      assert.equal(typeof bundle.label_class[cls], "string", cls);
      const count = bundle.label_class[`count_${cls}`];
      assert.equal(typeof count, "string", `count_${cls}`);
      // The numeral is wrapped so the chip can style it; a count form
      // without the tag would render the number as plain text.
      assert.match(count, /<num>.*<\/num>/, `count_${cls} wraps its numeral`);
      assert.equal(
        typeof bundle.label_class[`title_count_${cls}`],
        "string",
        `title_count_${cls}`
      );
      assert.equal(
        typeof bundle.severity[LABEL_CLASS_META[cls].severityKey],
        "string",
        `severity.${LABEL_CLASS_META[cls].severityKey}`
      );
    }
    // The mismatch sentence names both classes through chips.
    assert.match(
      bundle.privacy_profile_mismatch_sentence.template_rich,
      /<obs>.*<\/obs>.*<allow>.*<\/allow>/
    );
    assert.match(bundle.shortlist.match_row_allowed, /<allow>.*<\/allow>/);
  }
});

test("the short words are sentence case and carry no dash", () => {
  for (const cls of LABEL_CLASSES) {
    const word = en.label_class[cls];
    assert.equal(word[0], word[0].toUpperCase(), word);
    assert.equal(word.slice(1), word.slice(1).toLowerCase(), word);
    assert.doesNotMatch(word, /[—–]/, word);
  }
});

test("every class has its one colour rule in globals.css", () => {
  for (const cls of LABEL_CLASSES) {
    const rule = new RegExp(
      `\\.${LABEL_CLASS_META[cls].severityCls}\\s*\\{[^}]*color:[^}]*background:[^}]*\\}`
    );
    assert.match(globalsCss, rule, LABEL_CLASS_META[cls].severityCls);
  }
  // The profile tiers point at the same four rules.
  for (const cls of LABEL_CLASSES) {
    assert.equal(TIER_META[cls].severityCls, LABEL_CLASS_META[cls].severityCls);
  }
});

test("no surface keeps its own chip colours", () => {
  for (const dead of [
    ".risk-chip {",
    ".risk-chip-track",
    ".home-row-chip",
    ".change-review-sev-chip-track",
    ".compare-slot-chip-declared {",
  ]) {
    assert.equal(globalsCss.includes(dead), false, dead);
  }
  const reviewQueueCss = readFileSync(
    path.join(root, "app", "components", "review-queue.css"),
    "utf8"
  );
  assert.equal(reviewQueueCss.includes(".review-queue-card-chip-track"), false);
});
