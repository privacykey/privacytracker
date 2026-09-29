// Packs the updater archive from the bundle scripts/verify-macos-bundle.mjs
// has just verified, checks what landed in it, signs it with the updater
// key and records its SHA-256 in build-evidence.json. The release uploads
// this file; it never signs anything it downloaded.
//
// node scripts/stage-updater-archive.mjs <tag> <target-triple> <app> <out-dir>
//
// Needs TAURI_SIGNING_PRIVATE_KEY (and its password, if it has one) and the
// verifier built from scripts/verify-updater.
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  readReleaseMetadata,
  validateReleaseTag,
} from "./release-metadata.mjs";
import {
  APP_DIR,
  BUILD_EVIDENCE,
  packUpdaterArchive,
  readTarEntries,
  sha256File,
  updaterPlatformForTriple,
  validateUpdaterEntries,
} from "./updater-archive.mjs";

const [tag, triple, appArg, outArg] = process.argv.slice(2);
if (!(tag && triple && appArg && outArg)) {
  console.error(
    "Usage: stage-updater-archive.mjs <tag> <target-triple> <app> <out-dir>"
  );
  process.exit(2);
}
const metadata = readReleaseMetadata(process.cwd());
validateReleaseTag(tag, metadata);
const { platform, name } = updaterPlatformForTriple(triple);
const app = path.resolve(appArg);
const out = path.resolve(outArg);
const dryRun = process.env.RELEASE_DRY_RUN === "1";
if (!process.env.TAURI_SIGNING_PRIVATE_KEY) {
  throw new Error("TAURI_SIGNING_PRIVATE_KEY is not set");
}

const tar = process.platform === "darwin" ? "/usr/bin/tar" : "tar";

/** Verifies a bundle's signature and returns its code directory hash. */
function codeDirectoryHash(bundle) {
  execFileSync("codesign", ["--verify", "--deep", "--strict", bundle], {
    stdio: "inherit",
  });
  const shown = spawnSync("codesign", ["--display", "--verbose=4", bundle], {
    encoding: "utf8",
  });
  const match = `${shown.stdout}\n${shown.stderr}`.match(
    /^CDHash=([0-9a-f]+)$/m
  );
  if (shown.status !== 0 || !match) {
    throw new Error(`codesign reported no CDHash for ${bundle}`);
  }
  return match[1];
}

// The smoke test ran the app after verification; check its signature again
// right before its bytes are packed.
const cdhash = codeDirectoryHash(app);

mkdirSync(out, { recursive: true });
const archive = path.join(out, name);
for (const stale of [
  archive,
  `${archive}.sig`,
  path.join(out, BUILD_EVIDENCE),
]) {
  rmSync(stale, { force: true });
}
packUpdaterArchive(app, archive);
const files = validateUpdaterEntries(readTarEntries(readFileSync(archive)));

const scratch = mkdtempSync(path.join(tmpdir(), "privacytracker-updater-"));
try {
  // Unpacked, the archive must be the same signed app: an intact seal and
  // the same code directory hash as the bundle that was verified.
  const extracted = path.join(scratch, "extracted");
  mkdirSync(extracted);
  execFileSync(tar, ["-xzf", archive, "-C", extracted], { stdio: "inherit" });
  const copy = path.join(extracted, APP_DIR);
  if (codeDirectoryHash(copy) !== cdhash) {
    throw new Error("The packed app is not the app that was verified");
  }
  if (!dryRun) {
    execFileSync("xcrun", ["stapler", "validate", copy], { stdio: "inherit" });
  }

  // Sign these bytes, then check the signature against the public key the
  // shipped app trusts before anything is uploaded.
  execFileSync(
    process.execPath,
    [
      path.join(
        import.meta.dirname,
        "../node_modules/@tauri-apps/cli/tauri.js"
      ),
      "signer",
      "sign",
      archive,
    ],
    { stdio: "inherit", env: { ...process.env, CI: "true" } }
  );
  const key = path.join(scratch, "updater-public-key");
  writeFileSync(key, metadata.pubkey);
  execFileSync(
    "scripts/verify-updater/target/debug/verify-privacytracker-updater",
    [key, `${archive}.sig`, archive],
    { stdio: "inherit" }
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

const evidence = {
  schema: 1,
  tag,
  version: metadata.version,
  commit:
    process.env.GITHUB_SHA ??
    execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  target: triple,
  platform,
  asset: name,
  sha256: sha256File(archive),
  size: statSync(archive).size,
  cdhash,
  files,
  dryRun,
  packedAt: new Date().toISOString(),
};
writeFileSync(
  path.join(out, BUILD_EVIDENCE),
  `${JSON.stringify(evidence, null, 2)}\n`
);
console.log(
  `Packed and signed ${name} (${files} files, sha256 ${evidence.sha256}) from the verified ${triple} bundle.`
);
