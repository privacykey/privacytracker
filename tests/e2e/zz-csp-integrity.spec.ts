import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

/**
 * Runs LAST (files run alphabetically, one worker): after every other spec
 * has mutated state — verdicts, resets, imports, layout saves — the HTML
 * the server hands out for each page must still be the HTML the build
 * hashed. If any code path regenerates a prerendered page at runtime
 * (a stray revalidatePath, an ISR setting), its flight scripts change,
 * the hash-based CSP blocks them, and the page goes blank. This caught
 * exactly that once; it stays so it can't come back.
 *
 * Skips itself when there is no hash map next to the server (dev mode).
 */

const distDir = path.resolve(process.env.NEXT_DIST_DIR ?? ".next");
const mapPath = path.join(distDir, "csp-hashes.json");

const ROUTES = [
  "/",
  "/dashboard",
  "/dashboard/apps",
  "/dashboard/stats",
  "/dashboard/settings/you",
  "/dashboard/settings/admin",
  "/dashboard/review-recommendations",
  "/dashboard/shortlist",
  "/apps/94961186",
  "/definitely-not-a-route",
];

test("served HTML still matches the build-time CSP hash map", async ({
  request,
}) => {
  test.skip(!existsSync(mapPath), "no csp-hashes.json (dev server)");
  const map = JSON.parse(readFileSync(mapPath, "utf8")) as {
    all: string[];
    routes: Record<string, string[]>;
  };
  const known = new Set(map.all);
  const drift: string[] = [];
  for (const route of ROUTES) {
    const res = await request.get(route);
    const html = await res.text();
    for (const m of html.matchAll(
      /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi
    )) {
      if (m[1].trim().length === 0) {
        continue;
      }
      const hash = `sha256-${createHash("sha256").update(m[1], "utf8").digest("base64")}`;
      if (!known.has(hash)) {
        drift.push(
          `${route}: ${hash} ${m[1].slice(0, 70).replace(/\s+/g, " ")}`
        );
      }
    }
  }
  expect(
    drift,
    `inline scripts the build never hashed (page regenerated at runtime?):\n  ${drift.join("\n  ")}`
  ).toEqual([]);
});
