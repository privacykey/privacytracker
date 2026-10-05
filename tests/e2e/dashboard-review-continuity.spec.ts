import path from "node:path";
import { expect, test } from "@playwright/test";
import Database from "better-sqlite3";

const headers = {
  origin: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000",
};
const visitKey = "privacytracker.dashboard.visit.all";

// Only the disposable DB owned by playwright.config.ts. Seed time-sensitive
// history/reminders directly so both real backends can exercise due dates
// without changing the host clock or mocking their responses.
function fixtureDb() {
  return new Database(path.join(process.cwd(), ".playwright-data/privacy.db"));
}

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

test("change count survives app review, dashboard return and reload; a new tab gets a fresh visit", async ({
  page,
  request,
  context,
}) => {
  const apps = await (await request.get("/api/apps")).json();
  const baseline = Date.now() - 60000;
  const db = fixtureDb();
  try {
    // Isolate the two live changes from any history in the canned sample.
    db.prepare("DELETE FROM privacy_snapshots").run();
    for (const app of apps.slice(0, 2)) {
      db.prepare(
        "INSERT INTO privacy_snapshots(id,app_id,scraped_at,snapshot_json,changes_detected,changes_summary,source) VALUES (?,?,?,'[]',1,'[]','live')"
      ).run(`visit-${app.id}`, app.id, baseline + 10000);
    }
  } finally {
    db.close();
  }
  await page.addInitScript(
    ({ key, since }) => {
      if (!localStorage.getItem(key)) {
        localStorage.setItem(key, String(since));
      }
    },
    { key: visitKey, since: baseline }
  );
  await page.goto("/dashboard");
  const count = page.getByText("+2 changed since your last visit", {
    exact: true,
  });
  await expect(count).toBeVisible();
  await page
    .locator(`.focus-overview-apps a[href="/apps/${apps[0].id}"]`)
    .first()
    .click();
  await expect(page.locator(".verdict-picker")).toBeVisible();
  await page.getByRole("link", { name: "Home", exact: true }).click();
  await expect(count).toBeVisible();
  await page.reload();
  await expect(count).toBeVisible();
  const nextTab = await context.newPage();
  await nextTab.goto("/dashboard");
  await expect(
    nextTab.getByText("+0 changed since your last visit", { exact: true })
  ).toBeVisible();
  await nextTab.close();
  await page.reload();
  await expect(count).toBeVisible();
});

test("due reminders offer Review now and Reschedule; a failed save preserves the choice and retry updates the dashboard", async ({
  page,
  request,
}) => {
  const apps = await (await request.get("/api/apps")).json();
  const app = apps[0];
  const db = fixtureDb();
  try {
    db.prepare(
      "INSERT OR REPLACE INTO app_settings(key,value) VALUES (?,?)"
    ).run(`review.defer.${app.id}`, String(Date.now() - 60000));
  } finally {
    db.close();
  }
  await page.goto("/dashboard");
  const row = page
    .locator(".focus-overview-apps li")
    .filter({ has: page.getByRole("link", { name: app.name, exact: true }) });
  await expect(row).toContainText("Ready to review");
  await expect(
    row.getByRole("link", { name: "Review now", exact: true })
  ).toHaveAttribute("href", `/apps/${app.id}#verdict-picker-heading`);
  await row.getByRole("link", { name: "Reschedule", exact: true }).click();
  const controls = page.locator("#review-reminder");
  await expect(controls).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(controls.getByRole("combobox")).toBeFocused();
  await expect(
    page.getByText(
      "Ready to review. Make a decision above, or choose a new reminder.",
      { exact: true }
    )
  ).toBeVisible();
  await controls.getByRole("combobox").selectOption("1");
  // Fail one save: the reminder stays due, and the selected day remains.
  await page.route(
    "**/api/verdicts",
    async (route) => {
      await route.fulfill({
        status: 500,
        json: { error: "Temporary save failure" },
      });
    },
    { times: 1 }
  );
  await controls
    .getByRole("button", { name: "Reschedule", exact: true })
    .click();
  await expect(page.locator(".review-next-step [role=alert]")).toBeVisible();
  await expect(controls.getByRole("combobox")).toHaveValue("1");
  await controls
    .getByRole("button", { name: "Reschedule", exact: true })
    .click();
  await expect(page.locator(".review-next-step [role=status]")).toContainText(
    "This decision will return to your dashboard"
  );
  const decision = await (
    await request.get(`/api/verdicts?appId=${app.id}&decision=1`)
  ).json();
  expect(decision.deferredUntil).toBeGreaterThan(Date.now());
  expect(decision.deferredUntil).toBeLessThan(Date.now() + 86400000 + 1000);
  await page.getByRole("link", { name: "Home", exact: true }).click();
  await expect(row).toContainText("Decide later");
  await expect(row).not.toContainText("Ready to review");
  await expect(
    row.getByRole("link", { name: "Review now", exact: true })
  ).toHaveCount(0);
});

test("apps with unreviewed changes open in place from the overview, and close again", async ({
  page,
  request,
}) => {
  const apps = await (await request.get("/api/apps")).json();
  const changed = apps.slice(0, 2);
  const db = fixtureDb();
  try {
    // Two apps carry an unreviewed change, the third none. The counter is
    // what both the overview and "Changes to review" read.
    db.prepare("DELETE FROM privacy_snapshots").run();
    db.prepare(
      "UPDATE apps SET changeCount = 0, changes_acknowledged_at = 0"
    ).run();
    for (const app of changed) {
      db.prepare("UPDATE apps SET changeCount = 1 WHERE id = ?").run(app.id);
      db.prepare(
        "INSERT INTO privacy_snapshots(id,app_id,scraped_at,snapshot_json,changes_detected,changes_summary,source) VALUES (?,?,?,'[]',1,'[]','live')"
      ).run(`expand-${app.id}`, app.id, Date.now() - 1000);
    }
  } finally {
    db.close();
  }
  await page.goto("/dashboard");
  const overview = page.locator(".focus-overview");
  // The section below lists the changed apps, so the card starts collapsed
  // and each app appears once on the page.
  await expect(page.locator("#changes-to-review")).toBeVisible();
  const show = overview.getByRole("button", {
    name: "Show 2 apps with unreviewed changes",
    exact: true,
  });
  await expect(show).toHaveAttribute("aria-expanded", "false");
  const link = overview.getByRole("link", {
    name: changed[0].name,
    exact: true,
  });
  await expect(link).toBeHidden();
  await show.click();
  const hide = overview.getByRole("button", {
    name: "Hide apps with unreviewed changes",
    exact: true,
  });
  await expect(hide).toHaveAttribute("aria-expanded", "true");
  await expect(link).toBeVisible();
  await expect(overview.locator(".focus-overview-apps-more li")).toHaveCount(2);
  await hide.click();
  await expect(link).toBeHidden();
});
