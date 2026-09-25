/**
 * Screenshot import runs tesseract.js against copies of its worker, engine
 * and English model served from the app's own origin (lib/ocr-assets.ts,
 * scripts/stage-ocr-assets.mjs). These tests hold the pieces together
 * without a browser: the staged files are the ones tesseract.js will ask
 * for, the wizard hands it those paths, and a failed start reaches the UI.
 * tests/e2e/onboard-ocr.spec.ts runs the real thing under the CSP.
 */
import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  awaitOcrStart,
  describeOcrError,
  OCR_ASSET_BASE,
  OCR_START_TIMEOUT_MS,
  OCR_WORKER_OPTIONS,
  OCR_WORKER_PATH,
} from "../../lib/ocr-assets";
import {
  CORE_FILES,
  LANG_DATA_DIR,
  LANG_DATA_FILE,
  NOTICE_FILE,
  stageOcrAssets,
  WORKER_FILE,
} from "../../scripts/stage-ocr-assets.mjs";

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const repo = path.resolve(import.meta.dirname, "..", "..");
const requireFromRepo = createRequire(path.join(repo, "package.json"));
const tesseractDir = path.dirname(
  requireFromRepo.resolve("tesseract.js/package.json")
);

test("a failed start always gives the wizard a string, never a throw", () => {
  // A worker that cannot start rejects with `undefined` (tesseract.js
  // passes on the error event's missing `message`). The inline version of
  // this read `.slice` off `JSON.stringify(undefined)` inside the catch,
  // threw, and left the wizard on "Preparing screenshot scan…".
  assert.equal(describeOcrError(undefined), "");
  assert.equal(describeOcrError(null), "");
  assert.equal(describeOcrError(new Error("core failed")), "core failed");
  const unexplained = new TypeError("placeholder");
  unexplained.message = "";
  assert.equal(describeOcrError(unexplained), "TypeError");
  assert.equal(describeOcrError("Network error"), "Network error");
  assert.equal(describeOcrError({ code: 3 }), '{"code":3}');
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.equal(describeOcrError(circular), "[object Object]");
  assert.equal(describeOcrError("x".repeat(900)).length, 500);
});

test("a start tesseract.js leaves pending still ends", async () => {
  const never = () => new Promise<never>(() => undefined);

  // errorHandler fired (the model failed to download): the wait rejects
  // with what it was given.
  await assert.rejects(
    awaitOcrStart((fail) => {
      setTimeout(() => fail("Network error while fetching eng: 404"), 0);
      return never();
    }, 5000),
    (reason) => reason === "Network error while fetching eng: 404"
  );

  // Nothing fired at all (the engine failed to compile): it times out.
  await assert.rejects(
    awaitOcrStart(never, 20),
    /The OCR engine did not start within 0 seconds\./
  );

  // A start that throws synchronously, and one that rejects.
  await assert.rejects(
    awaitOcrStart(() => {
      throw new Error("no Worker");
    }, 5000),
    /no Worker/
  );
  await assert.rejects(
    awaitOcrStart(() => Promise.reject(undefined), 5000),
    (reason) => reason === undefined
  );

  // A normal start resolves, and a later `fail` (a failed recognize
  // reaching errorHandler) changes nothing.
  let failLater: (reason: unknown) => void = () => undefined;
  const worker = await awaitOcrStart((fail) => {
    failLater = fail;
    return Promise.resolve("worker");
  }, 5000);
  assert.equal(worker, "worker");
  failLater("recognize failed");

  // A worker that turns up after the wait gave up is handed back to be
  // terminated rather than left running.
  const discarded: string[] = [];
  await assert.rejects(
    awaitOcrStart(
      () =>
        new Promise<string>((resolve) => setTimeout(() => resolve("late"), 40)),
      10,
      (late) => discarded.push(late)
    ),
    /did not start/
  );
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(discarded, ["late"]);
  assert.equal(OCR_START_TIMEOUT_MS, 120_000);
});

