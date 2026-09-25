import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import {
  readReleaseMetadata,
  releaseNotes,
  validateReleaseTag,
} from "./release-metadata.mjs";

const metadata = readReleaseMetadata(process.cwd());
const tag = process.argv[2];
if (tag) {
  validateReleaseTag(tag, metadata);
  const git = (...args) =>
    execFileSync("git", args, { encoding: "utf8" }).trim();
  if (
    git("rev-parse", `refs/tags/${tag}^{commit}`) !== git("rev-parse", "HEAD")
  ) {
    throw new Error("Release tag does not identify the checked-out commit");
  }
  execFileSync("git", ["merge-base", "--is-ancestor", "HEAD", "origin/main"]);
  // The tagged version needs a curated CHANGELOG.md section that GitHub
  // will accept as a release body; find out here, before any build.
  releaseNotes(readFileSync("CHANGELOG.md", "utf8"), metadata.version);
}
console.log(JSON.stringify(metadata));
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `version=${metadata.version}\ntag=${metadata.tag}\nprerelease=${metadata.version.includes("-")}\n`
  );
}
