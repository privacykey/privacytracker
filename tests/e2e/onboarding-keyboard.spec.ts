import { expect, type Page, test } from "@playwright/test";
import { tabTo } from "./helpers/keyboard";

/**
 * Keyboard-only onboarding coverage.
 *
 * Walks the manual text-entry import path using ONLY the keyboard —
 * no mouse events. This is the half of the a11y gate that axe cannot
 * provide: axe analyses ARIA/DOM structure, but a plain clickable
 * <div> is invisible to it, so keyboard operability has to be proven
 * by actually driving the flow.
 *
 * Runs on Chromium (the suite's only project) — macOS Safari's
 * "Keyboard navigation" system setting makes WebKit skip buttons and
 * links entirely, which is an OS behaviour, not a bug (see AGENTS.md).
 *
 * The candidate-selection spec at the bottom is `fixme`-gated: it is
 * the acceptance test for the tracked candidate-selection fix
 * (candidate rows are bare clickable <div>s today). Remove the `fixme`
 * in the PR that converts them to native controls.
 */

const sameOriginHeaders = {
  origin: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000",
};

// Skip the browser flow inside CODEX_SANDBOX runs — matches the
// pattern used by every other spec in this directory.
const browserFlow = process.env.CODEX_SANDBOX ? test.skip : test;

const FIXTURES: Record<
  string,
  Array<{
    appleId: string;
    bundleId: string;
    developer: string;
    iconUrl: string;
    name: string;
    url: string;
  }>
> = {
  Clock: [
    {
      appleId: "1584215688",
      name: "Clock",
      developer: "Apple",
      iconUrl:
        "https://is1-ssl.mzstatic.com/image/thumb/Purple221/v4/clock.png/100x100bb.jpg",
      url: "https://apps.apple.com/us/app/clock/id1584215688",
      bundleId: "com.apple.mobiletimer",
    },
  ],
  Notes: [
    {
      appleId: "111100000",
      name: "Notes",
      developer: "Random Notes Co",
      iconUrl:
        "https://is1-ssl.mzstatic.com/image/thumb/Purple221/v4/notes-other.png/100x100bb.jpg",
      url: "https://apps.apple.com/us/app/notes/id111100000",
      bundleId: "com.example.notes",
    },
    {
      appleId: "1110145109",
      name: "Notes",
      developer: "Apple",
      iconUrl:
        "https://is1-ssl.mzstatic.com/image/thumb/Purple221/v4/notes-apple.png/100x100bb.jpg",
      url: "https://apps.apple.com/us/app/notes/id1110145109",
      bundleId: "com.apple.mobilenotes",
    },
  ],
};

async function mockSearchFromFixtures(page: Page) {
  await page.route("**/api/search", async (route) => {
    const body = route.request().postDataJSON() as {
      rows?: Array<{ name?: string }>;
    };
    const results = (body.rows ?? []).map((row) => {
      const query = (row.name ?? "").trim();
      const candidates = (FIXTURES[query] ?? []).map((c) => ({
        ...c,
        searchQuery: query,
      }));
      return { query, candidates };
    });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ results }),
    });
  });
}

test.beforeEach(async ({ request }) => {
  const focus = await request.post("/api/focus", {
    headers: sameOriginHeaders,
    data: {
      audience: "self",
      monitor: true,
      cleanup: false,
      minimal: false,
      accessibility: true,
    },
  });
  await expect(focus).toBeOK();
});

/**
 * Keyboard-only walk from the wizard's method step to the app-names
 * textarea: open the "Other import options" disclosure, move the
 * method radiogroup to "manual", and continue to step 2.
 */
