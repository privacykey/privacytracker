import assert from "node:assert/strict";
import test from "node:test";
import {
  getAccessibilityProfile,
  saveAccessibilityProfile,
} from "../lib/accessibility-profile-server";
import { createAnnotation, listAnnotations } from "../lib/annotations";
import { buildAuditBundle } from "../lib/audit-bundle";
import { exportBackup, restoreBackup } from "../lib/backup";
import db from "../lib/db";
import { addImportItems, createImport, getImport } from "../lib/imports";
import {
  getPrivacyProfile,
  savePrivacyProfile,
} from "../lib/privacy-profile-server";
import { setSetting } from "../lib/scheduler";
import {
  getAllApps,
  getAppWithPrivacy,
  getGroupedPrivacyView,
} from "../lib/scraper";
import {
  resetTestDb,
  seedAccessibilityFeature,
  seedPrivacyCategory,
  seedTrackedApp,
} from "./test-db";

test.beforeEach(resetTestDb);

test("profile routes sanitise invalid keys and clear saved profiles", async () => {
  const privacyRoute = await import("../app/api/privacy-profile/route");
  const a11yRoute = await import("../app/api/accessibility-profile/route");

  const privacyPut = await privacyRoute.PUT(
    jsonRequest("/api/privacy-profile", {
      profile: {
        LOCATION: "not_linked",
        NOT_A_CATEGORY: "tracking",
        CONTACT_INFO: "not_a_tier",
      },
    })
  );
  assert.equal(privacyPut.status, 200);
  assert.deepEqual((await privacyPut.json()).profile, {
    LOCATION: "not_linked",
  });

  const privacyGet = await privacyRoute.GET();
  assert.deepEqual((await privacyGet.json()).profile, {
    LOCATION: "not_linked",
  });

  const a11yPut = await a11yRoute.PUT(
    jsonRequest("/api/accessibility-profile", {
      profile: {
        voiceover: "required",
        made_up_feature: "required",
        captions: "invalid",
      },
    })
  );
  assert.equal(a11yPut.status, 200);
  assert.deepEqual((await a11yPut.json()).profile, { voiceover: "required" });

  const clear = await privacyRoute.PUT(
    jsonRequest("/api/privacy-profile", { profile: null })
  );
  assert.equal(clear.status, 200);
  assert.equal((await clear.json()).profile, null);
});

test("backup restore round-trips apps, profiles, annotations, summaries, imports, and labels", () => {
  seedTrackedApp({
    id: "backup-app",
    name: "Backup Fixture",
    developer: "Backup Labs",
    privacyPolicyUrl: "https://example.com/backup-privacy",
  });
  seedPrivacyCategory({
    appId: "backup-app",
    typeIdentifier: "DATA_LINKED_TO_YOU",
    typeTitle: "Data Linked to You",
    categoryIdentifier: "CONTACT_INFO",
    categoryTitle: "Contact Info",
  });
  seedAccessibilityFeature({
    appId: "backup-app",
    identifier: "voiceover",
    title: "VoiceOver",
  });
  createAnnotation({
    appId: "backup-app",
    content: "Exportable note",
    visibility: "export",
    tag: "positive",
  });
  createAnnotation({
    appId: "backup-app",
    content: "Private note",
    visibility: "private",
    tag: "concern",
  });
  savePrivacyProfile({ CONTACT_INFO: "linked" });
  saveAccessibilityProfile({ voiceover: "required" });
  setSetting("ai_api_key", "should-not-leave-backup");
  db.prepare(`
    INSERT INTO privacy_policy_analyses (
      app_id, policy_url, status, source_text, source_word_count,
      source_origin, source_final_url, content_hash, analysis_mode,
      summary_json, model, updated_at, source_fetched_at
    )
    VALUES (?, ?, 'ready', ?, 500, 'direct', ?, 'hash-backup', 'direct', ?, 'fixture-model', ?, ?)
  `).run(
    "backup-app",
    "https://example.com/backup-privacy",
    "Privacy policy source text ".repeat(120),
    "https://example.com/backup-privacy",
    JSON.stringify({ overview: "Backup summary", highlights: [], lenses: [] }),
    Date.now(),
    Date.now()
  );
  const batch = createImport({
    source: "file",
    sourceLabel: "backup.csv",
    total: 1,
  });
  addImportItems(batch.id, [
    {
      query: "Backup Fixture",
      status: "imported",
      appId: "backup-app",
      appName: "Backup Fixture",
      url: "https://apps.apple.com/us/app/backup/idbackup-app",
    },
  ]);

  const envelope = exportBackup();
  assert.equal(
    JSON.stringify(envelope).includes("should-not-leave-backup"),
    false
  );

  resetTestDb();
  const restored = restoreBackup(envelope, { actorIp: "backup-test" });

  assert.ok(restored.totalRows > 0);
  const app = getAppWithPrivacy("backup-app") as {
    policyAnalysis?: { summary?: { overview?: string } | null };
    privacyTypes: Array<{ categories: Array<{ identifier: string }> }>;
    accessibilityFeatures: Array<{ identifier: string }>;
  } | null;
  assert.ok(app);
  assert.deepEqual(
    app.privacyTypes[0].categories.map((category) => category.identifier),
    ["CONTACT_INFO"]
  );
  assert.deepEqual(
    app.accessibilityFeatures.map((feature) => feature.identifier),
    ["voiceover"]
  );
  assert.equal(app.policyAnalysis?.summary?.overview, "Backup summary");
  assert.deepEqual(getPrivacyProfile(), { CONTACT_INFO: "linked" });
  assert.deepEqual(getAccessibilityProfile(), { voiceover: "required" });
  assert.equal(listAnnotations("backup-app").length, 2);
  assert.equal(getImport(batch.id)?.items[0].status, "imported");
});

