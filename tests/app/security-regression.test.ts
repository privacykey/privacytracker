import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server";
import {
  readBoundedJson,
  sanitizePolicyUrl,
  validateExternalUrl,
} from "../../lib/security";
import { proxy } from "../../proxy";
import { resetTestDb } from "../helpers/test-db";

test.beforeEach(resetTestDb);

test("proxy blocks cross-origin API mutations and still attaches security headers", () => {
  const request = new NextRequest("http://127.0.0.1:3000/api/reset", {
    method: "POST",
    headers: {
      origin: "https://attacker.example",
      host: "127.0.0.1:3000",
    },
  });

  const response = proxy(request);

  assert.equal(response.status, 403);
  assert.equal(response.headers.get("X-Frame-Options"), "DENY");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.match(
    response.headers.get("Content-Security-Policy") ?? "",
    /frame-ancestors 'none'/
  );
});

test("proxy allows same-origin mutations and admin-token scripted callers", () => {
  const sameOrigin = proxy(
    new NextRequest("http://127.0.0.1:3000/api/reset", {
      method: "POST",
      headers: {
        origin: "http://127.0.0.1:3000",
        host: "127.0.0.1:3000",
      },
    })
  );
  assert.notEqual(sameOrigin.status, 403);

  const previousToken = process.env.AUDITOR_ADMIN_TOKEN;
  process.env.AUDITOR_ADMIN_TOKEN = "ci-secret";
  try {
    const scripted = proxy(
      new NextRequest("http://127.0.0.1:3000/api/reset", {
        method: "POST",
        headers: {
          origin: "https://automation.example",
          host: "127.0.0.1:3000",
          "x-auditor-admin-token": "ci-secret",
        },
      })
    );
    assert.notEqual(scripted.status, 403);
  } finally {
    if (previousToken === undefined) {
      delete process.env.AUDITOR_ADMIN_TOKEN;
    } else {
      process.env.AUDITOR_ADMIN_TOKEN = previousToken;
    }
  }
});

test("proxy requires admin token for an allowlisted, network-exposed host", () => {
  // Allowlisting privacytracker.example lets the request past the Host gate
  // (step 0) AND marks the deployment network-exposed (a non-loopback
  // allowlist entry) — so the admin-token gate is what's exercised here.
  const previousToken = process.env.AUDITOR_ADMIN_TOKEN;
  const previousHosts = process.env.PRIVACYTRACKER_ALLOWED_HOSTS;
  delete process.env.AUDITOR_ADMIN_TOKEN;
  process.env.PRIVACYTRACKER_ALLOWED_HOSTS = "privacytracker.example";
  try {
    const blockedWrite = proxy(
      new NextRequest("https://privacytracker.example/api/reset", {
        method: "POST",
        headers: {
          origin: "https://privacytracker.example",
          host: "privacytracker.example",
        },
      })
    );
    assert.equal(blockedWrite.status, 401);

    const blockedRead = proxy(
      new NextRequest("https://privacytracker.example/api/backup/export", {
        method: "GET",
        headers: { host: "privacytracker.example" },
      })
    );
    assert.equal(blockedRead.status, 401);

    process.env.AUDITOR_ADMIN_TOKEN = "ci-secret";
    const allowed = proxy(
      new NextRequest("https://privacytracker.example/api/reset", {
        method: "POST",
        headers: {
          origin: "https://privacytracker.example",
          host: "privacytracker.example",
          "x-auditor-admin-token": "ci-secret",
        },
      })
    );
    assert.notEqual(allowed.status, 401);
    assert.notEqual(allowed.status, 403);
  } finally {
    if (previousToken === undefined) {
      delete process.env.AUDITOR_ADMIN_TOKEN;
    } else {
      process.env.AUDITOR_ADMIN_TOKEN = previousToken;
    }
    if (previousHosts === undefined) {
      delete process.env.PRIVACYTRACKER_ALLOWED_HOSTS;
    } else {
      process.env.PRIVACYTRACKER_ALLOWED_HOSTS = previousHosts;
    }
  }
});

