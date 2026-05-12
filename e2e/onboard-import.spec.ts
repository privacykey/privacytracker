import { expect, test, type Page } from '@playwright/test';

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
  origin: 'http://127.0.0.1:3000',
};

// Skip the browser flow inside CODEX_SANDBOX runs — matches the
// pattern used by every other spec in this directory.
const browserFlow = process.env.CODEX_SANDBOX ? test.skip : test;

interface CandidateFixture {
  appleId: string;
  name: string;
  developer: string;
  iconUrl: string;
  url: string;
  bundleId: string;
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
      appleId: '1584215688',
      name: 'Clock',
      developer: 'Apple',
      iconUrl: 'https://is1-ssl.mzstatic.com/image/thumb/Purple221/v4/clock.png/100x100bb.jpg',
      url: 'https://apps.apple.com/us/app/clock/id1584215688',
      bundleId: 'com.apple.mobiletimer',
    },
  ],
  Music: [
    {
      appleId: '1108187390',
      name: 'Music',
      developer: 'Apple',
      iconUrl: 'https://is1-ssl.mzstatic.com/image/thumb/Purple221/v4/music.png/100x100bb.jpg',
      url: 'https://apps.apple.com/us/app/music/id1108187390',
      bundleId: 'com.apple.Music',
    },
  ],
  Maps: [
    {
      appleId: '915056765',
      name: 'Maps',
      developer: 'Apple',
      iconUrl: 'https://is1-ssl.mzstatic.com/image/thumb/Purple221/v4/maps.png/100x100bb.jpg',
      url: 'https://apps.apple.com/us/app/maps/id915056765',
      bundleId: 'com.apple.Maps',
    },
  ],
  // Ambiguous query: two distinct apps both named "Notes". The wizard
  // auto-selects the first; the test clicks into the second one to
  // verify the disambiguation UI.
  Notes: [
    {
      appleId: '111100000',
      name: 'Notes',
      developer: 'Random Notes Co',
      iconUrl: 'https://is1-ssl.mzstatic.com/image/thumb/Purple221/v4/notes-other.png/100x100bb.jpg',
      url: 'https://apps.apple.com/us/app/notes/id111100000',
      bundleId: 'com.example.notes',
    },
    {
      appleId: '1110145109',
      name: 'Notes',
      developer: 'Apple',
      iconUrl: 'https://is1-ssl.mzstatic.com/image/thumb/Purple221/v4/notes-apple.png/100x100bb.jpg',
      url: 'https://apps.apple.com/us/app/notes/id1110145109',
      bundleId: 'com.apple.mobilenotes',
    },
  ],
  Mail: [
    {
      appleId: '1108187098',
      name: 'Mail',
      developer: 'Apple',
      iconUrl: 'https://is1-ssl.mzstatic.com/image/thumb/Purple221/v4/mail.png/100x100bb.jpg',
      url: 'https://apps.apple.com/us/app/mail/id1108187098',
      bundleId: 'com.apple.mobilemail',
    },
  ],
};

/**
 * Install a /api/search mock that pulls from FIXTURES by query name.
 * Names not in FIXTURES return zero candidates — the same shape the
 * server returns when iTunes Search has nothing for that string.
 */
async function mockSearchFromFixtures(page: Page) {
  await page.route('**/api/search', async route => {
    const body = route.request().postDataJSON() as { rows?: Array<{ name?: string }> };
    const rows = body.rows ?? [];
    const results = rows.map(row => {
      const query = (row.name ?? '').trim();
      const candidates = (FIXTURES[query] ?? []).map(c => ({
        ...c,
        searchQuery: query,
      }));
      return { query, candidates };
    });
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ results }),
    });
  });
}

