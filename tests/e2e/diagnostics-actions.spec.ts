import { readFile } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";

/**
 * The Diagnostics page's actions, end to end: the integrity check, the
 * query-profiling switch, Clear over a real warning in the error log, and
 * the Download and Copy bundles. The suite runs on both servers (e2e on
 * Node, e2e-rust on the core), and their diagnostics are separate code:
 * the core re-specified the runtime envelope rather than porting it.
 *
 * The error log is the one Node never showed: its boot hook and its routes
 * held separate copies of the ring, so the page read an empty one whatever
 * the server logged (see lib/error-log-ring.ts).
 */

const sameOriginHeaders = {
  origin: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000",
};
const backend = process.env.PLAYWRIGHT_CORE_BIN ? "rust" : "node";

const browserFlow = process.env.CODEX_SANDBOX ? test.skip : test;

test.use({ permissions: ["clipboard-read", "clipboard-write"] });

function card(page: Page, heading: string) {
  return page.locator("section.diagnostics-card", {
    has: page.getByRole("heading", { name: heading }),
  });
}

browserFlow(
  "the integrity check reports on the page and the profiling switch sticks on the server",
  async ({ page }) => {
    await page.goto("/dashboard/diagnostics");

    const database = page.locator("section.diagnostics-card", {
      has: page.getByRole("button", { name: /Run integrity check/ }),
    });
    await database.getByRole("button", { name: /Run integrity check/ }).click();
    await expect(database.locator(".diagnostics-pill")).toContainText("✓ ok");

    // Process state, so later specs must find it as it was.
    const profiling = page.getByRole("checkbox", {
      name: "Profile DB queries",
    });
    const initially = await profiling.isChecked();
    try {
      await profiling.click();
      await expect(profiling).toBeChecked({ checked: !initially });
      await page.reload();
      await expect(profiling).toBeChecked({ checked: !initially });
    } finally {
      if ((await profiling.isChecked()) !== initially) {
        await profiling.click();
      }
    }
    await expect(profiling).toBeChecked({ checked: initially });
    await page.reload();
    await expect(profiling).toBeChecked({ checked: initially });
  }
);

browserFlow(
  "a warning the server logs shows in the error log, and Clear empties it",
  async ({ page, request }) => {
    // A request the limiter turns away makes both servers warn. The
    // rate-limit banner's reset allows ten a minute and nothing else in
    // the suite calls it.
    let denied = false;
    for (let i = 0; i < 11 && !denied; i++) {
      const res = await request.delete("/api/rate-limit/status", {
        headers: sameOriginHeaders,
        data: { category: "search" },
      });
      denied = res.status() === 429;
    }
    expect(denied, "the limiter turned a request away").toBe(true);

    await page.goto("/dashboard/diagnostics");
    const errorLog = card(page, "Error log");
    await expect(errorLog.locator("tbody")).toContainText(
      "[rate-limit] DENY rate_limit.clear"
    );

    await page.getByRole("button", { name: "↻ Clear" }).click();
    await expect(errorLog).toContainText("No errors or warnings logged.");
    const after = await request.get("/api/diagnostics/errors");
    await expect(after).toBeOK();
    const { entries } = (await after.json()) as {
      entries: { message: string }[];
    };
    expect(
      entries.filter((entry) => entry.message.includes("DENY rate_limit.clear"))
    ).toEqual([]);
  }
);

browserFlow(
  "Download and Copy hand over the same bundle, from this server",
  async ({ page }) => {
    await page.goto("/dashboard/diagnostics");
    await expect(card(page, "Error log")).toBeVisible();

    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "💾 Download" }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(
      /^privacytracker-diagnostics-.+\.json$/
    );
    const file = await download.path();
    const downloaded = JSON.parse(await readFile(file, "utf8"));
    expect(downloaded.runtime.backend).toBe(backend);
    for (const section of ["database", "errorLog", "clientDiagnostics"]) {
      expect(downloaded, section).toHaveProperty(section);
    }

    await page.getByRole("button", { name: "📋 Copy diagnostics" }).click();
    await expect(page.getByRole("button", { name: "✓ Copied" })).toBeVisible();
    const copied = JSON.parse(
      await page.evaluate(() => navigator.clipboard.readText())
    );
    expect(copied.runtime.backend).toBe(backend);
    expect(Object.keys(copied)).toEqual(Object.keys(downloaded));
  }
);
