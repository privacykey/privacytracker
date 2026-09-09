import { createServer } from "node:http";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

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
