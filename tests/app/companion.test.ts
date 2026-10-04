/**
 * Companion pairing (lib/companion.ts, lib/companion-gate.ts, proxy.ts step
 * 0.6, app/api/companion/**): the read-only phone tokens.
 *
 * The contract pinned here, each part of which a plausible change breaks:
 *   - a companion token reaches exactly the allowlisted GETs, on an install
 *     that otherwise demands the admin token for everything;
 *   - the same header on any other path or method is a 403 even when a
 *     valid admin token rides along, so a pairing code never widens another
 *     credential;
 *   - an unknown, malformed, revoked or never-used-and-expired token is a
 *     401, and a wipe revokes every pairing at once;
 *   - only the SHA-256 of a token is stored, and backups leave the table out.
 */

import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { NextRequest } from "next/server";
import { TABLES_EXCLUDED_FROM_BACKUP } from "../../lib/backup";
import {
  COMPANION_INSTANCE_NAME_KEY,
  COMPANION_MAX_DEVICES,
  createCompanionPairing,
  getCompanionInstanceName,
  listCompanionDevices,
  loadCompanionRegistry,
  revokeCompanionPairing,
  setCompanionInstanceName,
} from "../../lib/companion";
import {
  _resetCompanionRegistry,
  COMPANION_CLAIM_WINDOW_MS,
  COMPANION_HEADER,
  COMPANION_LAST_USED_RESOLUTION_MS,
  checkCompanionRequest,
  hashCompanionToken,
  isCompanionRoute,
  isWellFormedCompanionToken,
} from "../../lib/companion-gate";
import { buildPairingLink } from "../../lib/companion-link";
import db from "../../lib/db";
import { setSetting } from "../../lib/scheduler";
import { wipeAllUserData } from "../../lib/wipe-all-data";
import { proxy } from "../../proxy";
import { resetTestDb, seedTrackedApp } from "../helpers/test-db";

const ADMIN = "companion-test-admin-token";

beforeEach(() => {
  resetTestDb();
  _resetCompanionRegistry();
  loadCompanionRegistry();
});

function withNetworkExposure<T>(fn: () => T): T {
  const saved = { ...process.env };
  process.env.AUDITOR_ADMIN_TOKEN = ADMIN;
  process.env.PRIVACYTRACKER_NETWORK_EXPOSED = "1";
  process.env.PRIVACYTRACKER_TRUST_PROXY = "";
  try {
    return fn();
  } finally {
    process.env = saved;
  }
}

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

// ── allowlist + token shape ───────────────────────────────────────────

test("the allowlist is GET-only and exact", () => {
  for (const path of [
    "/api/companion/status",
    "/api/apps",
    "/api/apps/389801252/detail",
    "/api/apps/389801252/changelog",
    "/api/apps/389801252/since-install",
    "/api/apps/389801252/history-stats",
    "/api/changelog",
    "/api/triage",
  ]) {
    assert.equal(isCompanionRoute("GET", path), true, path);
    assert.equal(isCompanionRoute("HEAD", path), false, `HEAD ${path}`);
    assert.equal(isCompanionRoute("POST", path), false, `POST ${path}`);
  }
  for (const path of [
    "/api/companion",
    "/api/companion/pairings",
    "/api/settings",
    "/api/backup/export",
    "/api/apps/abc/detail",
    "/api/apps/1/detail/extra",
    "/api/apps/",
    "/api/changelog/x",
    "/api/export",
    "/dashboard",
  ]) {
    assert.equal(isCompanionRoute("GET", path), false, path);
  }
});

test("tokens are ptc_ + 64 lowercase hex, and only their hash is stored", () => {
  const { token, device } = createCompanionPairing("iPhone");
  assert.equal(isWellFormedCompanionToken(token), true);
  assert.equal(isWellFormedCompanionToken(token.toUpperCase()), false);
  assert.equal(isWellFormedCompanionToken("ptc_abc"), false);
  const row = db
    .prepare("SELECT token_hash FROM companion_tokens WHERE id = ?")
    .get(device.id) as { token_hash: string };
  assert.equal(row.token_hash, hashCompanionToken(token));
  const dump = JSON.stringify(
    db.prepare("SELECT * FROM companion_tokens").all()
  );
  assert.equal(dump.includes(token), false, "plaintext never stored");
});

