import { createServer, request as httpRequest } from "node:http";
import { networkInterfaces } from "node:os";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

interface RawResponse {
  body: string;
  retryAfter: string | null;
  status: number;
}

/**
 * One request from a chosen local source address. The server keys its
 * admin-token guess budget on the socket peer, so a second source address
 * is a second client without touching the one every other spec uses.
 */
function send(
  baseURL: string,
  path: string,
  options: {
    body?: string;
    headers?: Record<string, string>;
    localAddress?: string;
    method?: string;
  } = {}
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      new URL(path, baseURL),
      {
        method: options.method ?? "GET",
        headers: options.headers,
        localAddress: options.localAddress,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body,
            retryAfter: (res.headers["retry-after"] as string) ?? null,
          })
        );
      }
    );
    req.on("error", reject);
    req.end(options.body);
  });
}

/**
 * A local address other than 127.0.0.1 that can reach the loopback server:
 * 127.0.0.2 on Linux, where all of 127/8 is local; this host's own LAN
 * address on macOS, where it is not. Null when neither connects.
 */
async function secondSourceAddress(baseURL: string): Promise<string | null> {
  const candidates = ["127.0.0.2"];
  for (const list of Object.values(networkInterfaces())) {
    for (const address of list ?? []) {
      if (address.family === "IPv4" && !address.internal) {
        candidates.push(address.address);
      }
    }
  }
  for (const localAddress of candidates) {
    try {
      const res = await send(baseURL, "/api/health", { localAddress });
      if (res.status === 200) {
        return localAddress;
      }
    } catch {
      // Not usable as a source address on this host.
    }
  }
  return null;
}

test("private data requires sign-in and a same-site attacker cannot reuse its cookie", async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({ baseURL, extraHTTPHeaders: {} });
  const page = await context.newPage();
  let outboundCalls = 0;
  const attacker = createServer((req, res) => {
    if (req.url?.startsWith("/v1/")) {
      outboundCalls += 1;
    }
    res.setHeader("Content-Type", "text/html");
    res.end("<title>Local attacker simulation</title>");
  });
  await new Promise<void>((resolve) =>
    attacker.listen(0, "127.0.0.1", resolve)
  );
  const address = attacker.address();
  if (!address || typeof address === "string") {
    throw new Error("Missing listener");
  }
  const attackerURL = `http://127.0.0.1:${address.port}`;
  try {
    expect((await context.request.get("/api/apps")).status()).toBe(401);
    expect(
      (await context.request.get("/api/annotations?appId=private")).status()
    ).toBe(401);
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page
      .getByLabel("Access token")
      .fill(
        process.env.AUDITOR_ADMIN_TOKEN ?? "privacytracker-playwright-token"
      );
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page).not.toHaveURL(/\/login$/);
    expect((await context.request.get("/api/apps")).status()).toBe(200);
    const cookie = (await context.cookies()).find(
      (item) => item.name === "pt_admin_token"
    );
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe("Strict");

    // A real different-port page shares the cookie's site. The browser attaches
    // the cookie to this simple request; the server must still reject its Origin.
    await page.goto(attackerURL);
    // CORS hides rejected responses from page JavaScript. Read network-level
    // status/cookie evidence through Chromium's debugger, without modifying it.
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    let targetRequest = "";
    const statuses = new Map<string, number>();
    const sentCookies = new Map<string, string>();
    cdp.on("Network.requestWillBeSent", (event) => {
      if (event.request.url === `${baseURL}/api/ai/models`) {
        targetRequest = event.requestId;
      }
    });
    cdp.on("Network.responseReceivedExtraInfo", (event) => {
      statuses.set(event.requestId, event.statusCode);
    });
    cdp.on("Network.requestWillBeSentExtraInfo", (event) => {
      sentCookies.set(
        event.requestId,
        String(event.headers.Cookie ?? event.headers.cookie ?? "")
      );
    });
    await page.evaluate(
      async ({ appURL, canaryURL }) => {
        try {
          await fetch(`${appURL}/api/ai/models`, {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "text/plain" },
            body: JSON.stringify({
              provider: "openai",
              baseUrl: canaryURL,
              apiKey: "__SET__",
            }),
          });
        } catch {
          /* The response has no CORS permission, regardless of status. */
        }
      },
      { appURL: baseURL, canaryURL: attackerURL }
    );
    await expect.poll(() => statuses.get(targetRequest)).toBe(403);
    expect(sentCookies.get(targetRequest)).toContain("pt_admin_token=");
    await cdp.detach();
    expect(outboundCalls).toBe(0);

    await page.goto("/login");
    const logoutStatus = await page.evaluate(
      async () =>
        (await fetch("/api/auth/admin-token/logout", { method: "POST" })).status
    );
    expect(logoutStatus).toBe(200);
    expect((await context.request.get("/api/apps")).status()).toBe(401);
  } finally {
    await context.close();
    attacker.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      attacker.close((error) => (error ? reject(error) : resolve()))
    );
  }
});

