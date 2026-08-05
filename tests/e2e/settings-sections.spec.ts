import { expect, type Page, test } from "@playwright/test";

/**
 * Structural regression net for the settings surface.
 *
 * Written when `SettingsView.tsx` was ~11.6k lines rendering every section
 * from a single component, ahead of splitting it apart. That split is done
 * — ~20 section components plus four group routes — and this net caught
 * two real regressions during it (a sidebar that vanished from the group
 * routes, and a link card pinned to the old landing view). The
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
 *
 * Settings is now four routes (you / sync / policies / admin), so the
 * sweep visits each of them: a section only renders on the route that
 * owns it. The sidebar shows every entry from every route, linking within
 * the page for the current group and across routes for the others, which
 * is what lets the sweep discover the full set from any one page.
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

/** The four group routes, in sidebar order. */
const GROUPS = ["you", "sync", "policies", "admin"] as const;

/**
 * Section ids the sidebar advertises for the page we are on.
 *
 * Sidebar entries take two shapes now — a bare `#id` for a section on this
 * route, and `/dashboard/settings/<group>#id` for one on another. Reading
 * both means a single page still reveals the whole advertised set, and
 * passing `onlyThisPage` narrows it to what should actually be in this
 * DOM.
 */
async function sidebarSectionIds(
  page: Page,
  { onlyThisPage = false }: { onlyThisPage?: boolean } = {}
): Promise<string[]> {
  const links = page.locator(".settings-sidebar-link");
  await expect(links.first()).toBeVisible();
  const hrefs = await links.evaluateAll((els) =>
    els.map((el) => (el as HTMLAnchorElement).getAttribute("href") ?? "")
  );
  return hrefs
    .filter((h) => (onlyThisPage ? h.startsWith("#") : h.includes("#")))
    .map((h) => h.slice(h.indexOf("#") + 1))
    .filter((id) => id.length > 0);
}

browserFlow(
  "settings: every section the sidebar advertises renders with content",
  async ({ page }) => {
    const missing: string[] = [];
    const empty: string[] = [];
    let advertised = 0;

    for (const group of GROUPS) {
      await page.goto(`/dashboard/settings/${group}`);
      await expect(page.locator(".settings-sidebar")).toBeVisible();

      // Only this route's own sections should be in this DOM; the rest are
      // cross-route links and are checked when we visit their group.
      const ids = await sidebarSectionIds(page, { onlyThisPage: true });
      advertised += ids.length;

      for (const id of ids) {
        const section = page.locator(`#${id}`);
        if ((await section.count()) === 0) {
          missing.push(id);
          continue;
        }
        // A section that renders as an empty shell is just as broken as
        // one that vanished, and an extraction bug can easily produce it.
        const text = ((await section.first().innerText()) ?? "").trim();
        if (text.length < 10) {
          empty.push(id);
        }
      }
    }

    expect(
      advertised,
      `the four group routes advertised only ${advertised} sections between them — expected at least ${MIN_SECTIONS}`
    ).toBeGreaterThanOrEqual(MIN_SECTIONS);
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
    const headless: string[] = [];
    for (const group of GROUPS) {
      await page.goto(`/dashboard/settings/${group}`);
      await expect(page.locator(".settings-sidebar")).toBeVisible();

      for (const id of await sidebarSectionIds(page, { onlyThisPage: true })) {
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

    for (const group of GROUPS) {
      await page.goto(`/dashboard/settings/${group}`);
      await expect(page.locator(".settings-sidebar")).toBeVisible();
      // Let the section effects settle — several fetch their own state.
      await page.waitForTimeout(2000);
    }

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
  "settings: legacy hash deep-links redirect to the owning route",
  async ({ page }) => {
    // `/privacy-policy` links to `#ai-summaries` and the bell links to
    // `#ai-timeouts`. Those anchors were published against the old
    // single-page settings URL, so the landing page has to forward them to
    // whichever group route now owns the section — including the anchor,
    // which is the part a server redirect could never do (fragments are
    // never sent to the server).
    //
    // This replaces a weaker assertion. The old spec could only check that
    // the page had scrolled somewhere, because the anchor sat far down a
    // 23-section page and the sidebar's scroll retries gave up at 700ms
    // while later sections were still loading and shifting it. On a
    // per-group route the section is one of five, so "did we land on the
    // right section" is answerable directly.
    const expected: Record<string, string> = {
      "ai-summaries": "policies",
      "ai-timeouts": "admin",
      notifications: "you",
      "sync-status": "sync",
    };

    for (const [id, group] of Object.entries(expected)) {
      await page.goto(`/dashboard/settings#${id}`);

      await expect
        .poll(() => new URL(page.url()).pathname, { timeout: 10_000 })
        .toBe(`/dashboard/settings/${group}`);
      expect(
        new URL(page.url()).hash,
        `redirect dropped the anchor for #${id}`
      ).toBe(`#${id}`);

      const target = page.locator(`#${id}`);
      await expect(target).toHaveCount(1);
      await expect(target).toBeVisible();
    }
  }
);

browserFlow(
  "settings: the landing page forwards to the first group",
  async ({ page }) => {
    // No anchor to go on, so it should still land somewhere real rather
    // than rendering an empty shell. Nav links here.
    await page.goto("/dashboard/settings");
    await expect
      .poll(() => new URL(page.url()).pathname, { timeout: 10_000 })
      .toBe("/dashboard/settings/you");
    await expect(page.locator(".settings-sidebar")).toBeVisible();
  }
);
