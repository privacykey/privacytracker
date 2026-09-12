#!/usr/bin/env node
/**
 * Generate a differential test fixture for `diffSnapshots` by running the
 * REAL Node implementation over a table of hand-built snapshot pairs and
 * recording its exact output.
 *
 * Why this exists, and why it is not optional: the parity harness cannot
 * see `diffSnapshots` at all. Every app the canned seed creates ends up with
 * a baseline and a latest snapshot holding the SAME set of types and
 * categories (the arrays are reordered between them, but membership is
 * identical), so `/api/apps/{id}/since-install` answers `"changes": []` for
 * all ten of them. A Rust port whose diff function was
 * `fn diff_snapshots(..) -> Vec<ChangeEntry> { Vec::new() }` would pass the
 * read-parity gate cleanly. That is a blind spot of exactly the same kind as
 * the auth gate and the rate limiter, and it gets the same treatment: an
 * out-of-band check that the differ cannot be fooled by.
 *
 * Unlike `extract-schema.mjs`, which lifts source TEXT, this imports and
 * EXECUTES `diffSnapshots` from `lib/changelog.ts`. There is no
 * transcription step and therefore no transcription risk: the expected
 * bytes in the fixture were produced by the very function the Rust port has
 * to match. `lib/changelog.ts` opens the database at module scope, so the
 * script points `PRIVACYTRACKER_DATA_DIR` at a throwaway directory — it
 * never touches a real install and never reads a row.
 *
 * The output is checked in so reviewers can diff it, and CI re-runs this
 * script and fails on any change (see `just parity-diff-cases`) — so a
 * change to `diffSnapshots` that nobody ported to Rust is caught at the
 * fixture, not in production.
 *
 * Usage:  node core/scripts/extract-diff-cases.mjs
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");

// Must be set BEFORE lib/changelog.ts (and through it lib/db.ts) is
// imported, because db.ts resolves the data directory at module scope.
process.env.PRIVACYTRACKER_DATA_DIR ??= mkdtempSync(
  path.join(tmpdir(), "pt-diff-cases-")
);

const { diffSnapshots } = await import(path.join(repo, "lib", "changelog.ts"));

/** Terse builders, so a case reads as its shape rather than its punctuation. */
const type_ = (identifier, title, categories = []) => ({
  identifier,
  title,
  categories,
});
const cat = (identifier, title) => ({ identifier, title });

/**
 * Each case names the behaviour it pins. Where a case exists to catch a
 * specific wrong-but-plausible Rust implementation, `why` says which one —
 * a case with no failure mode behind it is just noise in a fixture.
 */
