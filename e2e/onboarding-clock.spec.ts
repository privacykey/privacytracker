import { expect, test } from '@playwright/test';

const clockCandidate = {
  appleId: '1584215688',
  name: 'Clock',
  developer: 'Apple',
  iconUrl: 'https://is1-ssl.mzstatic.com/image/thumb/Purple221/v4/clock.png/100x100bb.jpg',
  url: 'https://apps.apple.com/us/app/clock/id1584215688',
  bundleId: 'com.apple.mobiletimer',
  searchQuery: 'Clock',
};

const sameOriginHeaders = {
  origin: 'http://127.0.0.1:3000',
};

const browserFlow = process.env.CODEX_SANDBOX ? test.skip : test;

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

  const privacy = await request.put('/api/privacy-profile', {
    headers: sameOriginHeaders,
    data: {
      profile: {
        LOCATION: 'not_linked',
        CONTACT_INFO: 'linked',
      },
    },
  });
  await expect(privacy).toBeOK();

  const accessibility = await request.put('/api/accessibility-profile', {
    headers: sameOriginHeaders,
      data: {
        profile: {
          voiceover: 'required',
          larger_text: 'nice',
        },
      },
  });
  await expect(accessibility).toBeOK();
});

browserFlow('mocked Clock onboarding flow reaches import complete in the browser', async ({ page }) => {
  await page.route('**/api/search', async route => {
    const body = route.request().postDataJSON() as { rows?: Array<{ name?: string }> };
    const query = body.rows?.[0]?.name ?? 'Clock';
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        results: [
          {
            query,
            candidates: [{ ...clockCandidate, searchQuery: query }],
          },
        ],
      }),
    });
  });

  await page.goto('/onboard?preview=fresh');

  await page.getByText('Other import options').click();
  await page.getByTestId('onboard-method-manual').click();
  await page.getByTestId('onboard-step1-continue').click();

  await page.getByTestId('onboard-app-names').fill('Clock');
  await page.getByTestId('onboard-search').click();

  await expect(page.getByText('Clock')).toBeVisible();
  await expect(page.getByText('Apple')).toBeVisible();

  await page.getByTestId('onboard-confirm-import').click();
  await expect(page.getByRole('heading', { name: 'Import complete' })).toBeVisible();
  await expect(page.getByText('Clock')).toBeVisible();
  await expect(page.getByTestId('onboard-next-ai')).toBeEnabled();
});

test('profile APIs used by the browser flow persist cleanly', async ({ request }) => {
  const privacy = await request.get('/api/privacy-profile');
  await expect(privacy).toBeOK();
  await expect(privacy.json()).resolves.toMatchObject({
    profile: {
      LOCATION: 'not_linked',
      CONTACT_INFO: 'linked',
    },
  });

  const accessibility = await request.get('/api/accessibility-profile');
  await expect(accessibility).toBeOK();
  await expect(accessibility.json()).resolves.toMatchObject({
    profile: {
      voiceover: 'required',
      larger_text: 'nice',
    },
  });
});
