import { expect, test } from "@playwright/test";

const sameOriginHeaders = {
  origin: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000",
};

test.beforeEach(async ({ request }) => {
  const reset = await request.post("/api/reset", {
    headers: sameOriginHeaders,
  });
  await expect(reset).toBeOK();
  const preset = await request.post("/api/dashboard/layout/preset", {
    headers: sameOriginHeaders,
    data: { preset: "minimal" },
  });
  await expect(preset).toBeOK();
});

test("simple editor cannot replace a saved layout after a failed read", async ({
  page,
  request,
}) => {
  let failRead = true;
  let writes = 0;
  await page.route("**/api/dashboard/layout", async (route) => {
    if (route.request().method() === "PUT") {
      writes += 1;
    }
    if (route.request().method() === "GET" && failRead) {
      await route.fulfill({ status: 503, body: "Unavailable" });
      return;
    }
    await route.continue();
  });

  await page.goto("/dashboard/settings/layout");
  await expect(
    page.getByText(
      "Couldn't load your saved layout. Try again before making changes."
    )
  ).toBeVisible();
  await expect(page.locator(".layout-editor")).toHaveCount(0);
  expect(writes).toBe(0);

  failRead = false;
  await page.getByRole("button", { name: "Retry loading layout" }).click();
  await expect(page.locator('[data-preset="minimal"]')).toHaveAttribute(
    "aria-checked",
    "true"
  );
  const saved = await (await request.get("/api/dashboard/layout")).json();
  expect(saved.matchedPreset).toBe("minimal");
  expect(writes).toBe(0);
});

test("dashboard edit mode waits for a successful layout read", async ({
  page,
  request,
}) => {
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
  const seed = await request.post("/api/dev/seed-sample-data?source=canned", {
    headers: sameOriginHeaders,
  });
  await expect(seed).toBeOK();

  let failRead = true;
  let writes = 0;
  await page.route("**/api/dashboard/layout", async (route) => {
    if (route.request().method() === "PUT") {
      writes += 1;
    }
    if (route.request().method() === "GET" && failRead) {
      await route.fulfill({ status: 503, body: "Unavailable" });
      return;
    }
    await route.continue();
  });

  await page.goto("/dashboard?edit=layout");
  await expect(
    page.getByText("Couldn’t load your saved choices")
  ).toBeVisible();
  await expect(page.locator(".home-edit-toolbar")).toHaveCount(0);
  expect(writes).toBe(0);

  failRead = false;
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.locator(".home-edit-toolbar")).toBeVisible();
  const saved = await (await request.get("/api/dashboard/layout")).json();
  expect(saved.matchedPreset).toBe("minimal");
  expect(writes).toBe(0);
});
