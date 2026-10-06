/**
 * The desktop launch credential on the Node server: while the shell has
 * set one, every /api call needs it, the one-time link hands the window its
 * cookie once, and the header form alone stands in for an Origin.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import {
  _resetDesktopBootstrapNonces,
  BOOTSTRAP_TTL_MS,
  DESKTOP_BOOTSTRAP_NONCE_ENV,
  DESKTOP_BOOTSTRAP_PATH,
  DESKTOP_CREDENTIAL_ENV,
  DESKTOP_CREDENTIAL_HEADER,
  DESKTOP_SESSION_COOKIE,
  decideDesktopCredential,
  issueDesktopBootstrapNonce,
} from "../../lib/desktop-auth";
import { proxy } from "../../proxy";

const CREDENTIAL =
  "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const NONCE =
  "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
const ORIGIN = "http://127.0.0.1:4321";

let savedEnv: NodeJS.ProcessEnv;
test.beforeEach(() => {
  savedEnv = { ...process.env };
  _resetDesktopBootstrapNonces();
  // A token-less loopback install, as the desktop app is.
  process.env.AUDITOR_ADMIN_TOKEN = "";
  process.env.PRIVACYTRACKER_NETWORK_EXPOSED = "";
  process.env.PRIVACYTRACKER_BIND_HOST = "127.0.0.1";
  process.env.PRIVACYTRACKER_RUNTIME = "desktop";
  process.env[DESKTOP_CREDENTIAL_ENV] = CREDENTIAL;
  process.env[DESKTOP_BOOTSTRAP_NONCE_ENV] = NONCE;
});

test.afterEach(() => {
  process.env = savedEnv;
  _resetDesktopBootstrapNonces();
});

function request(
  path: string,
  method = "GET",
  headers: Record<string, string> = {}
) {
  return new NextRequest(`${ORIGIN}${path}`, {
    method,
    headers: { host: "127.0.0.1:4321", ...headers },
  });
}

test("every /api call needs the credential; the page shells stay public", () => {
  for (const path of [
    "/api/apps",
    "/api/health",
    "/api/ready",
    "/api/auth/admin-token/status",
    "/api",
  ]) {
    const refused = proxy(request(path));
    assert.equal(refused.status, 401, path);
    assert.equal(refused.headers.get("cache-control"), "no-store");
    assert.equal(
      proxy(request(path, "GET", { [DESKTOP_CREDENTIAL_HEADER]: CREDENTIAL }))
        .status,
      200,
      path
    );
    assert.equal(
      proxy(
        request(path, "GET", {
          cookie: `theme=dark; ${DESKTOP_SESSION_COOKIE}=stale; ${DESKTOP_SESSION_COOKIE}=${CREDENTIAL}`,
        })
      ).status,
      200,
      path
    );
  }
  assert.equal(proxy(request("/api/csp-report", "POST")).status, 401);
  for (const path of ["/", "/dashboard", "/login", "/welcome"]) {
    assert.equal(proxy(request(path)).status, 200, path);
  }
  // A wrong credential, in either form, is refused; the guess budget is
  // not involved because no admin token is configured.
  assert.equal(
    proxy(request("/api/apps", "GET", { [DESKTOP_CREDENTIAL_HEADER]: "nope" }))
      .status,
    401
  );
  assert.equal(
    proxy(
      request("/api/apps", "GET", {
        cookie: `${DESKTOP_SESSION_COOKIE}=${CREDENTIAL.slice(1)}`,
      })
    ).status,
    401
  );
});

test("the one-time link signs the window in once", () => {
  const first = proxy(request(`${DESKTOP_BOOTSTRAP_PATH}?nonce=${NONCE}`));
  assert.equal(first.status, 303);
  assert.equal(first.headers.get("location"), `${ORIGIN}/`);
  const cookie = first.headers.get("set-cookie") ?? "";
  assert.match(
    cookie,
    new RegExp(`^${DESKTOP_SESSION_COOKIE}=${CREDENTIAL}; `)
  );
  assert.match(cookie, /Path=\/api/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.equal(first.headers.get("cache-control"), "no-store");

  // The same link again, from a client holding nothing, is refused.
  const again = proxy(request(`${DESKTOP_BOOTSTRAP_PATH}?nonce=${NONCE}`));
  assert.equal(again.status, 403);
  // A window that already holds the cookie is sent on without a new one.
  const held = proxy(
    request(`${DESKTOP_BOOTSTRAP_PATH}?nonce=${NONCE}`, "GET", {
      cookie: `${DESKTOP_SESSION_COOKIE}=${CREDENTIAL}`,
    })
  );
  assert.equal(held.status, 303);
  assert.equal(held.headers.get("set-cookie"), null);
  // Wrong or missing nonces are refused too.
  assert.equal(
    proxy(request(`${DESKTOP_BOOTSTRAP_PATH}?nonce=wrong`)).status,
    403
  );
  assert.equal(proxy(request(DESKTOP_BOOTSTRAP_PATH)).status, 403);
  assert.equal(proxy(request(DESKTOP_BOOTSTRAP_PATH, "POST")).status, 401);
});

test("a link expires, and a later link can be issued", () => {
  const headers = new Headers({ host: "127.0.0.1:4321" });
  const start = Date.now();
  // The environment's nonce is read when a link is first looked at.
  assert.deepEqual(
    decideDesktopCredential(
      "GET",
      DESKTOP_BOOTSTRAP_PATH,
      "wrong",
      headers,
      CREDENTIAL,
      start
    ),
    { kind: "link_refused" }
  );
  assert.equal(
    decideDesktopCredential(
      "GET",
      DESKTOP_BOOTSTRAP_PATH,
      NONCE,
      headers,
      CREDENTIAL,
      start + BOOTSTRAP_TTL_MS
    ).kind,
    "link_refused",
    "a link older than its TTL is dead"
  );
  issueDesktopBootstrapNonce("later", start + BOOTSTRAP_TTL_MS);
  assert.equal(
    decideDesktopCredential(
      "GET",
      DESKTOP_BOOTSTRAP_PATH,
      "later",
      headers,
      CREDENTIAL,
      start + BOOTSTRAP_TTL_MS + 1
    ).kind,
    "signed_in"
  );
});

test("only the header form stands in for an Origin on a mutation", () => {
  // The shell's own requests: header, no Origin.
  assert.equal(
    proxy(
      request("/api/settings", "POST", {
        [DESKTOP_CREDENTIAL_HEADER]: CREDENTIAL,
      })
    ).status,
    200
  );
  // The webview: cookie plus its own Origin.
  assert.equal(
    proxy(
      request("/api/settings", "POST", {
        cookie: `${DESKTOP_SESSION_COOKIE}=${CREDENTIAL}`,
        origin: ORIGIN,
      })
    ).status,
    200
  );
  // A non-browser client with only the cookie and no Origin is refused.
  assert.equal(
    proxy(
      request("/api/settings", "POST", {
        cookie: `${DESKTOP_SESSION_COOKIE}=${CREDENTIAL}`,
      })
    ).status,
    403
  );
});

test("without a credential in the environment nothing changes", () => {
  delete process.env[DESKTOP_CREDENTIAL_ENV];
  assert.equal(proxy(request("/api/apps")).status, 200);
  assert.equal(
    proxy(request(`${DESKTOP_BOOTSTRAP_PATH}?nonce=${NONCE}`)).status,
    200
  );
  process.env[DESKTOP_CREDENTIAL_ENV] = "";
  assert.equal(proxy(request("/api/apps")).status, 200);
});
