import { expect, test } from "@playwright/test";

const headers = {
  origin: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000",
};
test.beforeEach(async ({ request }) => {
  await expect(await request.post("/api/reset", { headers })).toBeOK();
  await expect(
    await request.post("/api/focus", {
      headers,
      data: { audience: "self", monitor: true, cleanup: true, minimal: true },
    })
  ).toBeOK();
  await expect(
    await request.post("/api/dev/seed-sample-data?source=canned&limit=3", {
      headers,
    })
  ).toBeOK();
});

test("overview retains both goals with Minimal and leads into guided cleanup", async ({
  page,
  request,
}) => {
  const focus = await (await request.get("/api/focus")).json();
  expect(focus).toMatchObject({ monitor: true, cleanup: true, minimal: true });
  await page.goto("/dashboard");
  await expect(
    page.getByRole("heading", { name: "Your apps, your next steps" })
  ).toBeVisible();
  await expect(page.locator(".focus-goal-labels")).toContainText(
    "Monitor changes"
  );
  await expect(page.locator(".focus-goal-labels")).toContainText("Clean up");
  await expect(page.locator(".focus-goal-labels")).toContainText("Simple view");
  const apps = await (await request.get("/api/apps")).json();
  // Nothing is decided or changed in the fresh sample, so the card shows
  // only its starter rows (OVERVIEW_STARTER_ROWS), not the whole preview.
  await expect(page.locator(".focus-overview-apps li")).toHaveCount(
    Math.min(3, apps.length)
  );
  await page.getByRole("link", { name: "Start guided cleanup" }).click();
  await expect(
    page.getByRole("heading", { name: "Set up your review" })
  ).toBeVisible();
});

test("Keep and Decide later persist, and replacement opens a comparison for that app", async ({
  page,
  request,
}) => {
  const apps = await (await request.get("/api/apps")).json();
  const triage = await (await request.get("/api/triage")).json();
  const app = triage.higherRisk[0] ?? apps[0];
  await page.goto(`/apps/${app.id}`);
  const picker = page.locator(".verdict-picker");
  await picker.getByRole("radio", { name: /Keep/ }).click();
  await expect
    .poll(
      async () =>
        (
          await (
            await request.get(`/api/verdicts?appId=${app.id}&decision=1`)
          ).json()
        ).accepted
    )
    .toBe(true);
  await page.reload();
  await expect(
    page.getByText(/You are keeping this app and accepting/)
  ).toBeVisible();
  await page.getByRole("button", { name: "Decide later", exact: true }).click();
  await expect(
    page.getByText(/This decision will return to your dashboard/)
  ).toBeVisible();
  await page.goto("/dashboard");
  await expect(page.locator(".focus-overview-apps")).toContainText(
    "Decide later"
  );
  // The simple view folds the risk list. Open it when it has something to
  // show, so the check below reads a rendered list, not an absent one.
  const more = page.getByRole("button", {
    name: "Show more detail",
    exact: true,
  });
  if ((await more.count()) > 0) {
    await more.click();
  }
  await expect(
    page.locator(`#higher-risk a[href="/apps/${app.id}"]`)
  ).toHaveCount(0);
  await expect(
    await request.post("/api/focus", {
      headers,
      data: { audience: "self", monitor: true },
    })
  ).toBeOK();
  await page.reload();
  await expect(page.locator(".focus-overview-apps")).toContainText(
    "Decide later"
  );
  await expect(
    page.getByRole("link", { name: "Start guided cleanup" })
  ).toHaveCount(0);
  await expect(
    await request.post("/api/focus", {
      headers,
      data: { audience: "self", monitor: true, cleanup: true },
    })
  ).toBeOK();
  await expect(
    await request.post("/api/verdicts", {
      headers,
      data: { appId: app.id, verdict: "replace" },
    })
  ).toBeOK();
  await page.reload();
  const compare = page.getByRole("link", {
    name: "Find & compare alternatives",
    exact: true,
  });
  await expect(compare).toHaveAttribute(
    "href",
    `/dashboard/compare?a=id:${app.id}&from=review`
  );
  await compare.click();
  await expect(page).toHaveURL(
    new RegExp(`/dashboard/compare\\?a=id:${app.id}`)
  );
});

test("simple view folds the long lists behind Show more detail, and leaving it brings them back", async ({
  page,
  request,
}) => {
  // The whole canned set, so the risk list has rows to fold.
  await expect(
    await request.post("/api/dev/seed-sample-data?source=canned", { headers })
  ).toBeOK();
  const triage = await (await request.get("/api/triage")).json();
  expect(triage.higherRisk.length).toBeGreaterThan(0);

  await page.goto("/dashboard");
  await expect(
    page.getByRole("heading", { name: "Your apps, your next steps" })
  ).toBeVisible();
  await expect(page.locator("#higher-risk")).toHaveCount(0);
  const note = page.locator("#simple-view-more");
  await expect(note).toContainText("Simple view is hiding");
  const show = note.getByRole("button", {
    name: "Show more detail",
    exact: true,
  });
  await expect(show).toHaveAttribute("aria-expanded", "false");
  await show.click();
  await expect(page.locator("#higher-risk")).toBeVisible();
  const hide = note.getByRole("button", {
    name: "Hide the extra detail",
    exact: true,
  });
  await expect(hide).toHaveAttribute("aria-expanded", "true");
  // The note stops claiming the lists are hidden once they are on screen.
  await expect(note).toContainText("that simple view usually hides");
  await expect(note).not.toContainText("Simple view is hiding");
  await hide.click();
  await expect(page.locator("#higher-risk")).toHaveCount(0);

  // Without the modifier the lists are simply part of the page again.
  await expect(
    await request.post("/api/focus", {
      headers,
      data: { audience: "self", monitor: true, cleanup: true, minimal: false },
    })
  ).toBeOK();
  await page.reload();
  await expect(page.locator("#higher-risk")).toBeVisible();
  await expect(page.locator("#simple-view-more")).toHaveCount(0);
});

test("fixed layout survives a focus change; switching it off resumes automatic order on the next change", async ({
  page,
  request,
}) => {
  await page.goto("/dashboard/settings/layout");
  await page.getByRole("checkbox", { name: /Keep layout fixed/ }).check();
  await expect
    .poll(
      async () =>
        (await (await request.get("/api/dashboard/layout")).json()).layout
          .keepFixed
    )
    .toBe(true);
  const before = (await (await request.get("/api/dashboard/layout")).json())
    .layout;
  await expect(
    await request.post("/api/focus", {
      headers,
      data: { audience: "guardian", cleanup: true },
    })
  ).toBeOK();
  expect(
    (await (await request.get("/api/dashboard/layout")).json()).layout
  ).toEqual(before);
  await page.getByRole("checkbox", { name: /Keep layout fixed/ }).uncheck();
  await expect
    .poll(
      async () =>
        !!(await (await request.get("/api/dashboard/layout")).json()).layout
          .keepFixed
    )
    .toBe(false);
  await expect(
    await request.post("/api/focus", {
      headers,
      data: { audience: "loved_one", cleanup: true },
    })
  ).toBeOK();
  const focus = await (await request.get("/api/focus")).json();
  expect(focus.workflow).toBe("other_handoff");
  expect(
    (await (await request.get("/api/dashboard/layout")).json()).layout.order
  ).not.toEqual(before.order);
});
