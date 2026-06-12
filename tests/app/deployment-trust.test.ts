import assert from "node:assert/strict";
import test from "node:test";
import {
  bindIsAmbiguous,
  clientIpFromHeaders,
  effectiveHostFromHeaders,
  isHostAllowed,
  isLoopbackHost,
  isNetworkExposed,
  normalizeHost,
} from "../../lib/deployment-trust";
import {
  _resetLoginBruteForce,
  loginBruteForceTripped,
  rateLimitKeyForRequest,
  recordLoginFailure,
} from "../../lib/security";

/**
 * `lib/deployment-trust` is read directly from `process.env` on every call
 * (no cache), so these tests just set/restore the relevant vars around each
 * assertion. The trust vars are NOT set by the test env, so the baseline is
 * the loopback-only default.
 */
const TRUST_VARS = [
  "PRIVACYTRACKER_ALLOWED_HOSTS",
  "PRIVACYTRACKER_TRUST_PROXY",
  "PRIVACYTRACKER_NETWORK_EXPOSED",
  "PRIVACYTRACKER_BIND_HOST",
  "HOSTNAME",
];

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const saved = new Map<string, string | undefined>();
  // Clear all trust vars first so each case starts from a known baseline,
  // then apply the overrides for this case.
  for (const k of TRUST_VARS) {
    saved.set(k, process.env[k]);
    delete process.env[k];
  }
  for (const [k, v] of Object.entries(vars)) {
    if (!saved.has(k)) {
      saved.set(k, process.env[k]);
    }
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  try {
    fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  }
}

function headers(init: Record<string, string>): Headers {
  return new Headers(init);
}

test("normalizeHost strips port, brackets, zone id and trailing dot", () => {
  assert.equal(normalizeHost("EXAMPLE.COM:8080"), "example.com");
  assert.equal(normalizeHost("[::1]:3000"), "::1");
  assert.equal(normalizeHost("[fe80::1%eth0]"), "fe80::1");
  assert.equal(normalizeHost("127.0.0.1."), "127.0.0.1");
  assert.equal(normalizeHost("::1"), "::1");
  assert.equal(normalizeHost("  "), null);
  assert.equal(normalizeHost(null), null);
});

test("isLoopbackHost covers all of 127/8, ::1, ::, 0.0.0.0 and localhost", () => {
  for (const h of [
    "127.0.0.1",
    "127.0.0.5",
    "127.1.2.3:3000",
    "localhost",
    "app.localhost",
    "[::1]:3000",
    "::",
    "0.0.0.0",
  ]) {
    assert.equal(isLoopbackHost(h), true, `${h} should be loopback`);
  }
  for (const h of ["10.0.0.1", "192.168.1.5", "nas.lan", "evil.example"]) {
    assert.equal(isLoopbackHost(h), false, `${h} should NOT be loopback`);
  }
});

test("isHostAllowed: loopback always allowed; env list only ADDS hosts", () => {
  withEnv({}, () => {
    assert.equal(isHostAllowed("127.0.0.1:3000"), true);
    assert.equal(isHostAllowed("localhost"), true);
    assert.equal(isHostAllowed("[::1]:3000"), true);
    assert.equal(isHostAllowed("evil.example"), false);
    assert.equal(isHostAllowed(null), false);
  });

  withEnv({ PRIVACYTRACKER_ALLOWED_HOSTS: "nas.lan, 192.168.1.50" }, () => {
    assert.equal(isHostAllowed("nas.lan:3000"), true);
    assert.equal(isHostAllowed("192.168.1.50"), true);
    // Loopback is STILL allowed (append, not replace) — healthcheck invariant.
    assert.equal(isHostAllowed("127.0.0.1:3000"), true);
    assert.equal(isHostAllowed("other.lan"), false);
  });
});

test("isHostAllowed supports *.suffix wildcards", () => {
  withEnv({ PRIVACYTRACKER_ALLOWED_HOSTS: "*.lan" }, () => {
    assert.equal(isHostAllowed("a.lan"), true);
    assert.equal(isHostAllowed("a.b.lan"), true);
    assert.equal(isHostAllowed("lan"), true);
    assert.equal(isHostAllowed("nas.wan"), false);
  });
});

test("effectiveHostFromHeaders honours X-Forwarded-Host only behind a trusted proxy", () => {
  const h = headers({
    host: "internal:3000",
    "x-forwarded-host": "public.example",
  });
  withEnv({}, () => {
    assert.equal(effectiveHostFromHeaders(h), "internal:3000");
  });
  withEnv({ PRIVACYTRACKER_TRUST_PROXY: "1" }, () => {
    assert.equal(effectiveHostFromHeaders(h), "public.example");
  });
});

