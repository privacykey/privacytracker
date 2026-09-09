import { expect, type Page, test } from "@playwright/test";

/**
 * Full-surface route sweep — every page, in every locale.
 *
 * The behavioural specs cover flows; this net covers BREADTH: it visits
 * every route in the app under each shipped locale and fails on the
 * failure classes a converted client shell can regress silently:
 *
 *   - next-intl MISSING_MESSAGE / i18n errors on the console (a key
 *     referenced in code but absent from the active bundle),
 *   - uncaught page errors (hydration crashes, loader exceptions),
 *   - same-origin requests answering 5xx (a broken API behind a shell
 *     renders as a quiet empty state — the network is where it shows),
 *   - a page that renders nothing at all after settling.
 *
 * For zh it additionally asserts a known translated string actually
 * paints on a nav-bearing page — proving the cookie → locale → bundle
 * plumbing end to end rather than just the absence of errors.
 *
 * Gated behind SWEEP=1 (like VISUAL=1) so CI's runtime doesn't grow by
 * ~70 page loads on every push; run it around anything that touches
 * routing, i18n, or the Phase 0 loaders:
 *
 *   SWEEP=1 npx playwright test tests/e2e/sweep.spec.ts
 */

const sweep = process.env.SWEEP ? test : test.skip;

const sameOriginHeaders = {
  origin: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000",
};

/** Static routes — keep in sync with `find app -name page.tsx`. The two
 *  dynamic routes get their ids from the seeded fixtures below. */
const STATIC_ROUTES = [
  "/",
  "/about",
  "/changelog",
  "/dashboard",
  "/dashboard/about/ai-disclosure",
  "/dashboard/apps",
  "/dashboard/compare",
  "/dashboard/diagnostics",
  "/dashboard/manual-apps",
  "/dashboard/privacy",
  "/dashboard/review-recommendations",
  "/dashboard/settings",
  "/dashboard/settings/admin",
  "/dashboard/settings/devices",
  "/dashboard/settings/focus",
  "/dashboard/settings/focus-matrix",
  "/dashboard/settings/import-history",
  "/dashboard/settings/layout",
  "/dashboard/settings/policies",
  "/dashboard/settings/sync",
  "/dashboard/settings/you",
  "/dashboard/shortlist",
  "/dashboard/stats",
  "/help/definitions",
  "/help/export-app-list",
  "/help/focus",
  "/help/parental-controls",
  "/legal",
  "/login",
  "/onboard",
  "/onboard/goals",
  "/onboard/profile",
  "/privacy-policy",
  "/welcome",
];

/** Console text that indicates a broken translation lookup. */
const I18N_ERROR_RE =
  /MISSING_MESSAGE|INVALID_MESSAGE|INSUFFICIENT_PATH|INVALID_KEY/;
/** Console text Chromium emits when the hash-based CSP blocks something —
 *  a missed hash or a stray inline handler shows up here, on every route. */
const CSP_ERROR_RE =
  /Content Security Policy|Refused to (execute|load|apply|connect)/;

/** A known zh string per surface family, to prove the bundle really
 *  switched (nav renders on most dashboard pages). */
const ZH_PROOF = "隐私地图"; // nav.links.privacy_map

interface RouteIssues {
  consoleCsp: string[];
  consoleI18n: string[];
  pageErrors: string[];
  serverErrors: string[];
}

function watch(page: Page): RouteIssues {
  const issues: RouteIssues = {
    consoleCsp: [],
    consoleI18n: [],
    pageErrors: [],
    serverErrors: [],
  };
  page.on("console", (msg) => {
    if (msg.type() === "error" && I18N_ERROR_RE.test(msg.text())) {
      issues.consoleI18n.push(msg.text().slice(0, 200));
    }
    if (msg.type() === "error" && CSP_ERROR_RE.test(msg.text())) {
      issues.consoleCsp.push(msg.text().slice(0, 200));
    }
  });
  page.on("pageerror", (error) => {
    issues.pageErrors.push(String(error).slice(0, 200));
  });
  page.on("response", (res) => {
    if (res.status() >= 500 && res.url().startsWith(sameOriginHeaders.origin)) {
      issues.serverErrors.push(
        `${res.status()} ${new URL(res.url()).pathname}`
      );
    }
  });
  return issues;
}

let instagramId = "";
let manualAppId = "";

