import { expect, test } from "@playwright/test";

/**
 * "How much to trust this label" (LabelTrustCard) on the app detail page.
 *
 * Pins the gate in both directions plus the override path, and the deep
 * link into the help page:
 *
 *   - `flag.detail.labels.trust_card` is OFF by hard default and ON under
 *     `GOAL_RULES.monitor`. A focus with no goals must not show the card
 *     while the label cards underneath still render (so absence is the
 *     flag, not a blank tab); the Monitor focus must show it.
 *   - A user override turns it on with no goal selected, the contract
 *     FeatureToggleRow relies on.
 *   - The footer link lands on `/help/definitions#label-trust`, the
 *     section that explains the rules the card applies.
 *
 * Uses the offline canned sample apps (`?source=canned`), same as
 * app-detail.spec.ts. Instagram declares all three collected buckets, so
 * the card renders its age and policy rows and NOT the "Data Not
 * Collected" row; that row's derivation is unit-tested in
 * tests/app/label-trust.test.ts.
 */

const sameOriginHeaders = {
  origin: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000",
};

const browserFlow = process.env.CODEX_SANDBOX ? test.skip : test;

const TRUST_CARD = "flag.detail.labels.trust_card";

interface SeedResult {
  id: string;
  name: string;
}

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

/** The empty baseline: every flag at its hard default. */
const NO_GOALS_FOCUS: FocusPayload = {
  audience: "self",
  monitor: false,
  cleanup: false,
  minimal: false,
  accessibility: false,
};

let instagramId = "";

test.beforeEach(async ({ request }) => {
  const resetRes = await request.post("/api/reset", {
    headers: sameOriginHeaders,
  });
  await expect(resetRes).toBeOK();

  const seedRes = await request.post(
    "/api/dev/seed-sample-data?source=canned",
    {
      headers: sameOriginHeaders,
    }
  );
  await expect(seedRes).toBeOK();
  const seedBody = (await seedRes.json()) as {
    apps?: SeedResult[];
    results?: SeedResult[];
  };
  const seeded = seedBody.apps ?? seedBody.results ?? [];
  const instagram = seeded.find((s) => s.name === "Instagram");
  expect(instagram?.id, "expected Instagram in the canned seed").toBeTruthy();
  instagramId = instagram!.id;

  // Reset wipes any override from an earlier run; make it explicit anyway
  // so the no-goals assertion below is about the rule table alone.
  await request.delete(
    `/api/feature-flags/overrides/${encodeURIComponent(TRUST_CARD)}`,
    { headers: sameOriginHeaders }
  );
});

async function setFocus(
  request: Parameters<Parameters<typeof test>[2]>[0]["request"],
  focus: FocusPayload
) {
  const res = await request.post("/api/focus", {
    headers: sameOriginHeaders,
    data: focus,
  });
  await expect(res).toBeOK();
}

browserFlow(
  "no goals: the label cards render but the trust card does not",
  async ({ page, request }) => {
    await setFocus(request, NO_GOALS_FOCUS);

    const flags = await request.get("/api/feature-flags");
    await expect(flags).toBeOK();
    const body = (await flags.json()) as {
      flags: Array<{ currentValue: string; key: string }>;
    };
    const row = body.flags.find((f) => f.key === TRUST_CARD);
    expect(row?.currentValue, "hard default is off").toBe("off");

    await page.goto(`/apps/${instagramId}`);
    await expect(page.locator("h1.detail-hero-name")).toHaveText("Instagram");
    await expect(page.locator(".category-card").first()).toBeVisible();
    await expect(page.locator(".label-trust")).toHaveCount(0);
  }
);

browserFlow(
  "monitor focus: the trust card renders its rows and links to the help section",
  async ({ page, request }) => {
    await setFocus(request, MONITOR_FOCUS);

    await page.goto(`/apps/${instagramId}`);
    await expect(page.locator("h1.detail-hero-name")).toHaveText("Instagram");

    const card = page.locator(".label-trust");
    await expect(card).toBeVisible();
    await expect(card.locator("h2")).toHaveText("How much to trust this label");

    // Instagram declares tracking, so no "Data Not Collected" row.
    await expect(card.locator('[data-signal="dnc"]')).toHaveCount(0);
    // Age is always derivable from the seeded snapshot; the policy row
    // renders in every state (none / summary / consistent / mismatch).
    await expect(card.locator('[data-signal="age"]')).toBeVisible();
    await expect(card.locator('[data-signal="policy"]')).toBeVisible();

    // The canned seed writes synthetic history, so the age row may be
    // either form; what matters is that it derived one from the rows the
    // detail payload carries rather than falling through to nothing.
    const age = card.locator('[data-signal="age"]');
    await expect(age).toContainText(/Label last changed|Unchanged since/);

    // The footer link deep-links into the help page.
    await card
      .getByRole("link", { name: "What a label can't tell you" })
      .click();
    await expect(page).toHaveURL(/\/help\/definitions#label-trust$/);
    const section = page.locator("#label-trust");
    await expect(section).toBeVisible();
    await expect(section.locator("h2")).toHaveText(
      "What a label can't tell you"
    );
    await expect(section.locator(".definitions-rule")).toHaveCount(7);
  }
);

browserFlow(
  "override: the card turns on with no goal selected",
  async ({ page, request }) => {
    await setFocus(request, NO_GOALS_FOCUS);
    await expect(
      await request.post("/api/feature-flags/overrides", {
        headers: sameOriginHeaders,
        data: { key: TRUST_CARD, value: "on" },
      })
    ).toBeOK();

    await page.goto(`/apps/${instagramId}`);
    await expect(page.locator("h1.detail-hero-name")).toHaveText("Instagram");
    await expect(page.locator(".label-trust")).toBeVisible();

    await expect(
      await request.delete(
        `/api/feature-flags/overrides/${encodeURIComponent(TRUST_CARD)}`,
        { headers: sameOriginHeaders }
      )
    ).toBeOK();
  }
);
