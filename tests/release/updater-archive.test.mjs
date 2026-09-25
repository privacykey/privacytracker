import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readReleaseMetadata } from "../../scripts/release-metadata.mjs";
import {
  APP_DIR,
  BUILD_EVIDENCE,
  packUpdaterArchive,
  readTarEntries,
  sha256File,
  validateUpdaterEntries,
} from "../../scripts/updater-archive.mjs";
import { UPDATE_PLATFORMS } from "../../scripts/updater-manifest.mjs";
import {
  installFakeTools,
  putAsset,
  readState,
  writeState,
} from "./fake-tools.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const cli = path.join(root, "node_modules/@tauri-apps/cli/tauri.js");
const verifier = path.join(
  root,
  "scripts/verify-updater/target/debug/verify-privacytracker-updater"
);
const PASSWORD = "release-test-password";
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const PLATFORMS = Object.values(UPDATE_PLATFORMS);

function tauri(...args) {
  return execFileSync(process.execPath, [cli, "signer", ...args], {
    stdio: "pipe",
    env: { ...process.env, CI: "true" },
  });
}

let keys;
/**
 * Made once for the whole file, since each takes a CLI run: the updater key
 * the fixture's app trusts, another key, and v0.1.2's signed legacy feed.
 */
function signingKeys() {
  if (!keys) {
    const dir = mkdtempSync(path.join(tmpdir(), "release-chain-keys-"));
    const make = (name) => {
      const key = path.join(dir, name);
      tauri("generate", "--ci", "-p", PASSWORD, "-w", key);
      return {
        file: key,
        secret: readFileSync(key, "utf8").trim(),
        pubkey: readFileSync(`${key}.pub`, "utf8").trim(),
      };
    };
    const release = make("release.key");
    const legacy = {
      feed: {
        version: "0.1.2",
        notes: "Old.",
        pub_date: "2026-06-12T00:00:00Z",
        platforms: {},
      },
      archives: {},
    };
    for (const [platform, { name }] of Object.entries(UPDATE_PLATFORMS)) {
      const archive = path.join(dir, name);
      writeFileSync(archive, `legacy ${platform}`);
      tauri("sign", "-f", release.file, "-p", PASSWORD, archive);
      legacy.archives[name] = readFileSync(archive);
      legacy.feed.platforms[platform] = {
        signature: readFileSync(`${archive}.sig`, "utf8").trim(),
        url: `https://github.com/privacykey/privacytracker/releases/download/v0.1.2/${name}`,
      };
    }
    keys = { dir, release, other: make("other.key"), legacy };
  }
  return keys;
}
test.after(() => {
  if (keys) {
    rmSync(keys.dir, { recursive: true, force: true });
  }
});

/** A minimal app bundle, distinct per target. */
function makeApp(app, label) {
  mkdirSync(path.join(app, "Contents/MacOS"), { recursive: true });
  mkdirSync(path.join(app, "Contents/Resources/site"), { recursive: true });
  writeFileSync(
    path.join(app, "Contents/Info.plist"),
    `<plist>${label}</plist>`
  );
  writeFileSync(
    path.join(app, "Contents/MacOS/privacytracker"),
    `executable for ${label}`
  );
  chmodSync(path.join(app, "Contents/MacOS/privacytracker"), 0o755);
  writeFileSync(
    path.join(app, "Contents/Resources/site/index.html"),
    "<html></html>"
  );
  symlinkSync("site", path.join(app, "Contents/Resources/current"));
  if (process.platform === "darwin") {
    // What a build leaves on files; it must not reach the archive.
    execFileSync("xattr", [
      "-w",
      "org.privacykey.test",
      "metadata",
      path.join(app, "Contents/Info.plist"),
    ]);
  }
  return app;
}

/**
 * A checkout the release scripts can run in, whose tauri.conf.json trusts
 * the test key, with gh, codesign and xcrun replaced, a draft release as
 * tauri-action leaves it and the v0.1.2 release the legacy feed comes from.
 */
