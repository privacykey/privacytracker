import { expect, type Page, test } from "@playwright/test";

/**
 * E2E coverage for the multi-app side of the onboarding wizard's manual
 * entry flow. The single-app happy path is already covered by
 * `onboarding-clock.spec.ts`; this file extends that surface with:
 *
 *   - multi-app text entry (3 names → 3 matches → remove one → import 2)
 *   - ambiguous matches (one query, multiple candidates, user picks a
 *     non-default one)
 *   - no-match handling (zero candidates returned for a query)
 *   - mixed batch (some queries match, one doesn't — wizard still
 *     advances and only matched apps reach the Import-complete view)
 *
 * Every spec runs in dev-preview mode (`/onboard?preview=fresh`) so the
 * confirm-import handler short-circuits without writing real apps —
 * the focus here is the matching + selection UX, not the import
 * transaction. Real-import coverage stays in the unit tests.
 *
 * The /api/search endpoint is mocked at the page level: the wizard
 * sends `{ rows: [{ name, developer? }, …] }` and the mock returns
 * `{ results: [{ query, candidates: [...] }, …] }` keyed by query name,
 * pulling from the FIXTURES table at the top of this file.
 */

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

const sameOriginHeaders = {
  origin: "http://127.0.0.1:3000",
};

// Skip the browser flow inside CODEX_SANDBOX runs — matches the
// pattern used by every other spec in this directory.
const browserFlow = process.env.CODEX_SANDBOX ? test.skip : test;

interface CandidateFixture {
  appleId: string;
  bundleId: string;
  developer: string;
  iconUrl: string;
  name: string;
  url: string;
}

/**
 * Fixture set covering the queries used across this file. Each fixture
 * has the fields the wizard's SearchResultBlock actually reads:
 * appleId, name, developer, iconUrl, url, bundleId. iconUrl uses a
 * placeholder mzstatic-shaped path so the wizard's <Image> rendering
 * doesn't 404 in the trace; Playwright doesn't actually fetch the
 * image during the assertions we care about.
 */
const FIXTURES: Record<string, CandidateFixture[]> = {
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
  Music: [
    {
      appleId: "1108187390",
      name: "Music",
      developer: "Apple",
      iconUrl:
        "https://is1-ssl.mzstatic.com/image/thumb/Purple221/v4/music.png/100x100bb.jpg",
      url: "https://apps.apple.com/us/app/music/id1108187390",
      bundleId: "com.apple.Music",
    },
  ],
  Maps: [
    {
      appleId: "915056765",
      name: "Maps",
      developer: "Apple",
      iconUrl:
        "https://is1-ssl.mzstatic.com/image/thumb/Purple221/v4/maps.png/100x100bb.jpg",
      url: "https://apps.apple.com/us/app/maps/id915056765",
      bundleId: "com.apple.Maps",
    },
  ],
  // Ambiguous query: two distinct apps both named "Notes". The wizard
  // auto-selects the first; the test clicks into the second one to
  // verify the disambiguation UI.
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
  Mail: [
    {
      appleId: "1108187098",
      name: "Mail",
      developer: "Apple",
      iconUrl:
        "https://is1-ssl.mzstatic.com/image/thumb/Purple221/v4/mail.png/100x100bb.jpg",
      url: "https://apps.apple.com/us/app/mail/id1108187098",
      bundleId: "com.apple.mobilemail",
    },
  ],
};

/**
 * Install a /api/search mock that pulls from FIXTURES by query name.
 * Names not in FIXTURES return zero candidates — the same shape the
 * server returns when iTunes Search has nothing for that string.
 */
