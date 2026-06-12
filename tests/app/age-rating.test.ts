import assert from "node:assert/strict";
import test from "node:test";
import {
  AGE_BAND_KEYS,
  AGE_BAND_META,
  type AgeBandKey,
  compareRatingToBand,
  isValidAgeBand,
  parseRatingMinAge,
} from "../../lib/age-rating";

// ── band metadata ─────────────────────────────────────────────────────

test("every band key has meta and the caps walk upward", () => {
  let prev = -1;
  for (const key of AGE_BAND_KEYS) {
    const meta = AGE_BAND_META[key];
    assert.ok(meta, `missing meta for ${key}`);
    assert.ok(
      meta.maxRatingAge > prev,
      `${key} cap (${meta.maxRatingAge}) should exceed the previous band's`
    );
    prev = meta.maxRatingAge;
  }
});

// Caps are pinned: the comparison is conservative (the cap is the rating
// suitable for the YOUNGEST age in the band). Changing these changes which
// apps get flagged for existing users — deliberate decisions only.
test("band caps are pinned to the conservative mapping", () => {
  assert.equal(AGE_BAND_META.under_9.maxRatingAge, 4);
  assert.equal(AGE_BAND_META["9_12"].maxRatingAge, 9);
  assert.equal(AGE_BAND_META["13_15"].maxRatingAge, 13);
  assert.equal(AGE_BAND_META["16_17"].maxRatingAge, 16);
  assert.equal(AGE_BAND_META["18_plus"].maxRatingAge, 99);
});

test("isValidAgeBand accepts every key and rejects junk", () => {
  for (const key of AGE_BAND_KEYS) {
    assert.ok(isValidAgeBand(key));
  }
  assert.equal(isValidAgeBand(""), false);
  assert.equal(isValidAgeBand("9-12"), false);
  assert.equal(isValidAgeBand(null), false);
  assert.equal(isValidAgeBand(undefined), false);
  assert.equal(isValidAgeBand(9), false);
});

// ── rating parsing ────────────────────────────────────────────────────

test("parseRatingMinAge reads current and legacy tiers", () => {
  // Current tiers (Apple's 2025 overhaul).
  assert.equal(parseRatingMinAge("4+"), 4);
  assert.equal(parseRatingMinAge("9+"), 9);
  assert.equal(parseRatingMinAge("13+"), 13);
  assert.equal(parseRatingMinAge("16+"), 16);
  assert.equal(parseRatingMinAge("18+"), 18);
  // Legacy tiers still present on old rows / Wayback-era data.
  assert.equal(parseRatingMinAge("12+"), 12);
  assert.equal(parseRatingMinAge("17+"), 17);
  // Storefront phrasing variants.
  assert.equal(parseRatingMinAge("Ages 13+"), 13);
  assert.equal(parseRatingMinAge(" 13+ "), 13);
});

test("parseRatingMinAge reads the Brazilian plus-prefix storefront format", () => {
  // The br storefront is the only one of the 48 iTunes storefronts that
  // puts the plus first (verified live 2026-06: WhatsApp '+12', Reddit
  // '+17', Minecraft '+9', Pages '+4'). Pin all four observed values.
  assert.equal(parseRatingMinAge("+4"), 4);
  assert.equal(parseRatingMinAge("+9"), 9);
  assert.equal(parseRatingMinAge("+12"), 12);
  assert.equal(parseRatingMinAge("+17"), 17);
  assert.equal(parseRatingMinAge("+18"), 18);
  assert.equal(parseRatingMinAge(" +12 "), 12);
});

test("parseRatingMinAge returns null on missing or unparseable input", () => {
  assert.equal(parseRatingMinAge(null), null);
  assert.equal(parseRatingMinAge(undefined), null);
  assert.equal(parseRatingMinAge(""), null);
  assert.equal(parseRatingMinAge("Not Rated"), null);
  assert.equal(parseRatingMinAge("13"), null); // no '+', not a rating string
  assert.equal(parseRatingMinAge("999+"), null); // out of range
});

// ── comparison matrix ─────────────────────────────────────────────────

test("compareRatingToBand full matrix on the current tiers", () => {
  const expectations: Record<AgeBandKey, Record<string, string>> = {
    under_9: {
      "4+": "within",
      "9+": "above",
      "13+": "above",
      "16+": "above",
      "18+": "above",
    },
    "9_12": {
      "4+": "within",
      "9+": "within",
      "13+": "above",
      "16+": "above",
      "18+": "above",
    },
    "13_15": {
      "4+": "within",
      "9+": "within",
      "13+": "within",
      "16+": "above",
      "18+": "above",
    },
    "16_17": {
      "4+": "within",
      "9+": "within",
      "13+": "within",
      "16+": "within",
      "18+": "above",
    },
    "18_plus": {
      "4+": "within",
      "9+": "within",
      "13+": "within",
      "16+": "within",
      "18+": "within",
    },
  };
  for (const band of AGE_BAND_KEYS) {
    for (const [rating, verdict] of Object.entries(expectations[band])) {
      assert.equal(
        compareRatingToBand(band, rating),
        verdict,
        `${band} × ${rating}`
      );
    }
  }
});

test("legacy 12+/17+ compare numerically", () => {
  // 12+ fits a 13–15 band but not a 9–12 one.
  assert.equal(compareRatingToBand("13_15", "12+"), "within");
  assert.equal(compareRatingToBand("9_12", "12+"), "above");
  // 17+ exceeds the 16–17 cap (16) — matches Apple's own 17+→18+ migration.
  assert.equal(compareRatingToBand("16_17", "17+"), "above");
  assert.equal(compareRatingToBand("18_plus", "17+"), "within");
});

test("unknown ratings never flag", () => {
  for (const band of AGE_BAND_KEYS) {
    assert.equal(compareRatingToBand(band, null), "unknown");
    assert.equal(compareRatingToBand(band, undefined), "unknown");
    assert.equal(compareRatingToBand(band, ""), "unknown");
    assert.equal(compareRatingToBand(band, "Not Rated"), "unknown");
  }
});