test("proxy rejects a non-allowlisted Host with 400 for every method, even with a valid token", () => {
  const previousToken = process.env.AUDITOR_ADMIN_TOKEN;
  const previousHosts = process.env.PRIVACYTRACKER_ALLOWED_HOSTS;
  process.env.AUDITOR_ADMIN_TOKEN = "ci-secret";
  delete process.env.PRIVACYTRACKER_ALLOWED_HOSTS;
  try {
    // Rebind-style read against an un-gated GET. The Host gate fires before any
    // admin/CSRF logic, so even a valid token can't reach a disallowed host.
    const rebindRead = proxy(
      new NextRequest("http://attacker.example/api/apps", {
        method: "GET",
        headers: {
          host: "attacker.example",
          "x-auditor-admin-token": "ci-secret",
        },
      })
    );
    assert.equal(rebindRead.status, 400);
    // The reject still carries the security headers.
    assert.equal(rebindRead.headers.get("X-Frame-Options"), "DENY");
    assert.match(
      rebindRead.headers.get("Content-Security-Policy") ?? "",
      /frame-ancestors 'none'/
    );
  } finally {
    if (previousToken === undefined) {
      delete process.env.AUDITOR_ADMIN_TOKEN;
    } else {
      process.env.AUDITOR_ADMIN_TOKEN = previousToken;
    }
    if (previousHosts === undefined) {
      delete process.env.PRIVACYTRACKER_ALLOWED_HOSTS;
    } else {
      process.env.PRIVACYTRACKER_ALLOWED_HOSTS = previousHosts;
    }
  }
});

test("loopback Host always passes the allowlist even when a LAN host is configured", () => {
  // Healthcheck invariant: the in-container probe always uses 127.0.0.1, which
  // must keep working regardless of PRIVACYTRACKER_ALLOWED_HOSTS.
  const previousHosts = process.env.PRIVACYTRACKER_ALLOWED_HOSTS;
  process.env.PRIVACYTRACKER_ALLOWED_HOSTS = "nas.lan";
  try {
    const probe = proxy(
      new NextRequest("http://127.0.0.1:3000/api/ready", {
        method: "GET",
        headers: { host: "127.0.0.1:3000" },
      })
    );
    assert.notEqual(probe.status, 400);
  } finally {
    if (previousHosts === undefined) {
      delete process.env.PRIVACYTRACKER_ALLOWED_HOSTS;
    } else {
      process.env.PRIVACYTRACKER_ALLOWED_HOSTS = previousHosts;
    }
  }
});

test("destructive routes require admin token when configured", async () => {
  const previousToken = process.env.AUDITOR_ADMIN_TOKEN;
  process.env.AUDITOR_ADMIN_TOKEN = "reset-secret";
  try {
    const route = await import("../../app/api/reset/route");
    const response = await route.POST(
      new Request("http://127.0.0.1/api/reset", {
        method: "POST",
        headers: { "x-forwarded-for": "203.0.113.10" },
      })
    );
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "Admin token required" });
  } finally {
    if (previousToken === undefined) {
      delete process.env.AUDITOR_ADMIN_TOKEN;
    } else {
      process.env.AUDITOR_ADMIN_TOKEN = previousToken;
    }
  }
});

test("dev routes are disabled unless an admin token is configured", async () => {
  const previousToken = process.env.AUDITOR_ADMIN_TOKEN;
  delete process.env.AUDITOR_ADMIN_TOKEN;
  try {
    const route = await import("../../app/api/dev/wipe-apps/route");
    const disabled = await route.POST(
      new Request("http://127.0.0.1/api/dev/wipe-apps", {
        method: "POST",
        headers: {
          host: "127.0.0.1",
          origin: "http://127.0.0.1",
        },
      })
    );
    assert.equal(disabled.status, 403);

    process.env.AUDITOR_ADMIN_TOKEN = "dev-secret";
    const unauthorised = await route.POST(
      new Request("http://127.0.0.1/api/dev/wipe-apps", {
        method: "POST",
        headers: {
          host: "127.0.0.1",
          origin: "http://127.0.0.1",
        },
      })
    );
    assert.equal(unauthorised.status, 401);
  } finally {
    if (previousToken === undefined) {
      delete process.env.AUDITOR_ADMIN_TOKEN;
    } else {
      process.env.AUDITOR_ADMIN_TOKEN = previousToken;
    }
  }
});

