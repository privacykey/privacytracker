/**
 * Admin-token guessing is bounded per client on every path that says
 * whether a token is right (the proxy's check, the login form, the public
 * status endpoint), without one client's failures ever locking out another.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import { POST as login } from "../../app/api/auth/admin-token/login/route";
import { GET as status } from "../../app/api/auth/admin-token/status/route";
import {
  _resetAdminTokenGuard,
  checkAdminTokenAttempt,
  FAILURE_WINDOW_MS,
  GLOBAL_FAILURE_LIMIT,
  PEER_HEADER,
  PER_CLIENT_FAILURE_LIMIT,
} from "../../lib/admin-token-guard";
import { _resetLoginBruteForce } from "../../lib/security";
import { proxy } from "../../proxy";
import { resetTestDb } from "../helpers/test-db";

const TOKEN = "guard-test-token";
const STAMP = "test-stamp";
const STAMP_KEY = Symbol.for("privacytracker.peer-stamp");
const ORIGIN = "http://127.0.0.1:3000";

const previous = {
  token: process.env.AUDITOR_ADMIN_TOKEN,
  trust: process.env.PRIVACYTRACKER_TRUST_PROXY,
};

function restore(name: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

test.beforeEach(() => {
  resetTestDb();
  _resetAdminTokenGuard();
  _resetLoginBruteForce();
  process.env.AUDITOR_ADMIN_TOKEN = TOKEN;
  delete process.env.PRIVACYTRACKER_TRUST_PROXY;
  (globalThis as Record<symbol, unknown>)[STAMP_KEY] = STAMP;
});

test.afterEach(() => {
  _resetAdminTokenGuard();
  restore("AUDITOR_ADMIN_TOKEN", previous.token);
  restore("PRIVACYTRACKER_TRUST_PROXY", previous.trust);
  delete (globalThis as Record<symbol, unknown>)[STAMP_KEY];
});

function fromPeer(
  peer: string | null,
  headers: Record<string, string> = {}
): Record<string, string> {
  return {
    host: "127.0.0.1:3000",
    ...(peer ? { [PEER_HEADER]: `${STAMP} ${peer}` } : {}),
    ...headers,
  };
}

function apiRead(peer: string | null, token?: string) {
  return proxy(
    new NextRequest(`${ORIGIN}/api/apps`, {
      headers: fromPeer(
        peer,
        token === undefined ? {} : { "x-auditor-admin-token": token }
      ),
    })
  );
}

function loginAs(peer: string | null, token: string) {
  return login(
    new NextRequest(`${ORIGIN}/api/auth/admin-token/login`, {
      method: "POST",
      headers: fromPeer(peer, {
        origin: ORIGIN,
        "content-type": "application/json",
      }),
      body: JSON.stringify({ token }),
    })
  );
}

test("the proxy refuses a client past its budget before checking its token", () => {
  for (let i = 0; i < PER_CLIENT_FAILURE_LIMIT; i++) {
    assert.equal(apiRead("10.0.0.9", `guess-${i}`).status, 401);
  }
  const refused = apiRead("10.0.0.9", TOKEN);
  assert.equal(refused.status, 429);
  assert.equal(refused.headers.get("Retry-After"), "900");
  assert.equal(refused.headers.get("Cache-Control"), "no-store");
  assert.equal(refused.headers.get("X-Frame-Options"), "DENY");
  // No token at all still gets the ordinary 401.
  assert.equal(apiRead("10.0.0.9").status, 401);
  // Another client, the operator, is not locked out.
  assert.equal(apiRead("10.0.0.8", TOKEN).status, 200);
  // A client-sent peer header with the wrong stamp is not believed.
  assert.equal(
    proxy(
      new NextRequest(`${ORIGIN}/api/apps`, {
        headers: {
          host: "127.0.0.1:3000",
          [PEER_HEADER]: "forged 10.0.0.8",
          "x-auditor-admin-token": TOKEN,
        },
      })
    ).status,
    200
  );
});

test("a stale cookie counts as one failure however often it is sent", () => {
  const stale = {
    cookie: "theme=dark; pt_admin_token=from-before-the-rotation",
  };
  for (let i = 0; i < 3 * PER_CLIENT_FAILURE_LIMIT; i++) {
    const res = proxy(
      new NextRequest(`${ORIGIN}/api/apps`, {
        headers: fromPeer("::ffff:10.0.0.7", stale),
      })
    );
    assert.equal(res.status, 401);
  }
  assert.equal(apiRead("10.0.0.7", TOKEN).status, 200);
});

test("the status endpoint counts wrong tokens and refuses past the budget", async () => {
  const ask = (token: string) =>
    status(
      new NextRequest(`${ORIGIN}/api/auth/admin-token/status`, {
        headers: fromPeer("10.0.0.6", { "x-auditor-admin-token": token }),
      })
    );
  const first = await ask(TOKEN);
  assert.deepEqual(await first.json(), { configured: true, unlocked: true });
  for (let i = 0; i < PER_CLIENT_FAILURE_LIMIT; i++) {
    const res = await ask(`guess-${i}`);
    assert.deepEqual(await res.json(), { configured: true, unlocked: false });
  }
  const refused = await ask(TOKEN);
  assert.equal(refused.status, 429);
  assert.ok(Number(refused.headers.get("Retry-After")) > 0);
});

test("one client's failed logins never block another client's login", async () => {
  for (let i = 0; i < 5; i++) {
    assert.equal((await loginAs("10.0.0.5", `wrong-${i}`)).status, 401);
  }
  // The per-client attempt limit now applies to that client only.
  assert.equal((await loginAs("10.0.0.5", TOKEN)).status, 429);
  const operator = await loginAs("10.0.0.4", TOKEN);
  assert.equal(operator.status, 200);
  assert.match(operator.headers.get("set-cookie") ?? "", /pt_admin_token=/);
});

test("header guesses and login guesses share one budget per client", async () => {
  for (let i = 0; i < PER_CLIENT_FAILURE_LIMIT; i++) {
    assert.equal(apiRead("10.0.0.3", `guess-${i}`).status, 401);
  }
  const res = await loginAs("10.0.0.3", TOKEN);
  assert.equal(res.status, 429);
  assert.match(
    ((await res.json()) as { error: string }).error,
    /Too many failed admin-token attempts/
  );
});

test("without a known client or a configured token nothing is counted", () => {
  // No preloader stamp: no client, so no budget, as before these limits.
  for (let i = 0; i < 3 * PER_CLIENT_FAILURE_LIMIT; i++) {
    assert.equal(apiRead(null, `guess-${i}`).status, 401);
  }
  assert.equal(apiRead(null, TOKEN).status, 200);

  delete process.env.AUDITOR_ADMIN_TOKEN;
  for (let i = 0; i < 3 * PER_CLIENT_FAILURE_LIMIT; i++) {
    const outcome = checkAdminTokenAttempt(
      new Headers(fromPeer("10.0.0.2", { "x-auditor-admin-token": `g${i}` }))
    ).outcome;
    assert.equal(outcome, "invalid");
  }
  process.env.AUDITOR_ADMIN_TOKEN = TOKEN;
  assert.equal(apiRead("10.0.0.2", TOKEN).status, 200);
});

test("behind a trusted proxy the last forwarded hop is the client", () => {
  process.env.PRIVACYTRACKER_TRUST_PROXY = "1";
  const via = (hop: string, token: string) =>
    proxy(
      new NextRequest(`${ORIGIN}/api/apps`, {
        headers: fromPeer("172.17.0.1", {
          "x-forwarded-for": `198.51.100.1, ${hop}`,
          "x-auditor-admin-token": token,
        }),
      })
    );
  for (let i = 0; i < PER_CLIENT_FAILURE_LIMIT; i++) {
    assert.equal(via("203.0.113.9", `guess-${i}`).status, 401);
  }
  assert.equal(via("203.0.113.9", TOKEN).status, 429);
  // Every other client behind the same proxy is unaffected.
  assert.equal(via("203.0.113.10", TOKEN).status, 200);
});

test("the global backstop spares a client that signed in recently", () => {
  const now = 50_000_000;
  const check = (peer: string, token: string, at = now) =>
    checkAdminTokenAttempt(
      new Headers(fromPeer(peer, { "x-auditor-admin-token": token })),
      at
    );
  assert.equal(check("192.168.1.2", TOKEN).outcome, "valid");
  for (let i = 0; i < GLOBAL_FAILURE_LIMIT; i++) {
    const peer = `10.1.${Math.floor(i / 5)}.${i % 5}`;
    assert.equal(check(peer, `x${i}`).outcome, "invalid");
  }
  assert.equal(check("10.2.0.1", TOKEN, now + 1).outcome, "throttled");
  assert.equal(check("192.168.1.2", TOKEN, now + 1).outcome, "valid");
  // The window slides for everyone.
  assert.equal(
    check("10.2.0.1", TOKEN, now + FAILURE_WINDOW_MS).outcome,
    "valid"
  );
});
