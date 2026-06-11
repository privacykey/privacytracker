import assert from "node:assert/strict";
import test from "node:test";
import db from "../../lib/db";
import { fetchAndParseApp, getAppWithPrivacy } from "../../lib/scraper";
import { resetTestDb } from "../helpers/test-db";

const CLOCK_URL = "https://apps.apple.com/us/app/clock/id1584215688";
const CLOCK_POLICY_URL = "https://www.apple.com/legal/privacy/";

const originalFetch = global.fetch;

test.beforeEach(resetTestDb);

test.afterEach(() => {
  global.fetch = originalFetch;
});

test("fixture App Store import stores Clock privacy labels, accessibility labels, and initial snapshot", async () => {
  global.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith(CLOCK_URL)) {
      return new Response(clockAppStoreHtml(), {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    if (url.startsWith("https://itunes.apple.com/lookup")) {
      return new Response(
        JSON.stringify({
          resultCount: 1,
          results: [
            {
              version: "1.0.0",
              currentVersionReleaseDate: "2026-01-02T03:04:05Z",
              releaseNotes: "Fixture release notes",
              price: 0,
              currency: "USD",
              formattedPrice: "Free",
              primaryGenreId: 6002,
              primaryGenreName: "Utilities",
            },
          ],
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        }
      );
    }
    throw new Error(`Unexpected fetch in scraper fixture test: ${url}`);
  }) as typeof fetch;

  const result = await fetchAndParseApp(CLOCK_URL, false, false, "import");

  assert.equal(result.status, "success");
  assert.equal(result.id, "1584215688");
  assert.equal(result.name, "Clock");
  assert.equal(result.isNew, true);
  assert.equal(result.changesDetected, false);

  const app = getAppWithPrivacy("1584215688") as {
    name: string;
    developer: string;
    privacyPolicyUrl: string;
    hasPrivacyDetails: number;
    hasAccessibilityLabels: number;
    currentVersion: string;
    genreName: string;
    privacyTypes: Array<{
      identifier: string;
      categories: Array<{ identifier: string }>;
    }>;
    accessibilityFeatures: Array<{ identifier: string; title: string }>;
  } | null;

  assert.ok(app);
  assert.equal(app.name, "Clock");
  assert.equal(app.developer, "Apple");
  assert.equal(app.privacyPolicyUrl, CLOCK_POLICY_URL);
  assert.equal(app.hasPrivacyDetails, 1);
  assert.equal(app.hasAccessibilityLabels, 1);
  assert.equal(app.currentVersion, "1.0.0");
  assert.equal(app.genreName, "Utilities");

  const privacyByType = new Map(
    app.privacyTypes.map((type) => [
      type.identifier,
      type.categories.map((category) => category.identifier).sort(),
    ])
  );
  assert.deepEqual(privacyByType.get("DATA_LINKED_TO_YOU"), [
    "CONTACT_INFO",
    "IDENTIFIERS",
  ]);
  assert.deepEqual(privacyByType.get("DATA_NOT_LINKED_TO_YOU"), [
    "DIAGNOSTICS",
  ]);
  assert.deepEqual(privacyByType.get("DATA_USED_TO_TRACK_YOU"), ["LOCATION"]);

  assert.deepEqual(
    app.accessibilityFeatures.map((feature) => feature.identifier).sort(),
    ["captions", "voiceover"]
  );

  const snapshots = db
    .prepare(`
    SELECT changes_detected, triggered_by, app_version
    FROM privacy_snapshots
    WHERE app_id = ?
  `)
    .all("1584215688") as Array<{
    changes_detected: number;
    triggered_by: string | null;
    app_version: string | null;
  }>;
  assert.equal(snapshots.length, 1);
  assert.equal(snapshots[0].changes_detected, 0);
  assert.equal(snapshots[0].triggered_by, "import");
  assert.equal(snapshots[0].app_version, "1.0.0");
});

function clockAppStoreHtml(): string {
  const payload = {
    data: [
      {
        data: {
          title: "Clock",
          shelfMapping: {
            privacyTypes: {
              items: [
                {
                  identifier: "DATA_USED_TO_TRACK_YOU",
                  title: "Data Used to Track You",
                  detail: "Fixture tracking data",
                  categories: [{ identifier: "LOCATION", title: "Location" }],
                },
                {
                  identifier: "DATA_LINKED_TO_YOU",
                  title: "Data Linked to You",
                  detail: "Fixture linked data",
                  categories: [
                    { identifier: "CONTACT_INFO", title: "Contact Info" },
                    { identifier: "IDENTIFIERS", title: "Identifiers" },
                  ],
                },
                {
                  identifier: "DATA_NOT_LINKED_TO_YOU",
                  title: "Data Not Linked to You",
                  detail: "Fixture unlinked data",
                  categories: [
                    { identifier: "DIAGNOSTICS", title: "Diagnostics" },
                  ],
                },
              ],
            },
            accessibilityHeader: {
              seeAllAction: {
                pageData: {
                  shelves: [
                    {
                      contentType: "accessibilityFeatures",
                      items: [
                        {
                          features: [
                            {
                              title: "VoiceOver",
                              description: "Navigate by spoken feedback.",
                              artwork: { template: "systemimage://voiceover" },
                            },
                            {
                              title: "Captions",
                              description: "Displays captions for media.",
                              artwork: {
                                template: "systemimage://captions.bubble",
                              },
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
              },
            },
          },
        },
      },
    ],
    userTokenHash: "fixture",
  };

  return `<!doctype html>
    <html>
      <head>
        <meta property="og:title" content="Clock on the App Store">
        <meta property="og:image" content="https://example.com/clock.png">
        <script type="application/ld+json">
          {"author":{"@type":"Organization","name":"Apple"}}
        </script>
      </head>
      <body>
        <div id="notPurchasedLinks">
          <a aria-label="Developer's Privacy Policy" href="${CLOCK_POLICY_URL}">Privacy Policy</a>
        </div>
        <script id="serialized-server-data" type="application/json">${JSON.stringify(payload)}</script>
      </body>
    </html>`;
}
