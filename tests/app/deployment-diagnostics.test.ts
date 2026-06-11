import assert from "node:assert/strict";
import test from "node:test";
import {
  inferDeploymentNetwork,
  isLocalOnlyHost,
} from "../../lib/deployment-diagnostics";

test("isLocalOnlyHost recognises localhost forms", () => {
  assert.equal(isLocalOnlyHost("localhost:3000"), true);
  assert.equal(isLocalOnlyHost("privacytracker.localhost"), true);
  assert.equal(isLocalOnlyHost("127.0.0.1:3000"), true);
  assert.equal(isLocalOnlyHost("[::1]:3000"), true);
  assert.equal(isLocalOnlyHost("privacytracker.home.arpa"), false);
});

test("inferDeploymentNetwork detects reverse proxy headers", () => {
  const headers = new Headers({
    host: "privacytracker:3000",
    "x-forwarded-host": "privacytracker.home.arpa",
    "x-forwarded-proto": "https",
    "x-forwarded-for": "192.168.1.20",
  });

  const diag = inferDeploymentNetwork(headers);
  assert.equal(diag.host, "privacytracker.home.arpa");
  assert.equal(diag.proxyDetected, true);
  assert.equal(diag.protocol, "https");
  assert.equal(diag.localOnlyHost, false);
  assert.equal(diag.lanOrDomainHost, true);
  assert.equal(diag.forwardedForPresent, true);
});
