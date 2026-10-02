import {
  type APIRequestContext,
  expect,
  type Page,
  test,
} from "@playwright/test";

/**
 * The app detail page's tri-state flags.
 *
 * Four detail flags default to "collapsed": `flag.detail.a11y.panel`
 * and the policy diagnostics `run_log_strip`, `run_log_details` and
 * `chunk_notes`. AppDetailLoader read them raw and then coerced each
 * with `=== "on"`, so the default counted as off. The Accessibility tab
 * was missing for every focus without the accessibility modifier (its
 * header chip still showed, and clicking it emptied the page), and the
 * policy run-log strip never rendered. app-detail.spec.ts did not notice
 * because it turns the accessibility modifier on, which resolves the
 * panel flag to "on".
 *
 * The values must each look different on the page:
 *   - "collapsed" (the default): rendered; a <details> starts closed;
 *   - "on" (an override): rendered; a <details> starts open;
 *   - "off" (an override, or GOAL_RULES.minimal): not rendered.
 *
 * The resolver turns a dependent flag "off" while its parent is not
 * "on". `run_log_details` hangs off `run_log_strip`, so under the
 * default focus the strip shows without its full trace, and an "on"
 * strip brings the trace back closed.
 *
 * Chunk notes are not driven here: they need a multi-chunk AI summary,
 * which no route can create without a model. They use the same read
 * and the same <details> handling as the trace.
 *
 * tests/app/client-flag-reads.test.ts is the static half: it fails if a
 * tri-state key read raw is compared with "on" again.
 */

const sameOriginHeaders = {
  origin: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000",
};

const browserFlow = process.env.CODEX_SANDBOX ? test.skip : test;

const A11Y_PANEL = "flag.detail.a11y.panel";
const RUN_LOG_STRIP = "flag.detail.policy.run_log_strip";
const RUN_LOG_DETAILS = "flag.detail.policy.run_log_details";
const OVERRIDDEN = [A11Y_PANEL, RUN_LOG_STRIP, RUN_LOG_DETAILS];

/** Focus payload shape accepted by POST /api/focus. */
interface FocusPayload {
  accessibility: boolean;
  audience: "self" | "loved_one" | "guardian";
  cleanup: boolean;
  minimal: boolean;
  monitor: boolean;
}

/** No accessibility modifier, so the panel flag stays at "collapsed". */
const MONITOR_FOCUS: FocusPayload = {
  audience: "self",
  monitor: true,
  cleanup: false,
  minimal: false,
  accessibility: false,
};

/** `GOAL_RULES.minimal` turns the policy diagnostics "off". */
const MINIMAL_FOCUS: FocusPayload = {
  audience: "self",
  monitor: false,
  cleanup: false,
  minimal: true,
  accessibility: false,
};

interface SeedResult {
  id: string;
  name: string;
}

let gmailId = "";

async function setFocus(request: APIRequestContext, focus: FocusPayload) {
  await expect(
    await request.post("/api/focus", {
      headers: sameOriginHeaders,
      data: focus,
    })
  ).toBeOK();
}

async function setOverride(
  request: APIRequestContext,
  key: string,
  value: "on" | "off"
) {
  await expect(
    await request.post("/api/feature-flags/overrides", {
      headers: sameOriginHeaders,
      data: { key, value },
    })
  ).toBeOK();
}

async function clearOverrides(request: APIRequestContext) {
  for (const key of OVERRIDDEN) {
    await expect(
      await request.delete(
        `/api/feature-flags/overrides/${encodeURIComponent(key)}`,
        { headers: sameOriginHeaders }
      )
    ).toBeOK();
  }
}

/**
 * What the server resolved, so a failure on the page points at the
 * client read rather than at the rule or the override write.
 */
async function resolved(request: APIRequestContext, key: string) {
  const registry = await (await request.get("/api/feature-flags")).json();
  return (registry.flags as { currentValue: string; key: string }[]).find(
    (flag) => flag.key === key
  )?.currentValue;
}

/**
 * Open Gmail's detail page and wait for AppDetailView itself. The loader
 * paints a skeleton until both the payload and the flag bundle have
 * landed, so the hero name means every gate below has been decided.
 * Without it "the tab is absent" would also pass on a page that hadn't
 * loaded.
 */
async function openDetail(page: Page) {
  await page.goto(`/apps/${gmailId}`);
  await expect(page.locator("h1.detail-hero-name")).toHaveText("Gmail");
  await expect(page.locator("#tab-privacy")).toBeVisible();
}

async function openPolicyTab(page: Page) {
  await openDetail(page);
  await page.locator("#tab-policy").click();
  await expect(page.locator("#tabpanel-policy")).toBeVisible();
  return page.locator(".policy-run-log-strip");
}

