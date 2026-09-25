import { readFile } from "node:fs/promises";
import { type APIRequestContext, expect, test } from "@playwright/test";

/**
 * The whole-database backup, end to end in the browser: download a backup
 * from Settings, change the data, restore the file through the preview and
 * the typed confirmation, and find the original data back after the page
 * reloads. Restore rebuilds every table, and nothing else drives it through
 * the UI; the suite runs on both servers (e2e on Node, e2e-rust on the
 * core), so this covers both implementations of it.
 */

const sameOriginHeaders = {
  origin: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000",
};

const browserFlow = process.env.CODEX_SANDBOX ? test.skip : test;

test.beforeEach(async ({ request }) => {
  const reset = await request.post("/api/reset", {
    headers: sameOriginHeaders,
  });
  await expect(reset).toBeOK();
  const focus = await request.post("/api/focus", {
    headers: sameOriginHeaders,
    data: {
      audience: "self",
      monitor: true,
      cleanup: false,
      minimal: false,
      accessibility: true,
    },
  });
  await expect(focus).toBeOK();
  const seed = await request.post(
    "/api/dev/seed-sample-data?source=canned&limit=3",
    { headers: sameOriginHeaders }
  );
  await expect(seed).toBeOK();
});

interface AppRow {
  iconUrl: string | null;
  id: string;
  name: string;
  privacyPolicyUrl: string | null;
}

/**
 * Every app row, in id order. Restore re-validates each URL column (a
 * tampered backup must not plant a `javascript:` link) and stores an empty
 * one as null, so "" and null are the same "no link" here.
 */
async function apps(request: APIRequestContext): Promise<AppRow[]> {
  const res = await request.get("/api/apps", { headers: sameOriginHeaders });
  await expect(res).toBeOK();
  return ((await res.json()) as AppRow[])
    .map((row) => ({
      ...row,
      iconUrl: row.iconUrl || null,
      privacyPolicyUrl: row.privacyPolicyUrl || null,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

async function audience(request: APIRequestContext): Promise<string> {
  const res = await request.get("/api/focus", { headers: sameOriginHeaders });
  await expect(res).toBeOK();
  return ((await res.json()) as { audience: string }).audience;
}

browserFlow(
  "backup: download it from Settings, change the data, restore the file, get the data back",
  async ({ page, request }) => {
    const before = await apps(request);
    expect(before.length).toBeGreaterThan(1);
    expect(await audience(request)).toBe("self");

    // Download through the Backups card, as a user would.
    await page.goto("/dashboard/settings/admin#backup");
    const section = page.locator("#backup");
    const downloading = page.waitForEvent("download");
    await section.getByRole("button", { name: /Download backup/ }).click();
    const download = await downloading;
    const backupPath = await download.path();
    expect(backupPath).toBeTruthy();
    const backup = await readFile(backupPath as string, "utf8");
    expect(() => JSON.parse(backup)).not.toThrow();

    // Change what the backup holds: one app deleted, the focus moved.
    const deleted = await request.delete(
      `/api/apps?id=${encodeURIComponent(before[0].id)}`,
      { headers: sameOriginHeaders }
    );
    await expect(deleted).toBeOK();
    const moved = await request.post("/api/focus", {
      headers: sameOriginHeaders,
      data: {
        audience: "loved_one",
        monitor: true,
        cleanup: false,
        minimal: false,
        accessibility: true,
      },
    });
    await expect(moved).toBeOK();
    expect((await apps(request)).length).toBe(before.length - 1);
    expect(await audience(request)).toBe("loved_one");

    // Restore the downloaded file: preview, typed confirmation, apply. The
    // section also holds the audit-bundle import, a second file input.
    await section.getByLabel(/Choose backup file/).setInputFiles({
      name: download.suggestedFilename(),
      mimeType: "application/json",
      buffer: Buffer.from(backup),
    });
    const dialog = page.getByRole("dialog", {
      name: "Replace all data with this backup?",
    });
    await expect(dialog).toBeVisible();
    const confirm = dialog.getByRole("button", { name: "Restore backup" });
    await expect(confirm).toBeDisabled();
    await dialog.locator("#restore-confirm-input").fill("RESTORE");
    await expect(confirm).toBeEnabled();
    const reloaded = page.waitForEvent("load");
    await confirm.click();
    await reloaded;

    // Everything the backup held is back: the deleted app and the focus.
    expect(await apps(request)).toEqual(before);
    expect(await audience(request)).toBe("self");
  }
);