test("clientIpFromHeaders: null without a trusted proxy, rightmost hop with one", () => {
  const h = headers({ "x-forwarded-for": "1.1.1.1, 2.2.2.2, 3.3.3.3" });
  withEnv({}, () => {
    assert.equal(clientIpFromHeaders(h), null);
  });
  withEnv({ PRIVACYTRACKER_TRUST_PROXY: "1" }, () => {
    // Rightmost is the hop our trusted proxy appended; the leftmost is spoofable.
    assert.equal(clientIpFromHeaders(h), "3.3.3.3");
  });
  withEnv({ PRIVACYTRACKER_TRUST_PROXY: "1" }, () => {
    assert.equal(
      clientIpFromHeaders(headers({ "x-real-ip": "9.9.9.9" })),
      "9.9.9.9"
    );
    assert.equal(clientIpFromHeaders(headers({})), null);
  });
});

test("isNetworkExposed truth table", () => {
  withEnv({}, () => assert.equal(isNetworkExposed(), false));
  withEnv({ PRIVACYTRACKER_NETWORK_EXPOSED: "1" }, () =>
    assert.equal(isNetworkExposed(), true)
  );
  withEnv({ PRIVACYTRACKER_ALLOWED_HOSTS: "nas.lan" }, () =>
    assert.equal(isNetworkExposed(), true)
  );
  // A loopback-only allowlist does NOT count as exposure.
  withEnv({ PRIVACYTRACKER_ALLOWED_HOSTS: "127.0.0.1, localhost" }, () =>
    assert.equal(isNetworkExposed(), false)
  );
  // A wildcard bind (Docker's 0.0.0.0) is ambiguous, NOT exposed.
  withEnv({ PRIVACYTRACKER_BIND_HOST: "0.0.0.0" }, () =>
    assert.equal(isNetworkExposed(), false)
  );
  // A specific non-loopback bind IS exposure.
  withEnv({ PRIVACYTRACKER_BIND_HOST: "192.168.1.5" }, () =>
    assert.equal(isNetworkExposed(), true)
  );
  withEnv({ PRIVACYTRACKER_BIND_HOST: "127.0.0.1" }, () =>
    assert.equal(isNetworkExposed(), false)
  );
});

test("bindIsAmbiguous: wildcard or unknown bind, but not a classified one", () => {
  // A Docker-style HOSTNAME (random container id, not an IP) is unclassifiable.
  withEnv({ HOSTNAME: "a1b2c3d4e5f6" }, () => {
    assert.equal(bindIsAmbiguous(), true);
    // ...and crucially is NOT mistaken for exposure.
    assert.equal(isNetworkExposed(), false);
  });
  withEnv({ PRIVACYTRACKER_BIND_HOST: "0.0.0.0" }, () =>
    assert.equal(bindIsAmbiguous(), true)
  );
  withEnv({ PRIVACYTRACKER_BIND_HOST: "127.0.0.1" }, () =>
    assert.equal(bindIsAmbiguous(), false)
  );
  withEnv({ PRIVACYTRACKER_BIND_HOST: "192.168.1.5" }, () =>
    assert.equal(bindIsAmbiguous(), false)
  );
});

test("rateLimitKeyForRequest collapses X-Forwarded-For rotation to one bucket", () => {
  withEnv({}, () => {
    const a = rateLimitKeyForRequest(
      new Request("http://x/api", {
        headers: { "x-forwarded-for": "1.1.1.1" },
      }),
      "login"
    );
    const b = rateLimitKeyForRequest(
      new Request("http://x/api", {
        headers: { "x-forwarded-for": "2.2.2.2" },
      }),
      "login"
    );
    // Rotation can't multiply buckets — same key regardless of the spoofed IP.
    assert.equal(a, b);
    assert.equal(a, "login:local");
  });

  withEnv({ PRIVACYTRACKER_TRUST_PROXY: "1" }, () => {
    const a = rateLimitKeyForRequest(
      new Request("http://x/api", {
        headers: { "x-forwarded-for": "1.1.1.1" },
      }),
      "login"
    );
    const b = rateLimitKeyForRequest(
      new Request("http://x/api", {
        headers: { "x-forwarded-for": "2.2.2.2" },
      }),
      "login"
    );
    // Behind a trusted proxy, distinct clients get distinct buckets again.
    assert.notEqual(a, b);
  });
});

test("login brute-force backstop trips after the global limit and resets cleanly", () => {
  _resetLoginBruteForce();
  assert.equal(loginBruteForceTripped().tripped, false);

  // One under the limit is still allowed.
  for (let i = 0; i < 99; i += 1) {
    recordLoginFailure();
  }
  assert.equal(loginBruteForceTripped().tripped, false);

  // The 100th failure trips it, with a positive retry-after.
  recordLoginFailure();
  const verdict = loginBruteForceTripped();
  assert.equal(verdict.tripped, true);
  assert.ok(verdict.retryAfterMs > 0);

  _resetLoginBruteForce();
  assert.equal(loginBruteForceTripped().tripped, false);
});
