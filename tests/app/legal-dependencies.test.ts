/**
 * /legal must list every runtime npm dependency, under the licence the
 * package itself declares.
 *
 * The page used to be a hand-kept list and drifted to 6 of 17 runtime
 * dependencies. It is now derived from package.json (lib/legal-
 * dependencies.ts); these tests pin the parts that derivation cannot:
 * that every dependency has hand-written notes, that no notes outlive
 * their dependency, that each licence matches the `license` field of the
 * installed package's own package.json, and that every licence used has
 * a group the page actually renders.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  BUNDLED_ASSETS,
  DEV_DEPENDENCY_NOTES,
  LICENSE_META,
  LICENSE_ORDER,
  legalDependencies,
  normaliseLicenseExpression,
  pkgVersion,
  RUNTIME_DEPENDENCY_NOTES,
  runtimeDependenciesMissingNotes,
  runtimeDependencyEntries,
} from "../../lib/legal-dependencies";

const ROOT = process.cwd();
const rootPkg = JSON.parse(
  readFileSync(path.join(ROOT, "package.json"), "utf8")
) as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

/** The `license` field the installed package declares for itself. */
function installedLicense(name: string): string {
  const manifest = JSON.parse(
    readFileSync(path.join(ROOT, "node_modules", name, "package.json"), "utf8")
  ) as { license?: unknown };
  assert.equal(
    typeof manifest.license,
    "string",
    `${name}'s package.json has no string "license" field`
  );
  return manifest.license as string;
}

test("every runtime dependency in package.json has a /legal entry", () => {
  assert.deepEqual(
    runtimeDependenciesMissingNotes(),
    [],
    "Add these to RUNTIME_DEPENDENCY_NOTES in lib/legal-dependencies.ts"
  );
  const listed = runtimeDependencyEntries().map((d) => d.name);
  assert.deepEqual(listed, Object.keys(rootPkg.dependencies));
});

test("no /legal runtime entry outlives its dependency", () => {
  const stale = Object.keys(RUNTIME_DEPENDENCY_NOTES).filter(
    (name) => !Object.hasOwn(rootPkg.dependencies, name)
  );
  assert.deepEqual(
    stale,
    [],
    "These are no longer runtime dependencies; remove their notes"
  );
});

test("each runtime entry's licence is the one its package declares", () => {
  for (const [name, notes] of Object.entries(RUNTIME_DEPENDENCY_NOTES)) {
    assert.equal(
      normaliseLicenseExpression(notes.license),
      normaliseLicenseExpression(installedLicense(name)),
      `${name}: /legal says ${notes.license}, its package.json says ${installedLicense(name)}`
    );
  }
});

test("each listed dev tool is a real devDependency with its declared licence", () => {
  for (const [name, notes] of Object.entries(DEV_DEPENDENCY_NOTES)) {
    assert.ok(
      Object.hasOwn(rootPkg.devDependencies, name),
      `${name} is listed as a dev tool on /legal but is not a devDependency`
    );
    assert.equal(
      normaliseLicenseExpression(notes.license),
      normaliseLicenseExpression(installedLicense(name)),
      `${name}: /legal says ${notes.license}, its package.json says ${installedLicense(name)}`
    );
  }
});

test("every licence used on /legal has a group the page renders", () => {
  for (const entry of legalDependencies()) {
    assert.ok(
      LICENSE_ORDER.includes(entry.license),
      `${entry.name} uses ${entry.license}, which is missing from LICENSE_ORDER and would not render`
    );
    for (const choice of LICENSE_META[entry.license].anyOf ?? []) {
      assert.ok(
        LICENSE_META[choice],
        `${entry.license} names unknown ${choice}`
      );
    }
  }
});

test("versions come from package.json with the range prefix stripped", () => {
  for (const entry of runtimeDependencyEntries()) {
    assert.equal(entry.version, pkgVersion(entry.name));
    assert.ok(
      rootPkg.dependencies[entry.name].endsWith(entry.version),
      `${entry.name}: ${entry.version} is not the package.json version`
    );
    assert.match(entry.version, /^\d/);
  }
  assert.throws(() => pkgVersion("not-a-real-package"), /not listed/);
});

test("bundled assets keep hand-written versions and known licences", () => {
  const names = BUNDLED_ASSETS.map((a) => a.name);
  assert.ok(names.includes("Inter typeface"));
  assert.ok(names.includes("OpenDyslexic typeface"));
  for (const asset of BUNDLED_ASSETS) {
    assert.ok(asset.version.length > 0, `${asset.name} has no version`);
    assert.ok(LICENSE_ORDER.includes(asset.license));
  }
});

test("licence expressions compare regardless of order and parentheses", () => {
  assert.equal(
    normaliseLicenseExpression("Apache-2.0 OR MIT"),
    normaliseLicenseExpression("MIT OR Apache-2.0")
  );
  assert.equal(
    normaliseLicenseExpression("(MPL-2.0 OR Apache-2.0)"),
    normaliseLicenseExpression("MPL-2.0 OR Apache-2.0")
  );
  assert.equal(normaliseLicenseExpression(" MIT "), "MIT");
  assert.notEqual(
    normaliseLicenseExpression("MIT"),
    normaliseLicenseExpression("MIT OR Apache-2.0")
  );
});
