import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
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
