/**
 * The admin session cookie: every `pt_admin_token` cookie a request carries
 * is tried (a planted one cannot shadow the real one), and what login stores
 * is a per-boot session value rather than the token itself.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { POST as login } from "../../app/api/auth/admin-token/login/route";
import {
  adminSessionCookieValue,
  requestHasValidAdminToken,
} from "../../lib/admin-auth";
import {
  _resetAdminTokenGuard,
  checkAdminTokenAttempt,
} from "../../lib/admin-token-guard";
import { _resetLoginBruteForce } from "../../lib/security";
import { proxy } from "../../proxy";
import { resetTestDb } from "../helpers/test-db";

const TOKEN = "cookie-session-test-token";
const ORIGIN = "http://localhost:3000";
const SECRET = Symbol.for("privacytracker.admin-session-secret");

let savedEnv: NodeJS.ProcessEnv;
let savedSecret: unknown;
test.beforeEach(() => {
  resetTestDb();
  _resetAdminTokenGuard();
  _resetLoginBruteForce();
  savedEnv = { ...process.env };
  savedSecret = (globalThis as Record<symbol, unknown>)[SECRET];
  delete (globalThis as Record<symbol, unknown>)[SECRET];
  process.env.AUDITOR_ADMIN_TOKEN = TOKEN;
  process.env.PRIVACYTRACKER_NETWORK_EXPOSED = "1";
  process.env.PRIVACYTRACKER_TRUST_PROXY = "";
});

test.afterEach(() => {
  process.env = savedEnv;
  (globalThis as Record<symbol, unknown>)[SECRET] = savedSecret;
  _resetAdminTokenGuard();
});

function headers(extra: Record<string, string>) {
  return new Headers({ host: "localhost:3000", ...extra });
}

function read(cookie: string) {
  return proxy(
    new NextRequest(`${ORIGIN}/api/apps`, {
      headers: { host: "localhost:3000", cookie },
    })
  );
}

test("a planted first cookie no longer shadows the real one", () => {
  for (const cookie of [
    `pt_admin_token=junk; pt_admin_token=${TOKEN}`,
    `=junk; pt_admin_token=${TOKEN}`,
    `pt_admin_token=%zz; pt_admin_token=${TOKEN}`,
    `pt_admin_token=; pt_admin_token=${TOKEN}`,
    `theme=dark; pt_admin_token=junk; other=1; pt_admin_token=${TOKEN}`,
  ]) {
    assert.equal(
      requestHasValidAdminToken({ headers: headers({ cookie }) }),
      true,
      cookie
    );
    assert.equal(read(cookie).status, 200, cookie);
    // A valid credential among planted ones counts as a success, not a guess.
    assert.deepEqual(checkAdminTokenAttempt(headers({ cookie })), {
      outcome: "valid",
    });
  }
  for (const cookie of [
    "pt_admin_token=junk; pt_admin_token=nope",
    "pt_admin_token=%zz",
    "pt_admin_token=",
  ]) {
    assert.equal(
      requestHasValidAdminToken({ headers: headers({ cookie }) }),
      false,
      cookie
    );
    assert.equal(read(cookie).status, 401, cookie);
  }
});

test("login stores a per-boot session value, not the token, and a restart signs it out", async () => {
  const response = await login(
    new NextRequest(`${ORIGIN}/api/auth/admin-token/login`, {
      method: "POST",
      headers: {
        host: "localhost:3000",
        origin: ORIGIN,
        "content-type": "application/json",
      },
      body: JSON.stringify({ token: TOKEN }),
    })
  );
  assert.equal(response.status, 200);
  const setCookie = response.headers.get("set-cookie") ?? "";
  const value = /pt_admin_token=([^;]+)/.exec(setCookie)?.[1] ?? "";
  assert.match(value, /^[0-9a-f]{64}$/, setCookie);
  assert.notEqual(value, TOKEN);
  assert.equal(value, adminSessionCookieValue());
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=strict/i);

  // The session value is a cookie credential only, never a header one.
  assert.equal(read(`pt_admin_token=${value}`).status, 200);
  assert.equal(
    proxy(
      new NextRequest(`${ORIGIN}/api/apps`, {
        headers: { host: "localhost:3000", "x-auditor-admin-token": value },
      })
    ).status,
    401
  );

  // A new boot mints a new secret: the old cookie is refused, the next
  // login gets a different value, and the same secret gives the same value.
  const first = (globalThis as Record<symbol, unknown>)[SECRET];
  delete (globalThis as Record<symbol, unknown>)[SECRET];
  assert.equal(read(`pt_admin_token=${value}`).status, 401);
  assert.notEqual(adminSessionCookieValue(), value);
  (globalThis as Record<symbol, unknown>)[SECRET] = first;
  assert.equal(adminSessionCookieValue(), value);
  assert.equal(read(`pt_admin_token=${value}`).status, 200);

  // Rotating the token signs the old session out as well.
  process.env.AUDITOR_ADMIN_TOKEN = "rotated-token";
  assert.equal(read(`pt_admin_token=${value}`).status, 401);
  process.env.AUDITOR_ADMIN_TOKEN = TOKEN;

  // A cookie carrying the token itself still works, as the header does.
  assert.equal(read(`pt_admin_token=${TOKEN}`).status, 200);
});

test("no session value exists while no token is configured", () => {
  process.env.AUDITOR_ADMIN_TOKEN = "";
  assert.equal(adminSessionCookieValue(), null);
  assert.equal(
    requestHasValidAdminToken({
      headers: headers({ cookie: "pt_admin_token=anything" }),
    }),
    false
  );
});