// ── verification ──────────────────────────────────────────────────────

test("first use claims the token; an unclaimed token expires after the window", () => {
  const t0 = 1_800_000_000_000;
  const claimed = createCompanionPairing("claimed", t0);
  const unclaimed = createCompanionPairing("unclaimed", t0);

  const first = checkCompanionRequest(
    "GET",
    "/api/apps",
    claimed.token,
    t0 + 60_000
  );
  assert.equal(first.kind, "allowed");
  const stored = db
    .prepare(
      "SELECT first_used_at, last_used_at FROM companion_tokens WHERE id = ?"
    )
    .get(claimed.device.id) as { first_used_at: number; last_used_at: number };
  assert.equal(stored.first_used_at, t0 + 60_000, "sink persisted first use");

  const late = t0 + COMPANION_CLAIM_WINDOW_MS + 1;
  assert.equal(
    checkCompanionRequest("GET", "/api/apps", claimed.token, late).kind,
    "allowed",
    "a claimed token outlives the window"
  );
  assert.equal(
    checkCompanionRequest("GET", "/api/apps", unclaimed.token, late).kind,
    "invalid",
    "an unclaimed token does not"
  );
  const states = Object.fromEntries(
    listCompanionDevices(late).map((d) => [d.label, d.state])
  );
  assert.deepEqual(states, { claimed: "active", unclaimed: "expired" });
});

test("last_used_at is written at most once a minute", () => {
  const t0 = 1_800_000_000_000;
  const { token, device } = createCompanionPairing("iPhone", t0);
  const read = () =>
    (
      db
        .prepare("SELECT last_used_at FROM companion_tokens WHERE id = ?")
        .get(device.id) as { last_used_at: number }
    ).last_used_at;
  checkCompanionRequest("GET", "/api/apps", token, t0);
  checkCompanionRequest("GET", "/api/apps", token, t0 + 5000);
  assert.equal(read(), t0);
  checkCompanionRequest(
    "GET",
    "/api/apps",
    token,
    t0 + COMPANION_LAST_USED_RESOLUTION_MS
  );
  assert.equal(read(), t0 + COMPANION_LAST_USED_RESOLUTION_MS);
});

test("revoking and wiping end a pairing at once, and a restart reloads the rest", () => {
  const keep = createCompanionPairing("keep");
  const revoke = createCompanionPairing("revoke");
  assert.equal(revokeCompanionPairing(revoke.device.id), "revoke");
  assert.equal(revokeCompanionPairing(revoke.device.id), null);
  assert.equal(
    checkCompanionRequest("GET", "/api/apps", revoke.token).kind,
    "invalid"
  );

  // A new process: the registry comes back from the table alone.
  _resetCompanionRegistry();
  assert.equal(
    checkCompanionRequest("GET", "/api/apps", keep.token).kind,
    "unavailable",
    "the gate fails closed until boot loads the registry"
  );
  loadCompanionRegistry();
  assert.equal(
    checkCompanionRequest("GET", "/api/apps", keep.token).kind,
    "allowed"
  );

  wipeAllUserData("reset", Date.now());
  assert.equal(
    checkCompanionRequest("GET", "/api/apps", keep.token).kind,
    "invalid",
    "Delete everything revokes every pairing"
  );
});

test("backups leave the pairing table out", () => {
  assert.deepEqual([...TABLES_EXCLUDED_FROM_BACKUP], ["companion_tokens"]);
});

// ── proxy step 0.6 on an install that requires the admin token ────────

test("a companion token reads the allowlist where everything else needs the admin token", () => {
  const { token } = createCompanionPairing("iPhone");
  withNetworkExposure(() => {
    assert.equal(proxy(request("/api/apps")).status, 401, "baseline: locked");
    for (const path of [
      "/api/apps?limit=10&offset=0&meta=grid",
      "/api/apps/389801252/detail",
      "/api/changelog?limit=100",
      "/api/triage",
      "/api/companion/status",
    ]) {
      const res = proxy(request(path, "GET", { [COMPANION_HEADER]: token }));
      assert.equal(res.status, 200, path);
      assert.equal(res.headers.get("cache-control"), "no-store");
    }
  });
});

