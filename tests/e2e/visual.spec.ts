import { expect, type Page, test } from "@playwright/test";

/**
 * Visual-regression net for the CSS migration (docs/CSS.md).
 *
 * Nothing else catches a dropped selector: the structural settings net
 * asserts sections *render with content*, the behavioural onboarding specs
 * assert flows *work* — a rule that silently stops applying passes both.
 * This net exists so CSS can move out of globals.css with a gate, the same
 * way settings-sections.spec.ts existed before the component split (and
 * caught two real regressions during it).
 *
 * DELIBERATELY LOCAL-ONLY, two reasons:
 *
 *   1. Screenshot baselines are platform-renderer-specific (font
 *      antialiasing differs between this machine and CI's Linux runners),
 *      so committed baselines would fail everywhere but the machine that
 *      made them.
 *   2. App screenshots stay out of the public repo as a matter of policy —
 *      the baseline PNGs are gitignored (see .gitignore), like
 *      docs/screenshots/.
 *
 * Usage, around any CSS-moving change:
 *
 *   VISUAL=1 npx playwright test tests/e2e/visual.spec.ts --update-snapshots  # before
 *   VISUAL=1 npx playwright test tests/e2e/visual.spec.ts                     # after
 *
 * Without VISUAL=1 every test here skips, so CI and ordinary local runs
 * are unaffected.
 */

const visual = process.env.VISUAL ? test : test.skip;

const sameOriginHeaders = {
  origin: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000",
};

test.beforeEach(async ({ request }) => {
  const focus = await request.post("/api/focus", {
    headers: sameOriginHeaders,
    data: {
      audience: "self",
      monitor: true,
      cleanup: true,
      minimal: false,
      accessibility: true,
    },
  });
  await expect(focus).toBeOK();
  const seed = await request.post("/api/dev/seed-sample-data?source=canned", {
    headers: sameOriginHeaders,
  });
  await expect(seed).toBeOK();
  // Force every flag-gated section on so the shots cover the full surface —
  // a selector for a hidden section would otherwise never be exercised.
  for (const key of [
    "flag.settings.admin.backup",
    "flag.settings.admin.reset",
    "flag.settings.admin.start_over",
    "flag.settings.policies.wayback",
    "flag.settings.sync.schedule",
    "flag.devopts.visible",
    "flag.settings.ai.enabled",
    "flag.settings.import.history",
  ]) {
    await request.post("/api/feature-flags/overrides", {
      headers: sameOriginHeaders,
      data: { key, value: "on" },
    });
  }
});

/**
 * Neutralise legitimate nondeterminism before comparing pixels: relative
 * timestamps ("2m ago", "in ~40s"), clock-of-day datestamps ("02:41 AM" —
 * the canned fixture seeds snapshot times relative to seed time, so the
 * minutes drift between runs), and anything mid-animation. Same technique
 * as the DOM-diff harness used throughout the component split.
 *
 * The task-center trigger needs the same treatment for a different reason.
 * Its badge counts background jobs that are *in flight right now*, and its
 * `is-active` class restyles the button whenever that count is above zero —
 * so the nav, which appears in every shot, changes with how long the run
 * happened to take before this particular screenshot. Adding one test to
 * this file was enough to flip it from 3 to 2 and fail an unrelated
 * baseline. Both are normalised to the idle state.
 *
 * The trade is explicit: the net no longer covers the badge's own styling
 * (it is `position: absolute`, so removing it shifts nothing else). That is
 * a real gap, but a smaller one than a net that fails for reasons no CSS
 * change caused — the failure mode that gets a net ignored, then deleted.
 */
async function settle(page: Page) {
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    const volatile =
      /(\d+\s*(second|minute|hour|day|s|m|h)s?\s*(ago|from now)?)|(\d{1,2}:\d{2}(\s*[AP]M)?)/i;
    for (const el of document.querySelectorAll("main *, .wizard *")) {
      if (el.children.length === 0 && volatile.test(el.textContent ?? "")) {
        el.textContent = "~FROZEN";
      }
    }
    document.querySelector(".task-center-badge")?.remove();
    document
      .querySelector(".task-center-trigger")
      ?.classList.remove("is-active");
  });
}