async function mockSearchFromFixtures(page: Page) {
  await page.route("**/api/search", async (route) => {
    const body = route.request().postDataJSON() as {
      rows?: Array<{ name?: string }>;
    };
    const rows = body.rows ?? [];
    const results = rows.map((row) => {
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
  // Same focus seed onboarding-clock uses — `accessibility: true`
  // keeps the privacy-profile gating flag on for downstream pages
  // and matches the dependency these specs share.
  const focus = await request.post("/api/focus", {
    headers: sameOriginHeaders,
    data: {
      audience: "self",
      understand: true,
      declutter: false,
      minimal: false,
      accessibility: true,
    },
  });
  await expect(focus).toBeOK();

  // Clear any previously saved profile so each spec starts from a
  // known state — none of these specs care about the profile, but a
  // leftover one from a prior run could change downstream gating.
  const cleared = await request.put("/api/privacy-profile", {
    headers: sameOriginHeaders,
    data: { profile: null },
  });
  await expect(cleared).toBeOK();
});

/**
 * Reusable navigation: walks the wizard from the welcome step to step 2
 * (the "type app names" textarea), ready for the spec to fill in names
 * and click search.
 *
 * The manual-method click is wrapped in `expect.toPass` because the
 * wizard's method-card buttons are React-only (their onClick fires
 * `setMethod`). On a slow boot — dev server, cold cache, or a busy CI
 * runner — Playwright can dispatch the click before React 18 has
 * attached its document-level event delegation; the browser fires
 * the click but no handler runs, leaving the wizard on the default
 * `file` method. Polling the click until `aria-checked="true"` lands
 * lets the helper survive that race without slowing the happy path.
 */
async function openWizardToTextEntry(page: Page) {
  await page.goto("/onboard?preview=fresh");
  // The <summary> toggle is native browser behaviour, so this click
  // works pre-hydration.
  await page.getByText("Other import options").click();
  const manualCard = page.getByTestId("onboard-method-manual");
  await expect(async () => {
    await manualCard.click();
    await expect(manualCard).toHaveAttribute("aria-checked", "true", {
      timeout: 500,
    });
  }).toPass({ timeout: 10_000 });
  await page.getByTestId("onboard-step1-continue").click();
}

// ---------------------------------------------------------------------------
// Spec: multi-app text entry + remove-one + import
// ---------------------------------------------------------------------------

browserFlow(
  "multi-app entry: 3 names match, remove one, import the other two",
  async ({ page }) => {
    await mockSearchFromFixtures(page);
    await openWizardToTextEntry(page);

    await page.getByTestId("onboard-app-names").fill("Clock\nMusic\nMaps");
    // ImportedAppsTable's textarea is a *staging* input — names land in
    // the search-step `importedApps` list only after the "+ Add" button
    // (or Cmd/Ctrl-Enter) commits the pasted text. The pre-refactor
    // textarea was the source of truth, and the early version of this
    // spec skipped the commit click. Click it explicitly so the search
    // step has rows to work against.
    await page.getByTestId("imported-apps-add").click();
    await page.getByTestId("onboard-search").click();

    // Step 3: one .search-result-item per query. The wizard auto-selects
    // the first candidate of each match, so the import button should
    // count three apps before we touch anything.
    const blocks = page.locator(".search-result-item");
    await expect(blocks).toHaveCount(3);
    await expect(page.getByTestId("onboard-confirm-import")).toBeEnabled();

    // Remove the Music block via its per-block "Skip this" action.
    // handleBlockSkip drops the query from `selected` so its candidate
    // won't reach the import step.
    // The wizard renders the query in typographic curly quotes (“…”),
    // so a hasText with straight ASCII quotes wouldn't match. Filter by the
    // bare query name instead — fixture names are unique across blocks.
    const musicBlock = blocks.filter({ hasText: "Music" });
    await expect(musicBlock).toHaveCount(1);
    await musicBlock.getByRole("button", { name: /skip this/i }).click();

    // After skipping, Music's "Confirmed" pill should be gone — the
    // block stays visible but no longer counts toward the import.
    await expect(musicBlock.locator(".search-result-confirmed")).toHaveCount(0);

    await page.getByTestId("onboard-confirm-import").click();
    await expect(
      page.getByRole("heading", { name: "Import complete" })
    ).toBeVisible();

    // Two app names should land in the post-import list; Music should
    // not.
    const completedNames = page.locator(".scrape-name");
    await expect(completedNames).toHaveCount(2);
    await expect(completedNames.filter({ hasText: "Clock" })).toHaveCount(1);
    await expect(completedNames.filter({ hasText: "Maps" })).toHaveCount(1);
    await expect(completedNames.filter({ hasText: "Music" })).toHaveCount(0);
  }
);

// ---------------------------------------------------------------------------
// Spec: ambiguous match → user picks a non-default candidate
// ---------------------------------------------------------------------------

browserFlow(
  "ambiguous match: user picks the Apple Notes candidate over the default",
  async ({ page }) => {
    await mockSearchFromFixtures(page);
    await openWizardToTextEntry(page);

    await page.getByTestId("onboard-app-names").fill("Notes");
    // Commit staged text via the "+ Add" button before searching — the
    // ImportedAppsTable refactor turned the textarea into a staging
    // input. Same reason as the multi-app spec above.
    await page.getByTestId("imported-apps-add").click();
    await page.getByTestId("onboard-search").click();

    const block = page
      .locator(".search-result-item")
      .filter({ hasText: "Notes" });
    await expect(block).toHaveCount(1);

    // The wizard auto-selects the first candidate (the non-Apple one).
    // Expand the candidate list so we can pick the alternate. The toggle
    // label varies with state and count ("See 1 other match" / "+ 2 other
    // matches" / "Show less"), so we target the dedicated class instead
    // of trying to write a regex that handles every plural form.
    await block.locator(".show-more-btn").click();

    const appleRow = block
      .locator(".candidate-row")
      .filter({ hasText: "Apple" });
    await expect(appleRow).toHaveCount(1);
    await appleRow.click();

    // The Apple row should now be the chosen one.
    await expect(appleRow).toHaveClass(/chosen/);
    await expect(
      block
        .locator(".candidate-row.chosen")
        .filter({ hasText: "Random Notes Co" })
    ).toHaveCount(0);

    await page.getByTestId("onboard-confirm-import").click();
    await expect(
      page.getByRole("heading", { name: "Import complete" })
    ).toBeVisible();

    // The Apple-developed Notes is the one that imported. We don't
    // assert on the developer string here (the post-import row only
    // shows the app name), but the row count alone is enough to prove
    // exactly one candidate from this block reached step 4.
    const completedNames = page.locator(".scrape-name");
    await expect(completedNames).toHaveCount(1);
    await expect(completedNames).toHaveText("Notes");
  }
);

// ---------------------------------------------------------------------------
// Spec: no-match handling
// ---------------------------------------------------------------------------

browserFlow(
  "no-match: empty candidate list lands in the unavailable section and disables import",
  async ({ page }) => {
    await mockSearchFromFixtures(page);
    await openWizardToTextEntry(page);

    await page
      .getByTestId("onboard-app-names")
      .fill("asdfqwerty123notarealapp");
    // Commit staged text before searching — see the multi-app spec
    // above for the ImportedAppsTable staging-vs-committed split.
    await page.getByTestId("imported-apps-add").click();
    await page.getByTestId("onboard-search").click();

    // Step 3 now routes unmatched queries into the "Not in the App
    // Store" triage section (one <li> per query with a "Save as"
    // dropdown), rather than rendering an empty `.search-result-item`
    // block. The block-level UI is reserved for queries that resolved
    // against iTunes — anything that came back with zero candidates
    // gets the triage treatment so the user can route it to manual /
    // sideloaded / TestFlight / Skip in a single picker.
    await expect(page.locator(".search-result-item")).toHaveCount(0);
    const unavailableSection = page
      .locator("section.onboard-match-section")
      .filter({ hasText: "Not in the App Store" });
    await expect(unavailableSection).toBeVisible();
    await expect(
      unavailableSection.getByText("asdfqwerty123notarealapp")
    ).toBeVisible();

    // With nothing matched, the import button is disabled. (effectiveCount
    // === 0 → disabled per OnboardWizard's render guard.)
    await expect(page.getByTestId("onboard-confirm-import")).toBeDisabled();
  }
);

// ---------------------------------------------------------------------------
// Spec: mixed batch — some queries match, one doesn't, wizard still imports
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Spec: CSV file-upload import path
// ---------------------------------------------------------------------------
//
// The wizard's "file" method renders a drop zone backed by a hidden
// <input type="file" accept=".txt,.csv,..."> that runs CSV column
// detection (name vs developer). We use Playwright's setInputFiles to
// attach a generated CSV directly, mirroring what a real file drop
// would do, then walk the rest of the wizard exactly like the manual
// path. This covers the alt-onboarding surface that the multi-app
// text-entry spec doesn't reach.

browserFlow(
  "CSV file upload: drag-drop a CSV, walk through search and import",
  async ({ page }) => {
    await mockSearchFromFixtures(page);

    await page.goto("/onboard?preview=fresh");
    await page.getByText("Other import options").click();
    await page.getByTestId("onboard-method-file").click();
    await page.getByTestId("onboard-step1-continue").click();

    // The drop zone hosts a hidden input with accept=".txt,.csv,…". We
    // bypass the visible click-to-pick affordance and feed the file
    // directly via setInputFiles — this is the standard Playwright
    // pattern for hidden file inputs.
    const csv = ["Name,Developer", "Clock,Apple", "Maps,Apple"].join("\n");
    await page.locator('input[type="file"][accept*="csv"]').setInputFiles({
      name: "apps.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(csv),
    });

    // After parsing, the wizard renders one `.imported-apps-row` per
    // CSV row inside the ImportedAppsTable. (Earlier versions of the
    // wizard used a single textarea as the source of truth — see the
    // refactor note in the component — so this spec used to assert
    // `expect(textarea).toHaveValue(/Clock/)`. The textarea is now a
    // pending-input staging area and never receives CSV content, so we
    // verify the *committed* rows instead.) Wait for them before
    // searching so the search step has data to operate on.
    const importedRows = page.locator(".imported-apps-row");
    await expect(importedRows).toHaveCount(2);
    await expect(importedRows.filter({ hasText: "Clock" })).toHaveCount(1);
    await expect(importedRows.filter({ hasText: "Maps" })).toHaveCount(1);

    await page.getByTestId("onboard-search").click();

    const blocks = page.locator(".search-result-item");
    await expect(blocks).toHaveCount(2);
    await expect(
      blocks.filter({ hasText: "Clock" }).locator(".search-result-confirmed")
    ).toHaveCount(1);
    await expect(
      blocks.filter({ hasText: "Maps" }).locator(".search-result-confirmed")
    ).toHaveCount(1);

    await page.getByTestId("onboard-confirm-import").click();
    await expect(
      page.getByRole("heading", { name: "Import complete" })
    ).toBeVisible();

    const completedNames = page.locator(".scrape-name");
    await expect(completedNames).toHaveCount(2);
    await expect(completedNames.filter({ hasText: "Clock" })).toHaveCount(1);
    await expect(completedNames.filter({ hasText: "Maps" })).toHaveCount(1);
  }
);

browserFlow(
  "mixed batch: matched apps import, unmatched is flagged but does not block",
  async ({ page }) => {
    await mockSearchFromFixtures(page);
    await openWizardToTextEntry(page);

    // "Mail" + "Clock" are in FIXTURES; "asdfqwerty123" is not, so the
    // mock returns an empty candidates array for it.
    await page
      .getByTestId("onboard-app-names")
      .fill("Mail\nasdfqwerty123\nClock");
    // Commit staged text before searching — see the multi-app spec
    // above for the ImportedAppsTable staging-vs-committed split.
    await page.getByTestId("imported-apps-add").click();
    await page.getByTestId("onboard-search").click();

    const blocks = page.locator(".search-result-item");
    // Only matched queries render as `.search-result-item` blocks now —
    // the unmatched query lands in the "Not in the App Store" section
    // (one <li> per query) below, so the matched-block count is two
    // even though we searched for three names.
    await expect(blocks).toHaveCount(2);

    // The unmatched query shows up in the unavailable section, not as
    // a result block. Verify the section heading exists and contains
    // the unmatched query name so we know it surfaced for triage.
    const unavailableSection = page
      .locator("section.onboard-match-section")
      .filter({ hasText: "Not in the App Store" });
    await expect(unavailableSection).toBeVisible();
    await expect(unavailableSection.getByText("asdfqwerty123")).toBeVisible();

    // Both matched blocks should have an auto-selected candidate
    // ("Confirmed" pill present).
    await expect(
      blocks.filter({ hasText: "Mail" }).locator(".search-result-confirmed")
    ).toHaveCount(1);
    await expect(
      blocks.filter({ hasText: "Clock" }).locator(".search-result-confirmed")
    ).toHaveCount(1);

    // Import button reflects only the matched count (2), not 3.
    await expect(page.getByTestId("onboard-confirm-import")).toBeEnabled();

    await page.getByTestId("onboard-confirm-import").click();
    await expect(
      page.getByRole("heading", { name: "Import complete" })
    ).toBeVisible();

    const completedNames = page.locator(".scrape-name");
    await expect(completedNames).toHaveCount(2);
    await expect(completedNames.filter({ hasText: "Mail" })).toHaveCount(1);
    await expect(completedNames.filter({ hasText: "Clock" })).toHaveCount(1);
    await expect(
      completedNames.filter({ hasText: "asdfqwerty123" })
    ).toHaveCount(0);
  }
);

// ---------------------------------------------------------------------------
// Spec: security gate blocks /api/search → step 2 explains why
// ---------------------------------------------------------------------------
//
// proxy.ts returns 401 for mutating API calls from non-local hosts that
// lack the admin token (e.g. browsing the app via a LAN IP). The wizard
// used to swallow that response and mark every row "unmatched", telling
// users their apps weren't in the App Store. Pin the fixed contract:
// the wizard stays on step 2, renders the security-gate explanation
// with the Settings → Deployment login link, and never creates step-3
// result blocks for rows that were never actually searched.

browserFlow(
  "security-gate 401 on search stays on step 2 with the blocked message",
  async ({ page }) => {
    await page.route("**/api/search", (route) =>
      route.fulfill({
        status: 401,
        contentType: "application/json",
        body: JSON.stringify({
          error: "Admin token required for non-local API access",
        }),
      })
    );
    await openWizardToTextEntry(page);

    await page.getByTestId("onboard-app-names").fill("facebook\nebay");
    await page.getByTestId("imported-apps-add").click();
    await page.getByTestId("onboard-search").click();

    // The gate explanation renders on step 2 with the login deep-link.
    await expect(
      page.getByText(/blocked by this server's security gate \(HTTP 401\)/)
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: /log in with the admin token/i })
    ).toBeVisible();

    // Still on step 2 — the names input is present and no step-3
    // result blocks (or "Not in the App Store" rows) were created.
    await expect(page.getByTestId("onboard-app-names")).toBeVisible();
    await expect(page.locator(".search-result-item")).toHaveCount(0);
  }
);
