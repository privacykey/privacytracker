import assert from "node:assert/strict";
import test from "node:test";
import { rssEntries } from "../../lib/itunes-rss";

// The legacy iTunes RSS JSON is XML converted: a chart of ONE app carries
// its entry as a bare object. Both readers iterated `feed.entry` with
// for…of, which throws on an object — so the dev seed answered 502 to
// every ?limit=1 and the Compare page's "Top in category" quick-pick lost
// a category's only candidate. These pin the shape handling; the two routes' behaviour over
// it is held by the seed and discovery oracles under core/scripts.

const entry = (id: string) => ({ id: { attributes: { "im:id": id } } });

test("a chart of several apps is the array it came as", () => {
  const list = [entry("1"), entry("2")];
  assert.equal(rssEntries(list), list);
});

test("a chart of ONE app is an object, and becomes a list of one", () => {
  const only = entry("7");
  assert.deepEqual(rssEntries(only), [only]);
  // …and is iterable, which is the thing that used to throw.
  const seen: string[] = [];
  for (const e of rssEntries(only)) {
    seen.push(e.id.attributes["im:id"]);
  }
  assert.deepEqual(seen, ["7"]);
});

test("an empty chart is no entries", () => {
  assert.deepEqual(rssEntries([]), []);
  assert.deepEqual(rssEntries(undefined), []);
  assert.deepEqual(rssEntries(null), []);
});

test("anything that is neither a list nor an object is no entries", () => {
  // A string must not be read as a list of its characters.
  assert.deepEqual(rssEntries("entry" as unknown as object), []);
  assert.deepEqual(rssEntries(3 as unknown as object), []);
  assert.deepEqual(rssEntries(true as unknown as object), []);
});
