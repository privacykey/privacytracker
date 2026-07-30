import { expect, type Page, test } from "@playwright/test";

/**
 * Structural regression net for the settings surface.
 *
 * `SettingsView.tsx` is ~11.6k lines rendering 18 sections from a single
 * component, and it is about to be split into per-section components. The
 * logic *behind* settings is well covered by the unit suite (notification
 * prefs, policy throttle, diagnostics, backup, profiles, wayback…), but
 * before this file existed almost nothing exercised the component's own
 * wiring: only 3 of the 18 sections were touched by any browser test.
 *
 * That is the exact gap an extraction refactor falls into — a dropped
 * prop, an inverted guard or a handler that never gets passed down
 * typechecks cleanly, passes every unit test, and silently removes a
 * control from the page. These specs assert the things that would break.
 *
 * Deliberately structural rather than behavioural: it asserts that every
 * section the sidebar advertises actually renders with content, that the
 * page mounts without runtime errors, and that the documented hash
 * deep-links still work. Per-control behaviour stays with the unit tests
 * that already cover each route.
 *
 * The section list is NOT hardcoded — it is read from the rendered
 * sidebar. Add or flag-gate a section and this spec follows along, which
 * also means it can't drift out of date.
 */

const sameOriginHeaders = {
  origin: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000",
};

// Skip the browser flow inside CODEX_SANDBOX runs — matches the
// pattern used by every other spec in this directory.
const browserFlow = process.env.CODEX_SANDBOX ? test.skip : test;

/** Sanity floor. The sidebar declares 19 sections and gates only
 *  `developer` behind a flag, so anything under this means the sidebar
 *  itself failed to render rather than a section being legitimately
 *  hidden. */
const MIN_SECTIONS = 15;

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

  // `/dashboard/settings` server-redirects to `/onboard` when the DB has
  // no apps, so seed one. Mirrors profile-presets.spec.ts.
  const seed = await request.post(
    "/api/dev/seed-sample-data?source=canned&limit=1",
    { headers: sameOriginHeaders }
  );
  await expect(seed).toBeOK();
});

/** Collect the section ids the sidebar advertises, from its own links. */
async function sidebarSectionIds(page: Page): Promise<string[]> {
  const links = page.locator(".settings-sidebar-link");
  await expect(links.first()).toBeVisible();
  const hrefs = await links.evaluateAll((els) =>
    els.map((el) => (el as HTMLAnchorElement).getAttribute("href") ?? "")
  );
  return hrefs
    .filter((h) => h.startsWith("#") && h.length > 1)
    .map((h) => h.slice(1));
}

browserFlow(
  "settings: every section the sidebar advertises renders with content",
  async ({ page }) => {
    await page.goto("/dashboard/settings");
    await expect(page.locator(".settings-sidebar")).toBeVisible();

    const ids = await sidebarSectionIds(page);
    expect(
      ids.length,
      `sidebar advertised only ${ids.length} sections — expected at least ${MIN_SECTIONS}`
    ).toBeGreaterThanOrEqual(MIN_SECTIONS);

    const missing: string[] = [];
    const empty: string[] = [];
    for (const id of ids) {
      const section = page.locator(`#${id}`);
      if ((await section.count()) === 0) {
        missing.push(id);
        continue;
      }
      // A section that renders as an empty shell is just as broken as one
      // that vanished, and an extraction bug can easily produce it.
      const text = ((await section.first().innerText()) ?? "").trim();
      if (text.length < 10) {
        empty.push(id);
      }
    }

    expect(
      missing,
      `sidebar links to sections that do not exist in the DOM: ${missing.join(", ")}`
    ).toEqual([]);
    expect(
      empty,
      `sections rendered with (near-)empty content: ${empty.join(", ")}`
    ).toEqual([]);
  }
);

browserFlow(
  "settings: each section carries a visible heading",
  async ({ page }) => {
    await page.goto("/dashboard/settings");
    await expect(page.locator(".settings-sidebar")).toBeVisible();

    const ids = await sidebarSectionIds(page);
    const headless: string[] = [];
    for (const id of ids) {
      const section = page.locator(`#${id}`).first();
      if ((await section.count()) === 0) {
        continue; // covered by the spec above
      }
      const headings = section.locator(
        "h1, h2, h3, h4, .settings-section-title, .settings-card-title"
      );
      if ((await headings.count()) === 0) {
        headless.push(id);
      }
    }

    expect(
      headless,
      `sections with no heading element — likely lost their header during a refactor: ${headless.join(", ")}`
    ).toEqual([]);
  }
);

browserFlow(
  "settings: page mounts without console errors or failed requests",
  async ({ page }) => {
    // A section whose effect throws often still renders its shell, so the
    // structural checks above can pass while the section is dead. Console
    // and network watching catches that.
    const consoleErrors: string[] = [];
    const failedRequests: string[] = [];

    page.on("console", (msg) => {
      if (msg.type() === "error") {
        consoleErrors.push(msg.text());
      }
    });
    page.on("response", (res) => {
      // 5xx only: the settings page legitimately probes some endpoints
      // that answer 4xx (e.g. diagnostics without an admin token).
      if (res.status() >= 500) {
        failedRequests.push(`${res.status()} ${res.url()}`);
      }
    });

    await page.goto("/dashboard/settings");
    await expect(page.locator(".settings-sidebar")).toBeVisible();
    // Let the section effects settle — several fetch their own state.
    await page.waitForTimeout(2500);

    expect(
      failedRequests,
      `server errors while loading settings: ${failedRequests.join(" | ")}`
    ).toEqual([]);
    expect(
      consoleErrors,
      `console errors while loading settings: ${consoleErrors.join(" | ")}`
    ).toEqual([]);
  }
);

browserFlow(
  "settings: documented hash deep-links resolve and move the page",
  async ({ page }) => {
    // `/privacy-policy` links to `#ai-summaries`, and the AI timeout copy
    // links to `#ai-timeouts`; SettingsView pulses the target on arrival.
    // Both are a cross-page contract, so pin them explicitly rather than
    // relying on the generic sidebar sweep.
    //
    // NOT asserted: that the target ends up in the viewport. The sidebar
    // scrolls to the hash at 120/320/700ms and then stops
    // (SettingsSidebar's `retries`), while several sections fetch their
    // own state — so content landing above the target after 700ms can
    // push it back off-screen with nothing left to re-scroll. That's a
    // genuine (pre-existing, cosmetic) race in the app, not a test
    // artifact, and asserting final pixel position makes this spec flaky
    // rather than making the app correct. The route split planned for
    // this surface removes the race by turning these anchors into real
    // routes; until then, pin the part that is deterministic — the
    // section resolves, and the deep-link handler demonstrably ran.
    for (const id of ["ai-summaries", "ai-timeouts"]) {
      await page.goto(`/dashboard/settings#${id}`);
      const target = page.locator(`#${id}`);
      await expect(target).toHaveCount(1);
      await expect(target).toBeVisible();

      // The handler fired if the page left the top. Polled rather than
      // sampled once, because the last scheduled scroll lands at 700ms.
      await expect
        .poll(() => page.evaluate(() => window.scrollY), { timeout: 10_000 })
        .toBeGreaterThan(0);
    }
  }
);