function releaseFixture(t) {
  const { release, legacy } = signingKeys();
  const dir = mkdtempSync(path.join(tmpdir(), "release-chain-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, "src-tauri"));
  for (const file of [
    "package.json",
    "src-tauri/Cargo.toml",
    "src-tauri/Cargo.lock",
  ]) {
    cpSync(path.join(root, file), path.join(dir, file));
  }
  const config = JSON.parse(
    readFileSync(path.join(root, "src-tauri/tauri.conf.json"), "utf8")
  );
  config.plugins.updater.pubkey = release.pubkey;
  writeFileSync(
    path.join(dir, "src-tauri/tauri.conf.json"),
    JSON.stringify(config)
  );
  const verifierDir = path.join(dir, "scripts/verify-updater/target/debug");
  mkdirSync(verifierDir, { recursive: true });
  symlinkSync(
    realpathSync(verifier),
    path.join(verifierDir, "verify-privacytracker-updater")
  );
  const bin = path.join(dir, "bin");
  const fakeToolsEnv = installFakeTools(bin);
  const metadata = readReleaseMetadata(dir);
  const { tag, version } = metadata;
  for (const { triple } of PLATFORMS) {
    makeApp(path.join(dir, "bundle", triple, APP_DIR), triple);
  }

  const state = path.join(dir, "gh", "state.json");
  mkdirSync(path.dirname(state));
  writeState(state, {
    releases: {
      [tag]: { isDraft: true, body: "The summary.", assets: {} },
      "v0.1.2": { isDraft: false, body: "Old.", assets: {} },
    },
  });
  for (const arch of ["aarch64", "x64"]) {
    putAsset(
      state,
      tag,
      `privacytracker_${version}_${arch}.dmg`,
      `dmg ${arch}`
    );
    // tauri-action's own tar of the app, under its versioned name.
    putAsset(
      state,
      tag,
      `privacytracker_${version}_${arch}.app.tar.gz`,
      `tauri-action tar ${arch}`
    );
  }
  for (const [name, bytes] of Object.entries(legacy.archives)) {
    putAsset(state, "v0.1.2", name, bytes);
  }
  putAsset(state, "v0.1.2", "latest.json", JSON.stringify(legacy.feed));

  const log = path.join(dir, "calls.jsonl");
  const env = {
    ...process.env,
    ...fakeToolsEnv,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    CALL_LOG: log,
    FAKE_GH_STATE: state,
    GITHUB_SHA: COMMIT,
    GITHUB_REPOSITORY: "privacykey/privacytracker",
    TAURI_SIGNING_PRIVATE_KEY: release.secret,
    TAURI_SIGNING_PRIVATE_KEY_PASSWORD: PASSWORD,
  };
  for (const key of ["RELEASE_DRY_RUN", "GH_REPO"]) {
    delete env[key];
  }
  const run = (script, args, extra = {}) =>
    spawnSync(process.execPath, [path.join(root, "scripts", script), ...args], {
      cwd: dir,
      encoding: "utf8",
      env: { ...env, ...extra },
    });
  const calls = () =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
      : [];
  const draftAssets = () => readState(state).releases[tag].assets;
  return { dir, tag, version, state, run, calls, draftAssets };
}

function ok(result) {
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result;
}

function stage(fx, triple, extra) {
  return fx.run(
    "stage-updater-archive.mjs",
    [
      fx.tag,
      triple,
      path.join("bundle", triple, APP_DIR),
      path.join("updater-stage", triple),
    ],
    extra
  );
}

function upload(fx, triple, extra) {
  return fx.run(
    "upload-updater-archive.mjs",
    [fx.tag, triple, path.join("updater-stage", triple)],
    extra
  );
}

/** The build job for both targets, then the artifact download. */
function buildBoth(fx) {
  for (const { triple } of PLATFORMS) {
    ok(stage(fx, triple));
    ok(upload(fx, triple));
    cpSync(
      path.join(fx.dir, "updater-stage", triple),
      path.join(fx.dir, "updater", `updater-${triple}`),
      { recursive: true }
    );
  }
}

/** What the assemble job does after assemble-updater.mjs. */
function publishFeeds(fx) {
  for (const feed of ["latest.json", "latest-v2.json"]) {
    putAsset(fx.state, fx.tag, feed, readFileSync(path.join(fx.dir, feed)));
  }
}

test("the updater archive holds only the app, with no macOS metadata", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "updater-archive-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const app = makeApp(path.join(dir, APP_DIR), "test");
  const archive = path.join(dir, "packed.app.tar.gz");
  packUpdaterArchive(app, archive);
  const entries = readTarEntries(readFileSync(archive));
  assert.equal(validateUpdaterEntries(entries), 3);
  assert.deepEqual(
    entries.map((entry) => entry.path.replace(/\/$/, "")).sort(),
    [
      APP_DIR,
      `${APP_DIR}/Contents`,
      `${APP_DIR}/Contents/Info.plist`,
      `${APP_DIR}/Contents/MacOS`,
      `${APP_DIR}/Contents/MacOS/privacytracker`,
      `${APP_DIR}/Contents/Resources`,
      `${APP_DIR}/Contents/Resources/current`,
      `${APP_DIR}/Contents/Resources/site`,
      `${APP_DIR}/Contents/Resources/site/index.html`,
    ]
  );
  assert.ok(entries.every((entry) => entry.xattrs.length === 0));
});

test("a plain macOS tar of the app is refused as an updater archive", {
  skip: process.platform !== "darwin" && "macOS tar only",
}, (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "updater-archive-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  makeApp(path.join(dir, APP_DIR), "test");
  const archive = path.join(dir, "plain.app.tar.gz");
  // How tauri-action packs the app when no updater archive exists.
  execFileSync("/usr/bin/tar", ["czf", archive, "-C", dir, APP_DIR]);
  assert.throws(
    () => validateUpdaterEntries(readTarEntries(readFileSync(archive))),
    /macOS metadata|extended attributes/
  );
});

test("updater archive entries may not leave the app or omit it", () => {
  const file = (entryPath) => ({
    path: entryPath,
    type: "0",
    size: 1,
    linkname: "",
    xattrs: [],
  });
  const base = [
    { ...file(`${APP_DIR}/`), type: "5" },
    file(`${APP_DIR}/Contents/Info.plist`),
    file(`${APP_DIR}/Contents/MacOS/privacytracker`),
  ];
  assert.equal(validateUpdaterEntries(base), 2);
  for (const [entries, message] of [
    [[...base, file("other.app/Contents/Info.plist")], /outside/],
    [[...base, file(`/${APP_DIR}/x`)], /outside/],
    [[...base, file(`${APP_DIR}/../escape`)], /unsafe/],
    [[...base, file(`${APP_DIR}/Contents/._Info.plist`)], /metadata/],
    [
      [
        ...base,
        { ...file(`${APP_DIR}/Contents/x`), xattrs: ["SCHILY.xattr.a"] },
      ],
      /extended attributes/,
    ],
    [
      [
        ...base,
        { ...file(`${APP_DIR}/Contents/link`), type: "2", linkname: "../../x" },
      ],
      /leaves/,
    ],
    [
      [
        ...base,
        { ...file(`${APP_DIR}/Contents/link`), type: "2", linkname: "/etc" },
      ],
      /leaves/,
    ],
    [[...base, { ...file(`${APP_DIR}/Contents/dev`), type: "3" }], /type/],
    [base.slice(0, 2), /missing/],
  ]) {
    assert.throws(() => validateUpdaterEntries(entries), message);
  }
});

test("the release signs the archive packed from the verified bundle, and the draft carries exactly that", (t) => {
  const fx = releaseFixture(t);
  const [arm, intel] = PLATFORMS;

  ok(stage(fx, arm.triple));
  const staged = path.join(fx.dir, "updater-stage", arm.triple);
  const archive = path.join(staged, arm.name);
  const evidence = JSON.parse(
    readFileSync(path.join(staged, BUILD_EVIDENCE), "utf8")
  );
  assert.equal(evidence.sha256, sha256File(archive));
  assert.equal(evidence.tag, fx.tag);
  assert.equal(evidence.target, arm.triple);
  assert.equal(evidence.asset, arm.name);
  assert.equal(evidence.commit, COMMIT);
  assert.equal(evidence.dryRun, false);
  // The signature is over these bytes and made with the app's key.
  const key = path.join(fx.dir, "public-key");
  writeFileSync(key, signingKeys().release.pubkey);
  execFileSync(verifier, [key, `${archive}.sig`, archive]);
  // Both the bundle and the unpacked copy were checked, and the staple.
  const codesigned = fx.calls().filter((call) => call[0] === "codesign");
  assert.ok(
    codesigned.some((call) => call.at(-1).endsWith(`${arm.triple}/${APP_DIR}`))
  );
  assert.ok(
    codesigned.some((call) => call.at(-1).includes("privacytracker-updater-"))
  );
  assert.ok(
    fx.calls().some((call) => call[0] === "xcrun" && call[1] === "stapler")
  );
  // Nothing of this was downloaded from the draft.
  assert.ok(!fx.calls().some((call) => call[0] === "gh"));

  ok(upload(fx, arm.triple));
  let assets = fx.draftAssets();
  assert.equal(sha256File(assets[arm.name]), evidence.sha256);
  assert.ok(!(`privacytracker_${fx.version}_aarch64.app.tar.gz` in assets));
  // The other platform's build owns its own assets.
  assert.ok(`privacytracker_${fx.version}_x64.app.tar.gz` in assets);
  assert.ok(
    fx
      .calls()
      .some(
        (call) =>
          call[0] === "gh" && call[2] === "upload" && call.includes("--clobber")
      )
  );

  ok(stage(fx, intel.triple));
  ok(upload(fx, intel.triple));
  for (const { triple } of PLATFORMS) {
    cpSync(
      path.join(fx.dir, "updater-stage", triple),
      path.join(fx.dir, "updater", `updater-${triple}`),
      { recursive: true }
    );
  }
  ok(fx.run("assemble-updater.mjs", [fx.tag]));
  const feed = JSON.parse(
    readFileSync(path.join(fx.dir, "latest-v2.json"), "utf8")
  );
  for (const [platform, { triple, name }] of Object.entries(UPDATE_PLATFORMS)) {
    assert.equal(
      feed.platforms[platform].signature,
      readFileSync(
        path.join(fx.dir, "updater-stage", triple, `${name}.sig`),
        "utf8"
      ).trim()
    );
  }
  publishFeeds(fx);

  ok(fx.run("check-release-assets.mjs", [fx.tag]));
  assets = fx.draftAssets();
  assert.deepEqual(
    Object.keys(assets).sort(),
    [
      "latest-v2.json",
      "latest.json",
      "privacytracker_aarch64.app.tar.gz",
      `privacytracker_${fx.version}_aarch64.dmg`,
      `privacytracker_${fx.version}_x64.dmg`,
      "privacytracker_x64.app.tar.gz",
    ].sort()
  );
  const receipt = JSON.parse(
    readFileSync(path.join(fx.dir, "release-evidence.json"), "utf8")
  );
  for (const { triple, name } of PLATFORMS) {
    const recorded = JSON.parse(
      readFileSync(
        path.join(fx.dir, "updater-stage", triple, BUILD_EVIDENCE),
        "utf8"
      )
    );
    assert.equal(receipt.build[name].sha256, recorded.sha256);
    assert.equal(receipt.sha256[name], recorded.sha256);
  }
});

test("a draft archive replaced after the build is refused before it is signed into a feed", (t) => {
  const fx = releaseFixture(t);
  buildBoth(fx);
  const [arm] = PLATFORMS;
  const genuine = readFileSync(fx.draftAssets()[arm.name]);
  putAsset(fx.state, fx.tag, arm.name, "replacement bytes");

  const assembled = fx.run("assemble-updater.mjs", [fx.tag]);
  assert.notEqual(assembled.status, 0);
  assert.match(
    assembled.stderr,
    /draft's privacytracker_aarch64\.app\.tar\.gz is not the archive the aarch64-apple-darwin build verified and signed/
  );
  assert.ok(!existsSync(path.join(fx.dir, "latest-v2.json")));

  // Put it back, assemble, and replace it again before the draft check.
  putAsset(fx.state, fx.tag, arm.name, genuine);
  ok(fx.run("assemble-updater.mjs", [fx.tag]));
  publishFeeds(fx);
  putAsset(fx.state, fx.tag, arm.name, "replacement bytes");
  const checked = fx.run("check-release-assets.mjs", [fx.tag]);
  assert.notEqual(checked.status, 0);
  assert.match(
    checked.stderr,
    /is not the archive the aarch64-apple-darwin build/
  );
  assert.ok(!existsSync(path.join(fx.dir, "release-evidence.json")));
});

test("assembly refuses an artifact that differs from the build's record, or no record", (t) => {
  const fx = releaseFixture(t);
  buildBoth(fx);
  const [, intel] = PLATFORMS;
  const artifact = path.join(fx.dir, "updater", `updater-${intel.triple}`);
  writeFileSync(path.join(artifact, intel.name), "altered artifact");
  const altered = fx.run("assemble-updater.mjs", [fx.tag]);
  assert.notEqual(altered.status, 0);
  assert.match(
    altered.stderr,
    /x86_64-apple-darwin build artifact is not the archive/
  );

  rmSync(path.join(artifact, BUILD_EVIDENCE));
  const missing = fx.run("assemble-updater.mjs", [fx.tag]);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /Missing build evidence/);
});

