// The updater archive: the gzipped app bundle the desktop app installs when
// it updates itself. The release signs it with the updater key, so the bytes
// that key signs must be the bundle the release verified. The build job packs
// the archive from its own verified bundle, signs it there and records its
// SHA-256 in build-evidence.json. Every later step compares the draft's
// asset with that record and stops on any difference, so the draft asset
// is never the input to signing.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { UPDATE_PLATFORMS } from "./updater-manifest.mjs";

/**
 * The one directory at the root of an updater archive. tauri-plugin-updater
 * drops the first path component of every entry when it installs, so
 * anything outside this directory, or a second top-level entry, would land
 * in the wrong place.
 */
export const APP_DIR = "privacytracker.app";

/** Written next to the archive by the build job. */
export const BUILD_EVIDENCE = "build-evidence.json";

const SHA256 = /^[0-9a-f]{64}$/;

/** The updater platform a Rust target triple builds. */
export function updaterPlatformForTriple(triple) {
  for (const [platform, entry] of Object.entries(UPDATE_PLATFORMS)) {
    if (entry.triple === triple) {
      return { platform, triple, name: entry.name };
    }
  }
  throw new Error(`No updater platform for target ${triple}`);
}

export function sha256File(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/**
 * Packs `app` (a directory named APP_DIR) into a gzipped tar at `archive`.
 * macOS tar would otherwise add AppleDouble `._` entries and extended
 * attribute records, which the updater would install as stray files inside
 * the signed bundle. /usr/bin/tar is always bsdtar on macOS, whatever else
 * is on PATH.
 */
export function packUpdaterArchive(app, archive) {
  if (path.basename(app) !== APP_DIR) {
    throw new Error(`Expected a bundle named ${APP_DIR}, got ${app}`);
  }
  const darwin = process.platform === "darwin";
  execFileSync(
    darwin ? "/usr/bin/tar" : "tar",
    [
      ...(darwin
        ? ["--no-mac-metadata", "--no-xattrs", "--no-acls", "--no-fflags"]
        : []),
      "-czf",
      archive,
      "-C",
      path.dirname(app),
      APP_DIR,
    ],
    { env: { ...process.env, COPYFILE_DISABLE: "1" }, stdio: "inherit" }
  );
}

function tarNumber(field) {
  if (field[0] & 0x80) {
    throw new Error("Archive entry too large");
  }
  const text = field
    .toString("latin1")
    .replace(/[\0 ]+/g, " ")
    .trim();
  if (text === "") {
    return 0;
  }
  if (!/^[0-7]+$/.test(text)) {
    throw new Error(`Invalid number in archive header: ${text}`);
  }
  return Number.parseInt(text, 8);
}

function tarString(header, start, length) {
  const raw = header.subarray(start, start + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end < 0 ? length : end).toString("utf8");
}

function paxRecords(body) {
  const records = {};
  let offset = 0;
  while (offset < body.length) {
    const space = body.indexOf(0x20, offset);
    if (space < 0) {
      break;
    }
    const length = Number.parseInt(
      body.subarray(offset, space).toString("latin1"),
      10
    );
    if (!Number.isInteger(length) || length <= 0) {
      throw new Error("Invalid extended header in archive");
    }
    const record = body
      .subarray(space + 1, offset + length - 1)
      .toString("utf8");
    const equals = record.indexOf("=");
    records[record.slice(0, equals)] = record.slice(equals + 1);
    offset += length;
  }
  return records;
}

/**
 * Every entry of a gzipped tar, as a tar reader that does not interpret
 * macOS metadata sees it. bsdtar folds `._` entries back into the files they
 * describe when it lists or extracts, which is why this reads the headers
 * itself: tauri-plugin-updater does not fold them.
 */
export function readTarEntries(gzipped) {
  const data = gunzipSync(gzipped);
  const entries = [];
  let offset = 0;
  let pax = {};
  let globalPax = {};
  let longName = null;
  let longLink = null;
  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      return entries;
    }
    let sum = 0;
    for (let i = 0; i < 512; i++) {
      sum += i >= 148 && i < 156 ? 0x20 : header[i];
    }
    if (sum !== tarNumber(header.subarray(148, 156))) {
      throw new Error("Corrupt archive header");
    }
    const size = tarNumber(header.subarray(124, 136));
    const type = header[156] === 0 ? "0" : String.fromCharCode(header[156]);
    const body = data.subarray(offset + 512, offset + 512 + size);
    if (body.length !== size) {
      throw new Error("Truncated archive");
    }
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") {
      pax = paxRecords(body);
      continue;
    }
    if (type === "g") {
      globalPax = { ...globalPax, ...paxRecords(body) };
      continue;
    }
    if (type === "L" || type === "K") {
      const value = tarString(body, 0, body.length);
      if (type === "L") {
        longName = value;
      } else {
        longLink = value;
      }
      continue;
    }
    // Only POSIX ustar has a name prefix there; GNU tar keeps other fields
    // at that offset.
    const prefix =
      header.subarray(257, 263).toString("latin1") === "ustar\0"
        ? tarString(header, 345, 155)
        : "";
    const name = tarString(header, 0, 100);
    const records = { ...globalPax, ...pax };
    entries.push({
      path: records.path ?? longName ?? (prefix ? `${prefix}/${name}` : name),
      type,
      size,
      linkname: records.linkpath ?? longLink ?? tarString(header, 157, 100),
      xattrs: Object.keys(records).filter((key) => /xattr/i.test(key)),
    });
    pax = {};
    longName = null;
    longLink = null;
  }
  throw new Error("Archive has no end marker");
}

