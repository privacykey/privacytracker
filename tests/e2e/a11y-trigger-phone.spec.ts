import { expect, type Page, test } from "@playwright/test";

/**
 * On a phone the accessibility quick-toggles button must not sit on top of
 * the page's own controls.
 *
 * It used to float at the bottom right of the viewport at every width. At
 * 375 px it covered the right end of the welcome page's sticky Next button,
 * "Other import options" and "Search App Store" in onboarding, and the
 * first app card's delete button. Below 480 px it now sits in the page's
 * footer, after the content, where nothing can be under it.
 *
 * The check is geometric on purpose: every visible control's box must stay
 * clear of the trigger's box, at the top of the page and after scrolling to
 * the end (where a sticky bar and the trigger would meet).
 */

const sameOriginHeaders = {
  origin: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000",
};

const browserFlow = process.env.CODEX_SANDBOX ? test.skip : test;

const PHONE = { width: 375, height: 740 };

interface Overlap {
  label: string;
  x: [number, number];
  y: [number, number];
}

async function controlsUnderTrigger(page: Page): Promise<Overlap[]> {
  return page.evaluate(() => {
    const trigger = document.querySelector(".a11y-quick-trigger");
    if (!trigger) {
      throw new Error("accessibility trigger not rendered");
    }
    const t = trigger.getBoundingClientRect();
    const selector = [
      "a[href]",
      "button",
      "input:not([type=hidden])",
      "select",
      "textarea",
      "summary",
      "[role=button]",
      "[role=radio]",
      "[role=checkbox]",
    ].join(",");
    const hits: Overlap[] = [];
    for (const el of document.querySelectorAll<HTMLElement>(selector)) {
      if (el === trigger || el.closest(".a11y-quick-popover")) {
        continue;
      }
      if (el.closest("[inert], [aria-hidden='true']")) {
        continue;
      }
      // Not painted: display/visibility, or inside a closed <details>,
      // whose content Chrome still lays out (it reports a box) but hides
      // with content-visibility.
      if (!el.checkVisibility({ visibilityProperty: true })) {
        continue;
      }
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) {
        continue;
      }
      const ix = Math.min(r.right, t.right) - Math.max(r.left, t.left);
      const iy = Math.min(r.bottom, t.bottom) - Math.max(r.top, t.top);
      if (ix > 0 && iy > 0) {
        hits.push({
          label: (el.innerText || el.getAttribute("aria-label") || el.tagName)
            .trim()
            .slice(0, 60),
          x: [Math.round(r.left), Math.round(r.right)],
          y: [Math.round(r.top), Math.round(r.bottom)],
        });
      }
    }
    return hits;
  });
}

async function expectTriggerClear(page: Page) {
  const trigger = page.locator(".a11y-quick-trigger");
  await expect(trigger).toHaveCount(1);
  expect(await controlsUnderTrigger(page)).toEqual([]);

  await page.evaluate(() =>
    window.scrollTo(0, document.documentElement.scrollHeight)
  );
  await page.waitForTimeout(300);
  expect(await controlsUnderTrigger(page)).toEqual([]);

  // Still reachable and still opens the panel.
  await trigger.scrollIntoViewIfNeeded();
  await expect(trigger).toBeInViewport();
  await trigger.click();
  await expect(page.locator(".a11y-quick-popover")).toBeVisible();
  await page.keyboard.press("Escape");
}

test.beforeEach(async ({ page, request }) => {
  const reset = await request.post("/api/reset", {
    headers: sameOriginHeaders,
  });
  await expect(reset).toBeOK();
  await page.setViewportSize(PHONE);
});

browserFlow(
  "welcome: the trigger does not cover the sticky Next button",
  async ({ page }) => {
    await page.goto("/welcome");
    await expect(page.getByRole("button", { name: /^next$/i })).toBeVisible();
    await expectTriggerClear(page);
  }
);

browserFlow(
  "onboarding: the trigger does not cover step 1 or step 2 controls",
  async ({ page, request }) => {
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

    await page.goto("/onboard?preview=fresh");
    await expect(page.getByTestId("onboard-step1-continue")).toBeVisible();
    await expectTriggerClear(page);

    await page.evaluate(() => window.scrollTo(0, 0));
    await page.getByText("Other import options").click();
    const manual = page.getByTestId("onboard-method-manual");
    await expect(async () => {
      await manual.click();
      await expect(manual).toHaveAttribute("aria-checked", "true", {
        timeout: 500,
      });
    }).toPass({ timeout: 10_000 });
    await page.getByTestId("onboard-step1-continue").click();
    await page.getByTestId("onboard-app-names").fill("Clock\nMaps");
    await page.getByTestId("imported-apps-add").click();
    await expect(page.getByTestId("onboard-search")).toBeEnabled();
    await expectTriggerClear(page);
  }
);

browserFlow(
  "apps grid: the trigger does not cover the first card's controls",
  async ({ page, request }) => {
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

    await page.goto("/dashboard/apps");
    await expect(page.locator(".app-card").first()).toBeVisible();
    await expectTriggerClear(page);
  }
);

browserFlow(
  "wide screens keep the floating trigger in the corner",
  async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/welcome");
    const trigger = page.locator(".a11y-quick-trigger");
    await expect(trigger).toBeInViewport();
    expect(await trigger.evaluate((el) => getComputedStyle(el).position)).toBe(
      "fixed"
    );
  }
);
