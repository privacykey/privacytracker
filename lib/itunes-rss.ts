/**
 * The legacy iTunes RSS charts (`/rss/topfreeapplications/.../json`) are
 * an Atom feed converted to JSON, and the conversion keeps XML's habit: a
 * repeated element becomes an array, a SINGLE one becomes a bare object.
 * So `feed.entry` is an array for a chart of two or more apps and one
 * object for a chart of exactly one — `limit=1`, or a category with a
 * single app in a small storefront.
 *
 * Both readers of the feed iterated it with `for…of`, which throws
 * "entries is not iterable" on the object: the dev seed answered 502 to
 * every `?limit=1`, and the Compare page's "Top in category" quick-pick
 * (`/api/related-apps`) showed "no candidates" for a category whose only
 * candidate it had just been handed. (That reader already handled `link`
 * being object-or-array; `entry` was the one that got missed.)
 *
 * Anything that is neither — a string, a number, `null`, a missing feed —
 * is no entries at all.
 */
export function rssEntries<T>(entry: T | T[] | null | undefined): T[] {
  if (Array.isArray(entry)) {
    return entry;
  }
  return entry !== null && typeof entry === "object" ? [entry] : [];
}