test("the companion header refuses everything off the allowlist, whatever rides along", () => {
  const { token } = createCompanionPairing("iPhone");
  withNetworkExposure(() => {
    for (const [path, method] of [
      ["/api/settings", "GET"],
      ["/api/backup/export", "GET"],
      ["/api/companion", "GET"],
      ["/dashboard", "GET"],
      ["/api/apps", "HEAD"],
      ["/api/apps", "DELETE"],
      ["/api/companion/pairings", "POST"],
    ] as const) {
      const res = proxy(
        request(path, method, {
          [COMPANION_HEADER]: token,
          "x-auditor-admin-token": ADMIN,
        })
      );
      assert.equal(res.status, 403, `${method} ${path}`);
    }
  });
});

test("an unknown or malformed companion token is a 401 on the allowlist", () => {
  createCompanionPairing("iPhone");
  withNetworkExposure(() => {
    for (const bad of [`ptc_${"0".repeat(64)}`, "not-a-token", ""]) {
      const res = proxy(
        request("/api/apps", "GET", { [COMPANION_HEADER]: bad })
      );
      assert.equal(res.status, 401, JSON.stringify(bad));
    }
  });
});

test("the host allowlist still runs first", () => {
  const { token } = createCompanionPairing("iPhone");
  const res = proxy(
    new NextRequest("http://evil.example/api/apps", {
      headers: { host: "evil.example", [COMPANION_HEADER]: token },
    })
  );
  assert.equal(res.status, 400);
});

// ── routes ────────────────────────────────────────────────────────────

async function routes() {
  return {
    root: await import("../../app/api/companion/route"),
    pairings: await import("../../app/api/companion/pairings/route"),
    pairing: await import("../../app/api/companion/pairings/[id]/route"),
    status: await import("../../app/api/companion/status/route"),
    lan: await import("../../app/api/companion/lan/route"),
  };
}

test("an unnamed instance describes its host until someone names it", () => {
  const saved = { ...process.env };
  try {
    process.env.PRIVACYTRACKER_RUNTIME = "";
    assert.equal(getCompanionInstanceName(), "privacytracker server");
    // The old default says nothing a phone could tell instances apart by,
    // so a stored copy of it reads as unnamed too.
    setSetting(COMPANION_INSTANCE_NAME_KEY, "privacytracker");
    assert.equal(getCompanionInstanceName(), "privacytracker server");

    // The desktop app: the Mac's name, passed by the shell.
    process.env.PRIVACYTRACKER_RUNTIME = "desktop";
    process.env.PRIVACYTRACKER_COMPUTER_NAME = "  Adam's   MacBook Pro ";
    assert.equal(getCompanionInstanceName(), "Adam's MacBook Pro");
    process.env.PRIVACYTRACKER_COMPUTER_NAME = "";
    assert.equal(getCompanionInstanceName(), "My Mac");

    // A chosen name wins; an empty one hands back to the default.
    assert.equal(setCompanionInstanceName("  Home   server "), "Home server");
    assert.equal(getCompanionInstanceName(), "Home server");
    assert.equal(setCompanionInstanceName("   "), "My Mac");
  } finally {
    process.env = saved;
  }
});

const LOCAL = "http://127.0.0.1:3000";
const sameOrigin = { origin: LOCAL, host: "127.0.0.1:3000" };

