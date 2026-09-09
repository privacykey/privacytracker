import { readFileSync, writeFileSync } from "node:fs";
import { readReleaseMetadata, validateVersion } from "./release-metadata.mjs";

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
      `[Unreleased]: https://github.com/privacykey/privacytracker/compare/v${next}...HEAD\n[${next}]: https://github.com/privacykey/privacytracker/compare/v${current}...v${next}`
    )
);
console.log(
  `Prepared ${next}. Review these changes in a pull request; this command does not commit, tag or publish.`
);
