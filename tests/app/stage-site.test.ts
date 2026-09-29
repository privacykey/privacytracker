/**
 * `scripts/stage-site.mjs` stages the frontend the Rust backend serves into
 * the Tauri bundle. What it leaves OUT matters as much as what it copies:
 * the route modules a build writes beside the pages are server code the
 * desktop app never runs, and a runtime database must never reach a signed
 * bundle. Both are asserted here, over a synthetic build, so the checks hold
 * without running `next build`.
 */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { stageSite } from "../../scripts/stage-site.mjs";

interface Build {
  into: string;
  root: string;
}

/** A build with two pages, the files a real one writes beside them, a
 *  chunk, the CSP hashes and a public file. */
function build(extra: Record<string, string> = {}): Build {
  const root = mkdtempSync(path.join(tmpdir(), "pt-stage-site-"));
  const files: Record<string, string> = {
    ".next/server/app/index.html": "<html>home</html>",
    ".next/server/app/index.meta": '{"headers":{}}',
    ".next/server/app/index.rsc": "RSC home",
    ".next/server/app/index.segments/_tree.segment.rsc": "TREE home",
    ".next/server/app/_not-found.html": "<html>404</html>",
    ".next/server/app/_not-found.meta": '{"status":404,"headers":{}}',
    ".next/server/app/icon.png.body": "PNG",
    ".next/server/app/icon.png.meta": '{"status":200,"headers":{}}',
    // Server code, and the tracing file beside it. Neither is served.
    ".next/server/app/page.js": "module.exports = {}",
    ".next/server/app/page.js.nft.json": '{"files":[]}',
    ".next/static/chunks/app.js": "console.log(1)",
    ".next/csp-hashes.json": '{"all":[],"routes":{"/":[]}}',
    "public/brand-icon.png": "PNG",
    "public/ocr/worker.min.js": "importScripts()",
    ...extra,
  };
  for (const [rel, contents] of Object.entries(files)) {
    const full = path.join(root, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return { root, into: path.join(root, "staged") };
}

test("stages what the core serves and nothing else", () => {
  const { root, into } = build();
  const result = stageSite({ root, into });

  assert.equal(result.pages, 2, "both prerendered pages");
  for (const rel of [
    ".next/server/app/index.html",
    ".next/server/app/index.meta",
    ".next/server/app/index.rsc",
    ".next/server/app/index.segments/_tree.segment.rsc",
    ".next/server/app/_not-found.html",
    ".next/server/app/icon.png.body",
    ".next/static/chunks/app.js",
    ".next/csp-hashes.json",
    "public/brand-icon.png",
    "public/ocr/worker.min.js",
  ]) {
    assert.ok(existsSync(path.join(into, rel)), `${rel} should be staged`);
  }
  for (const rel of [
    ".next/server/app/page.js",
    ".next/server/app/page.js.nft.json",
  ]) {
    assert.ok(
      !existsSync(path.join(into, rel)),
      `${rel} is server code the desktop app never runs; it must not ship`
    );
  }

  rmSync(root, { recursive: true, force: true });
});

test("a page deleted since the last staging does not linger", () => {
  const { root, into } = build({
    ".next/server/app/gone.html": "<html>gone</html>",
    ".next/server/app/gone.meta": '{"headers":{}}',
  });
  stageSite({ root, into });
  assert.ok(existsSync(path.join(into, ".next/server/app/gone.html")));

  rmSync(path.join(root, ".next/server/app/gone.html"));
  rmSync(path.join(root, ".next/server/app/gone.meta"));
  const second = stageSite({ root, into });
  assert.ok(
    !existsSync(path.join(into, ".next/server/app/gone.html")),
    "the destination is wiped, so a removed page cannot be served from a stale copy"
  );
  assert.equal(second.pages, 2);

  rmSync(root, { recursive: true, force: true });
});

test("refuses a build it cannot serve, and a database", () => {
  const empty = mkdtempSync(path.join(tmpdir(), "pt-stage-site-empty-"));
  assert.throws(
    () => stageSite({ root: empty, into: path.join(empty, "staged") }),
    /Run `pnpm build` first/,
    "a missing build should say how to make one"
  );
  rmSync(empty, { recursive: true, force: true });

  // A build whose not-found page is missing: the core refuses to load it,
  // so staging it would turn a bad build into a bad bundle.
  const noFallback = build();
  rmSync(path.join(noFallback.root, ".next/server/app/_not-found.html"));
  assert.throws(
    () => stageSite({ root: noFallback.root, into: noFallback.into }),
    /the not-found page/
  );
  rmSync(noFallback.root, { recursive: true, force: true });

  // A bare `next build` skips scripts/stage-ocr-assets.mjs, and the bundle
  // it made would install with screenshot import unable to start.
  const noOcr = build();
  rmSync(path.join(noOcr.root, "public/ocr"), { recursive: true });
  assert.throws(
    () => stageSite({ root: noOcr.root, into: noOcr.into }),
    /the OCR worker/
  );
  rmSync(noOcr.root, { recursive: true, force: true });

  const withDb = build({ "public/privacy.db": "SQLite format 3" });
  assert.throws(
    () => stageSite({ root: withDb.root, into: withDb.into }),
    /refusing to stage a database/
  );
  assert.ok(
    !existsSync(withDb.into),
    "and the half-staged tree is removed rather than left for the bundler"
  );
  rmSync(withDb.root, { recursive: true, force: true });
});