test("a cookie left from an earlier token counts once, so the browser is never throttled", async ({
  baseURL,
}) => {
  const url = baseURL ?? "http://127.0.0.1:3000";
  const token = process.env.AUDITOR_ADMIN_TOKEN ?? "";
  const stale = { cookie: "pt_admin_token=from-an-earlier-token" };
  for (let i = 0; i < 15; i++) {
    expect((await send(url, "/api/apps", { headers: stale })).status).toBe(401);
  }
  const signedIn = await send(url, "/api/apps", {
    headers: { ...stale, "x-auditor-admin-token": token },
  });
  expect(signedIn.status).toBe(200);
});

test("wrong admin tokens from one client neither lock out another nor get checked past the budget", async ({
  baseURL,
  request,
}) => {
  const url = baseURL ?? "http://127.0.0.1:3000";
  const other = await secondSourceAddress(url);
  test.skip(!other, "no second local source address on this host");
  const guesser = other ?? undefined;
  const token = process.env.AUDITOR_ADMIN_TOKEN ?? "";
  const login = (from: string | undefined, value: string) =>
    send(url, "/api/auth/admin-token/login", {
      method: "POST",
      localAddress: from,
      headers: { origin: url, "content-type": "application/json" },
      body: JSON.stringify({ token: value }),
    });

  // Five wrong sign-ins from one client fill that client's attempt limit…
  for (let i = 0; i < 5; i++) {
    expect((await login(guesser, `wrong-sign-in-${i}`)).status).toBe(401);
  }
  expect((await login(guesser, token)).status).toBe(429);
  // …and no one else's: the operator still signs in.
  expect((await login("127.0.0.1", token)).status).toBe(200);

  // Five more wrong tokens, by header, reach the budget of ten…
  for (let i = 0; i < 5; i++) {
    const res = await send(url, "/api/apps", {
      localAddress: guesser,
      headers: { "x-auditor-admin-token": `wrong-header-${i}` },
    });
    expect(res.status).toBe(401);
  }
  // …after which even the right token is refused before it is checked, on
  // every path that would say whether it is right.
  const refused = await send(url, "/api/apps", {
    localAddress: guesser,
    headers: { "x-auditor-admin-token": token },
  });
  expect(refused.status).toBe(429);
  expect(Number(refused.retryAfter)).toBeGreaterThan(0);
  expect(
    (
      await send(url, "/api/auth/admin-token/status", {
        localAddress: guesser,
        headers: { "x-auditor-admin-token": token },
      })
    ).status
  ).toBe(429);
  // A request with no token is still answered as usual.
  expect((await send(url, "/api/apps", { localAddress: guesser })).status).toBe(
    401
  );
  // Every other client carries on.
  expect((await request.get("/api/apps")).status()).toBe(200);
});
