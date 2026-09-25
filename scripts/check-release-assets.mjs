import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  readReleaseMetadata,
  validateReleaseTag,
} from "./release-metadata.mjs";
import { assertEvidenceDigest, readBuildEvidence } from "./updater-archive.mjs";
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
// Publication ships every asset on the draft, so the draft holds only what
// this check covers.
const unexpected = release.assets
  .map((asset) => asset.name)
  .filter((name) => !expected.includes(name));
if (unexpected.length > 0) {
  throw new Error(`Unexpected release asset: ${unexpected.join(", ")}`);
}
// What each build job recorded about the updater archive it packed from its
// verified bundle and signed (the updater-* artifacts, downloaded here).
const build = Object.fromEntries(
  Object.values(UPDATE_PLATFORMS).map(({ triple, name }) => [
    name,
    readBuildEvidence(path.join("updater", `updater-${triple}`), {
      tag,
      version: metadata.version,
      triple,
      commit: process.env.GITHUB_SHA,
    }),
  ])
);
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
    assertEvidenceDigest(archive, build[name], `The draft's ${name}`);
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
    `${JSON.stringify(
      {
        tag,
        commit:
          process.env.GITHUB_SHA ??
          execFileSync("git", ["rev-parse", "HEAD"], {
            encoding: "utf8",
          }).trim(),
        verifiedAt: new Date().toISOString(),
        sha256: hashes,
        // The updater archives as each build job packed and signed them.
        // `sha256` above must match these.
        build: Object.fromEntries(
          Object.entries(build).map(([name, evidence]) => [
            name,
            {
              target: evidence.target,
              sha256: evidence.sha256,
              size: evidence.size,
              cdhash: evidence.cdhash,
              commit: evidence.commit,
              packedAt: evidence.packedAt,
            },
          ])
        ),
      },
      null,
      2
    )}\n`
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(
  `Draft ${tag} has exactly the six required assets, and its updater archives are the ones the builds verified and signed; publication remains manual.`
);