async function keyboardToTextEntry(page: Page) {
  await page.goto("/onboard?preview=fresh");

  // The manual method card sits inside the collapsed "Other import
  // options" <details>, so open the disclosure first — <summary> is
  // natively focusable and Enter toggles it pre-hydration.
  const summary = page.getByText("Other import options");
  await expect(summary).toBeVisible();
  await tabTo(page, summary);
  await page.keyboard.press("Enter");

  // Every method radio ships tabindex="0" (no roving tabindex), so Tab
  // reaches the manual card directly. Selection via Space is polled the
  // same way the click-based specs poll their click — React may not
  // have attached handlers yet on a cold start (see the `toPass` note
  // in onboard-import.spec.ts).
  const manualCard = page.getByTestId("onboard-method-manual");
  await expect(manualCard).toBeVisible();
  await tabTo(page, manualCard);
  await expect(async () => {
    await page.keyboard.press("Space");
    await expect(manualCard).toHaveAttribute("aria-checked", "true", {
      timeout: 500,
    });
  }).toPass({ timeout: 10_000 });

  // Continue to step 2.
  const continueBtn = page.getByTestId("onboard-step1-continue");
  await tabTo(page, continueBtn);
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("onboard-app-names")).toBeVisible();
}

browserFlow(
  "keyboard-only: manual entry from method step through search to a confirmed match",
  async ({ page }) => {
    await mockSearchFromFixtures(page);
    await keyboardToTextEntry(page);

    // Type an app name into the staging textarea and commit it via the
    // "+ Add" button — all keyboard.
    const textarea = page.getByTestId("onboard-app-names");
    await tabTo(page, textarea);
    await page.keyboard.type("Clock");

    const addBtn = page.getByTestId("imported-apps-add");
    await tabTo(page, addBtn);
    await page.keyboard.press("Enter");
    await expect(page.locator(".imported-apps-row")).toHaveCount(1);

    // Run the search from the keyboard.
    const searchBtn = page.getByTestId("onboard-search");
    await tabTo(page, searchBtn);
    await page.keyboard.press("Enter");

    // The match auto-confirms; the import CTA must be enabled and
    // keyboard-reachable.
    const block = page
      .locator(".search-result-item")
      .filter({ hasText: "Clock" });
    await expect(block).toHaveCount(1);
    await expect(block.locator(".search-result-confirmed")).toHaveCount(1);

    const importBtn = page.getByTestId("onboard-confirm-import");
    await expect(importBtn).toBeEnabled();
    await tabTo(page, importBtn);
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("heading", { name: "Import complete" })
    ).toBeVisible();
  }
);

// ---------------------------------------------------------------------------
// Acceptance test for the tracked candidate-selection fix
// ---------------------------------------------------------------------------
//
// The candidate rows in SearchResultBlock are bare clickable <div>s
// today (no role, no tabIndex, no keyboard handler), so this spec
// cannot pass. It documents the required end state: expand the
// alternate candidates and choose one using only the keyboard. When
// the fix converts the rows to native controls (radiogroup pattern, like
// the wizard's method cards), remove this `fixme` and the spec becomes
// the regression guard for that fix.

// `test.fixme` (not `browserFlow.fixme`) — the CODEX_SANDBOX alias is
// `test.skip`, which has no `.fixme` property; fixme already never runs.
test.fixme("keyboard-only: pick a non-default candidate in the match step (pending candidate-row fix)", async ({
  page,
}) => {
  await mockSearchFromFixtures(page);
  await keyboardToTextEntry(page);

  const textarea = page.getByTestId("onboard-app-names");
  await tabTo(page, textarea);
  await page.keyboard.type("Notes");
  const addBtn = page.getByTestId("imported-apps-add");
  await tabTo(page, addBtn);
  await page.keyboard.press("Enter");
  const searchBtn = page.getByTestId("onboard-search");
  await tabTo(page, searchBtn);
  await page.keyboard.press("Enter");

  const block = page
    .locator(".search-result-item")
    .filter({ hasText: "Notes" });
  await expect(block).toHaveCount(1);

  // Expand the alternate candidates from the keyboard.
  const showMore = block.locator(".show-more-btn");
  await tabTo(page, showMore);
  await page.keyboard.press("Enter");

  // Reach the Apple candidate row and select it — this is the part
  // that requires the candidate rows to become native controls.
  const appleRow = block.locator(".candidate-row").filter({ hasText: "Apple" });
  await tabTo(page, appleRow);
  await page.keyboard.press("Space");
  await expect(appleRow).toHaveClass(/chosen/);
});
