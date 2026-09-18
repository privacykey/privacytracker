/**
 * Pin `diffPolicyTexts`, the line-and-word diff behind the History tab's
 * "Show diff from previous version" and GET /api/policy/version/[id]/diff.
 *
 * The first three cases are the regression: the common-suffix trim used to
 * count from the start of both arrays (`at(1 + suffix)`) rather than the
 * end, so a changed last line, or a one-line policy with one edited word,
 * came out as no change at all, and an edit followed by an appended line
 * showed the new text on the removed line. Every expectation below is the
 * diff a reader would draw by hand.
 *
 * Results are compared as the route sends them (through JSON), which is
 * where an absent `words` and an undefined one look the same.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { diffPolicyTexts } from "../../lib/policy-diff";

type Wire = ReturnType<typeof diffPolicyTexts>;

function wire(oldText: string, newText: string): Wire {
  return JSON.parse(JSON.stringify(diffPolicyTexts(oldText, newText))) as Wire;
}

const u = (text: string) => ({ type: "unchanged", text });
const r = (text: string) => ({ type: "removed", text });
const a = (text: string) => ({ type: "added", text });
const words = (spec: string[]) =>
  spec.map((s) => {
    const type = { u: "unchanged", r: "removed", a: "added" }[s[0]];
    return { type, text: s.slice(2) };
  });

test("one edited word in a one-line policy is a change, marked word by word", () => {
  assert.deepEqual(wire("The quick brown fox", "The quick red fox"), {
    lines: [
      {
        ...r("The quick brown fox"),
        words: words([
          "u:The",
          "u: ",
          "u:quick",
          "u: ",
          "r:brown",
          "u: ",
          "u:fox",
        ]),
      },
      {
        ...a("The quick red fox"),
        words: words([
          "u:The",
          "u: ",
          "u:quick",
          "u: ",
          "a:red",
          "u: ",
          "u:fox",
        ]),
      },
    ],
    stats: { added: 1, removed: 1, unchanged: 0, truncated: false },
  });
});

test("an edit in the middle and an appended line are both where they happened", () => {
  const before = ["Title", "Intro", "Alpha", "Beta", "Gamma", "Delta"];
  const after = [
    "Title",
    "Intro",
    "ALPHA",
    "Beta",
    "Gamma",
    "Delta",
    "appended",
  ];
  assert.deepEqual(wire(before.join("\n"), after.join("\n")), {
    lines: [
      u("Title"),
      u("Intro"),
      { ...r("Alpha"), words: words(["r:Alpha"]) },
      { ...a("ALPHA"), words: words(["a:ALPHA"]) },
      u("Beta"),
      u("Gamma"),
      u("Delta"),
      a("appended"),
    ],
    stats: { added: 2, removed: 1, unchanged: 5, truncated: false },
  });
});

test("a changed last line is a change", () => {
  const before = ["Title", "Intro", "Alpha", "Beta", "Gamma", "Delta"];
  const after = ["Title", "Intro", "Alpha", "Beta", "Gamma", "DELTA"];
  assert.deepEqual(wire(before.join("\n"), after.join("\n")), {
    lines: [
      u("Title"),
      u("Intro"),
      u("Alpha"),
      u("Beta"),
      u("Gamma"),
      { ...r("Delta"), words: words(["r:Delta"]) },
      { ...a("DELTA"), words: words(["a:DELTA"]) },
    ],
    stats: { added: 1, removed: 1, unchanged: 5, truncated: false },
  });
});

test("a common suffix is kept and a removed tail has no word split", () => {
  assert.deepEqual(wire("A\nB\nC\nD", "A\nX\nD"), {
    lines: [
      u("A"),
      { ...r("B"), words: words(["r:B"]) },
      { ...a("X"), words: words(["a:X"]) },
      r("C"),
      u("D"),
    ],
    stats: { added: 1, removed: 2, unchanged: 2, truncated: false },
  });
  assert.deepEqual(wire("A\nB\nC", "A\nB"), {
    lines: [u("A"), u("B"), r("C")],
    stats: { added: 0, removed: 1, unchanged: 2, truncated: false },
  });
});

test("empty, identical and CRLF-only differences are no change", () => {
  assert.deepEqual(wire("", ""), {
    lines: [],
    stats: { added: 0, removed: 0, unchanged: 0, truncated: false },
  });
  assert.deepEqual(wire("", "New"), {
    lines: [a("New")],
    stats: { added: 1, removed: 0, unchanged: 0, truncated: false },
  });
  assert.deepEqual(wire("One\r\nTwo", "One\nTwo"), {
    lines: [u("One"), u("Two")],
    stats: { added: 0, removed: 0, unchanged: 2, truncated: false },
  });
});

test("more than 2000 lines is truncated and more than 400 tokens skips the word split", () => {
  const long = Array.from({ length: 2001 }, (_, i) => `Line ${i}`).join("\n");
  const truncated = wire(long, long);
  assert.equal(truncated.stats.truncated, true);
  assert.equal(truncated.stats.unchanged, 2000);
  assert.equal(truncated.lines.length, 2000);

  // 200 words and 200 spaces, then one more word: 401 tokens.
  const wide = (last: string) => `${"w ".repeat(200)}${last}`;
  const refined = wire(wide("x"), wide("y"));
  assert.deepEqual(refined.lines, [r(wide("x")), a(wide("y"))]);
  assert.deepEqual(refined.stats, {
    added: 1,
    removed: 1,
    unchanged: 0,
    truncated: false,
  });
});
