import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { isSameOriginRequest } from "../../lib/deployment-trust";
import { proxy } from "../../proxy";

const token = "network-auth-test-token";
let savedEnv: NodeJS.ProcessEnv;
test.beforeEach(() => {
  savedEnv = { ...process.env };
  process.env.AUDITOR_ADMIN_TOKEN = token;
  process.env.PRIVACYTRACKER_NETWORK_EXPOSED = "1";
  process.env.PRIVACYTRACKER_TRUST_PROXY = "";
});

test.afterEach(() => {
  process.env = savedEnv;
});

function request(
  path: string,
  method = "GET",
  headers: Record<string, string> = {}
) {
  return new NextRequest(`http://localhost:3000${path}`, {
    method,
    headers: { host: "localhost:3000", ...headers },
  });
}

test("all private reads, including future endpoints and HEAD, require authentication", () => {
  for (const path of [
    "/api/apps",
    "/api/annotations?appId=private",
    "/api/settings",
    "/api/new-private-route",
    "/api/health/private",
    "/api/auth/admin-token/status/private",
  ]) {
    for (const method of ["GET", "HEAD"]) {
      const res = proxy(request(path, method));
      assert.equal(res.status, 401, `${method} ${path}`);
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.equal(
        proxy(request(path, method, { cookie: `pt_admin_token=${token}` }))
          .status,
        200
      );
    }
  }
});

test("private pages and RSC requests redirect before rendering", () => {
  for (const path of [
    "/",
    "/welcome",
    "/dashboard",
    "/apps/private",
    "/privacy-policy",
  ]) {
    const res = proxy(
      request(path, "GET", { rsc: "1", "x-privacytracker-login": "1" })
    );
    assert.equal(res.status, 307);
    assert.equal(res.headers.get("location"), "http://localhost:3000/login");
  }
});

test("only exact public reads remain available without a token", () => {
  for (const path of [
    "/login",
    "/api/health",
    "/api/ready",
    "/api/auth/admin-token/status",
  ]) {
    assert.equal(proxy(request(path)).status, 200);
    assert.equal(
      proxy(request(path, "POST", { origin: "http://localhost:3000" })).status,
      path.startsWith("/api/") ? 401 : 307
    );
  }
});

test("cookies never exempt cross-origin or missing-origin mutations", () => {
  for (const origin of [
    "http://localhost:4000",
    "https://localhost:3000",
    "http://evil.localhost:3000",
    "null",
    "",
  ]) {
    const res = proxy(
      request("/api/ai/models", "POST", {
        cookie: `pt_admin_token=${token}`,
        origin,
      })
    );
    assert.equal(res.status, 403, origin);
  }
  assert.equal(
    proxy(
      request("/api/settings", "POST", {
        cookie: `pt_admin_token=${token}`,
        origin: "http://localhost:3000",
      })
    ).status,
    200
  );
  assert.equal(
    proxy(request("/api/settings", "POST", { "x-auditor-admin-token": token }))
      .status,
    200
  );
});

test("unknown and wildcard binds fail closed despite spoofed loopback headers", () => {
  process.env.AUDITOR_ADMIN_TOKEN = "";
  process.env.PRIVACYTRACKER_NETWORK_EXPOSED = "";
  for (const bind of ["", "0.0.0.0", "::"]) {
    process.env.PRIVACYTRACKER_BIND_HOST = bind;
    process.env.HOSTNAME = "127.0.0.1";
    assert.equal(proxy(request("/api/apps")).status, 401);
    assert.equal(
      proxy(
        request("/api/settings", "POST", { origin: "http://localhost:3000" })
      ).status,
      401
    );
  }
});

test("a configured token protects loopback reads too, malformed cookies do not crash", () => {
  process.env.PRIVACYTRACKER_NETWORK_EXPOSED = "";
  process.env.PRIVACYTRACKER_BIND_HOST = "127.0.0.1";
  assert.equal(
    proxy(request("/api/apps", "GET", { cookie: "pt_admin_token=%zz" })).status,
    401
  );
});

test("forwarded scheme and host affect origin only behind a trusted proxy", () => {
  const req = request("/api/settings", "POST", {
    origin: "https://nas.example:8443",
    "x-forwarded-host": "nas.example:8443",
    "x-forwarded-proto": "https",
  });
  assert.equal(isSameOriginRequest(req), false);
  process.env.PRIVACYTRACKER_TRUST_PROXY = "1";
  assert.equal(isSameOriginRequest(req), true);
  req.headers.set("origin", "https://nas.example");
  assert.equal(isSameOriginRequest(req), false);
});