test("the draft check refuses any asset it does not cover", (t) => {
  const fx = releaseFixture(t);
  buildBoth(fx);
  ok(fx.run("assemble-updater.mjs", [fx.tag]));
  publishFeeds(fx);
  putAsset(fx.state, fx.tag, "privacytracker_extra.app.tar.gz", "extra");
  const checked = fx.run("check-release-assets.mjs", [fx.tag]);
  assert.notEqual(checked.status, 0);
  assert.match(
    checked.stderr,
    /Unexpected release asset: privacytracker_extra/
  );
});

test("the upload refuses a published release and a draft that does not read back the same", (t) => {
  const fx = releaseFixture(t);
  const [arm] = PLATFORMS;
  ok(stage(fx, arm.triple));

  const state = readState(fx.state);
  state.releases[fx.tag].isDraft = false;
  writeState(fx.state, state);
  const published = upload(fx, arm.triple);
  assert.notEqual(published.status, 0);
  assert.match(published.stderr, /already published/);
  assert.ok(
    !fx.calls().some((call) => call[0] === "gh" && call[2] === "upload")
  );

  state.releases[fx.tag].isDraft = true;
  writeState(fx.state, state);
  const corrupted = upload(fx, arm.triple, {
    FAKE_GH_CORRUPT_DOWNLOAD: arm.name,
  });
  assert.notEqual(corrupted.status, 0);
  assert.match(
    corrupted.stderr,
    /draft's privacytracker_aarch64\.app\.tar\.gz is not the archive/
  );

  const otherCommit = upload(fx, arm.triple, { GITHUB_SHA: "f".repeat(40) });
  assert.notEqual(otherCommit.status, 0);
  assert.match(otherCommit.stderr, /does not describe/);
});

