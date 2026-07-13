import { expect, test } from "@playwright/test";

const sameOriginHeaders = {
  origin: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000",
};

const browserFlow = process.env.CODEX_SANDBOX ? test.skip : test;

test.beforeEach(async ({ request }) => {
  const reset = await request.post("/api/reset", {
    headers: sameOriginHeaders,
  });
  await expect(reset).toBeOK();
});

browserFlow(
  "welcome keeps first-run choices optional and defers advanced toggles",
  async ({ page }) => {
    await page.goto("/welcome");

    const goals = page
      .getByRole("group", { name: "What you want to do" })
      .getByRole("button");
    await expect(goals).toHaveCount(3);
    for (const goal of await goals.all()) {
      await expect(goal).toHaveAttribute("aria-pressed", "false");
    }

    await expect(
      page.getByText(
        "Local-first: your app list and history stay on the machine running privacytracker."
      )
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Fine-tune features" })
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Explore the sample dashboard" })
    ).toBeVisible();

    const focusRequest = page.waitForRequest(
      (request) =>
        request.url().endsWith("/api/focus") && request.method() === "POST"
    );
    await page
      .getByRole("button", { name: "Continue without choosing" })
      .click();

    expect((await focusRequest).postDataJSON()).toMatchObject({
      accessibility: false,
      audience: "self",
      cleanup: false,
      minimal: false,
      monitor: false,
      workflow: "custom",
    });
    await page.waitForURL(/\/onboard\/profile$/);
  }
);
