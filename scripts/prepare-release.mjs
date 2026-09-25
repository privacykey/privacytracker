import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { readReleaseMetadata, validateVersion } from "./release-metadata.mjs";

/** Run git in the checkout, or null outside one. */
function git(...args) {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

const next = validateVersion(process.argv[2]);
const current = readReleaseMetadata(process.cwd()).version;
if (current === next) {
  throw new Error("This version is already prepared");
}
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const cargo = readFileSync("src-tauri/Cargo.toml", "utf8");
const lock = readFileSync("src-tauri/Cargo.lock", "utf8");
const changelog = readFileSync("CHANGELOG.md", "utf8");
if (!changelog.includes("## [Unreleased]")) {
  throw new Error("Missing Unreleased changelog section");
}
if (changelog.includes(`## [${next}]`)) {
  throw new Error("Changelog already contains this release");
}
// The new section compares with the last release tag. The version the files
// carry is not always one: 0.2.0 was prepared and never released, and a link
// from its tag would lead nowhere.
const previous =
  git("describe", "--tags", "--abbrev=0", "--match", "v[0-9]*") ??
  `v${current}`;
pkg.version = next;
writeFileSync("package.json", `${JSON.stringify(pkg, null, 2)}\n`);
writeFileSync(
  "src-tauri/Cargo.toml",
  cargo.replace(
    /(\[package\][\s\S]*?^version = ")[^"]+("$)/m,
    (_match, before, after) => `${before}${next}${after}`
  )
);
writeFileSync(
  "src-tauri/Cargo.lock",
  lock.replace(
    /(\[\[package\]\]\nname = "privacytracker"\nversion = ")[^"]+("$)/m,
    (_match, before, after) => `${before}${next}${after}`
  )
);
const date = new Date().toISOString().slice(0, 10);
writeFileSync(
  "CHANGELOG.md",
  changelog
    .replace("## [Unreleased]", `## [Unreleased]\n\n## [${next}] — ${date}`)
    .replace(
      /\[Unreleased\]:[^\n]+/,
      `[Unreleased]: https://github.com/privacykey/privacytracker/compare/v${next}...HEAD\n[${next}]: https://github.com/privacykey/privacytracker/compare/${previous}...v${next}`
    )
);
// Name the sections whose version was never released, so the curated notes
// can say what became of them rather than leave a dated section for a
// release nobody can download.
const tags = git("tag", "--list", "v*");
if (tags !== null) {
  const tagged = new Set(tags.split("\n"));
  const untagged = [...changelog.matchAll(/^## \[(\d[^\]]*)\]/gm)]
    .map((match) => match[1])
    .filter((version) => !tagged.has(`v${version}`));
  if (untagged.length > 0) {
    console.warn(
      `CHANGELOG.md has sections for versions that were never tagged: ${untagged.join(", ")}. Fold their entries into the new release's notes, or say what became of them.`
    );
  }
}
console.log(
  `Prepared ${next}, compared with ${previous}. Review these changes in a pull request; this command does not commit, tag or publish.`
);
