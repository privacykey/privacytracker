import { expect, type Page, test } from "@playwright/test";

/**
 * First-run acceptance across the five audiences the focus system
 * models. Each spec drives `/welcome` exactly as a new user would —
 * clicking tiles, not POSTing to `/api/focus` — then reads the stored
 * focus back to prove the UI wrote what the user asked for.
 *
 * These are the regression guard for the first-run UX pass:
 *   - the per-feature toggles live behind an "Advanced" disclosure
 *     (collapsed by default, still reachable and functional),
 *   - the primary CTA is reachable without opening it,
 *   - selecting no tiles stays a VALID empty baseline (the
 *     no-silent-default invariant),
 *   - guardian reveals the child age-band picker.
 */

const sameOriginHeaders = {
  origin: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000",
};

// Skip the browser flow inside CODEX_SANDBOX runs — matches the
// pattern used by every other spec in this directory.
const browserFlow = process.env.CODEX_SANDBOX ? test.skip : test;

interface StoredFocus {
  accessibility: boolean;
  audience: string;
  childAgeBand: string | null;
  cleanup: boolean;
  minimal: boolean;
  monitor: boolean;
}

test.beforeEach(async ({ request }) => {
  // Fresh install so /welcome renders the first-run form rather than
  // redirecting to a populated dashboard.
  const reset = await request.post("/api/reset", {
    headers: sameOriginHeaders,
  });
  await expect(reset).toBeOK();
});

async function openWelcome(page: Page) {
  await page.goto("/welcome");
  await expect(page.locator(".focus-purpose-card").first()).toBeVisible();
}

/** Goal tiles are `aria-pressed` toggles labelled by their title copy. */
function goalTile(page: Page, title: string | RegExp) {
  return page.locator(".focus-purpose-option").filter({ hasText: title });
}

/**
 * Submit and wait for the wizard hand-off.
 *
 * The click is polled because the CTA is React-only: on a cold start
 * Playwright can dispatch it before React has attached its handlers,
 * the browser fires the click, and nothing happens. Specs that click a
 * tile first mask this (the tile click proves hydration); the ones that
 * accept the defaults hit it every time. Same `toPass` pattern the
 * import specs use for the method cards.
 */
async function submit(page: Page) {
  const next = page.getByRole("button", { name: /^next$/i });
  await expect(async () => {
    await next.click();
    await page.waitForURL((url) => !url.pathname.startsWith("/welcome"), {
      timeout: 2000,
    });
  }).toPass({ timeout: 20_000 });
}

async function readFocus(page: Page): Promise<StoredFocus> {
  const res = await page.request.get("/api/focus", {
    headers: sameOriginHeaders,
  });
  await expect(res).toBeOK();
  return (await res.json()) as StoredFocus;
}

// ---------------------------------------------------------------------------
// 1. Monitor my apps
// ---------------------------------------------------------------------------

browserFlow("persona: monitor my apps", async ({ page }) => {
  await openWelcome(page);

  const monitor = goalTile(page, /monitor my apps/i);
  await expect(monitor).toHaveAttribute("aria-pressed", "true");

  await submit(page);

  const focus = await readFocus(page);
  expect(focus.audience).toBe("self");
  expect(focus.monitor).toBe(true);
  expect(focus.cleanup).toBe(false);
  expect(focus.minimal).toBe(false);
});

// ---------------------------------------------------------------------------
// 2. Clean up my phone
// ---------------------------------------------------------------------------

browserFlow("persona: clean up my phone", async ({ page }) => {
  await openWelcome(page);

  // Turn the default Monitor tile off and Cleanup on, so the stored
  // focus is unambiguously the cleanup bundle.
  const monitor = goalTile(page, /monitor my apps/i);
  if ((await monitor.getAttribute("aria-pressed")) === "true") {
    await monitor.click();
  }
  const cleanup = goalTile(page, /clean up my phone/i);
  await cleanup.click();
  await expect(cleanup).toHaveAttribute("aria-pressed", "true");

  await submit(page);

  const focus = await readFocus(page);
  expect(focus.cleanup).toBe(true);
  expect(focus.monitor).toBe(false);
  expect(focus.audience).toBe("self");
});

// ---------------------------------------------------------------------------
// 3. Help another adult
// ---------------------------------------------------------------------------

browserFlow("persona: help another adult", async ({ page }) => {
  await openWelcome(page);

  // The "Help a friend" tile is not a goal — it sets the audience, and
  // stays in lockstep with the audience segmented control.
  await goalTile(page, /help a friend/i).click();

  await submit(page);

  const focus = await readFocus(page);
  expect(focus.audience).toBe("loved_one");
  expect(focus.childAgeBand).toBeNull();
});

// ---------------------------------------------------------------------------
// 4. Guardian / child
// ---------------------------------------------------------------------------

browserFlow("persona: guardian for a child", async ({ page }) => {
  await openWelcome(page);

  // "A child or dependant" is reachable only from the audience control
  // and is the only path that reveals the age-band picker.
  await page
    .locator('[role="radio"]')
    .filter({ hasText: /child or dependant/i })
    .click();

  const ageBands = page.locator('[role="radio"]').filter({ hasText: /\d/ });
  await expect(ageBands.first()).toBeVisible();
  await ageBands.first().click();

  await submit(page);

  const focus = await readFocus(page);
  expect(focus.audience).toBe("guardian");
  expect(focus.childAgeBand).toBeTruthy();
});

// ---------------------------------------------------------------------------
// 5. Minimal / no goals
// ---------------------------------------------------------------------------

browserFlow("persona: minimal, no goals selected", async ({ page }) => {
  await openWelcome(page);

  // Deselect everything: an empty selection is a VALID baseline that
  // resolves to the hard-default surface — nothing may silently force
  // `monitor` back on.
  for (const title of [/monitor my apps/i, /clean up my phone/i]) {
    const tile = goalTile(page, title);
    if ((await tile.getAttribute("aria-pressed")) === "true") {
      await tile.click();
    }
  }

  await submit(page);

  const focus = await readFocus(page);
  expect(focus.monitor).toBe(false);
  expect(focus.cleanup).toBe(false);
  expect(focus.audience).toBe("self");
});

// ---------------------------------------------------------------------------
// First-run UX contract
// ---------------------------------------------------------------------------

browserFlow(
  "feature toggles sit behind a collapsed Advanced disclosure",
  async ({ page }) => {
    await openWelcome(page);

    const disclosure = page.locator("details.focus-purpose-advanced");
    await expect(disclosure).toBeVisible();
    // Collapsed by default — the toggle row must not be on screen.
    await expect(disclosure).not.toHaveAttribute("open", /.*/);
    await expect(page.locator(".feature-toggle-grid")).toBeHidden();

    // The primary CTA is reachable without opening it.
    await expect(page.getByRole("button", { name: /^next$/i })).toBeVisible();

    // Opening reveals the same wired toggles as before.
    await disclosure.locator("summary").click();
    await expect(page.locator(".feature-toggle-grid")).toBeVisible();
  }
);

browserFlow(
  "primary CTA stays on screen on a phone viewport",
  async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openWelcome(page);

    // Sticky footer: the CTA is in the viewport at the top of the form
    // and stays there after scrolling to the bottom of the card.
    const next = page.getByRole("button", { name: /^next$/i });
    await expect(next).toBeInViewport();

    await page.mouse.wheel(0, 4000);
    await page.waitForTimeout(300);
    await expect(next).toBeInViewport();
  }
);
