/**
 * Where screenshot import's OCR engine is served from, and how the wizard
 * starts it.
 *
 * tesseract.js needs three things besides its own main-thread code: a
 * worker script, the Tesseract engine compiled to WebAssembly, and the
 * English model. Left to its defaults it fetches all three from public CDNs
 * (cdn.jsdelivr.net) and starts the worker from a `blob:` URL. The app's
 * CSP refuses that worker outright, and even with the CSP off it would load
 * third-party code into the app's origin on every scan. So the three are
 * copied out of node_modules into `public/ocr/` before every build
 * (`scripts/stage-ocr-assets.mjs`), served by both backends like any other
 * public file, and handed to `createWorker` by path.
 *
 * Dependency-free on purpose: `proxy.ts` imports `OCR_WORKER_PATH` to give
 * the worker script its own policy, and it runs in the proxy sandbox.
 * `core/src/server/csp_policy.rs` repeats the path for the Rust server.
 */

/** The directory the staged assets are served from. */
export const OCR_ASSET_BASE = "/ocr";

/**
 * The worker script. Its response carries a CSP of its own
 * (`OCR_WORKER_CSP_DIRECTIVES`): a dedicated worker started from a
 * same-origin URL is governed by the policy delivered with its script, not
 * by the page's, so this is the one response that may compile WebAssembly.
 */
export const OCR_WORKER_PATH = `${OCR_ASSET_BASE}/worker.min.js`;

/**
 * The worker's policy. Everything it loads is same-origin: the engine by
 * `importScripts` (script-src), the model by `fetch` (connect-src). The
 * engine then compiles its WebAssembly, which a CSP only allows with
 * `'wasm-unsafe-eval'`; that keyword permits WebAssembly compilation and
 * nothing else (no `eval`, no `new Function`). No page carries it.
 */
export const OCR_WORKER_CSP_DIRECTIVES = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "report-uri /api/csp-report",
] as const;

/**
 * The `createWorker` options that keep OCR on the app's own origin.
 * `corePath` is a directory so tesseract.js can pick the relaxed-SIMD, SIMD
 * or plain build of its LSTM engine for the browser it is running in; the
 * staging script copies all three. `langPath` holds `eng.traineddata.gz`.
 */
export const OCR_WORKER_OPTIONS = {
  workerPath: OCR_WORKER_PATH,
  corePath: OCR_ASSET_BASE,
  langPath: OCR_ASSET_BASE,
  workerBlobURL: false,
} as const;

/** How long the wizard waits for the worker, engine and model to load. The
 *  screenshot method is offered on desktops only, where the ~7 MB comes
 *  from the app's own server, so this is far above a normal start. */
export const OCR_START_TIMEOUT_MS = 120_000;

/**
 * Wait for tesseract.js's `createWorker` with the two exits it lacks.
 *
 * tesseract.js 7 settles `createWorker` only when its first step fails.
 * A model that cannot be downloaded is reported to `errorHandler` while
 * the promise stays pending, and an engine that cannot compile is not
 * reported at all; either way the wizard used to stay on "Preparing
 * screenshot scan…". `start` receives `fail`, to call from `errorHandler`,
 * and the wait gives up by itself after `timeoutMs`. A worker that arrives
 * after the wait has given up is handed to `discard`, to be terminated.
 */
export function awaitOcrStart<T>(
  start: (fail: (reason: unknown) => void) => Promise<T>,
  timeoutMs: number = OCR_START_TIMEOUT_MS,
  discard?: (late: T) => void
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = (finish: () => void) => {
      if (settled) {
        return false;
      }
      settled = true;
      clearTimeout(timer);
      finish();
      return true;
    };
    const fail = (reason: unknown) => {
      settle(() => reject(reason));
    };
    timer = setTimeout(() => {
      fail(
        new Error(
          `The OCR engine did not start within ${Math.round(timeoutMs / 1000)} seconds.`
        )
      );
    }, timeoutMs);
    let started: Promise<T>;
    try {
      started = start(fail);
    } catch (error) {
      fail(error);
      return;
    }
    started.then(
      (value) => {
        if (!settle(() => resolve(value))) {
          discard?.(value);
        }
      },
      (reason) => fail(reason)
    );
  });
}

/** The longest detail string the wizard shows under "Show technical details". */
const MAX_DETAIL_LENGTH = 500;

/**
 * The technical detail the wizard shows under a failed scan. A worker that
 * never starts rejects with `undefined` (tesseract.js passes on the error
 * event's missing `message`), so every input must produce a string: an
 * empty one when there is nothing to show, which hides the details block.
 */
export function describeOcrError(error: unknown): string {
  if (error === undefined || error === null) {
    return "";
  }
  let detail: string | undefined;
  if (error instanceof Error) {
    detail = error.message || error.name;
  } else if (typeof error === "string") {
    detail = error;
  } else {
    try {
      detail = JSON.stringify(error);
    } catch {
      detail = undefined;
    }
  }
  return (detail || String(error)).slice(0, MAX_DETAIL_LENGTH);
}