test.beforeEach(async ({ request }) => {
  // Same focus seed onboarding-clock uses — `accessibility: true`
  // keeps the privacy-profile gating flag on for downstream pages
  // and matches the dependency these specs share.
  const focus = await request.post('/api/focus', {
    headers: sameOriginHeaders,
    data: {
      audience: 'self',
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
  const cleared = await request.put('/api/privacy-profile', {
    headers: sameOriginHeaders,
    data: { profile: null },
  });
  await expect(cleared).toBeOK();
});

/**
 * Reusable navigation: walks the wizard from the welcome step to step 2
 * (the "type app names" textarea), ready for the spec to fill in names
 * and click search.
 */
async function openWizardToTextEntry(page: Page) {
  await page.goto('/onboard?preview=fresh');
  await page.getByText('Other import options').click();
  await page.getByTestId('onboard-method-manual').click();
  await page.getByTestId('onboard-step1-continue').click();
}

// ---------------------------------------------------------------------------
// Spec: multi-app text entry + remove-one + import
// ---------------------------------------------------------------------------

browserFlow('multi-app entry: 3 names match, remove one, import the other two', async ({ page }) => {
  await mockSearchFromFixtures(page);
  await openWizardToTextEntry(page);

  await page.getByTestId('onboard-app-names').fill('Clock\nMusic\nMaps');
  await page.getByTestId('onboard-search').click();

  // Step 3: one .search-result-item per query. The wizard auto-selects
  // the first candidate of each match, so the import button should
  // count three apps before we touch anything.
  const blocks = page.locator('.search-result-item');
  await expect(blocks).toHaveCount(3);
  await expect(page.getByTestId('onboard-confirm-import')).toBeEnabled();

  // Remove the Music block via its per-block "Skip this" action.
  // handleBlockSkip drops the query from `selected` so its candidate
  // won't reach the import step.
  // The wizard renders the query in typographic curly quotes (“…”),
  // so a hasText with straight ASCII quotes wouldn't match. Filter by the
  // bare query name instead — fixture names are unique across blocks.
  const musicBlock = blocks.filter({ hasText: 'Music' });
  await expect(musicBlock).toHaveCount(1);
  await musicBlock.getByRole('button', { name: /skip this/i }).click();

  // After skipping, Music's "Confirmed" pill should be gone — the
  // block stays visible but no longer counts toward the import.
  await expect(musicBlock.locator('.search-result-confirmed')).toHaveCount(0);

  await page.getByTestId('onboard-confirm-import').click();
  await expect(page.getByRole('heading', { name: 'Import complete' })).toBeVisible();

  // Two app names should land in the post-import list; Music should
  // not.
  const completedNames = page.locator('.scrape-name');
  await expect(completedNames).toHaveCount(2);
  await expect(completedNames.filter({ hasText: 'Clock' })).toHaveCount(1);
  await expect(completedNames.filter({ hasText: 'Maps' })).toHaveCount(1);
  await expect(completedNames.filter({ hasText: 'Music' })).toHaveCount(0);
});

// ---------------------------------------------------------------------------
// Spec: ambiguous match → user picks a non-default candidate
// ---------------------------------------------------------------------------

browserFlow('ambiguous match: user picks the Apple Notes candidate over the default', async ({ page }) => {
  await mockSearchFromFixtures(page);
  await openWizardToTextEntry(page);

  await page.getByTestId('onboard-app-names').fill('Notes');
  await page.getByTestId('onboard-search').click();

  const block = page.locator('.search-result-item').filter({ hasText: 'Notes' });
  await expect(block).toHaveCount(1);

  // The wizard auto-selects the first candidate (the non-Apple one).
  // Expand the candidate list so we can pick the alternate. The toggle
  // label varies with state and count ("See 1 other match" / "+ 2 other
  // matches" / "Show less"), so we target the dedicated class instead
  // of trying to write a regex that handles every plural form.
  await block.locator('.show-more-btn').click();

  const appleRow = block.locator('.candidate-row').filter({ hasText: 'Apple' });
  await expect(appleRow).toHaveCount(1);
  await appleRow.click();

  // The Apple row should now be the chosen one.
  await expect(appleRow).toHaveClass(/chosen/);
  await expect(
    block.locator('.candidate-row.chosen').filter({ hasText: 'Random Notes Co' }),
  ).toHaveCount(0);

  await page.getByTestId('onboard-confirm-import').click();
  await expect(page.getByRole('heading', { name: 'Import complete' })).toBeVisible();

  // The Apple-developed Notes is the one that imported. We don't
  // assert on the developer string here (the post-import row only
  // shows the app name), but the row count alone is enough to prove
  // exactly one candidate from this block reached step 4.
  const completedNames = page.locator('.scrape-name');
  await expect(completedNames).toHaveCount(1);
  await expect(completedNames).toHaveText('Notes');
});

// ---------------------------------------------------------------------------
// Spec: no-match handling
// ---------------------------------------------------------------------------

browserFlow('no-match: empty candidate list surfaces the zero-results UI and disables import', async ({ page }) => {
  await mockSearchFromFixtures(page);
  await openWizardToTextEntry(page);

  await page.getByTestId('onboard-app-names').fill('asdfqwerty123notarealapp');
  await page.getByTestId('onboard-search').click();

  // Step 3 still renders the block — the wizard wants the user to be
  // able to retry, edit, or skip the unmatched query — but the block
  // itself shows the empty/no-matches UI rather than candidate rows.
  const block = page.locator('.search-result-item');
  await expect(block).toHaveCount(1);
  await expect(block.locator('.search-result-empty')).toHaveCount(1);
  await expect(block.locator('.candidate-row')).toHaveCount(0);

  // With nothing selected, the import button is disabled. (effectiveCount
  // === 0 → disabled per OnboardWizard's render guard.)
  await expect(page.getByTestId('onboard-confirm-import')).toBeDisabled();
});

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

browserFlow('CSV file upload: drag-drop a CSV, walk through search and import', async ({ page }) => {
  await mockSearchFromFixtures(page);

  await page.goto('/onboard?preview=fresh');
  await page.getByText('Other import options').click();
  await page.getByTestId('onboard-method-file').click();
  await page.getByTestId('onboard-step1-continue').click();

  // The drop zone hosts a hidden input with accept=".txt,.csv,…". We
  // bypass the visible click-to-pick affordance and feed the file
  // directly via setInputFiles — this is the standard Playwright
  // pattern for hidden file inputs.
  const csv = [
    'Name,Developer',
    'Clock,Apple',
    'Maps,Apple',
  ].join('\n');
  await page.locator('input[type="file"][accept*="csv"]').setInputFiles({
    name: 'apps.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(csv),
  });

  // After parsing, the wizard populates the textarea with the detected
  // names. Wait for the textarea to reflect the upload before searching.
  const textarea = page.getByTestId('onboard-app-names');
  await expect(textarea).toHaveValue(/Clock/);
  await expect(textarea).toHaveValue(/Maps/);

  await page.getByTestId('onboard-search').click();

  const blocks = page.locator('.search-result-item');
  await expect(blocks).toHaveCount(2);
  await expect(blocks.filter({ hasText: 'Clock' }).locator('.search-result-confirmed')).toHaveCount(1);
  await expect(blocks.filter({ hasText: 'Maps' }).locator('.search-result-confirmed')).toHaveCount(1);

  await page.getByTestId('onboard-confirm-import').click();
  await expect(page.getByRole('heading', { name: 'Import complete' })).toBeVisible();

  const completedNames = page.locator('.scrape-name');
  await expect(completedNames).toHaveCount(2);
  await expect(completedNames.filter({ hasText: 'Clock' })).toHaveCount(1);
  await expect(completedNames.filter({ hasText: 'Maps' })).toHaveCount(1);
});

browserFlow('mixed batch: matched apps import, unmatched is flagged but does not block', async ({ page }) => {
  await mockSearchFromFixtures(page);
  await openWizardToTextEntry(page);

  // "Mail" + "Clock" are in FIXTURES; "asdfqwerty123" is not, so the
  // mock returns an empty candidates array for it.
  await page.getByTestId('onboard-app-names').fill('Mail\nasdfqwerty123\nClock');
  await page.getByTestId('onboard-search').click();

  const blocks = page.locator('.search-result-item');
  await expect(blocks).toHaveCount(3);

  // The unmatched block shows the zero-results UI, not a candidate row.
  // Filter by the bare query string — the wizard wraps the query in
  // typographic curly quotes, so a straight-quoted hasText never matches.
  const unmatchedBlock = blocks.filter({ hasText: 'asdfqwerty123' });
  await expect(unmatchedBlock.locator('.search-result-empty')).toHaveCount(1);
  await expect(unmatchedBlock.locator('.search-result-confirmed')).toHaveCount(0);

  // Both matched blocks should have an auto-selected candidate
  // ("Confirmed" pill present).
  await expect(blocks.filter({ hasText: 'Mail' }).locator('.search-result-confirmed')).toHaveCount(1);
  await expect(blocks.filter({ hasText: 'Clock' }).locator('.search-result-confirmed')).toHaveCount(1);

  // Import button reflects only the matched count (2), not 3.
  await expect(page.getByTestId('onboard-confirm-import')).toBeEnabled();

  await page.getByTestId('onboard-confirm-import').click();
  await expect(page.getByRole('heading', { name: 'Import complete' })).toBeVisible();

  const completedNames = page.locator('.scrape-name');
  await expect(completedNames).toHaveCount(2);
  await expect(completedNames.filter({ hasText: 'Mail' })).toHaveCount(1);
  await expect(completedNames.filter({ hasText: 'Clock' })).toHaveCount(1);
  await expect(completedNames.filter({ hasText: 'asdfqwerty123' })).toHaveCount(0);
});
