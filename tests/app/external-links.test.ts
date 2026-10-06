/**
 * `externalHttpUrl` decides which clicked links the desktop app hands to
 * the system browser (ExternalLinkBridge). Everything that stays inside
 * the app must come back null, or the bridge would open the app's own
 * pages in Safari; everything that leaves must come back as an absolute
 * http(s) URL the shell plugin's `open` scope accepts.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { externalHttpUrl } from "../../lib/desktop";

const ORIGIN = "http://127.0.0.1:4321";

test("links that leave the app resolve to their absolute http(s) URL", () => {
  assert.equal(
    externalHttpUrl(
      "https://developer.apple.com/app-store/app-privacy-details/",
      ORIGIN
    ),
    "https://developer.apple.com/app-store/app-privacy-details/"
  );
  assert.equal(
    externalHttpUrl("http://example.com/privacy", ORIGIN),
    "http://example.com/privacy"
  );
  // A different port is a different origin, so it leaves the app too.
  assert.equal(
    externalHttpUrl("http://127.0.0.1:3000/", ORIGIN),
    "http://127.0.0.1:3000/"
  );
});

test("links that stay inside the app are left to the browser", () => {
  assert.equal(externalHttpUrl("/dashboard/stats", ORIGIN), null);
  assert.equal(externalHttpUrl("#what-changed", ORIGIN), null);
  assert.equal(externalHttpUrl(`${ORIGIN}/apps/123`, ORIGIN), null);
  assert.equal(externalHttpUrl("/api/export?format=csv", ORIGIN), null);
});

test("non-http schemes are never handed to the shell", () => {
  assert.equal(externalHttpUrl("mailto:security@example.com", ORIGIN), null);
  assert.equal(externalHttpUrl("javascript:alert(1)", ORIGIN), null);
  assert.equal(externalHttpUrl("privacytracker://pair?url=x", ORIGIN), null);
  assert.equal(externalHttpUrl("file:///etc/hosts", ORIGIN), null);
  assert.equal(externalHttpUrl("not a url", ORIGIN), null);
  assert.equal(externalHttpUrl("", ORIGIN), null);
});