test("destructive routes require admin token when the deployment is network-exposed", async () => {
  // The route-layer gate is now config-driven (NOT derived from the spoofable
  // Host header): a network-exposed deployment with no token refuses the
  // mutation. This pins the route layer so removing Host-trust can't silently
  // drop the protection.
  const previousToken = process.env.AUDITOR_ADMIN_TOKEN;
  const previousExposed = process.env.PRIVACYTRACKER_NETWORK_EXPOSED;
  delete process.env.AUDITOR_ADMIN_TOKEN;
  process.env.PRIVACYTRACKER_NETWORK_EXPOSED = "1";
  try {
    const route = await import("../../app/api/reset/route");
    const response = await route.POST(
      new Request("https://privacytracker.example/api/reset", {
        method: "POST",
        headers: {
          host: "privacytracker.example",
          "x-forwarded-for": "203.0.113.12",
        },
      })
    );
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: "Admin token required" });
  } finally {
    if (previousToken === undefined) {
      delete process.env.AUDITOR_ADMIN_TOKEN;
    } else {
      process.env.AUDITOR_ADMIN_TOKEN = previousToken;
    }
    if (previousExposed === undefined) {
      delete process.env.PRIVACYTRACKER_NETWORK_EXPOSED;
    } else {
      process.env.PRIVACYTRACKER_NETWORK_EXPOSED = previousExposed;
    }
  }
});

test("backup restore rejects malformed JSON before mutating data", async () => {
  const route = await import("../../app/api/backup/restore/route");
  const response = await route.POST(
    new Request("http://127.0.0.1/api/backup/restore", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "203.0.113.11",
      },
      body: "{not json",
    })
  );

  assert.equal(response.status, 400);
  const body = await response.json();
  assert.match(body.error, /not valid JSON/i);
});

test("bounded JSON reader rejects oversized bodies", async () => {
  const body = JSON.stringify({ value: "x".repeat(64) });

  await assert.rejects(
    () =>
      readBoundedJson(
        new Request("http://127.0.0.1/api/test", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "content-length": String(Buffer.byteLength(body)),
          },
          body,
        }),
        32
      ),
    /Request body too large/
  );
});

test("policy URL sanitiser keeps metadata endpoints blocked even for localhost-friendly callers", () => {
  assert.equal(
    validateExternalUrl("http://169.254.169.254/latest/meta-data", {
      allowPrivateHosts: true,
    }).ok,
    false
  );
  assert.equal(
    sanitizePolicyUrl("http://metadata.google.internal/computeMetadata/v1"),
    ""
  );
});

// --- Tauri IPC in connect-src (desktop only) -------------------------------
// PR #212's hash-based CSP shipped `connect-src 'self'`, which blocks Tauri
// v2's custom IPC protocol: the page origin inside the desktop app is the
// Node sidecar's `http://127.0.0.1:<port>`, and `invoke()` fetches
// `ipc://localhost/...` (macOS/Linux) or `http://ipc.localhost/...`
// (Windows). tauri-plugin-notification's injected boot script tripped this
// on every page load. The allowance is gated on the desktop runtime so the
// browser/Docker policy stays untouched.

