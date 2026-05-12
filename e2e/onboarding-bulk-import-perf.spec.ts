import { expect, test, type Page } from '@playwright/test';

const sameOriginHeaders = {
  origin: 'http://127.0.0.1:3000',
};

const browserFlow = process.env.CODEX_SANDBOX ? test.skip : test;

interface BulkCall {
  count: number;
  statuses: string[];
}

function candidateFor(query: string, index: number) {
  return {
    appleId: `${9_000_000 + index}`,
    name: query,
    developer: 'Bulk Fixture Co',
    iconUrl: `https://is1-ssl.mzstatic.com/image/thumb/Purple221/v4/bulk-${index}.png/100x100bb.jpg`,
    url: `https://apps.apple.com/us/app/${query.toLowerCase().replace(/[^a-z0-9]+/g, '-')}/id${9_000_000 + index}`,
    bundleId: `com.example.bulk${index}`,
    searchQuery: query,
  };
}

async function mockBulkSearch(page: Page) {
  await page.route('**/api/search', async route => {
    const body = route.request().postDataJSON() as {
      rows?: Array<{ name?: string }>;
      bundleIds?: string[];
    };
    const rows = body.rows ?? [];
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        results: rows.map((row, index) => {
          const query = (row.name ?? '').trim();
          return {
            query,
            candidates: query ? [candidateFor(query, index + 1)] : [],
          };
        }),
      }),
    });
  });
}

async function openWizardToTextEntry(page: Page) {
  await page.goto('/onboard');
  await page.getByText('Other import options').click();
  await page.getByTestId('onboard-method-manual').click();
  await page.getByTestId('onboard-step1-continue').click();
}

test.beforeEach(async ({ request }) => {
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

  const cleared = await request.put('/api/privacy-profile', {
    headers: sameOriginHeaders,
    data: { profile: null },
  });
  await expect(cleared).toBeOK();
});

browserFlow('large onboarding import batches item status writes instead of fan-out updates', async ({ page }) => {
  const bulkCalls: BulkCall[] = [];
  let updateCalls = 0;

  await mockBulkSearch(page);
  await page.route('**/api/imports**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();

    if (url.pathname === '/api/imports/items/update') {
      updateCalls += 1;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ item: { id: `legacy-${updateCalls}` } }),
      });
      return;
    }

    if (url.pathname === '/api/imports/items' && method === 'POST') {
      const body = request.postDataJSON() as {
        items?: Array<{ query?: string; status?: string }>;
      };
      const items = body.items ?? [];
      bulkCalls.push({
        count: items.length,
        statuses: items.map(item => item.status ?? ''),
      });
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          items: items.map((item, index) => ({
            id: `item-${index}-${item.query}`,
            query: item.query,
            status: item.status,
          })),
        }),
      });
      return;
    }

    if (url.pathname === '/api/imports/queue') {
      const status = {
        queued: 150,
        oldestNextAttemptAt: null,
        soonestNextAttemptAt: null,
        items: [],
        pausedUntil: null,
        running: false,
        lastRunAt: null,
      };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(method === 'POST'
          ? { processed: 0, succeeded: 0, failed: 0, rateLimited: 0, pausedUntil: null, skipped: 'empty', status }
          : status),
      });
      return;
    }

    if (url.pathname === '/api/imports' && method === 'POST') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: 'imp-bulk-e2e',
          createdAt: Date.now(),
          completedAt: null,
          source: 'manual',
          sourceLabel: 'bulk e2e',
          total: 150,
          matched: 0,
          unmatched: 0,
          imported: 0,
          queued: 0,
          errored: 0,
          removed: 0,
          itemCount: 0,
        }),
      });
      return;
    }

    if (url.pathname === '/api/imports' && method === 'GET') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          import: {
            id: 'imp-bulk-e2e',
            createdAt: Date.now(),
            completedAt: null,
            source: 'manual',
            sourceLabel: 'bulk e2e',
            total: 150,
            matched: 0,
            unmatched: 0,
            imported: 0,
            queued: 150,
            errored: 0,
            removed: 0,
            itemCount: 150,
          },
          items: Array.from({ length: 150 }, (_, index) => ({
            id: `item-${index}`,
            query: `Bulk App ${index + 1}`,
            editedQuery: null,
            status: 'queued',
            appName: `Bulk App ${index + 1}`,
            url: `https://apps.apple.com/us/app/bulk-app-${index + 1}/id${9_000_000 + index}`,
            scrapeError: null,
            nextAttemptAt: null,
          })),
        }),
      });
      return;
    }

    await route.continue();
  });

  await openWizardToTextEntry(page);

  const names = Array.from({ length: 150 }, (_, index) => `Bulk App ${index + 1}`);
  await page.getByTestId('onboard-app-names').fill(names.join('\n'));
  await page.getByTestId('onboard-search').click();

  await expect(page.locator('.search-result-item')).toHaveCount(150);
  await page.getByTestId('onboard-confirm-import').click();
  await expect(page.getByRole('heading', { name: /Importing apps/i })).toBeVisible();

  await expect.poll(() => bulkCalls.length).toBeGreaterThanOrEqual(3);
  expect(updateCalls).toBe(0);
  expect(bulkCalls[0].count).toBe(150);
  expect(bulkCalls[1].count).toBe(150);
  expect([...new Set(bulkCalls[1].statuses)]).toEqual(['matched']);
  expect(bulkCalls[2].count).toBe(150);
  expect([...new Set(bulkCalls[2].statuses)]).toEqual(['queued']);
});