test("audit bundle excludes private annotations while preserving exportable context", () => {
  seedTrackedApp({ id: "audit-app", name: "Audit Fixture" });
  seedPrivacyCategory({
    appId: "audit-app",
    typeIdentifier: "DATA_NOT_LINKED_TO_YOU",
    typeTitle: "Data Not Linked to You",
    categoryIdentifier: "DIAGNOSTICS",
    categoryTitle: "Diagnostics",
  });
  seedAccessibilityFeature({
    appId: "audit-app",
    identifier: "captions",
    title: "Captions",
  });
  savePrivacyProfile({ DIAGNOSTICS: "not_linked" });
  createAnnotation({
    appId: "audit-app",
    content: "Share this note",
    visibility: "export",
  });
  createAnnotation({
    appId: "audit-app",
    content: "Keep this private",
    visibility: "private",
  });

  const bundle = buildAuditBundle({ recommenderName: "Tester" });

  assert.equal(bundle.apps.length, 1);
  assert.equal(bundle.apps[0].privacy_types.length, 1);
  assert.deepEqual(
    bundle.apps[0].accessibility_features.map((feature) => ({
      identifier: feature.identifier,
      declared: feature.declared,
    })),
    [{ identifier: "captions", declared: true }]
  );
  assert.deepEqual(bundle.recommender_profile, { DIAGNOSTICS: "not_linked" });
  assert.deepEqual(
    bundle.annotations.map((annotation) => annotation.content),
    ["Share this note"]
  );
});

test("dashboard/detail data helpers load seeded app privacy and accessibility data", () => {
  seedTrackedApp({ id: "ui-app", name: "UI Fixture" });
  seedPrivacyCategory({
    appId: "ui-app",
    typeIdentifier: "DATA_USED_TO_TRACK_YOU",
    typeTitle: "Data Used to Track You",
    categoryIdentifier: "LOCATION",
    categoryTitle: "Location",
  });
  seedAccessibilityFeature({
    appId: "ui-app",
    identifier: "voiceover",
    title: "VoiceOver",
  });

  const apps = getAllApps() as Array<{
    id: string;
    categoryCount: number;
    accessibilityCount: number;
  }>;
  assert.equal(apps.length, 1);
  assert.equal(apps[0].categoryCount, 1);
  assert.equal(apps[0].accessibilityCount, 1);

  const detail = getAppWithPrivacy("ui-app") as {
    privacyTypes: Array<{ identifier: string }>;
    accessibilityFeatures: Array<{ identifier: string }>;
  } | null;
  assert.equal(detail?.privacyTypes[0].identifier, "DATA_USED_TO_TRACK_YOU");
  assert.equal(detail?.accessibilityFeatures[0].identifier, "voiceover");

  const grouped = getGroupedPrivacyView() as Array<{
    identifier: string;
    categories: Array<{ identifier: string; apps: Array<{ id: string }> }>;
  }>;
  assert.equal(grouped[0].identifier, "DATA_USED_TO_TRACK_YOU");
  assert.equal(grouped[0].categories[0].identifier, "LOCATION");
  assert.equal(grouped[0].categories[0].apps[0].id, "ui-app");
});

function jsonRequest(path: string, body: unknown): Request {
  return new Request(`http://127.0.0.1${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