const CASES = [
  {
    name: "both empty",
    why: "an empty diff must serialise as [], never null",
    old: [],
    new: [],
  },
  {
    name: "added type with categories",
    why: "the only variant that carries `details`; it lists category TITLES, not identifiers",
    old: [],
    new: [
      type_("T_TRACK", "Data Used to Track You", [
        cat("C_ID", "Identifiers"),
        cat("C_LOC", "Location"),
      ]),
    ],
  },
  {
    name: "added type with no categories",
    why: "`details` is an EMPTY ARRAY here, not an absent key — skip_serializing_if would drop it and diverge",
    old: [],
    new: [type_("T_EMPTY", "Empty Label", [])],
  },
  {
    name: "removed type",
    why: "removed-type entries carry NO `details` key at all, unlike added ones",
    old: [type_("T_GONE", "Departed Label", [cat("C_ID", "Identifiers")])],
    new: [],
  },
  {
    name: "category added and removed inside a surviving type",
    why: "category-level entries carry neither `details` nor any other optional key",
    old: [type_("T", "Label", [cat("C_KEEP", "Kept"), cat("C_GONE", "Gone")])],
    new: [
      type_("T", "Label", [cat("C_KEEP", "Kept"), cat("C_NEW", "Arrived")]),
    ],
  },
  {
    name: "identical membership, reordered arrays",
    why: "the diff keys on identifiers, so reordering is NOT a change — this is what the canned seed happens to exercise, and all it exercises",
    old: [
      type_("A", "Alpha", [cat("C1", "One"), cat("C2", "Two")]),
      type_("B", "Beta", []),
    ],
    new: [
      type_("B", "Beta", []),
      type_("A", "Alpha", [cat("C2", "Two"), cat("C1", "One")]),
    ],
  },
  {
    name: "several added types keep NEW array order",
    why: "pass 1 iterates the new snapshot; sorting by identifier (a BTreeMap port) reverses this",
    old: [],
    new: [
      type_("Z_LAST", "Zeta", []),
      type_("A_FIRST", "Alpha", []),
      type_("M_MID", "Mu", []),
    ],
  },
  {
    name: "several removed types keep OLD array order",
    why: "pass 2 iterates the old snapshot, not the new one",
    old: [
      type_("Z_LAST", "Zeta", []),
      type_("A_FIRST", "Alpha", []),
      type_("M_MID", "Mu", []),
    ],
    new: [],
  },
  {
    name: "added, removed and modified together",
    why: "pins the ORDER OF THE THREE PASSES: all added types, then all removed types, then per-type category changes",
    old: [
      type_("KEEP", "Kept Label", [
        cat("C_OLD", "Old Cat"),
        cat("C_BOTH", "Shared"),
      ]),
      type_("DROP", "Dropped Label", [cat("C_X", "Ex")]),
    ],
    new: [
      type_("KEEP", "Kept Label", [
        cat("C_BOTH", "Shared"),
        cat("C_NEW", "New Cat"),
      ]),
      type_("ADD", "Added Label", [cat("C_A", "Ay")]),
    ],
  },
  {
    name: "added then removed categories within one type",
    why: "within a type, ALL added categories precede ALL removed ones — not interleaved in array order",
    old: [
      type_("T", "Label", [cat("R1", "Removed One"), cat("R2", "Removed Two")]),
    ],
    new: [
      type_("T", "Label", [cat("A1", "Added One"), cat("A2", "Added Two")]),
    ],
  },
  {
    name: "duplicate type identifier in the new snapshot",
    why: "new Map() keeps the FIRST occurrence's position but the LAST occurrence's value; a Vec scan or a HashMap gets one of those wrong",
    old: [],
    new: [
      type_("DUP", "First Title", [cat("C1", "One")]),
      type_("OTHER", "Other", []),
      type_("DUP", "Second Title", [cat("C2", "Two")]),
    ],
  },
  {
    name: "duplicate type identifier in the old snapshot",
    why: "same Map semantics on the removal pass",
    old: [
      type_("DUP", "First Title", [cat("C1", "One")]),
      type_("OTHER", "Other", []),
      type_("DUP", "Second Title", [cat("C2", "Two")]),
    ],
    new: [],
  },
  {
    name: "duplicate category identifier within a type",
    why: "categories go through a Set for membership but are ITERATED from the array, so a duplicate yields two entries",
    old: [type_("T", "Label", [])],
    new: [type_("T", "Label", [cat("C_DUP", "First"), cat("C_DUP", "Second")])],
  },
  {
    name: "category identifier unchanged but title changed",
    why: "titles are not compared; a title-only edit is invisible to the diff",
    old: [type_("T", "Label", [cat("C", "Old Title")])],
    new: [type_("T", "Label", [cat("C", "New Title")])],
  },
  {
    name: "type title changed, identifier and categories unchanged",
    why: "same reason at the type level — no entry is emitted",
    old: [type_("T", "Old Label", [cat("C", "Cat")])],
    new: [type_("T", "New Label", [cat("C", "Cat")])],
  },
  {
    name: "type title changed while a category also changes",
    why: "the description quotes the NEW type's title, never the old one",
    old: [type_("T", "Old Label", [cat("C1", "One")])],
    new: [type_("T", "New Label", [cat("C2", "Two")])],
  },
  {
    name: "double quotes inside titles",
    why: "the template literal wraps titles in bare double quotes and does NOT escape any already inside — the result is deliberately ambiguous text",
    old: [],
    new: [type_("T", 'He said "hi"', [cat("C", 'a "quoted" category')])],
  },
  {
    name: "non-ASCII titles",
    why: "Node emits UTF-8 unescaped; serde_json must not \\u-escape it",
    old: [type_("T", "Étiquette", [cat("C1", "Café ☕")])],
    new: [type_("T", "Étiquette", [cat("C2", "日本語 🇯🇵")])],
  },
  {
    name: "null titles",
    why: "a legacy row can hold a null title; the template literal renders the four characters n-u-l-l",
    old: [],
    new: [type_("T", null, [cat("C", null)])],
  },
  {
    name: "backslashes and newlines in titles",
    why: "JSON string escaping of the composed description, not of the input",
    old: [],
    new: [type_("T", "back\\slash", [cat("C", "line\nbreak\ttab")])],
  },
  {
    name: "numeric and boolean titles",
    why: "a template literal stringifies whatever it is given; 1.0 is `1` in JS but `1.0` to a naive Rust float formatter",
    old: [],
    new: [
      type_("T_NUM", 1, [cat("C_A", 1.0), cat("C_B", 2.5), cat("C_C", true)]),
    ],
  },
  {
    name: "numeric identifier is a different Map key from the string of it",
    why: 'JS Map keys use SameValueZero, so 1 and "1" do NOT collide; a port that stringifies keys would merge them',
    old: [],
    new: [type_(1, "Numeric Id", []), type_("1", "String Id", [])],
  },
  {
    name: "missing identifier and explicit null identifier are distinct keys",
    why: "undefined and null are different Map keys; serde's #[serde(default)] collapses both to Null unless the field is Option<Value>",
    old: [],
    new: [
      { title: "No Identifier At All", categories: [] },
      type_(null, "Null Identifier", []),
    ],
  },
  {
    name: "missing identifier on both sides pairs up",
    why: "two undefined-identifier types are the SAME key, so they match rather than reading as add+remove",
    old: [{ title: "Old Nameless", categories: [cat("C_OLD", "Old")] }],
    new: [{ title: "New Nameless", categories: [cat("C_NEW", "New")] }],
  },
  {
    name: "zero and negative zero are the SAME identifier",
    why: "Map keys use SameValueZero, so 0 and -0 collide — formatting the JSON token keeps them apart and reports a spurious add+remove",
    old: [type_(0, "Zero", [])],
    new: [type_(-0, "Minus Zero", [])],
  },
  {
    name: "an integer and its float spelling are the SAME identifier",
    why: "JavaScript has one number type, so 1 and 1.0 are one key",
    old: [type_(1, "Integer", [])],
    new: [type_(1.0, "Float", [])],
  },
  {
    name: "a missing category title serialises as null inside details",
    why: "JSON.stringify turns an `undefined` ARRAY ELEMENT into null — unlike an undefined object VALUE, which it drops",
    old: [],
    new: [
      {
        identifier: "T",
        title: "Label",
        categories: [{ identifier: "c1" }, { identifier: "c2", title: null }],
      },
    ],
  },
  {
    name: "an object title stringifies to [object Object]",
    why: "template literals call toString, and the raw value still reaches details unchanged",
    old: [],
    new: [
      {
        identifier: "T",
        title: { a: 1 },
        categories: [{ identifier: "c", title: ["x", "y"] }],
      },
    ],
  },
  // ── cases where the Node function THROWS ────────────────────────────
  // The try/catch in getSinceInstallDiff wraps only JSON.parse, so these
  // propagate out of the route as a 500. The Rust port refuses them at
  // deserialisation and answers `"sinceInstall": null` instead. Recorded
  // here so the boundary is pinned rather than discovered later.
  {
    name: "throws: a type with no categories",
    why: "newType.categories.map on undefined — Node 500s; the Rust port must REFUSE the blob, not default it to an empty list and invent an answer",
    old: [],
    new: [{ identifier: "T", title: "Label" }],
  },
  {
    name: "throws: categories is null",
    why: "same TypeError via null rather than undefined",
    old: [],
    new: [{ identifier: "T", title: "Label", categories: null }],
  },
  {
    name: "throws: an array element that is not an object",
    why: "a snapshot blob holding a bare number is not a snapshot; neither backend may answer as though it were",
    old: [],
    new: [1],
  },
];

