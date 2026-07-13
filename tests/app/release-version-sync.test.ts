import assert from "node:assert/strict";
import { test } from "node:test";
import {
  syncCargoLock,
  syncCargoManifest,
} from "../../scripts/sync-release-version.mjs";

test("release version sync updates only the desktop package metadata", () => {
  const manifest = `[package]
name = "privacytracker"
version = "0.1.2"

[dependencies]
example = "1.0.0"
`;
  const lock = `[[package]]
name = "example"
version = "1.0.0"

[[package]]
name = "privacytracker"
version = "0.1.2"
dependencies = [
 "example",
]
`;

  assert.equal(
    syncCargoManifest(manifest, "0.2.0"),
    manifest.replace('version = "0.1.2"', 'version = "0.2.0"')
  );
  assert.equal(
    syncCargoLock(lock, "0.2.0"),
    lock.replace('version = "0.1.2"', 'version = "0.2.0"')
  );
});

test("release version sync fails closed on ambiguous metadata", () => {
  assert.throws(
    () => syncCargoManifest('[dependencies]\nexample = "1"\n', "0.2.0"),
    /missing \[package\]/
  );
  assert.throws(
    () =>
      syncCargoLock('[[package]]\nname = "example"\nversion = "1"\n', "0.2.0"),
    /exactly one privacytracker package block/
  );
});