const SHOT = {
  fullPage: true,
  animations: "disabled",
} as const;

for (const group of ["you", "sync", "policies", "admin"] as const) {
  visual(`settings route: ${group}`, async ({ page }) => {
    await page.goto(`/dashboard/settings/${group}`);
    await expect(page.locator(".settings-sidebar")).toBeVisible();
    await settle(page);
    await expect(page).toHaveScreenshot(`settings-${group}.png`, SHOT);
  });
}

visual("onboarding: step 1, choose method", async ({ page }) => {
  await page.goto("/onboard");
  // On desktop the manual card sits inside the collapsed "Other import
  // options" disclosure; the primary card is always visible. Open the
  // disclosure so the shot covers the collapsed cards' styling too.
  await expect(page.locator(".method-card").first()).toBeVisible();
  await page.getByText("Other import options").click();
  await expect(page.getByTestId("onboard-method-manual")).toBeVisible();
  await settle(page);
  await expect(page).toHaveScreenshot("onboard-step1.png", SHOT);
});

visual("onboarding: step 2, manual entry", async ({ page }) => {
  await page.goto("/onboard");
  await page.getByText("Other import options").click();
  // React may not have attached handlers on a cold start — poll the click
  // until the radio actually takes, same as the behavioural specs do.
  const manualCard = page.getByTestId("onboard-method-manual");
  await expect(async () => {
    await manualCard.click();
    await expect(manualCard).toHaveAttribute("aria-checked", "true", {
      timeout: 500,
    });
  }).toPass({ timeout: 10_000 });
  await page.getByTestId("onboard-step1-continue").click();
  await expect(page.getByTestId("onboard-app-names")).toBeVisible();
  await settle(page);
  await expect(page).toHaveScreenshot("onboard-step2.png", SHOT);
});

visual("dashboard", async ({ page }) => {
  await page.goto("/dashboard");
  await expect(page.locator("main")).toBeVisible();
  await settle(page);
  await expect(page).toHaveScreenshot("dashboard.png", SHOT);
});

visual("apps grid", async ({ page }) => {
  await page.goto("/dashboard/apps");
  await expect(page.locator("main")).toBeVisible();
  await settle(page);
  await expect(page).toHaveScreenshot("apps-grid.png", SHOT);
});

/**
 * Compare was in the net's original spec and got missed when the first
 * nine shots landed. It matters more than most: CompareAppsView is the
 * largest remaining unsplit component, so this is the net that has to be
 * in place before anyone takes it on.
 *
 * The assertions before the shot are the empty-fixture guard — the page
 * boots with blank slots for an unknown id rather than erroring, so a
 * screenshot of two empty columns would compare clean forever and prove
 * nothing.
 */
visual("compare", async ({ page, request }) => {
  const res = await request.get("/api/apps");
  const apps = (await res.json()) as { id: string; name: string }[];
  const [appA, appB] = apps;
  await page.goto(`/dashboard/compare?a=id:${appA.id}&b=id:${appB.id}`);
  await expect(
    page.getByText(appA.name, { exact: true }).first()
  ).toBeVisible();
  await expect(
    page.getByText(appB.name, { exact: true }).first()
  ).toBeVisible();
  await settle(page);
  await expect(page).toHaveScreenshot("compare.png", SHOT);
});

visual("app detail", async ({ page, request }) => {
  const res = await request.get("/api/apps");
  const apps = (await res.json()) as { id: string; name: string }[];
  const target = apps.find((a) => a.name === "Instagram") ?? apps[0];
  await page.goto(`/apps/${target.id}`);
  await expect(page.locator("h1").first()).toBeVisible();
  await settle(page);
  await expect(page).toHaveScreenshot("app-detail.png", SHOT);
});
