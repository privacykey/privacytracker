import { readFileSync } from "node:fs";
import path from "node:path";

const VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;

export function validateVersion(version) {
  if (
    typeof version !== "string" ||
    version.trim() !== version ||
    !VERSION.test(version)
  ) {
    throw new Error(
      "Expected an explicit release version, for example 0.2.0 or 0.2.0-rc.1"
    );
  }
  return version;
}

export function readReleaseMetadata(root) {
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const config = JSON.parse(
    readFileSync(path.join(root, "src-tauri/tauri.conf.json"), "utf8")
  );
  const cargo = readFileSync(path.join(root, "src-tauri/Cargo.toml"), "utf8");
  const lock = readFileSync(path.join(root, "src-tauri/Cargo.lock"), "utf8");
  const cargoVersion = cargo.match(
    /\[package\][\s\S]*?^version = "([^"]+)"/m
  )?.[1];
  const lockVersion = lock.match(
    /\[\[package\]\]\nname = "privacytracker"\nversion = "([^"]+)"/
  )?.[1];
  const version = validateVersion(pkg.version);
  if (
    cargoVersion !== version ||
    lockVersion !== version ||
    config.version !== "../package.json"
  ) {
    throw new Error(
      `Release versions disagree: package=${version}, Cargo=${cargoVersion}, lock=${lockVersion}, Tauri=${config.version}`
    );
  }
  return {
    version,
    tag: `v${version}`,
    minimumMacOSVersion: config.bundle.macOS.minimumSystemVersion,
    pubkey: config.plugins.updater.pubkey,
  };
}

export function validateReleaseTag(tag, metadata) {
  if (tag !== metadata.tag) {
    throw new Error(
      `Tag ${tag} does not match the built application ${metadata.tag}`
    );
  }
}
