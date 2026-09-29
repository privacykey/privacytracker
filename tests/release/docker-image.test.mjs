import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
import { dockerPublishTarget } from "../../scripts/docker-image.mjs";
import { readReleaseMetadata } from "../../scripts/release-metadata.mjs";

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const root = path.resolve(import.meta.dirname, "../..");
const repository = "privacykey/privacytracker";
const sha = "0123456789abcdef0123456789abcdef01234567";

test("a push to main publishes only to the private edge image", () => {
  assert.deepEqual(
    dockerPublishTarget({
      repository,
      refType: "branch",
      refName: "main",
      sha,
    }),
    {
      channel: "edge",
      image: "ghcr.io/privacykey/privacytracker-edge",
      version: null,
      latest: false,
      tags: ["edge", `sha-${sha}`],
    }
  );
  assert.throws(
    () =>
      dockerPublishTarget({
        repository,
        refType: "branch",
        refName: "main",
        sha: "abc",
      }),
    /commit SHA/
  );
});

test("a release publishes its version, and only a final release moves latest", () => {
  assert.deepEqual(
    dockerPublishTarget({ repository, refType: "tag", refName: "v0.3.0", sha }),
    {
      channel: "release",
      image: "ghcr.io/privacykey/privacytracker",
      version: "0.3.0",
      latest: true,
      tags: ["0.3.0", "0.3", "latest"],
    }
  );
  assert.deepEqual(
    dockerPublishTarget({
      repository,
      refType: "tag",
      refName: "v0.3.0-rc.1",
      sha,
    }),
    {
      channel: "release",
      image: "ghcr.io/privacykey/privacytracker",
      version: "0.3.0-rc.1",
      latest: false,
      tags: ["0.3.0-rc.1"],
    }
  );
});

test("a tag that is not a release version publishes nothing", () => {
  for (const refName of ["nightly", "v0.3", "0.3.0", "v0.3.0;latest"]) {
    assert.throws(() =>
      dockerPublishTarget({ repository, refType: "tag", refName, sha })
    );
  }
  assert.throws(
    () =>
      dockerPublishTarget({
        repository: "privacykey/privacytracker:latest",
        refType: "tag",
        refName: "v0.3.0",
        sha,
      }),
    /repository/
  );
});

test("the workflow step writes the image and metadata-action tag rules, and checks a release tag against the checkout", (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "docker-image-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, "src-tauri"));
  for (const file of [
    "package.json",
    "src-tauri/Cargo.toml",
    "src-tauri/Cargo.lock",
    "src-tauri/tauri.conf.json",
  ]) {
    cpSync(path.join(root, file), path.join(dir, file));
  }
  const { tag, version } = readReleaseMetadata(dir);
  const output = path.join(dir, "github-output");
  const run = (env) => {
    writeFileSync(output, "");
    return spawnSync(
      process.execPath,
      [path.join(root, "scripts/docker-image.mjs")],
      {
        cwd: dir,
        encoding: "utf8",
        env: {
          ...process.env,
          GITHUB_OUTPUT: output,
          GITHUB_REPOSITORY: repository,
          GITHUB_SHA: sha,
          ...env,
        },
      }
    );
  };

  const edge = run({ GITHUB_REF_TYPE: "branch", GITHUB_REF_NAME: "main" });
  assert.equal(edge.status, 0, edge.stderr);
  assert.equal(
    readFileSync(output, "utf8"),
    [
      "channel=edge",
      "image=ghcr.io/privacykey/privacytracker-edge",
      "latest=false",
      "tags<<DOCKER_TAGS_END",
      "type=raw,value=edge",
      `type=raw,value=sha-${sha}`,
      "DOCKER_TAGS_END",
      "",
    ].join("\n")
  );

  const release = run({ GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: tag });
  assert.equal(release.status, 0, release.stderr);
  const written = readFileSync(output, "utf8");
  assert.match(written, /^channel=release$/m);
  assert.match(written, /^image=ghcr\.io\/privacykey\/privacytracker$/m);
  assert.match(
    written,
    new RegExp(`^type=raw,value=${escapeRegExp(version)}$`, "m")
  );

  // A tag the checked-out version does not declare never reaches the
  // public image.
  const mismatch = run({ GITHUB_REF_TYPE: "tag", GITHUB_REF_NAME: "v99.0.0" });
  assert.notEqual(mismatch.status, 0);
  assert.match(mismatch.stderr, /does not match/);
  assert.equal(readFileSync(output, "utf8"), "");
});
