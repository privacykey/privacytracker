import assert from "node:assert/strict";
import test from "node:test";
import { fetchAndParseApp, getAppWithPrivacy } from "../../lib/scraper";
import { resetTestDb } from "../helpers/test-db";

const CLOCK_URL = "https://apps.apple.com/us/app/clock/id1584215688";
const RUN_LIVE_TESTS = process.env.RUN_LIVE_TESTS === "1";

test("live Clock App Store smoke test imports the real Apple listing", {
  skip: RUN_LIVE_TESTS
    ? false
    : "Set RUN_LIVE_TESTS=1 to hit the live App Store.",
}, async () => {
  resetTestDb();

  const result = await fetchAndParseApp(CLOCK_URL, false, false, "manual");

  assert.equal(result.status, "success");
  assert.equal(result.id, "1584215688");

  const app = getAppWithPrivacy("1584215688") as {
    name?: string;
    url?: string;
    privacyTypes?: unknown[];
  } | null;
  assert.ok(app);
  assert.equal(app.url, CLOCK_URL);
  assert.match(app.name ?? "", /clock/i);
  assert.ok(Array.isArray(app.privacyTypes));
});