test.beforeAll(async ({ request }) => {
  // One reset and one seed for the file: both routes are rate limited and
  // the whole suite shares their budget, and nothing below removes an app.
  await expect(
    await request.post("/api/reset", { headers: sameOriginHeaders })
  ).toBeOK();
  const seedRes = await request.post(
    "/api/dev/seed-sample-data?source=canned",
    { headers: sameOriginHeaders }
  );
  await expect(seedRes).toBeOK();
  const seedBody = (await seedRes.json()) as {
    apps?: SeedResult[];
    results?: SeedResult[];
  };
  const seeded = seedBody.apps ?? seedBody.results ?? [];
  const gmail = seeded.find((app) => app.name === "Gmail");
  expect(gmail?.id, "expected Gmail in the canned seed").toBeTruthy();
  gmailId = gmail!.id;

  // The canned analysis has no run log, and the strip renders nothing
  // without one. A summarise pass with no AI provider configured (the
  // state the reset leaves) stops at once and stores a one-line log,
  // with no network and no model.
  await expect(
    await request.post("/api/policy/regenerate", {
      headers: sameOriginHeaders,
      data: { appId: gmailId, phase: "summarise" },
    })
  ).toBeOK();
});

test.beforeEach(async ({ request }) => {
  await setFocus(request, MONITOR_FOCUS);
  await clearOverrides(request);
});

test.afterEach(async ({ request }) => {
  await clearOverrides(request);
  await setFocus(request, MONITOR_FOCUS);
});

browserFlow(
  "the default 'collapsed' panel flag shows the Accessibility tab, and the header chip opens it",
  async ({ page, request }) => {
    expect(await resolved(request, A11Y_PANEL)).toBe("collapsed");

    await openDetail(page);
    await expect(page.locator("#tab-accessibility")).toBeVisible();

    // The chip switches to the tab. Before the fix it switched to a tab
    // that did not exist and left no panel on screen.
    await page.locator(".detail-a11y-chip").click();
    await expect(page.locator("#tab-accessibility")).toHaveAttribute(
      "aria-selected",
      "true"
    );
    await expect(
      page.locator("#tabpanel-accessibility .a11y-summary-card")
    ).toBeVisible();
  }
);

browserFlow(
  "an 'off' override removes the Accessibility tab",
  async ({ page, request }) => {
    await setOverride(request, A11Y_PANEL, "off");
    expect(await resolved(request, A11Y_PANEL)).toBe("off");

    await openDetail(page);
    await expect(page.locator("#tab-accessibility")).toHaveCount(0);
  }
);

browserFlow(
  "the default 'collapsed' strip renders the last run, without its trace",
  async ({ page, request }) => {
    expect(await resolved(request, RUN_LOG_STRIP)).toBe("collapsed");
    // Its parent is not "on", so the resolver turns it off.
    expect(await resolved(request, RUN_LOG_DETAILS)).toBe("off");

    const strip = await openPolicyTab(page);
    await expect(strip).toBeVisible();
    await expect(strip).toContainText("needs-config");
    await expect(strip.locator("details")).toHaveCount(0);
  }
);

browserFlow(
  "an 'on' strip shows the trace closed, and an 'on' trace starts open",
  async ({ page, request }) => {
    await setOverride(request, RUN_LOG_STRIP, "on");
    expect(await resolved(request, RUN_LOG_DETAILS)).toBe("collapsed");

    let strip = await openPolicyTab(page);
    const details = strip.locator("details");
    await expect(details).toHaveJSProperty("open", false);
    // Collapsed, not inert: the reader can still expand it.
    await details.locator("summary").click();
    await expect(details).toHaveJSProperty("open", true);

    await setOverride(request, RUN_LOG_DETAILS, "on");
    expect(await resolved(request, RUN_LOG_DETAILS)).toBe("on");
    strip = await openPolicyTab(page);
    await expect(strip.locator("details")).toHaveJSProperty("open", true);
  }
);

browserFlow(
  "the minimal focus hides the strip but keeps the Accessibility tab",
  async ({ page, request }) => {
    await setFocus(request, MINIMAL_FOCUS);
    expect(await resolved(request, RUN_LOG_STRIP)).toBe("off");
    expect(await resolved(request, A11Y_PANEL)).toBe("collapsed");

    const strip = await openPolicyTab(page);
    await expect(page.locator("#tab-accessibility")).toBeVisible();
    // The note rendered just above the strip is on screen, so the strip's
    // absence is the flag and not a half-drawn panel.
    await expect(
      page.locator('.policy-summary-panel .policy-summary-note[role="note"]')
    ).toBeVisible();
    await expect(strip).toHaveCount(0);
  }
);