test("staging stops when the packed app is not the verified one or the key is not the app's", (t) => {
  const fx = releaseFixture(t);
  const [arm] = PLATFORMS;
  const evidence = path.join(
    fx.dir,
    "updater-stage",
    arm.triple,
    BUILD_EVIDENCE
  );

  const mismatch = stage(fx, arm.triple, { FAKE_CDHASH_MISMATCH: "1" });
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /not the app that was verified/);
  assert.ok(!existsSync(evidence));

  const noKey = stage(fx, arm.triple, { TAURI_SIGNING_PRIVATE_KEY: "" });
  assert.notEqual(noKey.status, 0);
  assert.match(noKey.stderr, /TAURI_SIGNING_PRIVATE_KEY is not set/);
  assert.ok(!existsSync(evidence));

  const wrongKey = stage(fx, arm.triple, {
    TAURI_SIGNING_PRIVATE_KEY: signingKeys().other.secret,
  });
  assert.notEqual(wrongKey.status, 0);
  assert.ok(!existsSync(evidence));
});

test("a dry run signs and records its archive, and that record is never accepted for a release", (t) => {
  const fx = releaseFixture(t);
  const [arm] = PLATFORMS;
  ok(stage(fx, arm.triple, { RELEASE_DRY_RUN: "1" }));
  const staged = path.join(fx.dir, "updater-stage", arm.triple);
  const evidence = JSON.parse(
    readFileSync(path.join(staged, BUILD_EVIDENCE), "utf8")
  );
  assert.equal(evidence.dryRun, true);
  assert.ok(existsSync(path.join(staged, `${arm.name}.sig`)));
  // An unnotarised rehearsal has no staple to validate.
  assert.ok(!fx.calls().some((call) => call[0] === "xcrun"));
  const refused = upload(fx, arm.triple);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /does not describe/);
});
