import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { minimumMacOSVersions } from "../../scripts/macos-binary-checks.mjs";
import {
  RELEASE_NOTES_END,
  readReleaseMetadata,
  validateReleaseTag,
  validateVersion,
} from "../../scripts/release-metadata.mjs";
import { validateSigningEnvironment } from "../../scripts/signing-environment.mjs";
import {
  UPDATE_PLATFORMS,
  validateManifest,
} from "../../scripts/updater-manifest.mjs";

const root = path.resolve(import.meta.dirname, "../..");
test("release preparation updates all versions and rolls curated notes forward", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "release-test-"));
  try {
    mkdirSync(path.join(dir, "src-tauri"));
    for (const file of [
      "package.json",
      "src-tauri/Cargo.toml",
      "src-tauri/Cargo.lock",
      "src-tauri/tauri.conf.json",
      "CHANGELOG.md",
    ]) {
      cpSync(path.join(root, file), path.join(dir, file));
    }
    const before = readReleaseMetadata(dir);
    const next = "9.8.7-rc.1";
    execFileSync(
      process.execPath,
      [path.join(root, "scripts/prepare-release.mjs"), next],
      { cwd: dir }
    );
    assert.equal(readReleaseMetadata(dir).version, next);
    const changelog = readFileSync(path.join(dir, "CHANGELOG.md"), "utf8");
    assert.ok(changelog.includes(`## [${next}]`));
    assert.ok(changelog.includes(`v${before.version}...v${next}`));
    assert.throws(
      () => validateReleaseTag(before.tag, readReleaseMetadata(dir)),
      /does not match/
    );
    const cargo = path.join(dir, "src-tauri/Cargo.toml");
    writeFileSync(cargo, readFileSync(cargo, "utf8").replace(next, "9.8.6"));
    assert.throws(() => readReleaseMetadata(dir), /disagree/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("release versions reject refs and shell-like input", () => {
  for (const value of [
    "main",
    "v0.2.0",
    "0.2",
    "0.2.0;echo bad",
    "0.2.0\n",
    "01.2.0",
    `0.2.0${String.fromCharCode(10)}`,
  ]) {
    assert.throws(() => validateVersion(value));
  }
});
test("signing preflight fails closed without reviewers or with broad deployment access", () => {
  const env = {
    protection_rules: [
      {
        type: "required_reviewers",
        reviewers: [{ type: "User", reviewer: { id: 1 } }],
      },
    ],
    deployment_branch_policy: {
      custom_branch_policies: true,
      protected_branches: false,
    },
  };
  const branches = [{ type: "tag", name: "v*" }];
  assert.equal(validateSigningEnvironment(env, branches), 1);
  assert.throws(
    () =>
      validateSigningEnvironment({ ...env, protection_rules: [] }, branches),
    /no required reviewer/
  );
  assert.throws(
    () =>
      validateSigningEnvironment(env, [
        ...branches,
        { type: "branch", name: "*" },
      ]),
    /only/
  );
  assert.throws(
    () =>
      validateSigningEnvironment(
        { ...env, deployment_branch_policy: null },
        branches
      ),
    /restrict/
  );
});
test("update manifest requires both platforms, matching version and immutable asset URLs", () => {
  const manifest = {
    version: "0.2.0",
    platforms: Object.fromEntries(
      Object.entries(UPDATE_PLATFORMS).map(([key, { name }]) => [
        key,
        {
          signature: "signature",
          url: `https://github.com/privacykey/privacytracker/releases/download/v0.2.0/${name}`,
        },
      ])
    ),
  };
  validateManifest(manifest, "0.2.0", "privacykey/privacytracker");
  assert.throws(
    () => validateManifest(manifest, "0.2.1", "privacykey/privacytracker"),
    /version/
  );
  const missing = structuredClone(manifest);
  missing.platforms = {
    "darwin-aarch64": manifest.platforms["darwin-aarch64"],
  };
  assert.throws(
    () => validateManifest(missing, "0.2.0", "privacykey/privacytracker"),
    /Both/
  );
  const tampered = structuredClone(manifest);
  tampered.platforms["darwin-aarch64"].url = "https://example.com/malware";
  assert.throws(
    () => validateManifest(tampered, "0.2.0", "privacykey/privacytracker"),
    /URL/
  );
});
test("signing-only rehearsal unsets all notarization credentials and forwards arguments", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "tauri-dry-run-"));
  try {
    writeFileSync(
      path.join(dir, "pnpm"),
      "#!/usr/bin/env node\nconsole.log(JSON.stringify({args:process.argv.slice(2),env:process.env}));\n",
      { mode: 0o755 }
    );
    const result = spawnSync(
      process.execPath,
      [
        path.join(root, "scripts/run-release-tauri.mjs"),
        "build",
        "--target",
        "x86_64-apple-darwin",
      ],
      {
        encoding: "utf8",
        env: {
          PATH: `${dir}:${process.env.PATH}`,
          RELEASE_DRY_RUN: "1",
          APPLE_API_KEY: "synthetic",
          APPLE_API_ISSUER: "synthetic",
          APPLE_API_KEY_PATH: "synthetic",
          APPLE_ID: "synthetic",
          APPLE_PASSWORD: "synthetic",
          APPLE_TEAM_ID: "synthetic",
          APPLE_CERTIFICATE: "signing-only",
        },
      }
    );
    assert.equal(result.status, 0, result.stderr);
    const actual = JSON.parse(result.stdout);
    assert.deepEqual(actual.args, [
      "tauri",
      "build",
      "--target",
      "x86_64-apple-darwin",
    ]);
    assert.equal(actual.env.APPLE_CERTIFICATE, "signing-only");
    assert.deepEqual(
      Object.keys(actual.env).filter((key) => key.startsWith("APPLE_")),
      ["APPLE_CERTIFICATE"]
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the updater verifier accepts Tauri signatures and rejects altered bytes or another key", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "updater-signature-test-"));
  try {
    const cli = path.join(root, "node_modules/@tauri-apps/cli/tauri.js");
    const key = path.join(dir, "test.key");
    const other = path.join(dir, "other.key");
    const archive = path.join(dir, "payload.app.tar.gz");
    const tauri = (...args) =>
      execFileSync(process.execPath, [cli, "signer", ...args], {
        stdio: "pipe",
        env: { ...process.env, CI: "true" },
      });
    tauri("generate", "--ci", "-p", "", "-w", key);
    tauri("generate", "--ci", "-p", "", "-w", other);
    writeFileSync(archive, "synthetic update archive bytes");
    tauri("sign", "-f", key, "-p", "", archive);
    const verifier = path.join(
      root,
      "scripts/verify-updater/target/debug/verify-privacytracker-updater"
    );
    execFileSync(verifier, [`${key}.pub`, `${archive}.sig`, archive]);
    assert.notEqual(
      spawnSync(verifier, [`${other}.pub`, `${archive}.sig`, archive]).status,
      0
    );
    writeFileSync(archive, "tampered update bytes");
    assert.notEqual(
      spawnSync(verifier, [`${key}.pub`, `${archive}.sig`, archive]).status,
      0
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("draft preparation refuses an already published release before any mutation", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "release-published-test-"));
  try {
    const log = path.join(dir, "calls.jsonl");
    writeFileSync(
      path.join(dir, "gh"),
      `#!/usr/bin/env node\nconst fs=require('node:fs');fs.appendFileSync(process.env.CALL_LOG,JSON.stringify(process.argv.slice(2))+'\\n');console.log('{"isDraft":false}');\n`,
      { mode: 0o755 }
    );
    const tag = readReleaseMetadata(root).tag;
    const result = spawnSync(
      process.execPath,
      [path.join(root, "scripts/ensure-draft-release.mjs"), tag],
      {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          CALL_LOG: log,
        },
      }
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /already published/);
    assert.deepEqual(
      readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
      [["release", "view", tag, "--json", "isDraft"]]
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a new draft's body is the curated summary above the notes marker", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "release-notes-draft-test-"));
  try {
    mkdirSync(path.join(dir, "src-tauri"));
    for (const file of [
      "package.json",
      "src-tauri/Cargo.toml",
      "src-tauri/Cargo.lock",
      "src-tauri/tauri.conf.json",
    ]) {
      cpSync(path.join(root, file), path.join(dir, file));
    }
    const { version, tag } = readReleaseMetadata(dir);
    writeFileSync(
      path.join(dir, "CHANGELOG.md"),
      [
        "# Changelog",
        "",
        "## [Unreleased]",
        "",
        `## [${version}] — 2026-10-01`,
        "",
        "The summary.",
        "",
        RELEASE_NOTES_END,
        "",
        "### Added",
        "",
        "- Every entry.",
        "",
        "## [0.1.2] — 2026-06-12",
        "",
        "- Older.",
        "",
      ].join("\n")
    );
    const bin = path.join(dir, "bin");
    mkdirSync(bin);
    const log = path.join(dir, "calls.jsonl");
    // No release exists yet, so `release view` fails; `release create`
    // records the notes file it was handed.
    writeFileSync(
      path.join(bin, "gh"),
      [
        "#!/usr/bin/env node",
        'const fs = require("node:fs");',
        "const args = process.argv.slice(2);",
        'const at = args.indexOf("--notes-file");',
        "const notes = at < 0 ? null : fs.readFileSync(args[at + 1], 'utf8');",
        "fs.appendFileSync(process.env.CALL_LOG, JSON.stringify({ args: args.slice(0, 2), notes }) + '\\n');",
        'if (args[1] === "view") process.exit(1);',
        "",
      ].join("\n"),
      { mode: 0o755 }
    );
    const result = spawnSync(
      process.execPath,
      [path.join(root, "scripts/ensure-draft-release.mjs"), tag],
      {
        cwd: dir,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          CALL_LOG: log,
        },
      }
    );
    assert.equal(result.status, 0, result.stderr);
    const calls = readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      calls.map((call) => call.args),
      [
        ["release", "view"],
        ["release", "create"],
      ]
    );
    assert.equal(calls[1].notes, "The summary.");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("release preparation compares against the last tag, not an untagged version", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "release-tag-test-"));
  try {
    mkdirSync(path.join(dir, "src-tauri"));
    for (const file of [
      "package.json",
      "src-tauri/Cargo.toml",
      "src-tauri/Cargo.lock",
      "src-tauri/tauri.conf.json",
      "CHANGELOG.md",
    ]) {
      cpSync(path.join(root, file), path.join(dir, file));
    }
    const git = (...args) =>
      execFileSync(
        "git",
        [
          "-c",
          "user.name=Release test",
          "-c",
          "user.email=release-test@example.invalid",
          "-c",
          "commit.gpgsign=false",
          "-c",
          "tag.gpgsign=false",
          ...args,
        ],
        { cwd: dir, stdio: "pipe" }
      );
    git("init", "-q");
    git("add", "-A");
    git("commit", "-q", "-m", "fixture");
    // The last release. The version the files carry may never have been
    // tagged, as 0.2.0 was prepared and not released.
    git("tag", "v0.1.2");
    const before = readReleaseMetadata(dir).version;
    const next = "9.8.7";
    const result = spawnSync(
      process.execPath,
      [path.join(root, "scripts/prepare-release.mjs"), next],
      { cwd: dir, encoding: "utf8" }
    );
    assert.equal(result.status, 0, result.stderr);
    const changelog = readFileSync(path.join(dir, "CHANGELOG.md"), "utf8");
    assert.ok(
      changelog.includes(
        `[${next}]: https://github.com/privacykey/privacytracker/compare/v0.1.2...v${next}`
      ),
      "the new section compares with the last tag"
    );
    if (before !== "0.1.2") {
      assert.ok(!changelog.includes(`v${before}...v${next}`));
    }
    // Sections for versions that were never tagged are named, so the notes
    // can say what became of them. [0.1.1] has no tag in this repository.
    assert.match(result.stderr, /never tagged/);
    assert.match(result.stderr, /\b0\.1\.1\b/);
    assert.doesNotMatch(result.stderr, /9\.8\.7/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parity fixtures do not record the app version, so a release bump needs no re-recording", () => {
  // `pnpm release:prepare` changes package.json's version and nothing
  // under core/. The core-parity job re-runs every extractor and diffs its
  // output, and the Rust replays read the version from package.json, so a
  // fixture that records it as written fails that job on the release PR.
  // Extractors mask it as `<APP_VERSION>` and the Rust replay substitutes
  // it back (extract-bundles-cases.mjs and bundles_tests.rs).
  const { version } = readReleaseMetadata(root);
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // The whole version, not part of a longer one or of an address.
  const literal = new RegExp(`(?<![0-9.])${escaped}(?![0-9]|\\.[0-9])`);
  const outputs = ["core/tests/fixtures", "core/src/server"].flatMap((dir) =>
    readdirSync(path.join(root, dir))
      .filter((name) => name.endsWith(".json"))
      .map((name) => `${dir}/${name}`)
  );
  assert.ok(
    outputs.includes("core/tests/fixtures/bundles-cases.json"),
    "the scan found the extractor outputs"
  );
  const found = outputs.flatMap((file) =>
    readFileSync(path.join(root, file), "utf8")
      .split("\n")
      .flatMap((line, index) =>
        literal.test(line) ? [`${file}:${index + 1}`] : []
      )
  );
  assert.deepEqual(
    found,
    [],
    `These parity fixtures record ${version}, so the next release bump breaks core-parity. Mask it as <APP_VERSION> in the extractor and substitute it back in the Rust replay. If it is canned data that happens to equal the version, change that data in the extractor.`
  );
});

test("Mach-O minimum OS parsing ignores SDK and linker tool versions", () => {
  assert.deepEqual(
    minimumMacOSVersions(`Load command 8
      cmd LC_BUILD_VERSION
  cmdsize 32
 platform 1
    minos 13.5
      sdk 26.2
   ntools 1
     tool 3
  version 1267.0
Load command 9
      cmd LC_LOAD_DYLIB
  current version 1600.0.0
Load command 10
      cmd LC_VERSION_MIN_MACOSX
  cmdsize 16
  version 11.0
      sdk 12.3
`),
    ["13.5", "11.0"]
  );
});
