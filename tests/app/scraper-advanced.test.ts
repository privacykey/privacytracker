import assert from "node:assert/strict";
import test from "node:test";
import db from "../../lib/db";
import {
  fetchAndParseApp,
  getAppWithPrivacy,
  getPendingChangeCategoriesByApp,
} from "../../lib/scraper";
import { resetTestDb } from "../helpers/test-db";

const originalFetch = global.fetch;

test.beforeEach(resetTestDb);
test.afterEach(() => {
  global.fetch = originalFetch;
});

test("resync detects privacy-label diffs, bumps change count, and writes a notification", async () => {
  installScraperFetchMock({
    appHtml: appStoreHtml({
      id: "2001",
      name: "Diff Fixture",
      privacyItems: [
        privacyType("DATA_LINKED_TO_YOU", "Data Linked to You", [
          ["CONTACT_INFO", "Contact Info"],
        ]),
      ],
    }),
    version: "1.0",
  });
  await fetchAndParseApp(
    "https://apps.apple.com/us/app/diff-fixture/id2001",
    false,
    false,
    "import"
  );

  installScraperFetchMock({
    appHtml: appStoreHtml({
      id: "2001",
      name: "Diff Fixture",
      privacyItems: [
        privacyType("DATA_LINKED_TO_YOU", "Data Linked to You", [
          ["CONTACT_INFO", "Contact Info"],
          ["LOCATION", "Location"],
        ]),
      ],
    }),
    version: "1.0",
  });
  const result = await fetchAndParseApp(
    "https://apps.apple.com/us/app/diff-fixture/id2001",
    true,
    false,
    "manual"
  );

  assert.equal(result.changesDetected, true);
  assert.equal(result.changeCount, 1);

  const app = db
    .prepare("SELECT changeCount FROM apps WHERE id = ?")
    .get("2001") as { changeCount: number };
  assert.equal(app.changeCount, 1);

  const snapshots = db
    .prepare(`
    SELECT changes_detected, changes_summary, triggered_by
    FROM privacy_snapshots
    WHERE app_id = ?
    ORDER BY scraped_at ASC
  `)
    .all("2001") as Array<{
    changes_detected: number;
    changes_summary: string | null;
    triggered_by: string | null;
  }>;
  assert.equal(snapshots.length, 2);
  assert.equal(snapshots[1].changes_detected, 1);
  assert.equal(snapshots[1].triggered_by, "manual");
  assert.match(snapshots[1].changes_summary ?? "", /Location/);

  const notification = db
    .prepare("SELECT change_summary FROM notifications WHERE app_id = ?")
    .get("2001") as { change_summary: string };
  assert.match(notification.change_summary, /Location/);
  assert.deepEqual(getPendingChangeCategoriesByApp()["2001"], {
    privacy: true,
    accessibility: false,
    policy: false,
  });
});

