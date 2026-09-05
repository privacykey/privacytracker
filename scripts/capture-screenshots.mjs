#!/usr/bin/env node
/**
 * Capture a consistent set of UI screenshots into `docs/screenshots/`
 * (gitignored — the images are for docs, issues, and release notes).
 *
 * Screenshots rot, so this exists to make refreshing them a two-command
 * chore rather than an afternoon of cropping. Every shot is taken against
 * the canned demo fixture, never real user data.
 *
 * Usage:
 *
 *   # 1. build and serve on :3001 with a throwaway database
 *   rm -rf .playwright-data && mkdir -p .playwright-data
 *   NEXT_DIST_DIR=.next-e2e pnpm build
 *   NEXT_DIST_DIR=.next-e2e PRIVACYTRACKER_DATA_DIR="$PWD/.playwright-data" \
 *     AUDITOR_ADMIN_TOKEN=privacytracker-playwright-token \
 *     pnpm start -- -H 127.0.0.1 -p 3001
 *
 *   # 2. in another shell
 *   pnpm screenshots
 *
 * Flags:
 *   --light   also write light-mode variants (`*-light.png`).
 *
 * Env:
 *   SCREENSHOT_BASE_URL   default http://127.0.0.1:3001
 *   SCREENSHOT_ADMIN_TOKEN  must match the server's AUDITOR_ADMIN_TOKEN
 *
 * The server needs a *disposable* data directory: this script calls
 * /api/reset and seeds fixtures, so never point it at a real install.
 */
import { chromium } from "@playwright/test";

const BASE = process.env.SCREENSHOT_BASE_URL ?? "http://127.0.0.1:3001";
const TOKEN =
  process.env.SCREENSHOT_ADMIN_TOKEN ?? "privacytracker-playwright-token";
const OUT = "docs/screenshots";
const WITH_LIGHT = process.argv.includes("--light");

const HEADERS = { "x-auditor-admin-token": TOKEN, origin: BASE };

/** Strict profile — makes the mismatch badges in the shots meaningful
 *  rather than an all-clear page. */
const STRICT_PROFILE = {
  CONTACT_INFO: "not_linked",
  HEALTH_AND_FITNESS: "not_collected",
  FINANCIAL_INFO: "not_linked",
  LOCATION: "not_collected",
  SENSITIVE_INFO: "not_collected",
  CONTACTS: "not_collected",
  USER_CONTENT: "not_linked",
  BROWSING_HISTORY: "not_collected",
  SEARCH_HISTORY: "not_linked",
  IDENTIFIERS: "not_linked",
  PURCHASES: "not_linked",
  USAGE_DATA: "not_linked",
  DIAGNOSTICS: "not_linked",
  OTHER: "not_collected",
};

async function post(request, path, data) {
  const res = await request.post(`${BASE}${path}`, { headers: HEADERS, data });
  if (!res.ok()) {
    throw new Error(`${path} -> HTTP ${res.status()}`);
  }
  return res;
}

const browser = await chromium.launch();

// --- fixture state -------------------------------------------------------
const setup = await browser.newContext({
  baseURL: BASE,
  extraHTTPHeaders: HEADERS,
});
await post(setup.request, "/api/reset");
await post(setup.request, "/api/focus", {
  audience: "self",
  monitor: true,
  cleanup: true,
  minimal: false,
  accessibility: false,
});
const seedRes = await post(
  setup.request,
  "/api/dev/seed-sample-data?source=canned"
);
const seedBody = await seedRes.json();
const seeded = seedBody.apps ?? seedBody.results ?? [];
const detailApp = seeded.find((s) => s.name === "Instagram") ?? seeded[0];
if (!detailApp) {
  throw new Error("seeding produced no apps — cannot capture the detail shot");
}
const put = await setup.request.put(`${BASE}/api/privacy-profile`, {
  headers: HEADERS,
  data: { profile: STRICT_PROFILE },
});
if (!put.ok()) {
  throw new Error(`/api/privacy-profile -> HTTP ${put.status()}`);
}
// The coachmark tour auto-opens for a fresh profile and dims the whole
// dashboard behind a spotlight overlay — useless in a still.
await post(setup.request, "/api/feature-flags/overrides", {
  key: "flag.onboarding.coachmark_tour",
  value: "off",
});
await setup.close();
console.log(`seeded ${seeded.length} demo apps`);

// --- capture -------------------------------------------------------------
async function shot(page, { path, file, waitFor, scrollY }) {
  await page.goto(`${BASE}${path}`);
  if (waitFor) {
    await page.locator(waitFor).first().waitFor({ timeout: 15_000 });
  }
  await page.waitForTimeout(900);
  if (scrollY) {
    // An explicit offset, not scrollIntoView*: the dashboard opens on the
    // first-run checklist, and we want the risk sections below it.
    await page.evaluate((y) => window.scrollTo(0, y), scrollY);
    await page.waitForTimeout(600);
  }
  await page.screenshot({ path: `${OUT}/${file}` });
  console.log("captured", file);
}

const DESKTOP_SHOTS = [
  {
    path: "/dashboard/apps",
    file: "apps-grid.png",
    // `main` is the layout wrapper and exists before the grid loads
    // client-side — wait for an actual card.
    waitFor: ".app-card",
  },
  {
    path: `/apps/${detailApp.id}`,
    file: "app-detail.png",
    waitFor: "h1.detail-hero-name",
  },
  {
    path: "/dashboard",
    file: "dashboard.png",
    // Client shell (Rust-core Phase 0): wait for HomeView's root, not
    // the layout wrapper, so the shot isn't an empty page.
    waitFor: ".home-page",
    scrollY: 455,
  },
  {
    path: "/dashboard/privacy",
    file: "privacy-map.png",
    waitFor: ".pmap-grid",
  },
];

for (const scheme of WITH_LIGHT ? ["dark", "light"] : ["dark"]) {
  const ctx = await browser.newContext({
    baseURL: BASE,
    extraHTTPHeaders: HEADERS,
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: scheme,
  });
  const page = await ctx.newPage();
  const suffix = scheme === "dark" ? "" : "-light";
  for (const s of DESKTOP_SHOTS) {
    await shot(page, { ...s, file: s.file.replace(".png", `${suffix}.png`) });
  }
  await ctx.close();
}

// Phone width — the mobile layout is a different composition, not just a
// narrower one, so it earns its own shot.
const mob = await browser.newContext({
  baseURL: BASE,
  extraHTTPHeaders: HEADERS,
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  colorScheme: "dark",
  isMobile: true,
  hasTouch: true,
});
await shot(await mob.newPage(), {
  path: "/dashboard/apps",
  file: "apps-grid-mobile.png",
  waitFor: ".app-card",
});
await mob.close();

await browser.close();
console.log("done");
