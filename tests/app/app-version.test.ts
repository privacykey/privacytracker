import assert from "node:assert/strict";
import test from "node:test";
import { bareVersion } from "../../lib/app-version";

test("bareVersion drops a developer's own v prefix before a digit", () => {
  assert.equal(bareVersion("v1.181"), "1.181");
  assert.equal(bareVersion("V2.0"), "2.0");
  assert.equal(bareVersion("1.181"), "1.181");
});

test("bareVersion leaves anything else as Apple reported it", () => {
  assert.equal(bareVersion(""), "");
  assert.equal(bareVersion("v"), "v");
  assert.equal(bareVersion("vNext"), "vNext");
  assert.equal(bareVersion("version 3"), "version 3");
  assert.equal(bareVersion(" v1.0"), " v1.0");
});
