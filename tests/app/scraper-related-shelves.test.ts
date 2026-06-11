/**
 * Tests for `extractRelatedAppShelves` — pulls "Customers Also Bought" /
 * "You Might Also Like" + "More By This Developer" entries out of the
 * modern serialized-server-data `shelfMapping` blob.
 *
 * These shelves drift in shape every few months; the extractor walks a
 * handful of known key names defensively. Each test pins one shape we've
 * seen in the wild.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { extractRelatedAppShelves } from "../../lib/scraper";

function buildRawData(shelfMapping: Record<string, unknown>): unknown {
  return [{ data: { shelfMapping } }];
}

test("extracts may_also_like from customersAlsoBoughtAppsCollection.items", () => {
  const raw = buildRawData({
    customersAlsoBoughtAppsCollection: {
      items: [
        {
          id: "111",
          name: "Counterpart One",
          artistName: "Acme",
          url: "https://apps.apple.com/us/app/id111",
          artwork: { url: "https://img.test/111.png" },
        },
        {
          id: "222",
          name: "Counterpart Two",
          artistName: "Beta",
          url: "https://apps.apple.com/us/app/id222",
        },
      ],
    },
  });

  const out = extractRelatedAppShelves(raw);
  assert.equal(out.length, 2);
  assert.equal(out[0].relatedAppleId, "111");
  assert.equal(out[0].shelfType, "may_also_like");
  assert.equal(out[0].relatedName, "Counterpart One");
  assert.equal(out[0].relatedDeveloper, "Acme");
  assert.equal(out[0].relatedIconUrl, "https://img.test/111.png");
  // Item without icon falls through to null rather than undefined.
  assert.equal(out[1].relatedIconUrl, null);
});

test("extracts more_by_developer from moreByThisDeveloperCollection.items", () => {
  const raw = buildRawData({
    moreByThisDeveloperCollection: {
      items: [
        {
          id: "333",
          name: "Sibling App",
          artistName: "Same Dev",
          url: "https://apps.apple.com/us/app/id333",
        },
      ],
    },
  });

  const out = extractRelatedAppShelves(raw);
  assert.equal(out.length, 1);
  assert.equal(out[0].shelfType, "more_by_developer");
  assert.equal(out[0].relatedAppleId, "333");
});

test("extracts both shelves from the same page", () => {
  const raw = buildRawData({
    customersAlsoBoughtAppsCollection: {
      items: [
        { id: "111", name: "A", url: "https://apps.apple.com/us/app/id111" },
      ],
    },
    moreByThisDeveloperCollection: {
      items: [
        { id: "222", name: "B", url: "https://apps.apple.com/us/app/id222" },
      ],
    },
  });

  const out = extractRelatedAppShelves(raw);
  const byType: Record<string, string[]> = {
    may_also_like: [],
    more_by_developer: [],
  };
  for (const r of out) {
    byType[r.shelfType].push(r.relatedAppleId);
  }
  assert.deepEqual(byType.may_also_like, ["111"]);
  assert.deepEqual(byType.more_by_developer, ["222"]);
});

test("accepts the alternate seeAllAction.pageData.shelves[].items wrapping", () => {
  const raw = buildRawData({
    customersAlsoBoughtApps: {
      seeAllAction: {
        pageData: {
          shelves: [
            {
              items: [
                {
                  id: "999",
                  name: "Wrapped App",
                  url: "https://apps.apple.com/us/app/id999",
                },
              ],
            },
          ],
        },
      },
    },
  });

  const out = extractRelatedAppShelves(raw);
  assert.equal(out.length, 1);
  assert.equal(out[0].relatedAppleId, "999");
});

test("caps each shelf at 10 entries", () => {
  const items = Array.from({ length: 30 }, (_, i) => ({
    id: String(1000 + i),
    name: `App ${i}`,
    url: `https://apps.apple.com/us/app/id${1000 + i}`,
  }));
  const raw = buildRawData({
    customersAlsoBoughtAppsCollection: { items },
  });

  const out = extractRelatedAppShelves(raw);
  assert.equal(out.length, 10);
});

test("drops items with missing required fields (id, name, url)", () => {
  const raw = buildRawData({
    customersAlsoBoughtAppsCollection: {
      items: [
        { id: "1", name: "OK", url: "https://apps.apple.com/us/app/id1" },
        { id: "2", /* no name */ url: "https://apps.apple.com/us/app/id2" },
        { /* no id */ name: "No ID", url: "https://apps.apple.com/us/app/id3" },
        { id: "4", name: "No URL" /* no url */ },
        null,
        "not-an-object",
      ],
    },
  });

  const out = extractRelatedAppShelves(raw);
  assert.equal(out.length, 1);
  assert.equal(out[0].relatedAppleId, "1");
});

test("coerces numeric ids to strings (Apple sometimes ships them as numbers)", () => {
  const raw = buildRawData({
    customersAlsoBoughtAppsCollection: {
      items: [
        {
          id: 12_345,
          name: "Numeric ID",
          url: "https://apps.apple.com/us/app/id12345",
        },
      ],
    },
  });

  const out = extractRelatedAppShelves(raw);
  assert.equal(out[0].relatedAppleId, "12345");
  assert.equal(typeof out[0].relatedAppleId, "string");
});

test("returns empty array on missing shelfMapping (and never throws)", () => {
  assert.deepEqual(extractRelatedAppShelves(undefined), []);
  assert.deepEqual(extractRelatedAppShelves([]), []);
  assert.deepEqual(extractRelatedAppShelves([{ data: {} }]), []);
  assert.deepEqual(
    extractRelatedAppShelves([{ data: { shelfMapping: {} } }]),
    []
  );
});

test("tolerates the older artistName fallback chain", () => {
  const raw = buildRawData({
    customersAlsoBoughtAppsCollection: {
      items: [
        {
          adamId: 999,
          title: "Title field",
          developerName: "Dev name field",
          appLink: "https://apps.apple.com/us/app/id999",
          imageUrl: "https://img.test/999.png",
        },
      ],
    },
  });

  const out = extractRelatedAppShelves(raw);
  assert.equal(out.length, 1);
  assert.equal(out[0].relatedAppleId, "999");
  assert.equal(out[0].relatedName, "Title field");
  assert.equal(out[0].relatedDeveloper, "Dev name field");
  assert.equal(out[0].relatedStoreUrl, "https://apps.apple.com/us/app/id999");
  assert.equal(out[0].relatedIconUrl, "https://img.test/999.png");
});
