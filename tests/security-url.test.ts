import assert from "node:assert/strict";
import test from "node:test";
import {
  safeFetch,
  sanitizePolicyUrl,
  validateAppStoreUrl,
  validateExternalUrl,
} from "../lib/security";

test("validateAppStoreUrl only accepts App Store hosts with an Apple id segment", () => {
  assert.equal(
    validateAppStoreUrl("https://apps.apple.com/us/app/example/id123456789").ok,
    true
  );
  assert.equal(
    validateAppStoreUrl("https://itunes.apple.com/app/example/id123456789").ok,
    true
  );
  assert.equal(
    validateAppStoreUrl("https://apps.apple.com/us/app/example").ok,
    false
  );
  assert.equal(
    validateAppStoreUrl("https://example.com/us/app/example/id123456789").ok,
    false
  );
});

test("validateExternalUrl blocks private and non-http targets by default", () => {
  assert.equal(validateExternalUrl("javascript:alert(1)").ok, false);
  assert.equal(validateExternalUrl("file:///etc/passwd").ok, false);
  assert.equal(validateExternalUrl("http://localhost:3000").ok, false);
  assert.equal(
    validateExternalUrl("http://169.254.169.254/latest/meta-data").ok,
    false
  );
});

test("sanitizePolicyUrl persists only safe http(s) URLs", () => {
  assert.equal(
    sanitizePolicyUrl("https://example.com/privacy"),
    "https://example.com/privacy"
  );
  assert.equal(sanitizePolicyUrl("javascript:alert(1)"), "");
  assert.equal(sanitizePolicyUrl("http://127.0.0.1/privacy"), "");
});

test("safeFetch keeps unit tests offline while preserving explicit DNS checks", async () => {
  const originalFetch = global.fetch;
  global.fetch = (async () =>
    new Response("ok", {
      status: 200,
      headers: { "content-type": "text/plain" },
    })) as typeof fetch;
  try {
    const result = await safeFetch("https://example.invalid/privacy", {
      allowedHosts: ["example.invalid"],
      maxBytes: 32,
    });
    assert.equal(result.body.toString("utf8"), "ok");

    await assert.rejects(
      () =>
        safeFetch("https://example.invalid/privacy", {
          allowedHosts: ["example.invalid"],
          maxBytes: 32,
          resolveAndCheck: true,
        }),
      /did not resolve to a public address/
    );
  } finally {
    global.fetch = originalFetch;
  }
});
