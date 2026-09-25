import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  readReleaseMetadata,
  releaseNotes,
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
    const notes = path.join(dir, "notes.md");
    writeFileSync(
      notes,
      releaseNotes(readFileSync("CHANGELOG.md", "utf8"), metadata.version)
    );
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