/**
 * Checks an updater archive's entries: one APP_DIR at the root, no macOS
 * metadata, no paths that could leave it, and the bundle's executable and
 * Info.plist present. Returns the number of files.
 */
export function validateUpdaterEntries(entries) {
  const seen = new Set();
  let files = 0;
  for (const entry of entries) {
    const entryPath = entry.path.replace(/^\.\//, "").replace(/\/+$/, "");
    const parts = entryPath.split("/");
    if (parts.some((part) => part.startsWith("._"))) {
      throw new Error(`Archive carries macOS metadata: ${entry.path}`);
    }
    if (entryPath.startsWith("/") || parts[0] !== APP_DIR) {
      throw new Error(`Archive entry outside ${APP_DIR}: ${entry.path}`);
    }
    if (parts.some((part) => part === ".." || part === "")) {
      throw new Error(`Archive entry with an unsafe path: ${entry.path}`);
    }
    if (entry.xattrs.length > 0) {
      throw new Error(`Archive carries extended attributes: ${entry.path}`);
    }
    if (entry.type === "2" || entry.type === "1") {
      const target =
        entry.type === "2"
          ? path.posix.join(path.posix.dirname(entryPath), entry.linkname)
          : path.posix.normalize(entry.linkname);
      if (
        entry.linkname.startsWith("/") ||
        !(target === APP_DIR || target.startsWith(`${APP_DIR}/`))
      ) {
        throw new Error(`Archive link leaves ${APP_DIR}: ${entry.path}`);
      }
    } else if (entry.type === "0" || entry.type === "7") {
      files++;
    } else if (entry.type !== "5") {
      throw new Error(
        `Unexpected archive entry type ${entry.type}: ${entry.path}`
      );
    }
    seen.add(`${entry.type === "7" ? "0" : entry.type}:${entryPath}`);
  }
  for (const required of [
    `${APP_DIR}/Contents/Info.plist`,
    `${APP_DIR}/Contents/MacOS/privacytracker`,
  ]) {
    if (!seen.has(`0:${required}`)) {
      throw new Error(`Archive is missing ${required}`);
    }
  }
  return files;
}

/**
 * Reads and checks the build's record of the archive it signed. A dry run's
 * record is refused: its app was never notarised.
 */
export function readBuildEvidence(dir, { tag, version, triple, commit }) {
  const file = path.join(dir, BUILD_EVIDENCE);
  if (!existsSync(file)) {
    throw new Error(`Missing build evidence: ${file}`);
  }
  const evidence = JSON.parse(readFileSync(file, "utf8"));
  const { name } = updaterPlatformForTriple(triple);
  if (
    evidence.schema !== 1 ||
    evidence.tag !== tag ||
    evidence.version !== version ||
    evidence.target !== triple ||
    evidence.asset !== name ||
    typeof evidence.sha256 !== "string" ||
    !SHA256.test(evidence.sha256) ||
    evidence.dryRun !== false ||
    (commit && evidence.commit !== commit)
  ) {
    throw new Error(
      `Build evidence in ${file} does not describe ${name} for ${tag} (${triple})`
    );
  }
  return evidence;
}

/** Refuses `file` unless its bytes are the ones the build recorded. */
export function assertEvidenceDigest(file, evidence, what) {
  const actual = sha256File(file);
  if (actual !== evidence.sha256) {
    throw new Error(
      `${what} is not the archive the ${evidence.target} build verified and signed (sha256 ${actual}, recorded ${evidence.sha256})`
    );
  }
}