test.beforeAll(async ({ request }) => {
  if (!process.env.SWEEP) {
    return;
  }
  const focus = await request.post("/api/focus", {
    headers: sameOriginHeaders,
    data: {
      audience: "self",
      monitor: true,
      cleanup: true,
      minimal: false,
      accessibility: true,
    },
  });
  await expect(focus).toBeOK();
  const seed = await request.post("/api/dev/seed-sample-data?source=canned", {
    headers: sameOriginHeaders,
  });
  await expect(seed).toBeOK();
  const seedBody = (await seed.json()) as {
    results?: Array<{ id: string; name: string }>;
    apps?: Array<{ id: string; name: string }>;
  };
  instagramId =
    (seedBody.apps ?? seedBody.results ?? []).find(
      (s) => s.name === "Instagram"
    )?.id ?? "";
  expect(instagramId, "canned Instagram must seed").toBeTruthy();

  // One manual app so /manual-apps/[id] has a target. Idempotent enough:
  // a second run just adds another row, and the sweep only needs one id.
  const manual = await request.post("/api/manual-apps", {
    headers: sameOriginHeaders,
    data: { name: "Sweep Fixture", source: "web_clip" },
  });
  if (manual.ok()) {
    manualAppId =
      ((await manual.json()) as { app?: { id?: string } }).app?.id ?? "";
  } else {
    // Already present from a previous sweep on this server — look it up.
    const list = await request.get("/api/manual-apps", {
      headers: sameOriginHeaders,
    });
    const apps = ((await list.json()) as { apps?: Array<{ id: string }> }).apps;
    manualAppId = apps?.[0]?.id ?? "";
  }
  expect(manualAppId, "a manual app must exist").toBeTruthy();
});

for (const locale of ["en", "zh"] as const) {
  sweep(
    `sweep: every route is clean in ${locale}`,
    async ({ page, baseURL }) => {
      test.setTimeout(300_000);
      await page.context().addCookies([
        {
          name: "NEXT_LOCALE",
          value: locale,
          url: baseURL ?? sameOriginHeaders.origin,
        },
      ]);
      const issues = watch(page);
      const failures: string[] = [];

      const routes = [
        ...STATIC_ROUTES,
        `/apps/${instagramId}`,
        `/manual-apps/${manualAppId}`,
      ];
      for (const route of routes) {
        const before = {
          csp: issues.consoleCsp.length,
          i18n: issues.consoleI18n.length,
          errs: issues.pageErrors.length,
          srv: issues.serverErrors.length,
        };
        await page.goto(route, { waitUntil: "load" });
        // Let client loaders settle: the Phase 0 shells render after their
        // fetches resolve, and redirect routes (/, /onboard/goals) need
        // the router to land.
        await page.waitForTimeout(1200);

        // The client tree must have mounted: `main` (or the bare login form)
        // with real text. The old body-text check passed on the noscript /
        // skip-link copy alone, which let a page whose JavaScript never
        // booted (a CSP block, a hash drift) slide through as "rendered".
        const mounted = await page.evaluate(() => {
          const root =
            document.querySelector("main") ?? document.querySelector("form");
          return (
            (root?.textContent ?? "").trim().length > 0 ||
            Boolean(document.querySelector("form"))
          );
        });
        if (!mounted) {
          failures.push(`${route}: client tree never mounted (blank page)`);
        }
        if (issues.consoleI18n.length > before.i18n) {
          failures.push(
            `${route}: i18n errors — ${issues.consoleI18n.slice(before.i18n).join(" | ")}`
          );
        }
        if (issues.consoleCsp.length > before.csp) {
          failures.push(
            `${route}: CSP violations — ${issues.consoleCsp.slice(before.csp).join(" | ")}`
          );
        }
        if (issues.pageErrors.length > before.errs) {
          failures.push(
            `${route}: page errors — ${issues.pageErrors.slice(before.errs).join(" | ")}`
          );
        }
        if (issues.serverErrors.length > before.srv) {
          failures.push(
            `${route}: 5xx — ${issues.serverErrors.slice(before.srv).join(" | ")}`
          );
        }
      }

      if (locale === "zh") {
        // Prove the locale plumbing on a nav-bearing page, not just the
        // absence of errors.
        await page.goto("/dashboard/apps", { waitUntil: "load" });
        await expect(page.locator("nav")).toContainText(ZH_PROOF);
      }

      expect(
        failures,
        `route sweep (${locale}) found:\n  ${failures.join("\n  ")}`
      ).toEqual([]);
    }
  );
}
