/**
 * Tests for `extractFromShoebox` — the historical Ember/FastBoot fallback
 * the scraper uses to parse apps.apple.com HTML from Jan 2021 to the
 * Nov 2025 redesign.
 *
 *     <script type="fastboot/shoebox" id="shoebox-media-api-cache-apps">
 *       {"<cache-key>": "<json-string>"}
 *     </script>
 *     decoded → d[0].attributes.privacy.privacyTypes[]
 *
 * The historical schema renames `privacyType` / `dataCategories` /
 * `dataCategory` to `title` / `categories` / `title` versus the modern
 * serialized-server-data shape; these tests pin the rename.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { extractFromShoebox } from "../../lib/scraper";

/**
 * Build a single shoebox blob mimicking the on-disk shape Apple's pages
 * shipped through the historical era. The outer object is keyed by
 * Apple's API request URLs (the `…` cache-key sentinel); the inner
 * value is a JSON-encoded *string* (Ember's shoebox writes nested JSON
 * as escaped strings, not objects). We mimic that here so the tests
 * exercise the same decode path the scraper takes against real captures.
 */
function buildShoeboxHtml(privacyTypes: unknown[]): string {
  const innerPayload = JSON.stringify({
    d: [
      {
        attributes: {
          name: "Fixture App",
          privacy: { privacyTypes },
        },
      },
    ],
  });
  const outerPayload = JSON.stringify({
    "fixture.cache.key.us.apps.310633997": innerPayload,
  });
  // Ember writes the shoebox body HTML-escaped; mirror that so the
  // extractor's decode step is exercised.
  const escaped = outerPayload
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<!doctype html>
    <html>
      <head>
        <script id="perfkit">/* unrelated */</script>
        <script type="fastboot/shoebox" id="shoebox-language-code">"en-US"</script>
        <script type="fastboot/shoebox" id="shoebox-media-api-cache-apps">${escaped}</script>
      </head>
      <body><!-- rendered DOM omitted --></body>
    </html>`;
}

test("extractFromShoebox returns three privacy types with renamed fields", () => {
  const html = buildShoeboxHtml([
    {
      identifier: "DATA_USED_TO_TRACK_YOU",
      privacyType: "Data Used to Track You",
      description: "Tracking data",
      dataCategories: [
        { identifier: "IDENTIFIERS", dataCategory: "Identifiers" },
      ],
    },
    {
      identifier: "DATA_LINKED_TO_YOU",
      privacyType: "Data Linked to You",
      description: "Linked data",
      dataCategories: [
        { identifier: "CONTACT_INFO", dataCategory: "Contact Info" },
        { identifier: "LOCATION", dataCategory: "Location" },
      ],
    },
    {
      identifier: "DATA_NOT_LINKED_TO_YOU",
      privacyType: "Data Not Linked to You",
      description: "Unlinked data",
      dataCategories: [
        { identifier: "DIAGNOSTICS", dataCategory: "Diagnostics" },
      ],
    },
  ]);

  const items = extractFromShoebox(html);

  assert.equal(items.length, 3, "all three privacy types parsed");

  // Field-renames: privacyType → title, dataCategories → categories,
  // dataCategory → category.title. Extractor output must match what
  // normalizePrivacyItems consumes on the modern path.
  assert.equal(items[0].identifier, "DATA_USED_TO_TRACK_YOU");
  assert.equal(items[0].title, "Data Used to Track You");
  assert.equal(items[0].categories.length, 1);
  assert.equal(items[0].categories[0].identifier, "IDENTIFIERS");
  assert.equal(items[0].categories[0].title, "Identifiers");

  assert.equal(items[1].identifier, "DATA_LINKED_TO_YOU");
  assert.equal(items[1].categories.length, 2);
  assert.equal(items[1].categories[0].identifier, "CONTACT_INFO");
  assert.equal(items[1].categories[1].identifier, "LOCATION");

  // Order preservation — the timeline UI renders items in array order.
  assert.deepEqual(
    items.map((t) => t.identifier),
    ["DATA_USED_TO_TRACK_YOU", "DATA_LINKED_TO_YOU", "DATA_NOT_LINKED_TO_YOU"]
  );
});

test("extractFromShoebox handles a single-type single-category capture", () => {
  // Minimal capture (one type, one category) — mirrors the actual WhatsApp
  // 2022-01-04 Wayback capture. Pinned because the modern-only parser
  // would have returned zero against this shape.
  const html = buildShoeboxHtml([
    {
      identifier: "DATA_LINKED_TO_YOU",
      privacyType: "Data Linked to You",
      dataCategories: [{ identifier: "PURCHASES", dataCategory: "Purchases" }],
    },
  ]);
  const items = extractFromShoebox(html);
  assert.equal(items.length, 1);
  assert.equal(items[0].identifier, "DATA_LINKED_TO_YOU");
  assert.equal(items[0].categories[0].identifier, "PURCHASES");
});

test("extractFromShoebox returns [] when there is no shoebox script at all", () => {
  // Pre-Jan-2021 pages carry no shoebox-media-api-cache-apps tag. The
  // extractor must not fall back to other shoebox ids; historical-import
  // relies on [] here to record `skipped_no_capture`.
  const html = "<html><head><script>foo</script></head><body></body></html>";
  assert.deepEqual(extractFromShoebox(html), []);
});

test("extractFromShoebox ignores unrelated shoebox scripts", () => {
  // Apple's Ember boot ships several shoeboxes (localizer, language-code,
  // global-elements); only media-api|apps should be parsed.
  const html = `<html><head>
    <script type="fastboot/shoebox" id="shoebox-language-code">"en-US"</script>
    <script type="fastboot/shoebox" id="shoebox-ember-localizer">{}</script>
    <script type="fastboot/shoebox" id="shoebox-global-elements">{}</script>
  </head></html>`;
  assert.deepEqual(extractFromShoebox(html), []);
});

test("extractFromShoebox returns [] when shoebox is present but lacks a privacy block", () => {
  // Non-app pages (search results, editorial collections) include a
  // media-api shoebox without a privacy path; the extractor returns []
  // instead of throwing.
  const innerPayload = JSON.stringify({
    d: [{ attributes: { name: "No privacy here" } }],
  });
  const outerPayload = JSON.stringify({ "cache.key": innerPayload });
  const escaped = outerPayload.replace(/"/g, "&quot;").replace(/</g, "&lt;");
  const html = `<script type="fastboot/shoebox" id="shoebox-media-api-cache-apps">${escaped}</script>`;
  assert.deepEqual(extractFromShoebox(html), []);
});

test("extractFromShoebox tolerates a malformed cache entry", () => {
  // The shoebox body is a JSON object whose values are JSON-encoded
  // strings. A single non-JSON value must be skipped, not abort the parse.
  const innerOk = JSON.stringify({
    d: [
      {
        attributes: {
          privacy: {
            privacyTypes: [
              {
                identifier: "DATA_LINKED_TO_YOU",
                privacyType: "Data Linked to You",
                dataCategories: [
                  { identifier: "PURCHASES", dataCategory: "Purchases" },
                ],
              },
            ],
          },
        },
      },
    ],
  });
  const outerPayload = JSON.stringify({
    "broken.cache.key": "{this is not valid JSON",
    "good.cache.key": innerOk,
  });
  const escaped = outerPayload
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
  const html = `<script type="fastboot/shoebox" id="shoebox-media-api-cache-apps">${escaped}</script>`;
  const items = extractFromShoebox(html);
  assert.equal(items.length, 1);
  assert.equal(items[0].identifier, "DATA_LINKED_TO_YOU");
});

test("extractFromShoebox falls back to identifier when localised label is missing", () => {
  // Defensive: when a privacy type lacks a `privacyType` string the
  // extractor defaults title to the identifier. normalizePrivacyItems
  // requires `title: string`, so an undefined would silently drop the type.
  const html = buildShoeboxHtml([
    {
      identifier: "DATA_USED_TO_TRACK_YOU",
      // privacyType deliberately omitted
      dataCategories: [
        { identifier: "IDENTIFIERS" /* dataCategory deliberately omitted */ },
      ],
    },
  ]);
  const items = extractFromShoebox(html);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, "DATA_USED_TO_TRACK_YOU");
  assert.equal(items[0].categories[0].title, "IDENTIFIERS");
});
