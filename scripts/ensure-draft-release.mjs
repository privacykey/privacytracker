import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  readReleaseMetadata,
  validateReleaseTag,
} from "./release-metadata.mjs";

const metadata = readReleaseMetadata(process.cwd());
const tag = process.argv[2];
validateReleaseTag(tag, metadata);
const result = spawnSync("gh", ["release", "view", tag, "--json", "isDraft"], {
  encoding: "utf8",
});
if (result.status === 0) {
  if (!JSON.parse(result.stdout).isDraft) {
    throw new Error("Refusing to alter an already published release");
  }
} else {
  // A transport/permission error also makes creation fail; never alter an existing release.
  const dir = mkdtempSync(path.join(tmpdir(), "privacytracker-release-notes-"));
  try {
    const changelog = readFileSync("CHANGELOG.md", "utf8");
    const section = changelog
      .split(`## [${metadata.version}]`)[1]
      ?.split("\n## [")[0];
    if (!section) {
      throw new Error("Missing curated release notes");
    }
    const notes = path.join(dir, "notes.md");
    writeFileSync(notes, section.replace(/^[^\n]*\n/, "").trim());
    execFileSync(
      "gh",
      [
        "release",
        "create",
        tag,
        "--verify-tag",
        "--draft",
        "--title",
        `privacytracker ${tag}`,
        "--notes-file",
        notes,
        ...(metadata.version.includes("-") ? ["--prerelease"] : []),
      ],
      { stdio: "inherit" }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