const cases = CASES.map((c) => {
  // A case whose name starts with `throws:` is expected to blow up: the
  // upstream try/catch covers only JSON.parse, so a structurally malformed
  // snapshot reaches diffSnapshots intact and the route 500s. Record that
  // as a fact rather than letting the generator die on it.
  let expected = null;
  let throws = null;
  try {
    expected = diffSnapshots(c.old, c.new);
  } catch (e) {
    throws = e?.constructor?.name ?? "Error";
  }
  return { name: c.name, why: c.why, old: c.old, new: c.new, expected, throws };
});

const outDir = path.join(repo, "core", "tests", "fixtures");
mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, "diff-cases.json");
writeFileSync(
  outFile,
  `${JSON.stringify(
    {
      generated_by: "core/scripts/extract-diff-cases.mjs",
      source: "lib/changelog.ts → diffSnapshots",
      note: "DO NOT EDIT BY HAND. Regenerate with `just parity-diff-cases`; the expected values are the real Node function's output.",
      cases,
    },
    null,
    2
  )}\n`
);

const entries = cases.reduce((n, c) => n + (c.expected?.length ?? 0), 0);
const throwing = cases.filter((c) => c.throws).length;
console.log(
  `extract-diff-cases: wrote ${cases.length} cases (${entries} change entries, ${throwing} that Node throws on) to ${path.relative(repo, outFile)}`
);