test("the wizard's worker options stay on this origin and off blob: URLs", () => {
  assert.equal(OCR_WORKER_OPTIONS.workerBlobURL, false);
  assert.equal(OCR_WORKER_OPTIONS.workerPath, OCR_WORKER_PATH);
  for (const value of [
    OCR_WORKER_OPTIONS.workerPath,
    OCR_WORKER_OPTIONS.corePath,
    OCR_WORKER_OPTIONS.langPath,
  ]) {
    assert.ok(value.startsWith(`${OCR_ASSET_BASE}`), value);
    assert.doesNotMatch(value, /^[a-z]+:|^\/\//i, "a path, never a URL");
  }
  assert.equal(path.posix.basename(OCR_WORKER_PATH), WORKER_FILE);

  // The wizard passes them, and passes the File itself rather than a blob:
  // URL, which tesseract.js would fetch and the page's connect-src refuses.
  const wizard = readFileSync(
    path.join(repo, "lib", "use-onboard-wizard.ts"),
    "utf8"
  );
  assert.match(
    wizard,
    /awaitOcrStart\(\s*\(failStart\) =>\s*createWorker\("eng", 1, \{\s*\.\.\.OCR_WORKER_OPTIONS,/,
    "createWorker must receive OCR_WORKER_OPTIONS, inside awaitOcrStart"
  );
  assert.match(wizard, /failStart\(err\);/);
  assert.match(wizard, /worker\.recognize\(file\)/);
  assert.doesNotMatch(wizard, /createObjectURL\(file\)/);
});

test("the staged engine builds are exactly the ones tesseract.js loads", () => {
  // tesseract.js's getCore picks one of these by browser support when the
  // engine mode is LSTM only, as the wizard asks. If an upgrade renames
  // them, the staging list has to follow or the worker 404s.
  const getCore = readFileSync(
    path.join(tesseractDir, "src", "worker-script", "browser", "getCore.js"),
    "utf8"
  );
  const lstmBuilds = new Set(
    [...getCore.matchAll(/tesseract-core[a-z-]*-lstm\.wasm\.js/g)].map(
      (m) => m[0]
    )
  );
  assert.deepEqual([...lstmBuilds].sort(), [...CORE_FILES].sort());

  // …and for LSTM-only recognition it reads the `4.0.0_best_int` model.
  const workerScript = readFileSync(
    path.join(tesseractDir, "src", "worker-script", "index.js"),
    "utf8"
  );
  assert.match(
    workerScript,
    new RegExp(`lstmOnly \\? \`[^\`]*/${escapeRegExp(LANG_DATA_DIR)}\``)
  );
  assert.match(workerScript, /\.traineddata\$\{gzip \? '\.gz' : ''\}/);

  // With workerBlobURL off the worker is started from its own URL.
  const spawnWorker = readFileSync(
    path.join(tesseractDir, "src", "worker", "browser", "spawnWorker.js"),
    "utf8"
  );
  assert.match(spawnWorker, /new Worker\(workerPath\)/);
});

test("stages the worker, the engines, the model and their notices from node_modules", () => {
  const into = mkdtempSync(path.join(tmpdir(), "pt-stage-ocr-"));
  try {
    const result = stageOcrAssets({ root: repo, into });
    assert.deepEqual(
      [...result.files].sort(),
      [
        WORKER_FILE,
        `${WORKER_FILE}.LICENSE.txt`,
        "LICENSE-tesseract.js.txt",
        ...CORE_FILES,
        "LICENSE-tesseract.js-core.txt",
        LANG_DATA_FILE,
        NOTICE_FILE,
      ].sort()
    );
    assert.deepEqual(
      readFileSync(path.join(into, WORKER_FILE)),
      readFileSync(path.join(tesseractDir, "dist", WORKER_FILE)),
      "the worker is tesseract.js's own, byte for byte"
    );
    const model = readFileSync(path.join(into, LANG_DATA_FILE));
    assert.deepEqual([model[0], model[1]], [0x1f, 0x8b], "gzipped model");
    const notice = readFileSync(path.join(into, NOTICE_FILE), "utf8");
    for (const name of [
      "tesseract.js",
      "tesseract.js-core",
      "@tesseract.js-data/eng",
      WORKER_FILE,
      LANG_DATA_FILE,
      ...CORE_FILES,
    ]) {
      assert.ok(notice.includes(name), `${NOTICE_FILE} names ${name}`);
    }
    assert.deepEqual(Object.keys(result.versions).sort(), [
      "@tesseract.js-data/eng",
      "tesseract.js",
      "tesseract.js-core",
    ]);
  } finally {
    rmSync(into, { recursive: true, force: true });
  }
});

/** A node_modules tree with just enough of the three packages to stage. */
function fakeRoot(coreVersionForTesseract?: string): string {
  const root = mkdtempSync(path.join(tmpdir(), "pt-stage-ocr-root-"));
  const write = (rel: string, contents: string) => {
    const full = path.join(root, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, contents);
  };
  write("package.json", "{}");
  write(NOTICE_FILE, "notice");
  write(
    "node_modules/tesseract.js/package.json",
    '{"name":"tesseract.js","version":"7.0.0"}'
  );
  write(`node_modules/tesseract.js/dist/${WORKER_FILE}`, "worker");
  write(`node_modules/tesseract.js/dist/${WORKER_FILE}.LICENSE.txt`, "l");
  write("node_modules/tesseract.js/LICENSE.md", "apache");
  write(
    "node_modules/tesseract.js-core/package.json",
    '{"name":"tesseract.js-core","version":"7.0.0"}'
  );
  write("node_modules/tesseract.js-core/LICENSE", "apache");
  for (const name of CORE_FILES) {
    write(`node_modules/tesseract.js-core/${name}`, "core");
  }
  write(
    "node_modules/@tesseract.js-data/eng/package.json",
    '{"name":"@tesseract.js-data/eng","version":"1.0.0"}'
  );
  write(
    `node_modules/@tesseract.js-data/eng/${LANG_DATA_DIR}/${LANG_DATA_FILE}`,
    "model"
  );
  if (coreVersionForTesseract) {
    // tesseract.js carrying its own, different core: what a half-applied
    // upgrade leaves behind.
    write(
      "node_modules/tesseract.js/node_modules/tesseract.js-core/package.json",
      `{"name":"tesseract.js-core","version":"${coreVersionForTesseract}"}`
    );
  }
  return root;
}

test("wipes the destination, so a file dropped upstream cannot linger", () => {
  const root = fakeRoot();
  try {
    const into = path.join(root, "public", "ocr");
    mkdirSync(into, { recursive: true });
    writeFileSync(path.join(into, "tesseract-core-old.wasm.js"), "stale");
    stageOcrAssets({ root });
    assert.throws(() =>
      readFileSync(path.join(into, "tesseract-core-old.wasm.js"))
    );
    assert.equal(readFileSync(path.join(into, WORKER_FILE), "utf8"), "worker");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refuses a worker and an engine from different tesseract.js releases", () => {
  const root = fakeRoot("7.1.0");
  try {
    assert.throws(
      () => stageOcrAssets({ root, into: path.join(root, "out") }),
      /tesseract\.js 7\.0\.0 uses tesseract\.js-core 7\.1\.0, but package\.json resolves 7\.0\.0/
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refuses to stage when a file tesseract.js needs is missing", () => {
  const root = fakeRoot();
  try {
    rmSync(path.join(root, "node_modules", "tesseract.js-core", CORE_FILES[1]));
    assert.throws(
      () => stageOcrAssets({ root, into: path.join(root, "out") }),
      new RegExp(`missing .*${escapeRegExp(CORE_FILES[1])}`)
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the staged directory is generated, never committed", () => {
  const gitignore = readFileSync(path.join(repo, ".gitignore"), "utf8");
  assert.match(gitignore, /^\/public\/ocr\/$/m);
});
