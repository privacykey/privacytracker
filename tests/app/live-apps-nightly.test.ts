import assert from "node:assert/strict";
import test from "node:test";
import { fetchAndParseApp, getAppWithPrivacy } from "../../lib/scraper";
import { resetTestDb } from "../helpers/test-db";

const RUN_NIGHTLY_LIVE_TESTS = process.env.RUN_NIGHTLY_LIVE_TESTS === "1";

const LIVE_APPS = [
  {
    id: "1584215688",
    name: /clock/i,
    url: "https://apps.apple.com/us/app/clock/id1584215688",
    expectPrivacyLabels: false,
  },
  {
    id: "874139669",
    name: /signal/i,
    url: "https://apps.apple.com/us/app/signal-private-messenger/id874139669",
    expectPrivacyLabels: true,
  },
  {
    id: "389801252",
    name: /instagram/i,
    url: "https://apps.apple.com/us/app/instagram/id389801252",
    expectPrivacyLabels: true,
  },
] as const;

for (const appFixture of LIVE_APPS) {
  test(`nightly live App Store import: ${appFixture.id}`, {
    skip: RUN_NIGHTLY_LIVE_TESTS
      ? false
      : "Set RUN_NIGHTLY_LIVE_TESTS=1 to hit the live App Store.",
  }, async () => {
    resetTestDb();

    const result = await fetchAndParseApp(
      appFixture.url,
      false,
      false,
      "manual"
    );

    assert.equal(result.status, "success");
    assert.equal(result.id, appFixture.id);

    const app = getAppWithPrivacy(appFixture.id) as {
      name?: string;
      privacyTypes?: Array<{ categories?: unknown[] }>;
    } | null;
    assert.ok(app);
    assert.match(app.name ?? "", appFixture.name);
    assert.ok(Array.isArray(app.privacyTypes));
    if (appFixture.expectPrivacyLabels) {
      assert.ok(
        app.privacyTypes.some((type) => (type.categories?.length ?? 0) > 0),
        "expected at least one privacy-label category"
      );
    }
  });
}
