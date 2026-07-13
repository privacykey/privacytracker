#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function replaceVersionLine(lines, start, end, version, label) {
  const indexes = [];
  for (let index = start; index < end; index += 1) {
    if (/^version\s*=\s*"[^"]+"/.test(lines[index])) {
      indexes.push(index);
    }
  }
  if (indexes.length !== 1) {
    throw new Error(`${label} must contain exactly one version field`);
  }
  const index = indexes[0];
  lines[index] = lines[index].replace(
    /^(version\s*=\s*")[^"]+(".*)$/,
    (_match, prefix, suffix) => `${prefix}${version}${suffix}`
  );
}

export function syncCargoManifest(text, version) {
  const lines = text.split("\n");
  const start = lines.indexOf("[package]");
  if (start === -1) {
    throw new Error("Cargo.toml is missing [package]");
  }
  const nextSection = lines.findIndex(
    (line, index) => index > start && /^\[.+\]$/.test(line)
  );
  replaceVersionLine(
    lines,
    start + 1,
    nextSection === -1 ? lines.length : nextSection,
    version,
    "Cargo.toml [package]"
  );
  return lines.join("\n");
}

export function syncCargoLock(text, version) {
  const lines = text.split("\n");
  const starts = lines
    .map((line, index) => (line === "[[package]]" ? index : -1))
    .filter((index) => index !== -1);
  const privacytrackerBlocks = starts.filter((start, position) => {
    const end = starts[position + 1] ?? lines.length;
    return lines
      .slice(start + 1, end)
      .some((line) => line === 'name = "privacytracker"');
  });
  if (privacytrackerBlocks.length !== 1) {
    throw new Error(
      "Cargo.lock must contain exactly one privacytracker package block"
    );
  }
  const start = privacytrackerBlocks[0];
  const position = starts.indexOf(start);
  replaceVersionLine(
    lines,
    start + 1,
    starts[position + 1] ?? lines.length,
    version,
    "Cargo.lock privacytracker package"
  );
  return lines.join("\n");
}

async function main() {
  const unexpectedArgs = process.argv
    .slice(2)
    .filter((arg) => arg !== "--check");
  if (unexpectedArgs.length > 0) {
    throw new Error(`Unknown argument: ${unexpectedArgs[0]}`);
  }
  const checkOnly = process.argv.includes("--check");
  const packageJson = JSON.parse(
    await readFile(resolve(ROOT, "package.json"), "utf8")
  );
  const version = packageJson.version;
  if (typeof version !== "string" || !SEMVER.test(version)) {
    throw new Error(`package.json has an invalid semver version: ${version}`);
  }

  const tauriConfig = JSON.parse(
    await readFile(resolve(ROOT, "src-tauri/tauri.conf.json"), "utf8")
  );
  if (tauriConfig.version !== "../package.json") {
    throw new Error(
      'src-tauri/tauri.conf.json must keep version set to "../package.json"'
    );
  }

  const manifestPath = resolve(ROOT, "src-tauri/Cargo.toml");
  const lockPath = resolve(ROOT, "src-tauri/Cargo.lock");
  const [manifest, lock] = await Promise.all([
    readFile(manifestPath, "utf8"),
    readFile(lockPath, "utf8"),
  ]);
  const nextManifest = syncCargoManifest(manifest, version);
  const nextLock = syncCargoLock(lock, version);

  if (checkOnly) {
    if (nextManifest !== manifest || nextLock !== lock) {
      throw new Error(
        `Desktop release metadata does not match package.json ${version}; run node scripts/sync-release-version.mjs`
      );
    }
    console.log(`✓ Release version metadata matches ${version}`);
    return;
  }

  await Promise.all([
    writeFile(manifestPath, nextManifest),
    writeFile(lockPath, nextLock),
  ]);
  console.log(`✓ Desktop release metadata synced to ${version}`);
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
