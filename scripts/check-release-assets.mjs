import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  readReleaseMetadata,
  validateReleaseTag,
} from "./release-metadata.mjs";
import { UPDATE_PLATFORMS, validateManifest } from "./updater-manifest.mjs";

const metadata = readReleaseMetadata(process.cwd());
const tag = process.argv[2];
validateReleaseTag(tag, metadata);
const release = JSON.parse(
  execFileSync("gh", ["release", "view", tag, "--json", "isDraft,assets"], {
    encoding: "utf8",
  })
);
if (!release.isDraft) {
  throw new Error("Release must remain a draft during candidate verification");
}
const expected = [
  "latest.json",
  "latest-v2.json",
  "privacytracker_aarch64.app.tar.gz",
  "privacytracker_x64.app.tar.gz",
  `privacytracker_${metadata.version}_aarch64.dmg`,
  `privacytracker_${metadata.version}_x64.dmg`,
];
for (const name of expected) {
  const assets = release.assets.filter(
    (asset) => asset.name === name && asset.size > 0
  );
  if (assets.length !== 1) {
    throw new Error(`Missing or empty release asset: ${name}`);
  }
}
// Re-download the actual draft bytes, verify their updater signatures, and
// leave a digest receipt for the maintainer's manual publication review.
const dir = mkdtempSync(path.join(tmpdir(), "privacytracker-draft-check-"));
try {
  execFileSync("gh", [
    "release",
    "download",
    tag,
    "--dir",
    dir,
    ...expected.flatMap((name) => ["--pattern", name]),
  ]);
  const repo = process.env.GITHUB_REPOSITORY ?? "privacykey/privacytracker";
  const current = JSON.parse(
    readFileSync(path.join(dir, "latest-v2.json"), "utf8")
  );
  const legacy = JSON.parse(
    readFileSync(path.join(dir, "latest.json"), "utf8")
  );
  validateManifest(current, metadata.version, repo);
  validateManifest(legacy, "0.1.2", repo);
  const key = path.join(dir, "public-key");
  writeFileSync(key, metadata.pubkey);
  for (const [platform, { name }] of Object.entries(UPDATE_PLATFORMS)) {
    const archive = path.join(dir, name);
    writeFileSync(`${archive}.sig`, current.platforms[platform].signature);
    execFileSync(
      "scripts/verify-updater/target/debug/verify-privacytracker-updater",
      [key, `${archive}.sig`, archive],
      { stdio: "inherit" }
    );
  }
  const hashes = Object.fromEntries(
    expected.map((name) => [
      name,
      createHash("sha256")
        .update(readFileSync(path.join(dir, name)))
        .digest("hex"),
    ])
  );
  writeFileSync(
    "release-evidence.json",
    `${JSON.stringify({ tag, commit: process.env.GITHUB_SHA ?? execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), verifiedAt: new Date().toISOString(), sha256: hashes }, null, 2)}\n`
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(
  `Draft ${tag} has all six required assets; publication remains manual.`
);