test("resync reports version updates separately from label diffs", async () => {
  const privacyItems = [
    privacyType("DATA_LINKED_TO_YOU", "Data Linked to You", [
      ["CONTACT_INFO", "Contact Info"],
    ]),
  ];
  installScraperFetchMock({
    appHtml: appStoreHtml({
      id: "2007",
      name: "Version Fixture",
      privacyItems,
    }),
    releaseDate: "2026-01-01T00:00:00Z",
    version: "1.0",
  });
  await fetchAndParseApp(
    "https://apps.apple.com/us/app/version-fixture/id2007",
    false,
    false,
    "import"
  );

  installScraperFetchMock({
    appHtml: appStoreHtml({
      id: "2007",
      name: "Version Fixture",
      privacyItems,
    }),
    releaseDate: "2026-02-01T00:00:00Z",
    version: "2.0",
  });
  const result = await fetchAndParseApp(
    "https://apps.apple.com/us/app/version-fixture/id2007",
    true,
    false,
    "manual"
  );

  assert.equal(result.changesDetected, false);
  assert.equal(result.changeCount, 0);
  assert.equal(result.versionChanged, true);
  assert.equal(result.previousVersion, "1.0");
  assert.equal(result.currentVersion, "2.0");

  const app = db
    .prepare("SELECT currentVersion, changeCount FROM apps WHERE id = ?")
    .get("2007") as { changeCount: number; currentVersion: string };
  assert.equal(app.currentVersion, "2.0");
  assert.equal(app.changeCount, 0);

  const latestSnapshot = db
    .prepare(`
    SELECT changes_detected, changes_summary, app_version
    FROM privacy_snapshots
    WHERE app_id = ?
    ORDER BY scraped_at DESC
    LIMIT 1
  `)
    .get("2007") as {
    app_version: string | null;
    changes_detected: number;
    changes_summary: string | null;
  };
  assert.equal(latestSnapshot.changes_detected, 0);
  assert.equal(latestSnapshot.changes_summary, "[]");
  assert.equal(latestSnapshot.app_version, "2.0");

  const notification = db
    .prepare("SELECT change_summary FROM notifications WHERE app_id = ?")
    .get("2007") as { change_summary: string };
  assert.match(notification.change_summary, /version_update/);
  assert.match(notification.change_summary, /v1\.0 to v2\.0/);

  const activity = db
    .prepare(`
    SELECT summary, detail
    FROM activity_log
    WHERE app_id = ? AND type = 'resync'
    ORDER BY started_at DESC
    LIMIT 1
  `)
    .get("2007") as { detail: string; summary: string };
  assert.match(activity.summary, /Version updated from v1\.0 to v2\.0/);
  assert.equal(JSON.parse(activity.detail).versionChanged, true);
});

