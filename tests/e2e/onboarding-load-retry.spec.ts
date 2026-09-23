import { expect, test } from "@playwright/test";

const sameOriginHeaders = {
  origin: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000",
};

test.beforeEach(async ({ request }) => {
  const response = await request.post("/api/focus", {
    headers: sameOriginHeaders,
    data: {
      audience: "guardian",
      monitor: false,
      cleanup: true,
      minimal: false,
      accessibility: false,
    },
  });
  await expect(response).toBeOK();
});

test("welcome retries a failed focus read before showing saved choices", async ({
  page,
}) => {
  let reads = 0;
  await page.route("**/api/focus", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    reads += 1;
    if (reads === 1) {
      await route.fulfill({ status: 503, body: "Unavailable" });
    } else {
      await route.continue();
    }
  });
  await page.goto("/welcome");
  await expect(
    page.getByText("Couldn’t load your saved choices")
  ).toBeVisible();
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(
    page.getByText("Couldn’t load your saved choices")
  ).not.toBeVisible();
  await expect(
    page.getByRole("radio", { name: /For a child or dependant/ })
  ).toHaveAttribute("aria-checked", "true");
  expect(reads).toBeGreaterThanOrEqual(2);
});

test("profile setup retries failed profile read without presenting empty editors", async ({
  page,
}) => {
  let reads = 0;
  await page.route("**/api/privacy-profile", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    reads += 1;
    if (reads === 1) {
      await route.fulfill({ status: 503, body: "Unavailable" });
    } else {
      await route.continue();
    }
  });
  await page.goto("/onboard/profile");
  await expect(
    page.getByText("Couldn’t load your saved choices")
  ).toBeVisible();
  await expect(page.getByText("Set up matching profiles")).not.toBeVisible();
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByText("Set up matching profiles")).toBeVisible();
  expect(reads).toBeGreaterThanOrEqual(2);
});
