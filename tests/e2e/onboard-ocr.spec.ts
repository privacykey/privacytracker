import { expect, type Page, test } from "@playwright/test";

/**
 * Screenshot import (the onboarding wizard's "Upload screenshots" method),
 * end to end on a production build under the enforced CSP.
 *
 * tesseract.js reads the screenshot in a browser worker. Its defaults start
 * that worker from a `blob:` URL and fetch the worker script, the
 * WebAssembly engine and the English model from public CDNs; the CSP
 * refused the worker and the wizard sat on "Preparing screenshot scan…"
 * for good. The wizard now starts it from the copies the app serves under
 * /ocr/ (lib/ocr-assets.ts, scripts/stage-ocr-assets.mjs), and the worker
 * script's response carries the one policy that allows WebAssembly.
 *
 * The first spec runs a real scan of a PNG rendered at test time and
 * checks the three promises: the names come out, nothing leaves this
 * machine, and the CSP reports nothing. The second pins the failure path:
 * a worker that cannot start must end in an error message, not a spinner.
 *
 * Runs on both backends: CI's quality job serves `next start`, e2e-rust
 * serves the same build from `pt-core serve`.
 */

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000";
const origin = new URL(baseURL).origin;
const sameOriginHeaders = { origin };

const browserFlow = process.env.CODEX_SANDBOX ? test.skip : test;

/** Distinct, dictionary-unlike names a real Home Screen list might hold. */
const APP_NAMES = ["Instagram", "Spotify", "WhatsApp", "Duolingo", "Strava"];

test.beforeEach(async ({ request }) => {
  // /onboard sends a visitor with no audience back to /welcome.
  const focus = await request.post("/api/focus", {
    headers: sameOriginHeaders,
    data: {
      audience: "self",
      monitor: true,
      cleanup: false,
      minimal: false,
      accessibility: false,
    },
  });
  await expect(focus).toBeOK();
});

/**
 * Render the app names as a crisp list and screenshot it: a stand-in for
 * an iPhone Storage screenshot, made fresh each run so no image fixture is
 * committed.
 */
async function renderScreenshot(page: Page, file: string) {
  await page.setViewportSize({ width: 720, height: 720 });
  await page.setContent(
    `<!doctype html><html><body style="margin:0;background:#fff">
      <div id="list" style="width:640px;padding:40px;color:#111;
        font:700 44px/1.7 Arial, Helvetica, 'Liberation Sans', sans-serif">
        ${APP_NAMES.map((name) => `<div>${name}</div>`).join("")}
      </div>
    </body></html>`
  );
  await page.locator("#list").screenshot({ path: file });
}

/** Onboarding step 1 → the screenshots method → step 2. On a desktop the
 *  method sits in the "Other import options" drawer. */
async function openScreenshotMethod(page: Page) {
  await page.goto("/onboard?preview=fresh");
  await page.getByText("Other import options").click();
  const card = page.getByTestId("onboard-method-screenshots");
  // The method cards are React-only buttons; retry the click until
  // hydration has attached the handler (see onboard-import.spec.ts).
  await expect(async () => {
    await card.click();
    await expect(card).toHaveAttribute("aria-checked", "true", {
      timeout: 500,
    });
  }).toPass({ timeout: 10_000 });
  await page.getByTestId("onboard-step1-continue").click();
}

interface CspReport {
  blockedUri: string;
  directive: string;
  documentUri: string;
  receivedAt: number;
}