function cspFor(runtime: string | undefined): string {
  const previous = process.env.PRIVACYTRACKER_RUNTIME;
  if (runtime === undefined) {
    delete process.env.PRIVACYTRACKER_RUNTIME;
  } else {
    process.env.PRIVACYTRACKER_RUNTIME = runtime;
  }
  try {
    const res = proxy(
      new NextRequest("http://127.0.0.1:3000/dashboard", {
        headers: { host: "127.0.0.1:3000" },
      })
    );
    return res.headers.get("Content-Security-Policy") ?? "";
  } finally {
    if (previous === undefined) {
      delete process.env.PRIVACYTRACKER_RUNTIME;
    } else {
      process.env.PRIVACYTRACKER_RUNTIME = previous;
    }
  }
}

function connectSrcOf(csp: string): string {
  const directive = csp
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith("connect-src "));
  assert.ok(directive, `no connect-src in CSP: ${csp}`);
  return directive;
}

test("desktop runtime grants Tauri's IPC origins in connect-src", () => {
  const connect = connectSrcOf(cspFor("desktop"));
  // macOS + Linux route invoke() over `ipc://localhost`; the scheme-source
  // `ipc:` covers it. Windows/Android use `http://ipc.localhost`.
  assert.match(connect, /(^|\s)ipc:(\s|$)/);
  assert.match(connect, /(^|\s)http:\/\/ipc\.localhost(\s|$)/);
  // 'self' must survive — same-origin /api/* calls are the app's hot path.
  assert.match(connect, /'self'/);
});

test("browser and Docker deployments keep connect-src 'self' only", () => {
  for (const runtime of [undefined, "", "docker", "web"]) {
    assert.equal(
      connectSrcOf(cspFor(runtime)),
      "connect-src 'self'",
      `runtime=${String(runtime)} must not widen connect-src`
    );
  }
});

test("the desktop CSP allowance stays scoped to IPC, not the updater feed", () => {
  const csp = cspFor("desktop");
  // `plugin:updater|check` crosses the IPC boundary only; the HTTPS fetch to
  // the GitHub release feed runs in Rust (reqwest), never in the webview.
  // If someone adds github.com here, it is almost certainly a misdiagnosis.
  assert.doesNotMatch(csp, /github\.com/);
  // Every other directive must be byte-identical to the non-desktop policy.
  const desktopRest = csp.split(";").filter((d) => !d.includes("connect-src"));
  const webRest = cspFor(undefined)
    .split(";")
    .filter((d) => !d.includes("connect-src"));
  assert.deepEqual(desktopRest, webRest);
});

test("proxy normalises a trailing slash with headers attached, not a bare 308", () => {
  // Next's own trailing-slash redirect fires inside the router before the
  // proxy runs and returns `resHeaders: null`, so it lands with zero security
  // headers — including the static set from next.config.js's `headers()`.
  // `skipTrailingSlashRedirect: true` hands the redirect to us instead.
  const response = proxy(
    new NextRequest("http://127.0.0.1:3000/dashboard/?edit=layout", {
      headers: { host: "127.0.0.1:3000" },
    })
  );

  assert.equal(response.status, 308);
  assert.equal(response.headers.get("X-Frame-Options"), "DENY");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.match(
    response.headers.get("Content-Security-Policy") ?? "",
    /frame-ancestors 'none'/
  );

  // The Location must drop the slash and keep the query. Building it with
  // `request.nextUrl.clone()` does NOT: NextURL's pathname setter reports the
  // new value but does not rebuild `href`, so the redirect pointed at itself
  // and looped forever.
  const location = new URL(response.headers.get("Location") ?? "");
  assert.equal(location.pathname, "/dashboard");
  assert.equal(location.search, "?edit=layout");
});

test("proxy leaves a canonical path alone and the root slash untouched", () => {
  const canonical = proxy(
    new NextRequest("http://127.0.0.1:3000/dashboard", {
      headers: { host: "127.0.0.1:3000" },
    })
  );
  assert.notEqual(canonical.status, 308);

  // "/" is the one path whose trailing slash IS canonical.
  const root = proxy(
    new NextRequest("http://127.0.0.1:3000/", {
      headers: { host: "127.0.0.1:3000" },
    })
  );
  assert.notEqual(root.status, 308);
});
