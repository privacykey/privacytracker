import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

/**
 * E2E coverage for the privacy-label explanation surfaces on the app
 * detail page (`/apps/[id]`, Privacy labels tab):
 *
 *   1. The label-scope note — the always-on caveat that Apple's labels
 *      name a CATEGORY, not the fields inside it — and its deep-link
 *      into the policy summary's collection-scope lens.
 *   2. The `DataLabelHint` vignette trigger on each category card,
 *      sitting alongside (never replacing) the existing InfoTooltip.
 *   3. The `flag.global.label_hints` mute, which the guardian and
 *      minimal focuses set to "off".
 *
 * (3) is the case worth having in CI. The component used to read the
 * flag through `useFlag` (lib/feature-flags-hooks.ts), which resolves
 * against a client resolver context that nothing primes in the browser
 * after the Phase 0 static-shell migration — so it always returned the
 * HARD_DEFAULT of "on" and the mute silently did nothing on the client.
 * It now reads the resolved value via `useFlagBundle`. A regression
 * would put animated vignettes back in front of the two audiences the
 * flag exists to keep them away from, with nothing failing to say so.
 *
 * Seeds via `/api/dev/seed-sample-data?source=canned` for the same
 * reasons app-detail.spec.ts does: deterministic, offline, and it
 * writes canonical privacy-type + category identifiers so the vignette
 * registry lookup (identifier × severity) joins correctly.
 */

const sameOriginHeaders = {
  origin: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000",
};

const browserFlow = process.env.CODEX_SANDBOX ? test.skip : test;

const HINTS_FLAG = "flag.global.label_hints";

interface SeedResult {
  id: string;
  name: string;
  source: "canned" | "live";
  status: "inserted" | "skipped" | "error";
}

