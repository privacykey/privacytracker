import { readFileSync } from "node:fs";
import path from "node:path";

const VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;

export function validateVersion(version) {
  if (
    typeof version !== "string" ||
    version.trim() !== version ||
    !VERSION.test(version)
  ) {
    throw new Error(
      "Expected an explicit release version, for example 0.2.0 or 0.2.0-rc.1"
    );
  }
  return version;
}

export function readReleaseMetadata(root) {
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const config = JSON.parse(
    readFileSync(path.join(root, "src-tauri/tauri.conf.json"), "utf8")
  );
  const cargo = readFileSync(path.join(root, "src-tauri/Cargo.toml"), "utf8");
  const lock = readFileSync(path.join(root, "src-tauri/Cargo.lock"), "utf8");
  const cargoVersion = cargo.match(
    /\[package\][\s\S]*?^version = "([^"]+)"/m
  )?.[1];
  const lockVersion = lock.match(
    /\[\[package\]\]\nname = "privacytracker"\nversion = "([^"]+)"/
  )?.[1];
  const version = validateVersion(pkg.version);
  if (
    cargoVersion !== version ||
    lockVersion !== version ||
    config.version !== "../package.json"
  ) {
    throw new Error(
      `Release versions disagree: package=${version}, Cargo=${cargoVersion}, lock=${lockVersion}, Tauri=${config.version}`
    );
  }
  return {
    version,
    tag: `v${version}`,
    minimumMacOSVersion: config.bundle.macOS.minimumSystemVersion,
    pubkey: config.plugins.updater.pubkey,
  };
}

/** GitHub refuses a release body longer than this many characters. */
export const RELEASE_NOTES_LIMIT = 125_000;

/**
 * Ends a version's curated summary in CHANGELOG.md. The draft release body
 * is the text above it; the full list of entries below it stays in the
 * changelog. A section without it is used whole, as before.
 *
 * A link reference definition, not an HTML comment: both render as nothing
 * on GitHub, but the docs site mirrors CHANGELOG.md into MDX, where an HTML
 * comment silently drops the text around it from the page. It needs a blank
 * line above it, or Markdown reads it as part of the paragraph.
 */
export const RELEASE_NOTES_END = "[//]: # (release-notes-end)";

/** The marker on a line of its own, not quoted inside another line. */
const RELEASE_NOTES_END_LINE = new RegExp(
  `^${RELEASE_NOTES_END.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}[ \\t]*$`,
  "m"
);

/** The draft release body for `version`, taken from CHANGELOG.md. */
export function releaseNotes(changelog, version) {
  const section = changelog.split(`## [${version}]`)[1]?.split("\n## [")[0];
  if (section === undefined) {
    throw new Error(`CHANGELOG.md has no ## [${version}] section`);
  }
  // The first line is the rest of the heading (the date).
  const rest = section.replace(/^[^\n]*\n/, "");
  const end = rest.search(RELEASE_NOTES_END_LINE);
  const body = (end < 0 ? rest : rest.slice(0, end)).trim();
  if (!body) {
    throw new Error("Missing curated release notes");
  }
  if (body.length > RELEASE_NOTES_LIMIT) {
    throw new Error(
      `The ${version} release notes are ${body.length} characters; GitHub allows ${RELEASE_NOTES_LIMIT}. Summarise them above ${RELEASE_NOTES_END} and keep the full list below it.`
    );
  }
  return body;
}

export function validateReleaseTag(tag, metadata) {
  if (tag !== metadata.tag) {
    throw new Error(
      `Tag ${tag} does not match the built application ${metadata.tag}`
    );
  }
}