test("privacyHeader legacy purposes are flattened into privacy categories", async () => {
  installScraperFetchMock({
    appHtml: appStoreHtml({
      id: "2002",
      name: "Legacy Header Fixture",
      shelfMapping: {
        privacyHeader: {
          seeAllAction: {
            pageData: {
              shelves: [
                {
                  contentType: "privacyType",
                  items: [
                    {
                      identifier: "DATA_LINKED_TO_YOU",
                      title: "Data Linked to You",
                      purposes: [
                        {
                          categories: [
                            { identifier: "CONTACTS", title: "Contacts" },
                          ],
                        },
                        {
                          categories: [
                            { identifier: "CONTACTS", title: "Contacts" },
                            { identifier: "IDENTIFIERS", title: "Identifiers" },
                          ],
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
    }),
  });

  await fetchAndParseApp(
    "https://apps.apple.com/us/app/header-fixture/id2002",
    false,
    false,
    "import"
  );
  const app = getAppWithPrivacy("2002") as AppWithPrivacy;
  const categories = app.privacyTypes[0].categories
    .map((category) => category.identifier)
    .sort();
  assert.deepEqual(categories, ["CONTACTS", "IDENTIFIERS"]);
});

test("generic pageData privacy shelves are parsed as final fallback", async () => {
  installScraperFetchMock({
    appHtml: appStoreHtml({
      id: "2003",
      name: "Page Data Fixture",
      pageData: {
        shelves: [
          {
            contentType: "privacyType",
            items: [
              privacyType("DATA_NOT_LINKED_TO_YOU", "Data Not Linked to You", [
                ["DIAGNOSTICS", "Diagnostics"],
              ]),
            ],
          },
        ],
      },
    }),
  });

  await fetchAndParseApp(
    "https://apps.apple.com/us/app/page-data-fixture/id2003",
    false,
    false,
    "import"
  );
  const app = getAppWithPrivacy("2003") as AppWithPrivacy;
  assert.equal(app.privacyTypes[0].identifier, "DATA_NOT_LINKED_TO_YOU");
  assert.deepEqual(
    app.privacyTypes[0].categories.map((category) => category.identifier),
    ["DIAGNOSTICS"]
  );
});

test("No Details Provided pages store an explicit empty privacy-label state", async () => {
  installScraperFetchMock({
    appHtml: appStoreHtml({
      id: "2004",
      name: "No Details Fixture",
      shelfMapping: {},
      extraBody:
        "No Details Provided. The developer will be required to provide privacy details when they submit their next app update.",
    }),
  });

  await fetchAndParseApp(
    "https://apps.apple.com/us/app/no-details-fixture/id2004",
    false,
    false,
    "import"
  );
  const app = getAppWithPrivacy("2004") as AppWithPrivacy;
  assert.equal(app.hasPrivacyDetails, 0);
  assert.equal(app.privacyTypes.length, 0);
});

test("older App Store HTML with raw array payload and single-quoted script id is parsed", async () => {
  const payload = [
    {
      data: {
        title: "Raw Array Fixture",
        shelfMapping: {
          privacyTypes: {
            items: [
              privacyType("DATA_USED_TO_TRACK_YOU", "Data Used to Track You", [
                ["IDENTIFIERS", "Identifiers"],
              ]),
            ],
          },
        },
      },
    },
  ];

  installScraperFetchMock({
    appHtml: appStoreHtml({
      id: "2005",
      name: "Raw Array Fixture",
      rawPayload: payload,
      scriptIdQuote: "'",
    }),
  });

  await fetchAndParseApp(
    "https://apps.apple.com/us/app/raw-array-fixture/id2005",
    false,
    false,
    "import"
  );
  const app = getAppWithPrivacy("2005") as AppWithPrivacy;
  assert.equal(app.privacyTypes[0].identifier, "DATA_USED_TO_TRACK_YOU");
  assert.deepEqual(
    app.privacyTypes[0].categories.map((category) => category.identifier),
    ["IDENTIFIERS"]
  );
});

test("curly-apostrophe privacy policy link is extracted and sanitised", async () => {
  installScraperFetchMock({
    appHtml: appStoreHtml({
      id: "2006",
      name: "Policy Link Fixture",
      privacyItems: [],
      extraBody:
        '<a href="https://example.com/privacy" aria-label="Developer’s Privacy Policy">Privacy Policy</a>',
    }),
  });

  await fetchAndParseApp(
    "https://apps.apple.com/us/app/policy-link-fixture/id2006",
    false,
    false,
    "import"
  );
  const app = getAppWithPrivacy("2006") as AppWithPrivacy;
  assert.equal(app.privacyPolicyUrl, "https://example.com/privacy");
});

interface AppWithPrivacy {
  hasPrivacyDetails: number | null;
  privacyPolicyUrl?: string | null;
  privacyTypes: Array<{
    identifier: string;
    categories: Array<{ identifier: string }>;
  }>;
}

function installScraperFetchMock(input: {
  appHtml: string;
  releaseDate?: string;
  version?: string;
}) {
  global.fetch = (async (raw: string | URL | Request) => {
    const url = String(raw);
    if (url.startsWith("https://apps.apple.com/")) {
      return new Response(input.appHtml, {
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
              version: input.version ?? "1.0",
              currentVersionReleaseDate:
                input.releaseDate ?? "2026-01-01T00:00:00Z",
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
    throw new Error(`Unexpected fetch: ${url}`);
  }) as typeof fetch;
}

function privacyType(
  identifier: string,
  title: string,
  categories: [string, string][]
) {
  return {
    identifier,
    title,
    detail: "",
    categories: categories.map(([categoryId, categoryTitle]) => ({
      identifier: categoryId,
      title: categoryTitle,
    })),
  };
}

function appStoreHtml(input: {
  id: string;
  name: string;
  privacyItems?: unknown[];
  shelfMapping?: Record<string, unknown>;
  pageData?: Record<string, unknown>;
  extraBody?: string;
  rawPayload?: unknown;
  scriptIdQuote?: '"' | "'";
}): string {
  const shelfMapping = input.shelfMapping ?? {
    privacyTypes: { items: input.privacyItems ?? [] },
  };
  const payload = input.rawPayload ?? {
    data: [
      {
        data: {
          title: input.name,
          shelfMapping,
          ...(input.pageData ? { pageData: input.pageData } : {}),
        },
      },
    ],
  };
  const quote = input.scriptIdQuote ?? '"';
  return `<!doctype html>
    <meta property="og:title" content="${input.name} on the App Store">
    <meta property="og:image" content="https://example.com/icon-${input.id}.png">
    <script type="application/ld+json">{"author":{"@type":"Organization","name":"Fixture Developer"}}</script>
    <script type="application/json" id=${quote}serialized-server-data${quote}>${JSON.stringify(payload)}</script>
    ${input.extraBody ?? ""}`;
}
