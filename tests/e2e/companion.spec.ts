import { expect, request as playwrightRequest, test } from "@playwright/test";

/**
 * Settings → Companion, end to end, on whichever backend the suite runs
 * against (`next start`, or `pt-core` in the e2e-rust job).
 *
 * The suite's server is network-exposed with an admin token, as a Docker
 * install is, and every request this suite's own contexts make carries that
 * token. The phone's requests are made from a SEPARATE request context with
 * no admin token, so what is asserted about them is what a phone gets:
 *   - the pairing code's token reads the companion allowlist;
 *   - it is refused (403) anywhere else, and for anything but GET;
 *   - the card shows the pairing flip from waiting to paired once the
 *     phone has used it, and removing it ends the token at once (401).
 * The QR code is asserted as an accessible image; decoding it is the phone
 * app's business (privacykey/privacytracker-ios tests its parser).
 */

const sameOriginHeaders = {
  origin: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000",
};
const BASE = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000";
const HEADER = "X-PrivacyTracker-Companion-Token";

const browserFlow = process.env.CODEX_SANDBOX ? test.skip : test;

test.beforeEach(async ({ request }) => {
  const reset = await request.post("/api/reset", {
    headers: sameOriginHeaders,
  });
  await expect(reset).toBeOK();
  const seed = await request.post("/api/dev/seed-sample-data?source=canned", {
    headers: sameOriginHeaders,
  });
  await expect(seed).toBeOK();
});

browserFlow(
  "pair a phone from Settings, read with its token, then revoke it",
  async ({ page }) => {
    await page.goto("/dashboard/settings/admin#companion");
    const card = page.locator("#companion");
    await expect(card).toBeVisible();
    await expect(card.locator("h2")).toHaveText("Companion");

    // Rename the instance as phones will see it.
    const name = card.getByLabel("Name phones see");
    await name.fill("E2E Mac");
    await card.getByRole("button", { name: "Save" }).click();
    await expect(name).toHaveValue("E2E Mac");

    // Outside the desktop app there is no Wi-Fi switch: the code points at
    // the address this page is open at.
    await expect(card.getByText("Allow phone connections")).toHaveCount(0);

    await card.getByPlaceholder("Phone name").fill("E2E iPhone");
    const created = page.waitForResponse(
      (res) =>
        res.url().endsWith("/api/companion/pairings") &&
        res.request().method() === "POST"
    );
    await card.getByRole("button", { name: "Make a pairing code" }).click();
    const response = await created;
    expect(response.status()).toBe(201);
    const { token, device } = (await response.json()) as {
      device: { id: string; label: string; state: string };
      token: string;
    };
    expect(token).toMatch(/^ptc_[0-9a-f]{64}$/);
    expect(device.state).toBe("waiting");

    await expect(
      card.getByRole("img", { name: "Pairing code for E2E iPhone" })
    ).toBeVisible();
    await expect(card.getByText("Waiting to be scanned")).toBeVisible();

    // The phone: its own client, no admin token, only the pairing token.
    const phone = await playwrightRequest.newContext({
      baseURL: BASE,
      extraHTTPHeaders: { [HEADER]: token },
    });
    try {
      const status = await phone.get("/api/companion/status");
      expect(status.status()).toBe(200);
      const body = await status.json();
      expect(body.instanceName).toBe("E2E Mac");
      expect(body.appCount).toBeGreaterThan(0);
      expect(body.device.label).toBe("E2E iPhone");

      expect((await phone.get("/api/apps?limit=5&meta=grid")).status()).toBe(
        200
      );
      expect((await phone.get("/api/triage")).status()).toBe(200);
      expect((await phone.get("/api/settings")).status()).toBe(403);
      expect((await phone.get("/api/companion")).status()).toBe(403);
      expect(
        (
          await phone.post("/api/companion/pairings", {
            headers: sameOriginHeaders,
          })
        ).status()
      ).toBe(403);

      // The card polls while the code is on screen: the row flips to paired.
      await expect(card.getByText("E2E iPhone is paired")).toBeVisible({
        timeout: 10_000,
      });

      await card.getByRole("button", { name: "Done" }).click();
      await card.getByRole("button", { name: "Remove E2E iPhone" }).click();
      await card
        .getByRole("group")
        .getByRole("button", { name: "Remove" })
        .click();
      await expect(card.getByText("No phones paired yet.")).toBeVisible();

      expect((await phone.get("/api/companion/status")).status()).toBe(401);
    } finally {
      await phone.dispose();
    }
  }
);

browserFlow(
  "a companion request without a valid token is refused",
  async () => {
    const stranger = await playwrightRequest.newContext({
      baseURL: BASE,
      extraHTTPHeaders: { [HEADER]: `ptc_${"0".repeat(64)}` },
    });
    try {
      expect((await stranger.get("/api/apps")).status()).toBe(401);
      expect((await stranger.get("/api/settings")).status()).toBe(403);
    } finally {
      await stranger.dispose();
    }
  }
);