browserFlow(
  "privacy labels: scope note, vignette hints, and the hints mute",
  async ({ page, request }) => {
    // `/api/reset` and the canned seed are rate-limited for the whole
    // suite (120 per 10 minutes each, shared by every spec), so this spec
    // resets once and runs its phases against the one seeded fixture
    // rather than splitting into several tests with a beforeEach.
    await expect(
      await request.post("/api/reset", { headers: sameOriginHeaders })
    ).toBeOK();
    await expect(
      await request.post("/api/focus", {
        headers: sameOriginHeaders,
        data: {
          audience: "self",
          monitor: true,
          cleanup: false,
          minimal: false,
          accessibility: false,
        },
      })
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
    const instagram = seeded.find((s) => s.name === "Instagram");
    expect(
      instagram?.id,
      "expected Instagram to land in the seeded apps"
    ).toBeTruthy();
    const appPath = `/apps/${instagram!.id}`;

    await page.goto(appPath);

    // ── 1. Label-scope note ──────────────────────────────────────────
    const note = page.locator(".label-scope-note");
    await expect(note).toBeVisible();
    // The <em> is the load-bearing word: the labels name a *category*.
    await expect(note.locator("em")).toHaveText("category");
    // With hints on, the note points at the vignette trigger.
    await expect(note).toContainText("shows what it could mean");

    // ── 2. Hint trigger sits BESIDE the info tooltip ─────────────────
    const cards = page.locator(".category-card-wrapper");
    const cardCount = await cards.count();
    expect(
      cardCount,
      "canned Instagram declares category cards"
    ).toBeGreaterThan(0);
    await expect(page.locator(".data-label-hint-trigger")).toHaveCount(
      cardCount
    );
    // The tooltip must survive alongside it — it carries Apple's
    // definition, which the vignette does not replace.
    await expect(
      page.locator(".category-card-info-overlay .info-tooltip-trigger")
    ).toHaveCount(cardCount);

    // Trigger clears the info icon on its left and the card edge on its
    // right. The card is at the grid's 140px minimum, which is the
    // tightest case the fixed offset has to survive.
    const geometry = await cards.first().evaluate((wrapper) => {
      const info = wrapper
        .querySelector(".category-card-info-overlay")!
        .getBoundingClientRect();
      const hint = wrapper
        .querySelector(".category-card-hint-overlay")!
        .getBoundingClientRect();
      return {
        infoRight: info.right,
        hintLeft: hint.left,
        hintRight: hint.right,
        cardRight: wrapper.getBoundingClientRect().right,
      };
    });
    expect(geometry.hintLeft).toBeGreaterThanOrEqual(geometry.infoRight);
    expect(geometry.hintRight).toBeLessThan(geometry.cardRight);

    // WCAG 2.2 target size (2.5.8). The trigger's own box must be 24x24:
    // axe measures the element, not an invisible ::after hit area, and the
    // spacing exception can't apply because the trigger sits on top of the
    // category card's link. a11y.spec.ts scans WCAG 2.1 tags only, so it
    // would not catch this. Filtered to the vignette trigger: the info
    // tooltip beside it has the same pre-existing failure, tracked apart.
    const targetSize = await new AxeBuilder({ page })
      .withRules(["target-size"])
      .analyze();
    const hintTargetFailures = targetSize.violations.flatMap((v) =>
      v.nodes
        .filter((n) => n.html.includes("data-label-hint-trigger"))
        .map((n) => n.failureSummary ?? n.html)
    );
    expect(hintTargetFailures).toEqual([]);

    // ── 3. The vignette plays THIS app's declared tier ───────────────
    // Severity comes from the accordion the card sits in, not a guess —
    // so the popover's aria-label must name that same shelf.
    const usageCard = cards.filter({ hasText: "Usage Data" }).first();
    const shelf = await usageCard.evaluate((el) =>
      el
        .closest(".accordion-section")!
        .querySelector(".severity-badge")!
        .textContent!.trim()
    );
    const trigger = usageCard.locator(".data-label-hint-trigger");
    await trigger.hover();
    const bubble = page.locator(".data-label-hint-bubble");
    await expect(bubble).toBeVisible();
    await expect(bubble.locator("svg")).toBeVisible();
    await expect(bubble.locator(".data-label-hint-lip")).toHaveText(
      "This is an example"
    );
    // The bubble states what IS known — that the app collects this
    // category, not what the category contains. The caption itself is
    // written conditionally, so nothing here should read as a report of
    // this app's observed behaviour.
    await expect(
      bubble.locator(".data-label-hint-not-disclosed")
    ).toContainText("not what that includes");
    expect((await bubble.getAttribute("aria-label"))?.toLowerCase()).toContain(
      shelf.toLowerCase()
    );
    // ── 3a. The "Read more" link is reachable, by every input ─────────
    // The bubble is the first vignette surface with anything clickable in
    // it, which is what these guard. Before the link existed, leaving the
    // trigger closed the bubble instantly, a click after hovering toggled
    // it shut, and the bubble (portalled to the end of <body>) was
    // unreachable by Tab.
    const more = bubble.locator(".data-label-hint-more");
    await expect(more).toHaveText("Read more about privacy labels");

    // Mouse: crossing from the trigger into the bubble must not close it.
    await more.hover();
    await page.waitForTimeout(400); // well past the 150ms hover-close grace
    await expect(bubble).toBeVisible();

    // Leaving both closes it, since nothing pinned it.
    await page.mouse.move(5, 5);
    await expect(bubble).toHaveCount(0);

    // A click after hovering pins it open instead of toggling it shut.
    await trigger.hover();
    await expect(bubble).toBeVisible();
    await trigger.click();
    await page.mouse.move(5, 5);
    await page.waitForTimeout(400);
    await expect(bubble).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(bubble).toHaveCount(0);
    // The click left focus on the trigger, so Enter must re-open it.
    await expect(trigger).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(bubble).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(bubble).toHaveCount(0);

    // Keyboard. Arriving on the trigger opens it, but Tab moves straight
    // on, as it always has: a row of these must not cost two extra stops
    // each. Blur first: focus() on an element that already has focus fires
    // no focus event, which is not how a Tab arrival behaves.
    await trigger.evaluate((el) => (el as HTMLElement).blur());
    await trigger.focus();
    await expect(bubble).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(trigger).not.toBeFocused();
    await expect(bubble).toHaveCount(0);

    // Opened on purpose with Enter, Tab carries focus into the bubble,
    // Shift+Tab comes back, and Escape closes it and returns focus. When the
    // bubble is taller than the room beside the trigger (common at 720px
    // tall), its scroll box is an extra stop ahead of the link, so the
    // keyboard can scroll it; the helpers step over it when it's there.
    const scrollBox = bubble.locator(".data-label-hint-scroll");
    const scrollBoxIsStop = async () =>
      (await scrollBox.getAttribute("tabindex")) === "0";
    const tabToLink = async () => {
      await page.keyboard.press("Tab");
      if (await scrollBoxIsStop()) {
        await expect(scrollBox).toBeFocused();
        await page.keyboard.press("Tab");
      }
      await expect(more).toBeFocused();
    };
    const shiftTabToTrigger = async () => {
      await page.keyboard.press("Shift+Tab");
      if (await scrollBoxIsStop()) {
        await expect(scrollBox).toBeFocused();
        await page.keyboard.press("Shift+Tab");
      }
      await expect(trigger).toBeFocused();
    };
    await trigger.focus();
    await expect(bubble).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(bubble).toBeVisible();
    await tabToLink();
    await shiftTabToTrigger();
    await expect(bubble).toBeVisible();
    await tabToLink();
    await page.keyboard.press("Escape");
    await expect(bubble).toHaveCount(0);
    await expect(trigger).toBeFocused();

    // Following it lands on this category's definition, and Back returns.
    await page.mouse.move(5, 5);
    await trigger.hover();
    await more.click();
    await expect(page).toHaveURL(
      /\/help\/definitions\?from=.*#category-usage_data$/
    );
    const definition = page.locator("#category-usage_data");
    await expect(definition).toBeInViewport();
    await expect(
      page.getByRole("link", { name: /back to app/i })
    ).toHaveAttribute("href", appPath);
    await page.goto(appPath);
    await expect(note).toBeVisible();

    // ── 4. Deep-link into the collection-scope lens ──────────────────
    await note.locator("button").click();
    const lens = page.locator("#policy-lens-collection_scope");
    await expect(lens).toBeVisible();
    expect(page.url()).toContain("#policy-lens-collection_scope");
    // The arrival highlight is React state, not `:target` — the lens is
    // inside a tab panel that isn't mounted when the hash is set, and
    // `:target` is resolved at navigation time only.
    await expect(lens).toHaveClass(/policy-lens-card--target/);
    await expect(lens).toBeInViewport();

    // ── 5. The hints mute ────────────────────────────────────────────
    await expect(
      await request.post("/api/feature-flags/overrides", {
        headers: sameOriginHeaders,
        data: { key: HINTS_FLAG, value: "off" },
      })
    ).toBeOK();
    await page.goto(appPath);
    await expect(note).toBeVisible();
    await expect(page.locator(".data-label-hint-trigger")).toHaveCount(0);
    // Definitions and the caveat must both survive the mute — muting the
    // animation must not cost these users the explanation.
    await expect(
      page.locator(".category-card-info-overlay .info-tooltip-trigger")
    ).toHaveCount(cardCount);
    // ...but the note's pointer at the ✦ must NOT survive it. The caveat is
    // deliberately ungated; the sentence telling users to look for a
    // trigger that no longer renders would send them hunting for nothing.
    await expect(note).toContainText("not the specific fields inside it");
    await expect(note).not.toContainText("shows what it could mean");

    // Clear the override. The whole suite shares one SQLite file, so
    // leaving `label_hints` off here would silently mute the vignettes
    // for every spec that runs after this one.
    await expect(
      await request.delete(`/api/feature-flags/overrides?key=${HINTS_FLAG}`, {
        headers: sameOriginHeaders,
      })
    ).toBeOK();
  }
);

/**
 * A popover taller than the screen must still be usable.
 *
 * The bubble is position: fixed, so any part past the viewport edge can't be
 * scrolled to. On a phone held sideways (or a desktop zoomed to 400%, which is
 * what WCAG 1.4.10 Reflow tests) the lip, artwork, caption and link together
 * are taller than the screen, and the Read more link used to sit below the
 * edge, unreachable. The bubble now keeps itself on screen and scrolls its
 * contents internally.
 */
browserFlow(
  "privacy labels: popover fits a short screen and its link stays reachable",
  async ({ page, request }) => {
    await page.setViewportSize({ width: 667, height: 375 });
    // No /api/reset here (suite-wide rate limit); seeding is idempotent and returns
    // the existing ids, so this runs alone or after the test above.
    const seedRes = await request.post(
      "/api/dev/seed-sample-data?source=canned",
      { headers: sameOriginHeaders }
    );
    await expect(seedRes).toBeOK();
    const seedBody = (await seedRes.json()) as {
      apps?: SeedResult[];
      results?: SeedResult[];
    };
    const instagram = (seedBody.apps ?? seedBody.results ?? []).find(
      (s) => s.name === "Instagram"
    );
    expect(instagram?.id).toBeTruthy();
    await page.goto(`/apps/${instagram!.id}`);

    const trigger = page
      .locator(".category-card-wrapper", { hasText: "Usage Data" })
      .first()
      .locator(".data-label-hint-trigger");
    await trigger.scrollIntoViewIfNeeded();
    await trigger.click();
    const bubble = page.locator(".data-label-hint-bubble");
    await expect(bubble).toBeVisible();

    const box = await bubble.boundingBox();
    expect(box, "bubble has a box").not.toBeNull();
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(375);

    // It must not cover its own trigger: with focus on the trigger that
    // fails WCAG focus-not-obscured (2.4.11 AA, 2.4.12 AAA). Short of room,
    // it takes the roomier side and scrolls instead.
    const t = await trigger.boundingBox();
    expect(t, "trigger has a box").not.toBeNull();
    const covered =
      box!.x < t!.x + t!.width &&
      t!.x < box!.x + box!.width &&
      box!.y < t!.y + t!.height &&
      t!.y < box!.y + box!.height;
    expect(covered, "popover covers its own trigger").toBe(false);

    // Scrolling inside it must not move it. Re-placing on its own inner
    // scroll once let a near-tie (equal room above and below) flip it to
    // the other side of the trigger, out from under the pointer, and it
    // closed as soon as anyone scrolled it.
    await bubble
      .locator(".data-label-hint-scroll")
      .evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
    await page.waitForTimeout(100);
    const afterScroll = await bubble.boundingBox();
    expect(afterScroll?.y).toBe(box!.y);
    await expect(bubble).toBeVisible();
    await bubble
      .locator(".data-label-hint-scroll")
      .evaluate((el) => el.scrollTo({ top: 0 }));

    // Its contents overflow here, so the scroll box is a Tab stop (arrow
    // keys can then scroll it), ahead of the link.
    await trigger.focus();
    await page.keyboard.press("Tab");
    await expect(bubble.locator(".data-label-hint-scroll")).toBeFocused();
    await page.keyboard.press("Tab");
    const more = bubble.locator(".data-label-hint-more");
    await expect(more).toBeFocused();
    await expect(more).toBeInViewport();
    await more.click();
    await expect(page).toHaveURL(/\/help\/definitions/);
  }
);

/**
 * WCAG 2.2 AAA on the popover and the scope note: text contrast of 7:1
 * (1.4.6) in both themes, and 44x44 pointer targets (2.5.5).
 *
 * The colours are local mixes (--data-label-hint-accent-text and
 * --data-label-hint-muted in data-label-hint.css, and the .label-scope-note
 * rules in globals.css); the plain --blue and --text-3 they replaced
 * measured 5.2 to 6.6. A palette change upstream can quietly drag these back
 * under 7:1, which is what this catches. The pointer target check measures
 * the ::before hit area, which axe does not see.
 */
browserFlow(
  "privacy labels: AAA contrast and pointer targets",
  async ({ page, request }) => {
    const seedRes = await request.post(
      "/api/dev/seed-sample-data?source=canned",
      { headers: sameOriginHeaders }
    );
    await expect(seedRes).toBeOK();
    const seedBody = (await seedRes.json()) as {
      apps?: SeedResult[];
      results?: SeedResult[];
    };
    const instagram = (seedBody.apps ?? seedBody.results ?? []).find(
      (s) => s.name === "Instagram"
    );
    expect(instagram?.id).toBeTruthy();

    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await page.goto(`/apps/${instagram!.id}`);
      const trigger = page
        .locator(".category-card-wrapper", { hasText: "Usage Data" })
        .first()
        .locator(".data-label-hint-trigger");
      await trigger.hover();
      await expect(page.locator(".data-label-hint-bubble")).toBeVisible();
      const contrast = await new AxeBuilder({ page })
        .withRules(["color-contrast-enhanced"])
        .include(".data-label-hint-bubble")
        .include(".label-scope-note")
        .analyze();
      expect(
        contrast.violations.flatMap((v) =>
          v.nodes.map((n) => `${colorScheme}: ${n.failureSummary}`)
        )
      ).toEqual([]);
    }

    const pointerArea = await page
      .locator(".category-card-hint-overlay .data-label-hint-trigger")
      .first()
      .evaluate((el) => {
        const r = el.getBoundingClientRect();
        const before = getComputedStyle(el, "::before");
        const ext =
          before.content === "none" ? 0 : -Number.parseFloat(before.top || "0");
        return { w: r.width + 2 * ext, h: r.height + 2 * ext };
      });
    expect(pointerArea.w).toBeGreaterThanOrEqual(44);
    expect(pointerArea.h).toBeGreaterThanOrEqual(44);
    const link = await page.locator(".data-label-hint-more").boundingBox();
    expect(link?.height ?? 0).toBeGreaterThanOrEqual(44);
  }
);
