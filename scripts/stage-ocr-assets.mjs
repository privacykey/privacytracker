// Stage the OCR engine that screenshot import runs in the browser into
// `public/ocr/`, so every deployment serves it from the app's own origin.
//
// tesseract.js, left to its defaults, starts its worker from a `blob:` URL
// and has it download the engine and the English model from public CDNs
// (cdn.jsdelivr.net). The CSP refuses the worker, and nothing else in the
// app loads third-party code, so the wizard instead points `createWorker`
// at these copies (`lib/ocr-assets.ts`):
//
//   worker.min.js                            tesseract.js's worker script
//   tesseract-core{,-simd,-relaxedsimd}-lstm.wasm.js
//                                            the engine, in the three builds
//                                            tesseract.js picks between for
//                                            LSTM-only recognition
//   eng.traineddata.gz                       the English model it loads for
//                                            LSTM-only recognition
//
// plus THIRD-PARTY-OCR.md and the licence texts it names. `public/` is what
// reaches every deployment: `next start` serves it, `stage-site.mjs` copies
// it for the Rust core (the desktop bundle and the Docker image), and
// `stage-standalone.mjs` copies it for the Node sidecar. The directory is
// generated, so it is gitignored and rebuilt from node_modules each time.
//
// Run by `pnpm build`, `pnpm build:standalone` and `pnpm dev` before Next
// starts. Idempotent: wipes the destination first.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..");

/** The worker script, from tesseract.js's `dist/`. Its name is the one
 *  `OCR_WORKER_PATH` in lib/ocr-assets.ts serves. */
export const WORKER_FILE = "worker.min.js";

/** The engine builds tesseract.js's `getCore` chooses between when the
 *  engine mode is LSTM only, as the wizard's `createWorker("eng", 1)` asks:
 *  relaxed SIMD, SIMD, or neither, by what the browser supports. A browser
 *  asks for exactly one, so all three have to be present. */
export const CORE_FILES = [
  "tesseract-core-lstm.wasm.js",
  "tesseract-core-simd-lstm.wasm.js",
  "tesseract-core-relaxedsimd-lstm.wasm.js",
];

/** The model: the directory of `@tesseract.js-data/eng` tesseract.js reads
 *  for LSTM-only recognition, and the gzipped file it asks for. */
export const LANG_DATA_DIR = "4.0.0_best_int";
export const LANG_DATA_FILE = "eng.traineddata.gz";

export const NOTICE_FILE = "THIRD-PARTY-OCR.md";

function packageDir(fromDir, name) {
  const require = createRequire(path.join(fromDir, "package.json"));
  let manifest;
  try {
    manifest = require.resolve(`${name}/package.json`);
  } catch {
    throw new Error(
      `stage-ocr-assets: cannot find ${name} from ${fromDir}. Run \`pnpm install\`.`
    );
  }
  return path.dirname(manifest);
}

function versionOf(dir) {
  return JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"))
    .version;
}

/**
 * @param {{ root?: string, into?: string }} [options] `root` is the
 *   directory holding package.json and node_modules; `into` is where to
 *   stage, defaulting to `<root>/public/ocr`. The test passes both.
 * @returns {{ target: string, files: string[], bytes: number,
 *   versions: Record<string, string> }}
 */
export function stageOcrAssets({ root = repo, into } = {}) {
  const tesseract = packageDir(root, "tesseract.js");
  const core = packageDir(root, "tesseract.js-core");
  const eng = packageDir(root, "@tesseract.js-data/eng");

  // The worker script comes from tesseract.js and the engine from
  // tesseract.js-core, and the two must be the pair tesseract.js was built
  // against. package.json lists the core directly (so /legal can name its
  // version), which lets the two drift apart after a partial upgrade; stop
  // the build rather than ship a mismatched pair.
  const coreForTesseract = packageDir(tesseract, "tesseract.js-core");
  if (realpathSync(coreForTesseract) !== realpathSync(core)) {
    throw new Error(
      `stage-ocr-assets: tesseract.js ${versionOf(tesseract)} uses tesseract.js-core ${versionOf(coreForTesseract)}, but package.json resolves ${versionOf(core)}. Bump them together.`
    );
  }

  /** [source, name in the staged directory] */
  const copies = [
    [path.join(tesseract, "dist", WORKER_FILE), WORKER_FILE],
    [
      path.join(tesseract, "dist", `${WORKER_FILE}.LICENSE.txt`),
      `${WORKER_FILE}.LICENSE.txt`,
    ],
    [path.join(tesseract, "LICENSE.md"), "LICENSE-tesseract.js.txt"],
    ...CORE_FILES.map((name) => [path.join(core, name), name]),
    [path.join(core, "LICENSE"), "LICENSE-tesseract.js-core.txt"],
    [path.join(eng, LANG_DATA_DIR, LANG_DATA_FILE), LANG_DATA_FILE],
    [path.join(root, NOTICE_FILE), NOTICE_FILE],
  ];
  const missing = copies.filter(([from]) => !existsSync(from));
  if (missing.length > 0) {
    throw new Error(
      `stage-ocr-assets: missing ${missing.map(([from]) => path.relative(root, from)).join(", ")}. The OCR packages changed shape; check lib/ocr-assets.ts against them.`
    );
  }

  const target = into ?? path.join(root, "public", "ocr");
  rmSync(target, { recursive: true, force: true });
  mkdirSync(target, { recursive: true });
  let bytes = 0;
  for (const [from, name] of copies) {
    copyFileSync(from, path.join(target, name));
    bytes += statSync(from).size;
  }
  return {
    target,
    files: copies.map(([, name]) => name),
    bytes,
    versions: {
      "tesseract.js": versionOf(tesseract),
      "tesseract.js-core": versionOf(core),
      "@tesseract.js-data/eng": versionOf(eng),
    },
  };
}

// Only run when invoked directly, so the test can import `stageOcrAssets`.
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const result = stageOcrAssets();
    console.log(
      `stage-ocr-assets: ${result.files.length} files, ${(result.bytes / 1024 / 1024).toFixed(1)} MB → ${path.relative(repo, result.target)}`
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
