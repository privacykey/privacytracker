import assert from "node:assert/strict";
import test from "node:test";
import {
  appIdOfAppStoreUrl,
  canonicalAppStoreUrl,
  checkAlternateUrl,
  isAlternateUrlRejection,
  MAX_ALTERNATE_URLS,
  withAlternateUrl,
  withoutAlternateUrl,
} from "../../lib/wayback-alternate-urls";

const OLD = "https://apps.apple.com/us/app/old-name/id389801252";

test("App Store product addresses are spelled one way", () => {
  assert.equal(canonicalAppStoreUrl(OLD), OLD);
  assert.equal(canonicalAppStoreUrl(`  ${OLD}/  `), OLD);
  assert.equal(canonicalAppStoreUrl(`${OLD}?l=en&platform=iphone#x`), OLD);
  assert.equal(
    canonicalAppStoreUrl("apps.apple.com/us/app/old-name/id389801252"),
    OLD
  );
  assert.equal(
    canonicalAppStoreUrl("http://APPS.apple.com/us/app/old-name/id389801252"),
    OLD
  );
  assert.equal(
    canonicalAppStoreUrl("https://apps.apple.com/app/id389801252"),
    "https://apps.apple.com/app/id389801252"
  );
});

test("anything that is not an App Store product page is refused", () => {
  for (const raw of [
    "",
    "   ",
    "not a url",
    "https://itunes.apple.com/us/app/old-name/id389801252",
    "https://apps.apple.com.evil.example/us/app/x/id389801252",
    "https://evil.example/apps.apple.com/us/app/x/id389801252",
    "https://user@apps.apple.com/us/app/x/id389801252",
    "https://apps.apple.com:8443/us/app/x/id389801252",
    "ftp://apps.apple.com/us/app/x/id389801252",
    "https://apps.apple.com/us/app/old-name",
    "https://apps.apple.com/us/app/old-name/id389801252/reviews",
    "javascript:alert(1)",
  ]) {
    assert.equal(canonicalAppStoreUrl(raw), null, raw);
  }
});

test("the app id is read from the end of the address", () => {
  assert.equal(appIdOfAppStoreUrl(OLD), "389801252");
  assert.equal(appIdOfAppStoreUrl(`${OLD}?mt=8`), "389801252");
  assert.equal(appIdOfAppStoreUrl("https://example.com/id389801252"), null);
});

test("an older address must be this app's, new, and within the limit", () => {
  const base = { appId: "389801252", existing: [] as string[] };
  assert.deepEqual(checkAlternateUrl(`${OLD}?l=en`, base), {
    ok: true,
    url: OLD,
  });
  assert.deepEqual(checkAlternateUrl("instagram", base), {
    ok: false,
    problem: "not_app_store",
  });
  assert.deepEqual(
    checkAlternateUrl("https://apps.apple.com/us/app/other/id1", base),
    { ok: false, problem: "other_app" }
  );
  // Already an older address, or the address the import looked up,
  // however it is spelled.
  assert.deepEqual(
    checkAlternateUrl(`${OLD}/?l=en`, { ...base, existing: [OLD] }),
    { ok: false, problem: "duplicate" }
  );
  assert.deepEqual(
    checkAlternateUrl("https://apps.apple.com/us/app/Old-Name/id389801252", {
      ...base,
      existing: [OLD],
    }),
    { ok: false, problem: "duplicate" }
  );
  assert.deepEqual(
    checkAlternateUrl(OLD, { ...base, lookupUrl: `${OLD}?l=en` }),
    { ok: false, problem: "duplicate" }
  );
  const full = [
    "https://apps.apple.com/gb/app/a/id389801252",
    "https://apps.apple.com/au/app/b/id389801252",
    "https://apps.apple.com/ca/app/c/id389801252",
  ];
  assert.equal(full.length, MAX_ALTERNATE_URLS);
  assert.deepEqual(checkAlternateUrl(OLD, { ...base, existing: full }), {
    ok: false,
    problem: "limit",
  });
});

test("the list to post adds or removes one address", () => {
  const other = "https://apps.apple.com/gb/app/a/id389801252";
  assert.deepEqual(withAlternateUrl([other], OLD), [other, OLD]);
  assert.deepEqual(withoutAlternateUrl([other, OLD], OLD), [other]);
  // Removing the last one posts an empty list, which clears them.
  assert.deepEqual(withoutAlternateUrl([OLD], OLD), []);
});

test("the route's refusal is told apart from other errors", () => {
  assert.equal(
    isAlternateUrlRejection({ code: "invalid_alternate_url", error: "x" }),
    true
  );
  assert.equal(isAlternateUrlRejection({ code: "archive_unavailable" }), false);
  assert.equal(isAlternateUrlRejection(null), false);
  assert.equal(isAlternateUrlRejection(undefined), false);
});
