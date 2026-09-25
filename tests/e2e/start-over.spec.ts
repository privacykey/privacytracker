import { existsSync } from "node:fs";
import path from "node:path";
import { type APIRequestContext, expect, test } from "@playwright/test";

/**
 * "Delete all data", end to end: the one wipe action in Settings (it
 * replaced the separate "Reset all data" and "Start over" buttons, which
 * wiped different subsets while both promised everything). The dialog names
 * what goes and enables "Delete everything" only once DELETE is typed; the
 * wipe removes every tracked app, the privacy profile, the focus, the
 * notifications, the devices and their app links, the automatic backup
 * snapshots and the backup signing key; the browser lands on the welcome
 * screen; and the activity row the route writes after the wipe is what the
 * log holds. A backup downloaded before the wipe still restores, through
 * the "untrusted" confirmation the dialog warned about.
 *
 * Nothing else drives this through the UI; the suite runs on both servers
 * (e2e on Node, e2e-rust on the core), so this covers both implementations
 * of the wipe.
 */

const sameOriginHeaders = {
  origin: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000",
};

const browserFlow = process.env.CODEX_SANDBOX ? test.skip : test;

/** A complete profile, so the save is accepted as it stands. */
const PROFILE = {
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
} as const;

const FOCUS = {
  audience: "self",
  monitor: true,
  cleanup: false,
  minimal: false,
  accessibility: true,
} as const;

test.beforeEach(async ({ request }) => {
  const reset = await request.post("/api/reset", {
    headers: sameOriginHeaders,
  });
  await expect(reset).toBeOK();
  const focus = await request.post("/api/focus", {
    headers: sameOriginHeaders,
    data: FOCUS,
  });
  await expect(focus).toBeOK();
  const profile = await request.put("/api/privacy-profile", {
    headers: sameOriginHeaders,
    data: { profile: PROFILE },
  });
  await expect(profile).toBeOK();
  const seed = await request.post(
    "/api/dev/seed-sample-data?source=canned&limit=3",
    { headers: sameOriginHeaders }
  );
  await expect(seed).toBeOK();
});

async function read<T>(request: APIRequestContext, url: string): Promise<T> {
  const res = await request.get(url, { headers: sameOriginHeaders });
  await expect(res).toBeOK();
  return (await res.json()) as T;
}

interface ActivityRow {
  detail: { mode?: string } | null;
  type: string;
}

interface AppRow {
  id: string;
}

interface SnapshotsPayload {
  directory: string;
  snapshots: unknown[];
}

/** The signing key sits beside the snapshots folder, in the data dir. */
function signingKeyPath(snapshotsDirectory: string): string {
  return path.join(path.dirname(snapshotsDirectory), "backup-signing.key");
}