test("pair, list, status and revoke through the routes", async () => {
  const r = await routes();
  seedTrackedApp({ id: "389801252", name: "Instagram" });
  seedTrackedApp({ id: "324684580", name: "Spotify" });

  const renamed = await r.root.PUT(
    new Request(`${LOCAL}/api/companion`, {
      method: "PUT",
      headers: { ...sameOrigin, "content-type": "application/json" },
      body: JSON.stringify({ instanceName: "  Adam's   Mac  " }),
    })
  );
  assert.equal(renamed.status, 200);
  assert.equal((await renamed.json()).instanceName, "Adam's Mac");

  const created = await r.pairings.POST(
    new Request(`${LOCAL}/api/companion/pairings`, {
      method: "POST",
      headers: { ...sameOrigin, "content-type": "application/json" },
      body: JSON.stringify({ label: "Adam's iPhone" }),
    })
  );
  assert.equal(created.status, 201);
  const body = (await created.json()) as {
    device: { id: string; label: string; state: string };
    token: string;
  };
  assert.deepEqual(Object.keys(body), ["device", "token"]);
  assert.equal(body.device.label, "Adam's iPhone");
  assert.equal(body.device.state, "waiting");

  const listed = await (await r.root.GET()).json();
  assert.equal(listed.devices.length, 1);
  assert.equal(listed.maxDevices, COMPANION_MAX_DEVICES);
  assert.equal(JSON.stringify(listed).includes(body.token), false);

  // The phone's first request, through the gate and then the route.
  assert.equal(
    checkCompanionRequest("GET", "/api/companion/status", body.token).kind,
    "allowed"
  );
  const status = await r.status.GET(
    new Request(`${LOCAL}/api/companion/status`, {
      headers: { [COMPANION_HEADER]: body.token },
    })
  );
  assert.equal(status.status, 200);
  const statusBody = await status.json();
  assert.deepEqual(Object.keys(statusBody), [
    "instanceName",
    "appCount",
    "version",
    "scope",
    "device",
  ]);
  assert.equal(statusBody.instanceName, "Adam's Mac");
  assert.equal(statusBody.appCount, 2);
  assert.equal(statusBody.scope, "read");
  assert.deepEqual(statusBody.device, {
    id: body.device.id,
    label: "Adam's iPhone",
  });

  const noHeader = await r.status.GET(
    new Request(`${LOCAL}/api/companion/status`)
  );
  assert.equal(noHeader.status, 401);

  const revoked = await r.pairing.DELETE(
    new Request(`${LOCAL}/api/companion/pairings/${body.device.id}`, {
      method: "DELETE",
      headers: sameOrigin,
    }),
    { params: Promise.resolve({ id: body.device.id }) }
  );
  assert.equal(revoked.status, 200);
  const again = await r.pairing.DELETE(
    new Request(`${LOCAL}/api/companion/pairings/${body.device.id}`, {
      method: "DELETE",
      headers: sameOrigin,
    }),
    { params: Promise.resolve({ id: body.device.id }) }
  );
  assert.equal(again.status, 404);

  const audit = db
    .prepare(
      "SELECT action FROM audit_log WHERE action LIKE 'companion.%' ORDER BY created_at"
    )
    .all()
    .map((row) => (row as { action: string }).action);
  assert.deepEqual(audit, ["companion.paired", "companion.revoked"]);
});

test("pairing is capped", async () => {
  const r = await routes();
  for (let i = 0; i < COMPANION_MAX_DEVICES; i++) {
    createCompanionPairing(`phone ${i}`);
  }
  const res = await r.pairings.POST(
    new Request(`${LOCAL}/api/companion/pairings`, {
      method: "POST",
      headers: sameOrigin,
    })
  );
  assert.equal(res.status, 409);
});

test("the Node backend reports the Wi-Fi listener as not available", async () => {
  const r = await routes();
  const lan = await (await r.lan.GET()).json();
  assert.equal(lan.supported, false);
  const put = await r.lan.PUT(
    new Request(`${LOCAL}/api/companion/lan`, {
      method: "PUT",
      headers: { ...sameOrigin, "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    })
  );
  assert.equal(put.status, 409);
});

test("the pairing link percent-encodes every value and orders fp before scope", () => {
  const token = `ptc_${"a".repeat(64)}`;
  const link = buildPairingLink({
    baseUrl: "https://192.168.1.20:47831",
    fingerprint: "b".repeat(64),
    instanceName: "Adam's Mac & co",
    token,
  });
  assert.equal(
    link,
    `privacytracker://pair?url=https%3A%2F%2F192.168.1.20%3A47831&token=${token}&name=Adam's%20Mac%20%26%20co&fp=${"b".repeat(64)}&scope=read`
  );
  const parsed = new URL(link);
  assert.equal(parsed.searchParams.get("name"), "Adam's Mac & co");
  assert.equal(
    buildPairingLink({
      baseUrl: "https://tracker.example",
      fingerprint: null,
      instanceName: "x",
      token,
    }).includes("fp="),
    false
  );
});
