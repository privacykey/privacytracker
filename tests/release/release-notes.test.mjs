import assert from "node:assert/strict";
import test from "node:test";
import {
  RELEASE_NOTES_END,
  RELEASE_NOTES_LIMIT,
  releaseNotes,
} from "../../scripts/release-metadata.mjs";

/**
 * The draft release body is a version's CHANGELOG.md section. A curated
 * summary can stand above the full list, ended by the marker, so the body
 * stays readable and under GitHub's limit while every entry stays in the
 * changelog.
 */
function changelog(section) {
  return [
    "# Changelog",
    "",
    "## [Unreleased]",
    "",
    "## [9.8.7] — 2026-10-01",
    "",
    ...section,
    "",
    "## [9.8.6] — 2026-09-01",
    "",
    "- Older.",
    "",
  ].join("\n");
}

const summarised = changelog([
  "What changed, for people upgrading.",
  "",
  RELEASE_NOTES_END,
  "",
  "### Added",
  "",
  "- Every entry.",
]);

test("the body is the summary above the marker", () => {
  assert.equal(
    releaseNotes(summarised, "9.8.7"),
    "What changed, for people upgrading."
  );
});

test("without a marker the body is the whole section, as before", () => {
  assert.equal(
    releaseNotes(changelog(["### Added", "", "- Every entry."]), "9.8.7"),
    "### Added\n\n- Every entry."
  );
  assert.equal(releaseNotes(summarised, "9.8.6"), "- Older.");
});

test("only the marker on a line of its own ends the summary", () => {
  const quoted = changelog([
    `The summary explains the \`${RELEASE_NOTES_END}\` line.`,
    "",
    `${RELEASE_NOTES_END}  `,
    "",
    "- Every entry.",
  ]);
  assert.equal(
    releaseNotes(quoted, "9.8.7"),
    `The summary explains the \`${RELEASE_NOTES_END}\` line.`
  );
});

test("a missing section or an empty summary is refused", () => {
  assert.throws(() => releaseNotes(summarised, "9.8.5"), /no ## \[9\.8\.5\]/);
  assert.throws(
    () => releaseNotes(changelog(["", RELEASE_NOTES_END, "- Entry."]), "9.8.7"),
    /Missing curated release notes/
  );
});

test("a body longer than GitHub allows is refused before any release call", () => {
  const atLimit = changelog(["x".repeat(RELEASE_NOTES_LIMIT)]);
  assert.equal(releaseNotes(atLimit, "9.8.7").length, RELEASE_NOTES_LIMIT);
  const over = changelog([
    "x".repeat(RELEASE_NOTES_LIMIT + 1),
    RELEASE_NOTES_END,
  ]);
  assert.throws(
    () => releaseNotes(over, "9.8.7"),
    new RegExp(`${RELEASE_NOTES_LIMIT + 1} characters; GitHub allows`)
  );
  // Only the summary counts: a long list below the marker is fine.
  const longList = changelog([
    "Short summary.",
    RELEASE_NOTES_END,
    "x".repeat(RELEASE_NOTES_LIMIT * 2),
  ]);
  assert.equal(releaseNotes(longList, "9.8.7"), "Short summary.");
});