browserFlow(
  "delete all data: typing DELETE enables it, and apps, devices and local backups all go",
  async ({ page, request }) => {
    // Someone else's device with the seeded apps on it, and a local
    // backup snapshot (which also mints the signing key).
    const apps = await read<AppRow[]>(request, "/api/apps");
    expect(apps.length).toBeGreaterThan(0);
    const created = await request.post("/api/devices", {
      headers: sameOriginHeaders,
      data: {
        name: "Mum's iPad",
        ownerLabel: "Mum",
        ownerAudience: "loved_one",
        permissionAcknowledged: true,
      },
    });
    await expect(created).toBeOK();
    const { device } = (await created.json()) as { device: { id: string } };
    const linked = await request.post("/api/device-sync/commit", {
      headers: sameOriginHeaders,
      data: {
        deviceId: device.id,
        addAppIds: apps.map((a) => a.id),
        removeAppIds: [],
      },
    });
    await expect(linked).toBeOK();
    const snapshot = await request.post("/api/backup/snapshots", {
      headers: sameOriginHeaders,
    });
    await expect(snapshot).toBeOK();

    // What there is to wipe.
    const devicesBefore = await read<{
      devices: { appCount: number; name: string }[];
    }>(request, "/api/devices");
    expect(devicesBefore.devices).toEqual([
      expect.objectContaining({ name: "Mum's iPad", appCount: apps.length }),
    ]);
    const backupsBefore = await read<SnapshotsPayload>(
      request,
      "/api/backup/snapshots"
    );
    expect(backupsBefore.snapshots).toHaveLength(1);
    const keyPath = signingKeyPath(backupsBefore.directory);
    expect(existsSync(keyPath)).toBe(true);
    expect(
      (await read<{ profile: unknown }>(request, "/api/privacy-profile"))
        .profile
    ).not.toBeNull();
    expect(
      (await read<{ audienceSet: boolean }>(request, "/api/focus")).audienceSet
    ).toBe(true);
    const seeded = await read<{ rows: ActivityRow[] }>(
      request,
      "/api/activity?limit=50"
    );
    expect(seeded.rows.length).toBeGreaterThan(0);

    // One action, one dialog that names what goes.
    await page.goto("/dashboard/settings/admin#reset");
    const section = page.locator("#reset");
    await expect(
      section.getByRole("button", { name: "Start over", exact: true })
    ).toHaveCount(0);
    await section
      .getByRole("button", { name: "Delete all data", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Delete everything on this install?",
    });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Your devices");
    await expect(dialog).toContainText("automatic backup snapshots");
    await expect(dialog).toContainText("untrusted");

    // The button stays disabled until the word is typed.
    const confirm = dialog.getByRole("button", {
      name: "Delete everything",
      exact: true,
    });
    await expect(confirm).toBeDisabled();
    const input = dialog.locator("#reset-confirm-input");
    await input.fill("DELET");
    await expect(confirm).toBeDisabled();
    await input.fill("delete");
    await expect(confirm).toBeEnabled();
    await confirm.click();
    await page.waitForURL("**/welcome");

    // What the wipe promises to delete.
    expect(await read<unknown[]>(request, "/api/apps")).toEqual([]);
    expect(
      (await read<{ devices: unknown[] }>(request, "/api/devices")).devices
    ).toEqual([]);
    expect(
      (await read<{ profile: unknown }>(request, "/api/privacy-profile"))
        .profile
    ).toBeNull();
    expect(
      (await read<{ audienceSet: boolean }>(request, "/api/focus")).audienceSet
    ).toBe(false);
    expect(
      (await read<{ notifications: unknown[] }>(request, "/api/notifications"))
        .notifications
    ).toEqual([]);
    const backupsAfter = await read<SnapshotsPayload>(
      request,
      "/api/backup/snapshots"
    );
    expect(backupsAfter.snapshots).toEqual([]);
    expect(existsSync(keyPath)).toBe(false);
    const { rows } = await read<{ rows: ActivityRow[] }>(
      request,
      "/api/activity?limit=50"
    );
    // The seed's rows went with the wipe; the route's own row came after.
    expect(rows.map((r) => [r.type, r.detail?.mode])).toEqual([
      ["reset", "start-over"],
    ]);
  }
);

browserFlow(
  "a backup downloaded before delete all data still restores, after confirming it is untrusted",
  async ({ page, request }) => {
    const before = (await read<AppRow[]>(request, "/api/apps"))
      .map((a) => a.id)
      .sort();
    expect(before.length).toBeGreaterThan(0);
    const exported = await request.get("/api/backup/export", {
      headers: sameOriginHeaders,
    });
    await expect(exported).toBeOK();
    const backup = await exported.text();

    // The wipe deletes the key that signed the file.
    const wiped = await request.post("/api/admin/start-over", {
      headers: sameOriginHeaders,
    });
    await expect(wiped).toBeOK();
    expect(await read<unknown[]>(request, "/api/apps")).toEqual([]);

    // A fresh install restores from onboarding; the focus opens it.
    const focus = await request.post("/api/focus", {
      headers: sameOriginHeaders,
      data: FOCUS,
    });
    await expect(focus).toBeOK();
    await page.goto("/onboard");
    await page
      .locator('.onboard-restore-footer input[type="file"]')
      .setInputFiles({
        name: "privacytracker-backup.json",
        mimeType: "application/json",
        buffer: Buffer.from(backup),
      });
    const dialog = page.getByRole("dialog", {
      name: "Restore from this backup?",
    });
    await expect(dialog).toBeVisible();
    await dialog.locator("#onboard-restore-input").fill("RESTORE");
    await dialog.getByRole("button", { name: "Restore backup" }).click();

    // Refused as not made by this install, and nothing written yet.
    await expect(dialog.getByTestId("restore-untrusted")).toContainText(
      "This install did not make this backup."
    );
    expect(await read<unknown[]>(request, "/api/apps")).toEqual([]);

    // Confirming again restores it.
    await dialog.getByRole("button", { name: "Restore anyway" }).click();
    await page.waitForURL("**/dashboard");
    expect(
      (await read<AppRow[]>(request, "/api/apps")).map((a) => a.id).sort()
    ).toEqual(before);
  }
);
