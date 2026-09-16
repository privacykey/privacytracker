/**
 * Page-parse oracle for the Rust scraper (Phase 3, batch 1).
 *
 * Runs the REAL `fetchAndParseApp` from lib/scraper.ts against synthetic
 * App Store pages with a stubbed `fetch` — never the network — on a fresh
 * database per case, then projects what the page alone determined out of
 * the rows it wrote: the apps row's page-derived columns, the privacy
 * types/categories in insertion order, the exact `snapshot_json` string,
 * the accessibility features and the observed related-app shelves. Cases
 * that make Node throw record the error message instead.
 *
 * Only page-derived values are projected. Version/price/genre come from
 * the iTunes lookup (batch 3), and everything about change detection,
 * notifications and re-syncs is the persist batch's oracle (batch 2).
 *
 * core/src/scrape/tests.rs replays every case; CI regenerates this file
 * and fails on drift, so a parser change in lib/scraper.ts must land with
 * its Rust port.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "pt-scrape-oracle-"));
process.env.PRIVACYTRACKER_DATA_DIR = dir;
process.env.PRIVACYTRACKER_BIND_HOST = "127.0.0.1";
process.env.PRIVACYTRACKER_SKIP_DNS_REBINDING_CHECK_FOR_TESTS = "1";
process.env.NEXT_PHASE = "phase-test";
// Keep the bulk write on this connection so each case's rows are visible
// here and a table wipe between cases is complete.
process.env.WORKER_DISABLED = "1";
delete process.env.AUDITOR_ADMIN_TOKEN;
let now = Date.UTC(2026, 8, 15, 12);
const RealDate = Date;
globalThis.Date = class extends RealDate {
  constructor(...a) {
    super(...(a.length ? a : [now]));
  }
  static now() {
    return now;
  }
};
const { default: db } = await import("../../lib/db.ts");
const { fetchAndParseApp } = await import("../../lib/scraper.ts");
const { _resetSoftBuckets, clearRateLimit } = await import(
  "../../lib/rate-limit.ts"
);
db.pragma("foreign_keys = OFF");
const tables = db
  .prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
  )
  .all()
  .map((r) => r.name);
const wipe = () => {
  for (const name of tables) {
    db.exec(`DELETE FROM "${name}"`);
  }
};

const LOOKUP = {
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
      contentAdvisoryRating: "4+",
    },
  ],
};

// ── Page builders ────────────────────────────────────────────────────
const og = (title, image = "https://example.com/icon.png") =>
  `${title === null ? "" : `<meta property="og:title" content="${title}">`}${image === null ? "" : `<meta property="og:image" content="${image}">`}`;
const author = (name) =>
  `<script type="application/ld+json">{"author":{"@type":"Organization","name":"${name}"}}</script>`;
const page = ({
  head = "",
  body = "",
  blob,
  attrs = 'id="serialized-server-data" type="application/json"',
  close = "</script>",
} = {}) =>
  `<!doctype html><html><head>${head}</head><body>${body}${
    blob === undefined
      ? ""
      : `<script ${attrs}>${typeof blob === "string" ? blob : JSON.stringify(blob)}${close}`
  }</body></html>`;
const wrap = (data) => ({ data, userTokenHash: "fixture" });
const app = (title, shelfMapping, extra = {}) =>
  wrap([
    {
      data: {
        ...(title === undefined ? {} : { title }),
        ...(shelfMapping === undefined ? {} : { shelfMapping }),
        ...extra,
      },
    },
  ]);
const escapeHtml = (s) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
const shoebox = (id, body) =>
  `<script type="fastboot/shoebox" id="${id}">${body}</script>`;
const cat = (identifier, title) => ({ identifier, title });
const TYPES = [
  {
    identifier: "DATA_USED_TO_TRACK_YOU",
    title: "Data Used to Track You",
    detail: "Fixture tracking data",
    categories: [cat("LOCATION", "Location")],
  },
  {
    identifier: "DATA_LINKED_TO_YOU",
    title: "Data Linked to You",
    detail: "Fixture linked data",
    categories: [
      cat("CONTACT_INFO", "Contact Info"),
      cat("IDENTIFIERS", "Identifiers"),
    ],
  },
  {
    identifier: "DATA_NOT_LINKED_TO_YOU",
    title: "Data Not Linked to You",
    detail: "Fixture unlinked data",
    categories: [cat("DIAGNOSTICS", "Diagnostics")],
  },
];
const related = (n, over = {}) => ({
  id: 90_000_100 + n,
  name: `Related ${n}`,
  url: `https://apps.apple.com/us/app/related-${n}/id${90_000_100 + n}`,
  artistName: `Dev ${n}`,
  artwork: { url: `https://example.com/${n}/{w}x{h}bb.png` },
  ...over,
});

// ── Case runner ──────────────────────────────────────────────────────
const cases = [];
const quiet = ["error", "warn", "info", "log"];
async function run(name, url, html, { lookup = LOOKUP } = {}) {
  now += 61_000;
  wipe();
  _resetSoftBuckets();
  clearRateLimit("scrape");
  const calls = [];
  globalThis.fetch = async (input, init) => {
    const target = String(input);
    calls.push({ url: target, headers: [...new Headers(init?.headers)] });
    if (target === url) {
      return new Response(html, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    if (target.startsWith("https://itunes.apple.com/lookup?")) {
      return new Response(JSON.stringify(lookup), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`Unexpected fetch in ${name}: ${target}`);
  };
  const saved = quiet.map((k) => [k, console[k]]);
  for (const k of quiet) {
    console[k] = () => {};
  }
  let expected;
  try {
    const result = await fetchAndParseApp(url, false, false, "import");
    expected = {
      ok: true,
      id: result.id,
      name: result.name,
      ...project(result.id),
    };
  } catch (error) {
    expected = { ok: false, error: error.message };
  } finally {
    for (const [k, fn] of saved) {
      console[k] = fn;
    }
  }
  cases.push({ name, url, html, calls, expected });
}
function project(id) {
  const app = db
    .prepare(
      "SELECT name, url, iconUrl, developer, privacyPolicyUrl, hasPrivacyDetails, hasIap, hasAccessibilityLabels FROM apps WHERE id = ?"
    )
    .get(id);
  const privacyItems = db
    .prepare(
      "SELECT id, identifier, title, detail FROM privacy_types WHERE app_id = ? ORDER BY rowid"
    )
    .all(id)
    .map((t) => ({
      identifier: t.identifier,
      title: t.title,
      detail: t.detail,
      categories: db
        .prepare(
          "SELECT identifier, title FROM privacy_categories WHERE type_id = ? ORDER BY rowid"
        )
        .all(t.id),
    }));
  const snapshot = db
    .prepare("SELECT snapshot_json FROM privacy_snapshots WHERE app_id = ?")
    .get(id).snapshot_json;
  const accessibilityFeatures =
    app.hasAccessibilityLabels === null
      ? null
      : db
          .prepare(
            "SELECT identifier, title, description, icon_template AS iconTemplate FROM accessibility_features WHERE app_id = ? ORDER BY rowid"
          )
          .all(id);
  const relatedApps = db
    .prepare(
      "SELECT related_apple_id AS relatedAppleId, related_name AS relatedName, related_developer AS relatedDeveloper, related_icon_url AS relatedIconUrl, related_store_url AS relatedStoreUrl, shelf_type AS shelfType FROM related_apps_observed WHERE source_app_id = ? ORDER BY rowid"
    )
    .all(id);
  return { app, privacyItems, snapshot, accessibilityFeatures, relatedApps };
}

const URL_OF = (slug, id) => `https://apps.apple.com/us/app/${slug}/id${id}`;
const STRAIGHT = (href) =>
  `<div id="notPurchasedLinks"><a aria-label="Developer's Privacy Policy" href="${href}">Privacy Policy</a></div>`;

try {
  // 1. The Clock fixture from tests/app/scraper-fixture.test.ts, verbatim.
  await run(
    "clock modern page",
    URL_OF("clock", 1584215688),
    page({
      head: `${og("Clock on the App Store", "https://example.com/clock.png")}${author("Apple")}`,
      body: STRAIGHT("https://www.apple.com/legal/privacy/"),
      blob: app("Clock", {
        privacyTypes: { items: TYPES },
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
      }),
    })
  );

  // 2. Every modern shelf at once: related-app shelves, the IAP shelf, the
  //    rich accessibility variant, and items the normaliser must filter.
  await run(
    "modern shelves related apps and iap shelf",
    URL_OF("instagram", 389801252),
    page({
      head: `${og("Instagram App - App Store")}${author("Instagram, Inc.")}`,
      body: `<a class="link" href="https://help.instagram.com/privacy" aria-label="Developer’s Privacy Policy">Privacy Policy</a>`,
      blob: app("Instagram", {
        privacyTypes: {
          items: [
            null,
            7,
            { identifier: 5, title: "numeric identifier is dropped" },
            { identifier: "NO_TITLE", categories: [] },
            {
              identifier: "DATA_LINKED_TO_YOU",
              title: "Data Linked to You",
              detail: 9,
              categories: [
                null,
                cat("A", 3),
                cat("CONTACT_INFO", "Contact Info"),
                cat("CONTACT_INFO", "Contact Info (duplicate)"),
                cat(4, "numeric identifier"),
                cat("IDENTIFIERS", "Identifiers"),
              ],
            },
            {
              identifier: "DATA_NOT_LINKED_TO_YOU",
              title: "Data Not Linked to You",
              categories: null,
            },
          ],
        },
        inAppPurchases: { items: [{ title: "Pro" }, { title: "Pro+" }] },
        accessibilityHeader: {
          seeAllAction: {
            pageData: {
              shelves: [
                {
                  contentType: "other",
                  items: [{ features: [{ title: "Ignored" }] }],
                },
                {
                  contentType: "accessibilityFeatures",
                  items: [
                    { notFeatures: [] },
                    {
                      features: [
                        {
                          title: "VoiceOver",
                          description: "Spoken feedback.",
                          artwork: { template: "systemimage://voiceover" },
                        },
                        {
                          title: "Captions ",
                          description: "  ",
                          artwork: { template: "" },
                        },
                        { title: "captions", description: "duplicate slug" },
                        { title: "   " },
                        { title: 12 },
                        null,
                        {
                          title: "Larger Text",
                          description: "Scales",
                          artwork: {},
                        },
                      ],
                    },
                    { features: [{ title: "Second item is never read" }] },
                  ],
                },
              ],
            },
          },
        },
        customersAlsoBoughtAppsCollection: {
          items: [
            ...Array.from({ length: 12 }, (_, i) => related(i + 1)),
            related(99),
          ],
        },
        moreByThisDeveloperCollection: {
          seeAllAction: {
            pageData: {
              shelves: [
                {
                  items: [
                    related(201, {
                      artistName: "",
                      subtitle: "Sub Dev",
                      artwork: {
                        template: "https://example.com/t/{w}x{h}.png",
                      },
                    }),
                  ],
                },
                { notItems: true },
                {
                  items: [
                    related(202, {
                      id: undefined,
                      appleId: 90_000_302,
                      url: undefined,
                      appLink: "https://apps.apple.com/app/id90000302",
                    }),
                  ],
                },
              ],
            },
          },
        },
      }),
    })
  );

  // 3. The privacyHeader fallback with nested purposes → categories.
  await run(
    "privacy header nested purposes",
    URL_OF("todoist", 572688855),
    page({
      head: `${og("Todoist: To-Do List & Planner - App Store")}${author("Doist Inc.")}`,
      body: `<div id="notPurchasedLinks"><a class="we-link" href="https://doist.com/privacy">Privacy Policy</a></div>`,
      blob: app(
        undefined,
        {
          privacyHeader: {
            seeAllAction: {
              pageData: {
                shelves: [
                  {
                    contentType: "other",
                    items: [
                      {
                        identifier: "IGNORED",
                        title: "Ignored",
                        categories: [cat("X", "x")],
                      },
                    ],
                  },
                  {
                    contentType: "privacyType",
                    items: [
                      {
                        identifier: "DATA_LINKED_TO_YOU",
                        title: "Data Linked to You",
                        detail: "Linked detail",
                        purposes: [
                          {
                            categories: [
                              cat("CONTACT_INFO", "Contact Info"),
                              cat("LOCATION", "Location"),
                            ],
                          },
                          {
                            categories: [
                              cat("LOCATION", "Location (second purpose)"),
                              cat("PURCHASES", "Purchases"),
                            ],
                          },
                          { categories: null },
                        ],
                      },
                      {
                        identifier: "DATA_NOT_LINKED_TO_YOU",
                        title: "Data Not Linked to You",
                        categories: [cat("DIAGNOSTICS", "Diagnostics")],
                        purposes: [
                          { categories: [cat("IGNORED_PURPOSE", "ignored")] },
                        ],
                      },
                      {
                        identifier: "EMPTY",
                        title: "Neither categories nor purposes",
                      },
                    ],
                  },
                ],
              },
            },
          },
          accessibilityFeatures: {
            items: [
              {
                features: [{ title: "VoiceOver" }, { title: "Switch Control" }],
              },
            ],
          },
        },
        {
          additionalAttributes: {
            attributes: [{ attributeKey: "in_app_purchases", value: false }],
          },
        }
      ),
    })
  );

  // 4. Generic pageData shelves, the header-only accessibility signal, the
  //    HTML badge scan for IAP and the last-resort policy link.
  await run(
    "generic page data shelves",
    URL_OF("weather", 1069513131),
    page({
      head: og("Weather on the App Store"),
      body: `<p>Offers In-App Purchases</p><a class="link" href="https://weather.example/privacy">Privacy Policy</a>`,
      blob: app(
        undefined,
        { accessibilityHeader: {} },
        {
          pageData: {
            shelves: [
              { contentType: "privacyType", items: [TYPES[0]] },
              { contentType: "privacyType", items: null },
              { contentType: "privacyType", items: [TYPES[1], TYPES[2]] },
              {
                contentType: "other",
                items: [{ identifier: "IGNORED", title: "Ignored" }],
              },
            ],
          },
        }
      ),
    })
  );

  // 5. Historical shoebox, media-api-cache shape (JSON-string values).
  await run(
    "shoebox media api cache",
    URL_OF("whatsapp-messenger", 310633997),
    page({
      head: `${shoebox("shoebox-language-code", '"en-US"')}${shoebox(
        "shoebox-media-api-cache-apps",
        escapeHtml(
          JSON.stringify({
            "fixture.cache.key.us.apps.not-json": "{not json",
            "fixture.cache.key.us.apps.no-privacy": JSON.stringify({
              d: [{ attributes: { name: "No privacy" } }],
            }),
            "fixture.cache.key.us.apps.310633997": JSON.stringify({
              d: [
                {
                  attributes: {
                    name: "WhatsApp Messenger",
                    privacy: {
                      privacyTypes: [
                        {
                          identifier: "DATA_LINKED_TO_YOU",
                          privacyType: "Data Linked to You",
                          dataCategories: [
                            {
                              identifier: "PURCHASES",
                              dataCategory: "Purchases",
                            },
                            {
                              identifier: 7,
                              dataCategory: "numeric identifier",
                            },
                            {
                              identifier: "LOCATION",
                              title: "Location via title",
                            },
                            { identifier: "USAGE_DATA" },
                          ],
                        },
                        {
                          identifier: "DATA_NOT_LINKED_TO_YOU",
                          title: "Title fallback",
                        },
                        { identifier: "DATA_USED_TO_TRACK_YOU" },
                        "not an object",
                        { privacyType: "No identifier" },
                      ],
                    },
                  },
                },
              ],
            }),
          })
        )
      )}`,
      blob: wrap([{ data: { title: "WhatsApp Messenger" } }]),
    })
  );

  // 6. Historical shoebox, ember-data-store shape (plain objects keyed by id),
  //    reached only after a media-api candidate with unparseable JSON.
  await run(
    "shoebox ember data store",
    URL_OF("signal", 874139669),
    page({
      head: `${shoebox("shoebox-media-api-cache-apps", "{&quot;broken&quot;: ")}${shoebox(
        "shoebox-ember-data-store",
        escapeHtml(
          JSON.stringify({
            "apps.874139669": {
              data: {
                attributes: {
                  privacy: {
                    privacyTypes: [
                      {
                        identifier: "DATA_NOT_LINKED_TO_YOU",
                        privacyType: "Data Not Linked to You",
                        dataCategories: [
                          {
                            identifier: "CONTACT_INFO",
                            dataCategory: "Contact Info",
                          },
                        ],
                      },
                    ],
                  },
                },
              },
            },
          })
        )
      )}`,
      blob: [{ data: { title: "Signal - Private Messenger" } }],
    })
  );

  // 7. Apple's "No Details Provided" copy, the U+2011 IAP row, and the
  //    aria-label link with href after the label.
  await run(
    "no details provided",
    URL_OF("newapp", 6450000001),
    page({
      head: `${og("NewApp on the App Store")}${author("New Dev")}`,
      body: `<h2>No Details Provided</h2><p>The developer will be required to provide privacy details when they submit their next app update.</p><a aria-label="Developer’s Privacy Policy" class="link" href="https://newapp.example/privacy">Privacy Policy</a>`,
      blob: app("NewApp", {
        information: {
          items: [{ title: "Size" }, { title: "In‑App Purchases" }],
        },
      }),
    })
  );

  // 8/9. The two hard failures of the JSON extraction.
  await run(
    "no serialized script",
    URL_OF("broken", 1000000001),
    page({ head: og("Broken on the App Store"), body: "<p>nothing here</p>" })
  );
  await run(
    "unparseable serialized json",
    URL_OF("broken", 1000000002),
    page({ head: og("Broken on the App Store"), blob: "{not json" })
  );

  // 10. Plain-array payload, single-quoted id, spaced closing tag, and a
  //     decoy script whose id only starts with the real one. The og:title
  //     needs the "App - App Store" strip, and its order matters.
  await run(
    "plain array payload and attribute variants",
    URL_OF("signal-private-messenger", 874139670),
    page({
      head: `${og("Signal - Private Messenger App - App Store")}<script id="serialized-server-data-v2">{"data":[{"data":{"title":"Decoy"}}]}</script>`,
      blob: [
        {
          data: {
            shelfMapping: { privacyTypes: { items: TYPES.slice(0, 1) } },
          },
        },
      ],
      attrs: `type="application/json" id='serialized-server-data' data-x="1"`,
      close: "</script >",
    })
  );

  // 11. Related-shelf key fallback, nested shelves, the id/name/url rules,
  //     and a non-array IAP shelf that must fall through.
  await run(
    "related shelf fallbacks and iap shelf without items",
    URL_OF("fallbacks", 1000000003),
    page({
      head: og("Fallbacks on the App Store"),
      blob: app("Fallbacks", {
        privacyTypes: { items: TYPES.slice(1, 2) },
        inAppPurchases: { items: "not an array" },
        customersAlsoBoughtAppsCollection: { items: [] },
        customersAlsoBoughtApps: {
          items: [
            related(1, { id: 0 }),
            related(2, { id: null, appleId: null, adamId: "77" }),
            related(3, { id: null }),
            related(4, { name: "", title: " Titled " }),
            related(5, { name: "   " }),
            related(6, {
              url: "",
              appLink: "",
              storeUrl: "",
              attributes: {
                url: "https://apps.apple.com/app/id90000106",
                artistName: "Attr Dev",
              },
              artistName: "",
              developerName: "",
              subtitle: "",
            }),
            related(7, { url: "  " }),
            related(8, {
              artwork: "https://not-an-object",
              iconUrl: "https://example.com/8.png",
            }),
            related(9, {
              artwork: {},
              imageUrl: "https://example.com/9.png",
              artistName: 5,
              developerName: "Dev Name 9",
            }),
            related(10, { id: true }),
            related(11, { id: [1, 2] }),
            related(12, { id: { nested: true } }),
          ],
        },
        moreByDeveloper: {
          seeAllAction: {
            pageData: {
              shelves: [
                { items: [related(301)] },
                { items: "not iterable" },
                { items: [related(302)] },
              ],
            },
          },
        },
      }),
    })
  );

  // 12. The normaliser is NOT inside the try/catch: a non-iterable
  //     `categories` on a modern item escapes as a hard error, with V8's
  //     type-specific message.
  for (const [label, categories] of [
    ["number", 5],
    ["object", {}],
    ["boolean", true],
  ]) {
    await run(
      `categories not iterable ${label}`,
      URL_OF("hard-error", 1000000004),
      page({
        head: og("Hard Error on the App Store"),
        blob: app("Hard Error", {
          privacyTypes: {
            items: [{ identifier: "T", title: "t", categories }],
          },
        }),
      })
    );
  }

  // 13. The header chain throws midway: what was pushed stays, the later
  //     fallbacks are skipped even though the snapshot would be fuller.
  await run(
    "header chain throws after first item",
    URL_OF("partial", 1000000005),
    page({
      head: og("Partial on the App Store"),
      blob: app(
        "Partial",
        {
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
                        categories: [cat("CONTACT_INFO", "Contact Info")],
                      },
                      {
                        identifier: "DATA_USED_TO_TRACK_YOU",
                        title: "Tracking",
                        purposes: [{ categories: [null] }],
                      },
                      {
                        identifier: "DATA_NOT_LINKED_TO_YOU",
                        title: "Never reached",
                        categories: [cat("DIAGNOSTICS", "Diagnostics")],
                      },
                    ],
                  },
                ],
              },
            },
          },
        },
        {
          pageData: { shelves: [{ contentType: "privacyType", items: TYPES }] },
        }
      ),
    })
  );

  // 14. The header chain throws on its first item: nothing accumulated, and
  //     the pageData fallback below is still skipped — yet the details flag
  //     reads the same shelf and says 1.
  await run(
    "header chain throws on first item",
    URL_OF("partial-empty", 1000000006),
    page({
      head: og("Partial Empty on the App Store"),
      blob: app(
        "Partial Empty",
        {
          privacyHeader: {
            seeAllAction: {
              pageData: {
                shelves: [
                  { contentType: "privacyType", items: [null, TYPES[0]] },
                ],
              },
            },
          },
        },
        {
          pageData: { shelves: [{ contentType: "privacyType", items: TYPES }] },
        }
      ),
    })
  );

  // 15. The pageData spread throws after a partial push.
  await run(
    "page data spread throws after partial push",
    URL_OF("partial-page-data", 1000000007),
    page({
      head: og("Partial Page Data on the App Store"),
      blob: app(
        "Partial Page Data",
        {},
        {
          pageData: {
            shelves: [
              { contentType: "privacyType", items: [TYPES[0]] },
              { contentType: "privacyType", items: 5 },
              { contentType: "privacyType", items: [TYPES[1]] },
            ],
          },
        }
      ),
    })
  );

  // 16. A wrapped payload with no `data` at all.
  await run(
    "wrapped payload without data",
    URL_OF("unknown-thing", 1000000008),
    page({
      head: og("Unknown Thing on the App Store"),
      blob: { userTokenHash: "x" },
    })
  );

  // 17. JavaScript trim and slug rules on non-ASCII input.
  await run(
    "unicode trims and slugs",
    URL_OF("notes", 1110145103),
    page({
      head: og(" Notes on the App Store"),
      blob: app(" Notes﻿ ", {
        privacyTypes: {
          items: [
            {
              identifier: "DATA_LINKED_TO_YOU",
              title: " Data Linked to You ",
              categories: [cat("CONTACT_INFO", " Contact Info ")],
            },
          ],
        },
        accessibilityFeatures: {
          items: [
            {
              features: [
                { title: "Zoom‑In" },
                { title: "Éclair Mode", description: " " },
                { title: " Captions ", description: " Shows captions " },
                { title: "A".repeat(70) },
                { title: "İstanbul Kit" },
                { title: " ﻿" },
              ],
            },
          ],
        },
        customersAlsoBoughtApps: {
          items: [
            related(1, { name: " Foo ", artistName: "", subtitle: " Dev﻿" }),
          ],
        },
      }),
    })
  );

  // 18. `privacyTypes.items` is a string: truthy length, iterates characters.
  await run(
    "privacy types items is a string",
    URL_OF("stringy", 1000000009),
    page({
      head: og("Stringy on the App Store"),
      blob: app("Stringy", { privacyTypes: { items: "abc" } }),
    })
  );

  // 19. `privacyTypes.items` is an object with a truthy length: it survives
  //     the chain (nothing else runs) and the normaliser's own `for…of`
  //     throws — with V8's identifier-rendered message this time.
  await run(
    "privacy types items is an object with length",
    URL_OF("lengthy", 1000000011),
    page({
      head: og("Lengthy on the App Store"),
      blob: app("Lengthy", { privacyTypes: { items: { length: 1 } } }),
    })
  );

  // 20. A truthy non-string JSON title is a hard error too (`.trim()`).
  await run(
    "json title is a number",
    URL_OF("numeric-title", 1000000012),
    page({
      head: og("Numeric on the App Store"),
      blob: app(5, { privacyTypes: { items: TYPES.slice(0, 1) } }),
    })
  );

  // 21. No og:title and no JSON title.
  await run(
    "unknown app name",
    URL_OF("nameless", 1000000010),
    page({
      head: og(null, null),
      blob: app(undefined, { privacyTypes: { items: TYPES.slice(2) } }),
    })
  );

  // 22. A shoebox candidate whose JSON is `null` ends the whole extraction
  //     (`Object.values(null)` throws inside the one catch), even with a
  //     good candidate after it.
  await run(
    "shoebox null candidate aborts",
    URL_OF("null-shoebox", 1000000013),
    page({
      head: `${shoebox("shoebox-media-api-cache-apps", "null")}${shoebox(
        "shoebox-ember-data-store",
        escapeHtml(
          JSON.stringify({
            "apps.1": {
              data: {
                attributes: {
                  privacy: {
                    privacyTypes: [
                      {
                        identifier: "DATA_LINKED_TO_YOU",
                        privacyType: "Data Linked to You",
                        dataCategories: [
                          {
                            identifier: "CONTACT_INFO",
                            dataCategory: "Contact Info",
                          },
                        ],
                      },
                    ],
                  },
                },
              },
            },
          })
        )
      )}`,
      blob: wrap([{ data: { title: "Null Shoebox" } }]),
    })
  );

  // 23. A serialized payload of `null`: `.data` on null throws inside the
  //     same catch as malformed JSON.
  await run(
    "serialized json is null",
    URL_OF("null-json", 1000000014),
    page({ head: og("Null on the App Store"), blob: "null" })
  );

  // 24. `raw.data` is a string: indexing it yields characters, not records.
  await run(
    "wrapped data is a string",
    URL_OF("stringy-data", 1000000015),
    page({ head: og("Stringy Data on the App Store"), blob: { data: "abc" } })
  );

  // 25. `raw.data` is an object keyed by index: `data[0]` reads key "0".
  await run(
    "wrapped data is an object keyed by index",
    URL_OF("keyed-data", 1000000016),
    page({
      head: og("Keyed on the App Store"),
      blob: {
        data: {
          0: {
            data: {
              title: "Keyed",
              shelfMapping: { privacyTypes: { items: TYPES.slice(0, 1) } },
            },
          },
        },
      },
    })
  );

  writeFileSync(
    new URL("../tests/fixtures/scrape-cases.json", import.meta.url),
    `${JSON.stringify({ cases }, null, 2)}\n`
  );
  console.log(
    `Recorded ${cases.length} actual Node page-parse cases from fetchAndParseApp; no network.`
  );
} finally {
  db.close();
  rmSync(dir, { recursive: true, force: true });
}
