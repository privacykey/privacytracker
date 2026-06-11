import assert from "node:assert/strict";
import test from "node:test";
import {
  computeAppA11yMismatch,
  getA11yBadgesByApp,
  getA11yMismatchedApps,
  saveAccessibilityProfile,
} from "../../lib/accessibility-profile-server";
import {
  computeAppMismatch,
  getMismatchedApps,
  getProfileBadgesByApp,
  savePrivacyProfile,
} from "../../lib/privacy-profile-server";
import {
  resetTestDb,
  seedAccessibilityFeature,
  seedPrivacyCategory,
  seedTrackedApp,
} from "../helpers/test-db";

test.beforeEach(resetTestDb);

test("privacy profiles compare saved preferences against stored App Store labels", () => {
  seedTrackedApp({ id: "profile-app", name: "Profile Fixture" });
  seedPrivacyCategory({
    appId: "profile-app",
    typeIdentifier: "DATA_USED_TO_TRACK_YOU",
    typeTitle: "Data Used to Track You",
    categoryIdentifier: "LOCATION",
    categoryTitle: "Location",
  });
  seedPrivacyCategory({
    appId: "profile-app",
    typeIdentifier: "DATA_LINKED_TO_YOU",
    typeTitle: "Data Linked to You",
    categoryIdentifier: "CONTACT_INFO",
    categoryTitle: "Contact Info",
  });

  savePrivacyProfile({
    LOCATION: "not_collected",
    CONTACT_INFO: "linked",
    DIAGNOSTICS: "tracking",
  });

  const mismatch = computeAppMismatch("profile-app");
  assert.equal(mismatch.profileActive, true);
  assert.equal(mismatch.count, 1);
  assert.equal(mismatch.totalGap, 3);
  assert.deepEqual(
    mismatch.mismatches.map((item) => ({
      category: item.category,
      allowed: item.allowed,
      observed: item.observed,
    })),
    [{ category: "LOCATION", allowed: "not_collected", observed: "tracking" }]
  );

  const mismatchedApps = getMismatchedApps();
  assert.equal(mismatchedApps.length, 1);
  assert.equal(mismatchedApps[0].appName, "Profile Fixture");

  const badge = getProfileBadgesByApp()["profile-app"];
  assert.equal(badge.kind, "mismatches");
  assert.equal(badge.tone, "bad");
  assert.equal(badge.worstCategory, "LOCATION");
});

test("accessibility profiles compare required and nice-to-have features against stored labels", () => {
  seedTrackedApp({ id: "a11y-app", name: "Accessibility Fixture" });
  seedAccessibilityFeature({
    appId: "a11y-app",
    identifier: "voiceover",
    title: "VoiceOver",
  });
  seedAccessibilityFeature({
    appId: "a11y-app",
    identifier: "captions",
    title: "Captions",
  });

  saveAccessibilityProfile({
    voiceover: "required",
    captions: "required",
    larger_text: "nice",
  });

  const mismatch = computeAppA11yMismatch("a11y-app");
  assert.equal(mismatch.profileActive, true);
  assert.equal(mismatch.count, 1);
  assert.equal(mismatch.missingRequired, 0);
  assert.equal(mismatch.totalGap, 1);
  assert.deepEqual(mismatch.missing, [
    { feature: "larger_text", preference: "nice" },
  ]);

  const mismatchedApps = getA11yMismatchedApps();
  assert.equal(mismatchedApps.length, 1);
  assert.equal(mismatchedApps[0].appName, "Accessibility Fixture");

  const badge = getA11yBadgesByApp()["a11y-app"];
  assert.equal(badge.kind, "missing_nice");
  assert.equal(badge.tone, "warn");
  assert.equal(badge.worstFeature, "larger_text");
});
