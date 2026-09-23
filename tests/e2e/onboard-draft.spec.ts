import { expect, type Page, test } from "@playwright/test";

const sameOriginHeaders = {
  origin: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000",
};

async function openManualEntry(page: Page) {
  await page.goto("/onboard");
  await page.getByText("Other import options").click();
  const manual = page.getByTestId("onboard-method-manual");
  await expect(async () => {
    await manual.click();
    await expect(manual).toHaveAttribute("aria-checked", "true", {
      timeout: 500,
    });
  }).toPass({ timeout: 10_000 });
  await page.getByTestId("onboard-step1-continue").click();
  await expect(page.getByTestId("onboard-app-names")).toBeVisible();
}

test.beforeEach(async ({ request }) => {
  const focus = await request.post("/api/focus", {
    headers: sameOriginHeaders,
    data: {
      audience: "self",
      monitor: true,
      cleanup: false,
      minimal: false,
      accessibility: false,
    },
  });
  await expect(focus).toBeOK();
});

test("reselecting an import method preserves the app list", async ({
  page,
}) => {
  await openManualEntry(page);
  await page.getByTestId("onboard-app-names").fill("Notes");
  await page.getByRole("button", { name: "+ Add to list" }).click();
  await expect(
    page.getByRole("button", { name: "Remove Notes" })
  ).toBeVisible();

  await page.getByRole("button", { name: "← Back" }).click();
  await page.getByText("Other import options").click();
  await page.getByTestId("onboard-method-manual").click();
  await page.getByTestId("onboard-step1-continue").click();
  await expect(
    page.getByRole("button", { name: "Remove Notes" })
  ).toBeVisible();

  await page.getByRole("button", { name: "← Back" }).click();
  await page.getByTestId("onboard-method-file").click();
  await expect(page.getByText("Switch to Upload a file?")).toBeVisible();
  await page.getByRole("button", { name: "Keep my list" }).click();
  await expect(page.getByTestId("onboard-method-manual")).toHaveAttribute(
    "aria-checked",
    "true"
  );
  await page.getByTestId("onboard-step1-continue").click();
  await expect(
    page.getByRole("button", { name: "Remove Notes" })
  ).toBeVisible();

  await page.getByRole("button", { name: "← Back" }).click();
  await page.getByTestId("onboard-method-file").click();
  await page.getByRole("button", { name: "Discard and switch" }).click();
  await expect(page.getByTestId("onboard-method-file")).toHaveAttribute(
    "aria-checked",
    "true"
  );
  await page.getByTestId("onboard-step1-continue").click();
  await expect(
    page.getByRole("button", { name: "Remove Notes" })
  ).not.toBeVisible();
});

test("typed but unadded names survive a reload", async ({ page }) => {
  await openManualEntry(page);
  await page.getByTestId("onboard-app-names").fill("Calendar");
  await page.reload();
  await expect(page.getByTestId("onboard-app-names")).toHaveValue("Calendar");
  await expect(page.getByTestId("onboard-search")).toBeEnabled();
});

test("mobile Live Text help is a separate control from method selection", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/onboard");
  const manual = page.getByTestId("onboard-method-manual");
  const help = page.getByRole("button", {
    name: /How to grab app names from a screenshot with Live Text/,
  });
  await expect(manual).toBeVisible();
  await expect(help).toBeVisible();
  expect(
    await manual.evaluate((element) =>
      element.contains(document.querySelector(".method-card-action button"))
    )
  ).toBe(false);
  const selectedBefore = await manual.getAttribute("aria-checked");
  await help.click();
  await expect(page.locator(".live-text-modal")).toBeVisible();
  await expect(manual).toHaveAttribute(
    "aria-checked",
    selectedBefore ?? "false"
  );
});
