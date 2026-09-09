import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  readReleaseMetadata,
  validateReleaseTag,
} from "./release-metadata.mjs";
import { UPDATE_PLATFORMS, validateManifest } from "./updater-manifest.mjs";

const metadata = readReleaseMetadata(process.cwd());
const tag = process.argv[2];
validateReleaseTag(tag, metadata);
const repo = process.env.GITHUB_REPOSITORY ?? "privacykey/privacytracker";
const gh = (...args) => execFileSync("gh", args, { encoding: "utf8" });
const verify = (archive, signature) => {
  const key = path.join("updater", "public-key.txt");
  writeFileSync(key, metadata.pubkey);
  execFileSync(
    "scripts/verify-updater/target/debug/verify-privacytracker-updater",
    [key, signature, archive],
    { stdio: "inherit" }
  );
};
const manifest = {
  version: metadata.version,
  notes: gh("release", "view", tag, "--json", "body", "--jq", ".body"),
  pub_date: new Date().toISOString(),
  platforms: {},
};
for (const [platform, { triple, name }] of Object.entries(UPDATE_PLATFORMS)) {
  const archive = path.join("updater", `updater-${triple}`, name);
  const signature = `${archive}.sig`;
  verify(archive, signature);
  manifest.platforms[platform] = {
    signature: readFileSync(signature, "utf8").trim(),
    url: `https://github.com/${repo}/releases/download/${tag}/${name}`,
  };
}
validateManifest(manifest, metadata.version, repo);
writeFileSync("latest-v2.json", `${JSON.stringify(manifest, null, 2)}\n`);
// v0.1.2 cannot negotiate an OS minimum. Preserve its signed feed unchanged.
// Download from its immutable version, never from /latest (which moves).
mkdirSync("updater/legacy", { recursive: true });
gh(
  "release",
  "download",
  "v0.1.2",
  "--pattern",
  "latest.json",
  "--dir",
  "updater/legacy",
  "--clobber"
);
const legacy = JSON.parse(readFileSync("updater/legacy/latest.json", "utf8"));
validateManifest(legacy, "0.1.2", repo);
for (const [platform, { name }] of Object.entries(UPDATE_PLATFORMS)) {
  gh(
    "release",
    "download",
    "v0.1.2",
    "--pattern",
    name,
    "--dir",
    "updater/legacy",
    "--clobber"
  );
  const archive = path.join("updater/legacy", name);
  writeFileSync(`${archive}.sig`, legacy.platforms[platform].signature);
  verify(archive, `${archive}.sig`);
}
copyFileSync("updater/legacy/latest.json", "latest.json");
