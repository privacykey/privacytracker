// Uploads the updater archive stage-updater-archive.mjs packed and signed
// to the draft release, removes any other updater archive for the same
// platform, and reads the upload back to confirm the draft holds exactly
// the bytes the build recorded.
//
// node scripts/upload-updater-archive.mjs <tag> <target-triple> <stage-dir>
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  readReleaseMetadata,
  validateReleaseTag,
} from "./release-metadata.mjs";
import { assertEvidenceDigest, readBuildEvidence } from "./updater-archive.mjs";

const [tag, triple, stageArg] = process.argv.slice(2);
if (!(tag && triple && stageArg)) {
  console.error(
    "Usage: upload-updater-archive.mjs <tag> <target-triple> <stage-dir>"
  );
  process.exit(2);
}
const metadata = readReleaseMetadata(process.cwd());
validateReleaseTag(tag, metadata);
const stage = path.resolve(stageArg);
const evidence = readBuildEvidence(stage, {
  tag,
  version: metadata.version,
  triple,
  commit: process.env.GITHUB_SHA,
});
const name = evidence.asset;
const archive = path.join(stage, name);
assertEvidenceDigest(archive, evidence, `The staged ${name}`);

const gh = (...args) => execFileSync("gh", args, { encoding: "utf8" });
const release = JSON.parse(
  gh("release", "view", tag, "--json", "isDraft,assets")
);
if (!release.isDraft) {
  throw new Error("Refusing to alter an already published release");
}
gh("release", "upload", tag, archive, "--clobber");

// tauri-action uploads its own archive of the app, named with the version
// (privacytracker_<version>_aarch64.app.tar.gz). Nothing verified or signed
// those bytes and the update feed never names them, so the draft keeps one
// updater archive per platform: the one uploaded above.
const suffix = name.slice(name.lastIndexOf("_"));
for (const asset of release.assets) {
  const other =
    asset.name !== name &&
    (asset.name.endsWith(suffix) || asset.name.endsWith(`${suffix}.sig`));
  if (other) {
    console.log(`Removing ${asset.name} from the draft`);
    gh("release", "delete-asset", tag, asset.name, "--yes");
  }
}

const readBack = mkdtempSync(path.join(tmpdir(), "privacytracker-upload-"));
try {
  gh("release", "download", tag, "--pattern", name, "--dir", readBack);
  assertEvidenceDigest(
    path.join(readBack, name),
    evidence,
    `The draft's ${name}`
  );
} finally {
  rmSync(readBack, { recursive: true, force: true });
}
console.log(
  `Draft ${tag} holds the verified ${name} (sha256 ${evidence.sha256}).`
);