browserFlow(
  "reads app names from a screenshot with nothing fetched off this machine and no CSP violation",
  async ({ page, context, request }, testInfo) => {
    // The first scan downloads ~7 MB from the local server and compiles
    // the engine; allow for a slow CI runner.
    test.setTimeout(120_000);
    const startedAt = Date.now();

    const canvas = await context.newPage();
    const png = testInfo.outputPath("app-list.png");
    await renderScreenshot(canvas, png);
    await canvas.close();

    // Anything addressed anywhere but this server is recorded and refused,
    // so a regression back to the CDN defaults fails the scan as well as
    // the assertion below.
    const offMachine: string[] = [];
    await context.route(
      (url) => url.origin !== origin,
      async (route) => {
        offMachine.push(route.request().url());
        await route.abort();
      }
    );
    const requested: string[] = [];
    page.on("request", (req) => requested.push(req.url()));
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    const cspConsole: string[] = [];
    page.on("console", (message) => {
      if (/content security policy/i.test(message.text())) {
        cspConsole.push(message.text());
      }
    });
    // Violations in the page itself; the worker's own land in the server's
    // report ring through its policy's report-uri, checked at the end.
    await page.addInitScript(() => {
      const seen: string[] = [];
      (window as unknown as { __cspViolations: string[] }).__cspViolations =
        seen;
      document.addEventListener("securitypolicyviolation", (event) => {
        seen.push(`${event.effectiveDirective} ${event.blockedURI}`);
      });
    });

    await openScreenshotMethod(page);
    const workerStarted = page.waitForEvent("worker");
    await page
      .locator('input[type="file"][accept="image/*"]')
      .setInputFiles(png);

    // The worker runs from the app's own URL, not a blob: wrapper.
    const worker = await workerStarted;
    expect(worker.url()).toBe(`${origin}/ocr/worker.min.js`);

    const rows = page.locator(".imported-apps-row-name");
    await expect(page.locator(".wizard-note-green")).toContainText(
      /Extracted \d+ app names/,
      { timeout: 90_000 }
    );
    for (const name of APP_NAMES) {
      await expect(rows.filter({ hasText: name })).toHaveCount(1);
    }
    await expect(page.locator(".wizard-note-red")).toHaveCount(0);

    // The engine and the model came from this server, so the request log
    // really does include the worker's traffic.
    expect(
      requested.some((url) =>
        /^.*\/ocr\/tesseract-core(-relaxedsimd|-simd)?-lstm\.wasm\.js$/.test(
          url
        )
      ),
      "the engine is loaded from /ocr/"
    ).toBe(true);
    expect(requested).toContain(`${origin}/ocr/eng.traineddata.gz`);
    expect(offMachine, "requests that left this machine").toEqual([]);
    expect(
      requested.filter((url) => !url.startsWith(`${origin}/`)),
      "every request stays on this origin"
    ).toEqual([]);

    expect(pageErrors).toEqual([]);
    expect(cspConsole).toEqual([]);
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { __cspViolations: string[] }).__cspViolations
      )
    ).toEqual([]);
    // Reports are posted asynchronously; give a late one time to arrive.
    await page.waitForTimeout(1000);
    const ring = await request.get("/api/csp-report");
    await expect(ring).toBeOK();
    const { reports } = (await ring.json()) as { reports: CspReport[] };
    expect(
      reports.filter((report) => report.receivedAt >= startedAt),
      "CSP reports posted during the scan"
    ).toEqual([]);
  }
);

browserFlow(
  "a worker that cannot start ends in an error message, not an endless spinner",
  async ({ page, context }, testInfo) => {
    const canvas = await context.newPage();
    const png = testInfo.outputPath("app-list.png");
    await renderScreenshot(canvas, png);
    await canvas.close();

    // What a refused worker looks like to tesseract.js: an error event with
    // no message, which it rejects with as `undefined`.
    await page.addInitScript(() => {
      class RefusedWorker extends EventTarget {
        onerror: ((event: Event) => void) | null = null;
        onmessage: ((event: MessageEvent) => void) | null = null;
        constructor() {
          super();
          setTimeout(() => this.onerror?.(new Event("error")), 0);
        }
        postMessage() {
          // Never answers: the worker did not start.
        }
        terminate() {
          // Nothing to stop.
        }
      }
      (window as unknown as { Worker: unknown }).Worker = RefusedWorker;
    });
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await openScreenshotMethod(page);
    await page
      .locator('input[type="file"][accept="image/*"]')
      .setInputFiles(png);

    await expect(page.locator(".wizard-note-red")).toContainText(
      "Screenshot scanning failed in this browser."
    );
    await expect(page.locator(".spinner-sm")).toHaveCount(0);
    await expect(page.getByText("Preparing screenshot scan…")).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  }
);

browserFlow(
  "a model that cannot be downloaded ends in an error message, not an endless spinner",
  async ({ page, context }, testInfo) => {
    const canvas = await context.newPage();
    const png = testInfo.outputPath("app-list.png");
    await renderScreenshot(canvas, png);
    await canvas.close();

    // A deployment without the model: tesseract.js reports the failed
    // download to errorHandler and leaves createWorker pending, which the
    // wizard has to turn into an error itself (awaitOcrStart).
    await context.route(`${origin}/ocr/eng.traineddata.gz`, (route) =>
      route.fulfill({ status: 404, body: "Not Found" })
    );
    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await openScreenshotMethod(page);
    await page
      .locator('input[type="file"][accept="image/*"]')
      .setInputFiles(png);

    const failure = page.locator(".wizard-note-red");
    await expect(failure).toContainText(
      "Screenshot scanning failed in this browser.",
      { timeout: 30_000 }
    );
    await failure.getByText("Show technical details").click();
    await expect(failure.locator("pre")).toContainText("404");
    await expect(page.locator(".spinner-sm")).toHaveCount(0);
    expect(pageErrors).toEqual([]);
  }
);
