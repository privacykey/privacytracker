import {
  type APIRequestContext,
  expect,
  type Page,
  test,
} from "@playwright/test";

/**
 * The dashboard's "How we score risk" legend and its tri-state flag.
 *
 * `flag.dashboard.risk_tier_legend` defaults to "collapsed": shown, with
 * its <details> closed. HomeLoader used to read it through
 * `useFlagBundle`, which coerces every flag with `=== "on"`, so the
 * default resolved to false and the legend never rendered for anyone.
 * The API said "collapsed" the whole time; only the browser was wrong,
 * which is why every case here drives the real page.
 *
 * The three values must each look different on the page:
 *   - "collapsed" (the default): rendered, closed, opens on click;
 *   - "on" (a user override): rendered open;
 *   - "off" (an override, or GOAL_RULES.minimal): not rendered.
 *
 * tests/app/client-flag-reads.test.ts is the static half: it fails if a
 * tri-state key goes back into a boolean read.
 */

const sameOriginHeaders = {
  origin: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000",
};

const LEGEND_FLAG = "flag.dashboard.risk_tier_legend";

/** Focus payload shape accepted by POST /api/focus. */
interface FocusPayload {
  accessibility: boolean;
  audience: "self" | "loved_one" | "guardian";
  cleanup: boolean;
  minimal: boolean;
  monitor: boolean;
}

const MONITOR_FOCUS: FocusPayload = {
  audience: "self",
  monitor: true,
  cleanup: false,
  minimal: false,
  accessibility: false,
};

/** `GOAL_RULES.minimal` sets the legend flag to "off". */
const MINIMAL_FOCUS: FocusPayload = {
  audience: "self",
  monitor: false,
  cleanup: false,
  minimal: true,
  accessibility: false,
};

async function setFocus(request: APIRequestContext, focus: FocusPayload) {
  await expect(
    await request.post("/api/focus", {
      headers: sameOriginHeaders,
      data: focus,
    })
  ).toBeOK();
}

async function clearLegendOverride(request: APIRequestContext) {
  await expect(
    await request.delete(
      `/api/feature-flags/overrides/${encodeURIComponent(LEGEND_FLAG)}`,
      { headers: sameOriginHeaders }
    )
  ).toBeOK();
}

/**
 * What the server resolved, so a failure on the page points at the
 * client read rather than at the rule or the override write.
 */
async function resolvedLegendValue(request: APIRequestContext) {
  const registry = await (await request.get("/api/feature-flags")).json();
  return (registry.flags as { currentValue: string; key: string }[]).find(
    (flag) => flag.key === LEGEND_FLAG
  )?.currentValue;
}

/**
 * Open the dashboard and wait for HomeView itself. HomeLoader paints a
 * skeleton until the flag bundle has settled, so `.home-page` being
 * visible means the legend's gate has been decided. Without this anchor
 * "the legend is absent" would also pass on a page that hadn't loaded.
 */
async function openDashboard(page: Page) {
  await page.goto("/dashboard");
  await expect(page.locator(".home-page")).toBeVisible();
  return page.locator("#risk-tiers");
}

test.beforeAll(async ({ request }) => {
  // The dashboard sends an install with no apps to onboarding. One app
  // is enough and nothing here removes it, so seed once per file: the
  // seed route is rate limited and the whole e2e suite shares its budget.
  await expect(
    await request.post("/api/dev/seed-sample-data?source=canned&limit=1", {
      headers: sameOriginHeaders,
    })
  ).toBeOK();
});

test.beforeEach(async ({ request }) => {
  await setFocus(request, MONITOR_FOCUS);
  // A layout saved by another spec could hide the card on the preference
  // axis, which would look exactly like the flag hiding it.
  await expect(
    await request.delete("/api/dashboard/layout", {
      headers: sameOriginHeaders,
    })
  ).toBeOK();
  await clearLegendOverride(request);
});

test.afterEach(async ({ request }) => {
  await clearLegendOverride(request);
  await setFocus(request, MONITOR_FOCUS);
});

test("the default 'collapsed' value renders the legend closed", async ({
  page,
  request,
}) => {
  expect(await resolvedLegendValue(request)).toBe("collapsed");

  const legend = await openDashboard(page);
  await expect(legend).toBeVisible();
  const details = legend.locator("details");
  await expect(details).toHaveJSProperty("open", false);
  await expect(legend.locator(".risk-tier-grid")).toBeHidden();

  // Collapsed, not inert: the reader can still expand it.
  await legend.locator("summary").click();
  await expect(details).toHaveJSProperty("open", true);
  await expect(legend.locator(".risk-tier-grid")).toBeVisible();
});

test("an 'on' override renders the legend open", async ({ page, request }) => {
  await expect(
    await request.post("/api/feature-flags/overrides", {
      headers: sameOriginHeaders,
      data: { key: LEGEND_FLAG, value: "on" },
    })
  ).toBeOK();
  expect(await resolvedLegendValue(request)).toBe("on");

  const legend = await openDashboard(page);
  await expect(legend.locator("details")).toHaveJSProperty("open", true);
  await expect(legend.locator(".risk-tier-grid")).toBeVisible();
});

test("an 'off' override hides the legend", async ({ page, request }) => {
  await expect(
    await request.post("/api/feature-flags/overrides", {
      headers: sameOriginHeaders,
      data: { key: LEGEND_FLAG, value: "off" },
    })
  ).toBeOK();
  expect(await resolvedLegendValue(request)).toBe("off");

  const legend = await openDashboard(page);
  await expect(legend).toHaveCount(0);
});

test("the minimal focus rule hides the legend, and leaving it brings it back", async ({
  page,
  request,
}) => {
  await setFocus(request, MINIMAL_FOCUS);
  expect(await resolvedLegendValue(request)).toBe("off");
  let legend = await openDashboard(page);
  await expect(legend).toHaveCount(0);

  await setFocus(request, MONITOR_FOCUS);
  expect(await resolvedLegendValue(request)).toBe("collapsed");
  legend = await openDashboard(page);
  await expect(legend).toBeVisible();
  await expect(legend.locator("details")).toHaveJSProperty("open", false);
});
