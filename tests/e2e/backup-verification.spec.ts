import { expect, test } from "@playwright/test";

const ecid = "ABCDEF1234567890";
const origin = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000";
const stamp = {
  finishedAt: Date.now() - 60_000,
  manifestBytes: 4096,
  path: "/Users/test/Library/Application Support/MobileSync/Backup/test-device",
};

test.beforeEach(async ({ page, request }) => {
  for (const [url, data] of [
    ["/api/reset", undefined],
    [
      "/api/focus",
      {
        audience: "self",
        monitor: true,
        cleanup: true,
        minimal: false,
        accessibility: false,
      },
    ],
    ["/api/dev/seed-sample-data?source=canned", undefined],
    [
      "/api/feature-flags/overrides",
      { key: "flag.devopts.cfgutil_uninstall", value: "on" },
    ],
  ] as const) {
    await expect(
      await request.post(url, { headers: { origin }, data })
    ).toBeOK();
  }
  const apps = await (await request.get("/api/apps")).json();
  await expect(
    await request.post("/api/verdicts", {
      headers: { origin },
      data: { appId: apps[0].id, verdict: "uninstall" },
    })
  ).toBeOK();
  // Exercise the desktop UI without making any real native/device calls.
  await page.addInitScript(
    ({ selectedEcid, backupPath }) => {
      Object.assign(window, {
        __TAURI_INTERNALS__: {
          transformCallback: () => 1,
          unregisterCallback: () => {},
          invoke: async (command: string) => {
            if (command === "list_connected_devices") {
              return {
                devices: [{ ecid: selectedEcid, name: "Test iPhone" }],
                cfgutil_unavailable: false,
              };
            }
            if (command === "run_cfgutil_backup") {
              return {
                ok: true,
                ecid: selectedEcid,
                backup_path: backupPath,
                finished_at: Date.now(),
                log: "",
              };
            }
            if (command === "run_cfgutil_remove_app") {
              throw new Error("Unexpected device removal in backup UI test");
            }
            return null;
          },
        },
      });
    },
    { selectedEcid: ecid, backupPath: stamp.path }
  );
});

test("reopened wizard uses the server backup for its final confirmation", async ({
  page,
}, testInfo) => {
  let preflight = false;
  await page.route("**/api/device-actions/uninstall?*", async (route) => {
    await route.fulfill({
      json: preflight
        ? { allowed: false, reason: "backup_unverified", lastBackup: stamp }
        : { allowed: true, lastBackup: stamp },
    });
  });
  await page.goto("/dashboard/review-recommendations?step=backup");
  await expect(
    page.getByText("A verified backup is available", { exact: false })
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("backup-verified.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Continue to uninstall" }).click();
  await expect(
    page.getByRole("button", { name: "Delete 1 app", exact: true })
  ).toBeEnabled();
  await page.getByRole("button", { name: "Delete 1 app", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Continue", exact: true })
    .click();
  await expect(
    page
      .getByRole("dialog")
      .getByText("A verified backup for", { exact: false })
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Delete apps", exact: true })
  ).toBeDisabled();
  preflight = true;
  await page.getByPlaceholder("DELETE", { exact: true }).fill("DELETE");
  await page.getByRole("button", { name: "Delete apps", exact: true }).click();
  await expect(
    page.getByText("The safety check refused this run", { exact: false })
  ).toBeVisible();
});

test("failed backup recording cannot enable the verified continuation", async ({
  page,
}) => {
  await page.route("**/api/device-actions/uninstall?*", (route) =>
    route.fulfill({
      json: { allowed: false, reason: "backup_missing", lastBackup: null },
    })
  );
  await page.route("**/api/device-actions/backup", (route) =>
    route.fulfill({ status: 422, json: { error: "backup_not_verified" } })
  );
  await page.goto("/dashboard/review-recommendations?step=backup");
  await expect(
    page.getByRole("button", { name: "Run backup", exact: true })
  ).toBeEnabled();
  await page.getByRole("button", { name: "Run backup", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Retry safety check" })
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Continue to uninstall" })
  ).toHaveCount(0);
  await expect(
    page.getByText("Apple Configurator completed the backup, but", {
      exact: false,
    })
  ).toBeVisible();
});

test("unreachable backup check shows the explicit no-backup confirmation", async ({
  page,
}) => {
  await page.route("**/api/device-actions/uninstall?*", (route) =>
    route.fulfill({ status: 503, json: { error: "unavailable" } })
  );
  await page.goto("/dashboard/review-recommendations?step=backup");
  await page
    .getByRole("button", { name: "Skip backup (at your own risk)" })
    .click();
  await expect(
    page.getByText("The local backup check could not be reached.")
  ).toBeVisible();
  await page.getByRole("button", { name: "Delete 1 app", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "Continue", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: /Proceed without a backup/ })
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Delete apps without backup" })
  ).toBeDisabled();
});
