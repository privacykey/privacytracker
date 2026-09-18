import { type APIRequestContext, expect, test } from "@playwright/test";

/**
 * E2E coverage for the global device scope ("family mode").
 *
 * The scope is the one piece of UI state that changes what EVERY other
 * surface counts, which makes it exactly the thing unit tests can't
 * fully vouch for: the pure model is covered in
 * tests/app/device-scope.test.ts and the SQL in
 * device-scope-server.test.ts, but neither can catch the wiring faults
 * that actually bit during development — a grid whose counts moved while
 * its cards didn't, and a remount that fired before the scoped data
 * arrived and so seeded from the previous scope.
 *
 * So the assertions here deliberately check the cards AND the counts
 * together, and re-check after a reload and a navigation.
 *
 * Fixture: two devices and ten apps — three on the phone, two on the
 * tablet, five tied to no device at all. Every count below derives from
 * that split, and `UNATTACHED_COUNT` exists so a change to the canned
 * sample set fails loudly here instead of silently weakening the spec.
 */

const sameOriginHeaders = {
  origin: process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3000",
};

const browserFlow = process.env.CODEX_SANDBOX ? test.skip : test;

const PHONE_APPS = 3;
const TABLET_APPS = 2;
const UNATTACHED_APPS = 5;
const TOTAL_APPS = PHONE_APPS + TABLET_APPS + UNATTACHED_APPS;

const PHONE_NAME = "Playwright iPhone";
const TABLET_NAME = "Playwright iPad";

let phoneId = "";
let tabletId = "";

/** Create a device and return its id. */
async function createDevice(
  request: APIRequestContext,
  name: string,
  deviceClass: string,
  model: string
): Promise<string> {
  const res = await request.post("/api/devices", {
    headers: sameOriginHeaders,
    data: { name, deviceClass, model },
  });
  await expect(res).toBeOK();
  return (await res.json()).device.id as string;
}

/**
 * Link apps to a device through the re-sync commit endpoint — the same
 * path a real import takes. There is no test-only seeding route for
 * `app_devices`, and adding one would mean the spec exercised a
 * code path no user ever runs.
 */
async function linkApps(
  request: APIRequestContext,
  deviceId: string,
  appIds: string[]
): Promise<void> {
  const res = await request.post("/api/device-sync/commit", {
    headers: sameOriginHeaders,
    data: { deviceId, addAppIds: appIds, removeAppIds: [] },
  });
  await expect(res).toBeOK();
  // The endpoint silently skips ids that don't resolve, so assert the
  // link count rather than trusting a 200 — a fixture that quietly
  // linked nothing would make every scoped assertion below vacuous.
  expect((await res.json()).added).toBe(appIds.length);
}

test.beforeAll(async ({ request }) => {
  const reset = await request.post("/api/reset", {
    headers: sameOriginHeaders,
  });
  await expect(reset).toBeOK();

  // `self` audience with goals set: the focus-switch test asserts the
  // goals survive an audience change, so they have to be non-default.
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

  const seed = await request.post(
    "/api/dev/seed-sample-data?source=canned&limit=10",
    { headers: sameOriginHeaders }
  );
  await expect(seed).toBeOK();

  // `/api/reset` clears `apps` (cascading `app_devices`) but NOT the
  // `devices` table, so devices from earlier specs — the import flows
  // create one per run — are still here and would show up as extra rows
  // in the picker. Clear them explicitly.
  const existing = await (
    await request.get("/api/devices", { headers: sameOriginHeaders })
  ).json();
  for (const device of existing.devices ?? []) {
    await request.delete(`/api/devices/${device.id}`, {
      headers: sameOriginHeaders,
    });
  }

  // Assert the table is actually empty rather than assuming it.
  // `devices.delete` is rate limited to 15/min, so if a future spec
  // ordering leaves more than that behind, the surplus survives
  // silently and the "2 selected" assertion below starts counting rows
  // this spec never created. Failing here names the cause; failing
  // there would not.
  const afterCleanup = await (
    await request.get("/api/devices", { headers: sameOriginHeaders })
  ).json();
  expect(
    afterCleanup.devices?.length ?? 0,
    "leftover devices — likely the 15/min delete rate limit; earlier specs now create more devices than this fixture can clear"
  ).toBe(0);

  phoneId = await createDevice(request, PHONE_NAME, "iPhone", "iPhone15,2");
  tabletId = await createDevice(request, TABLET_NAME, "iPad", "iPad13,4");

  const apps = await (
    await request.get("/api/apps", { headers: sameOriginHeaders })
  ).json();
  expect(Array.isArray(apps)).toBe(true);
  expect(apps.length).toBe(TOTAL_APPS);
  const ids = apps.map((a: { id: string }) => a.id);

  await linkApps(request, phoneId, ids.slice(0, PHONE_APPS));
  await linkApps(
    request,
    tabletId,
    ids.slice(PHONE_APPS, PHONE_APPS + TABLET_APPS)
  );
  // The remainder stay unlinked — that's the "Not tied to a device"
  // bucket, and it has to be non-empty for its row to mean anything.
  expect(ids.length - PHONE_APPS - TABLET_APPS).toBe(UNATTACHED_APPS);
});

test.beforeEach(async ({ request }) => {
  // The scope persists in app_settings, so clear it between tests —
  // otherwise each test inherits whatever the last one selected.
  const reset = await request.delete("/api/device-scope", {
    headers: sameOriginHeaders,
  });
  await expect(reset).toBeOK();
});

/** Tracked app cards, excluding the separately-rendered custom apps. */
const trackedCards = (page: import("@playwright/test").Page) =>
  page
    .locator(".app-card")
    .filter({ hasNot: page.locator(".app-card-custom") });

/**
 * The picker in the nav's right-hand cluster.
 *
 * Scoped to `.nav-right` because the nav ALSO renders a copy inside the
 * mobile drawer — always present in the DOM, hidden by CSS and, while
 * the drawer is closed, removed from the accessibility tree and the tab
 * order by its `aria-hidden` + `inert`, exactly as the nav links are. A bare `.device-scope-trigger` therefore
 * matches two elements and trips Playwright's strict mode. These specs
 * run at desktop width, where `.nav-right` is the one on screen.
 */
const picker = (page: import("@playwright/test").Page) =>
  page.locator(".nav-right .device-scope-trigger");

const popover = (page: import("@playwright/test").Page) =>
  page.locator(".nav-right .device-scope-popover");

/** Open the nav picker and wait for its menu. */
async function openPicker(page: import("@playwright/test").Page) {
  const trigger = picker(page);
  await expect(trigger).toBeVisible();
  await trigger.click();
  await expect(popover(page)).toBeVisible();
  return trigger;
}

/** A picker row by its visible device name. */
const pickerRow = (page: import("@playwright/test").Page, name: string) =>
  popover(page).locator("[data-scope-row]").filter({ hasText: name });

browserFlow(
  "scoping to one device narrows the cards, the counts and the nav badge together",
  async ({ page }) => {
    await page.goto("/dashboard/apps");
    await expect(trackedCards(page).first()).toBeVisible();
    await expect(trackedCards(page)).toHaveCount(TOTAL_APPS);

    await openPicker(page);
    // From "all devices" every row starts ticked, so narrowing to the
    // phone means unticking the other two buckets.
    await pickerRow(page, TABLET_NAME).click();
    await pickerRow(page, "Not tied to a device").click();
    await page.keyboard.press("Escape");

    // Cards AND counts. Checking only one of these is how the original
    // bug survived: the counts followed the device filter while the card
    // list was built from a separate chain that ignored it.
    await expect(trackedCards(page)).toHaveCount(PHONE_APPS);
    // Exact text, not a substring containing "3". The denominator comes
    // from the server's scoped total, which AppGrid seeds ONCE at mount
    // — so a grid that remounted before its scoped data arrived reads
    // "3 of 10 apps" here while still rendering three cards (the
    // client-side filter masks the stale set). Pinning the "N apps
    // tracked" form is what makes this test notice that.
    await expect(page.locator(".page-subtitle")).toHaveText(
      `${PHONE_APPS} apps tracked`
    );
    await expect(picker(page)).toContainText(PHONE_NAME);
    // The in-grid reminder that the list is scoped, with its way out.
    await expect(page.locator(".filter-status-device")).toContainText(
      PHONE_NAME
    );
    // Nav badge counts the same scoped set.
    await expect(
      page.locator(".nav-link", { hasText: "Apps" }).locator(".count-badge")
    ).toHaveText(String(PHONE_APPS));
  }
);

browserFlow(
  "the scope survives a reload and follows the user to another page",
  async ({ page }) => {
    await page.goto("/dashboard/apps");
    await openPicker(page);
    await pickerRow(page, PHONE_NAME).click();
    await pickerRow(page, "Not tied to a device").click();
    await page.keyboard.press("Escape");
    await expect(trackedCards(page)).toHaveCount(TABLET_APPS);

    // Reload: the scope is persisted server-side, not held in component
    // state, so a fresh page load must come back to the same view.
    await page.reload();
    await expect(trackedCards(page).first()).toBeVisible();
    await expect(trackedCards(page)).toHaveCount(TABLET_APPS);
    await expect(picker(page)).toContainText(TABLET_NAME);

    // And it is GLOBAL — Stats counts the same set. This is the whole
    // point of the feature: before it, every surface except the grid
    // silently spoke for the entire fleet.
    await page.goto("/dashboard/stats");
    await expect(picker(page)).toContainText(TABLET_NAME);
    await expect(page.getByText("Apps Tracked")).toBeVisible();
    await expect(
      page.locator(".stat-card", { hasText: "Apps Tracked" })
    ).toContainText(String(TABLET_APPS));
  }
);

browserFlow("clearing the scope restores the whole fleet", async ({ page }) => {
  await page.goto("/dashboard/apps");
  await openPicker(page);
  await pickerRow(page, TABLET_NAME).click();
  await pickerRow(page, "Not tied to a device").click();
  await page.keyboard.press("Escape");
  await expect(trackedCards(page)).toHaveCount(PHONE_APPS);

  // The status chip's ✕ is the in-context escape hatch — a user who
  // landed here with a scope set on another page needs a way out that
  // doesn't require finding the nav control first.
  await page.locator(".filter-status-device .filter-status-clear").click();

  await expect(trackedCards(page)).toHaveCount(TOTAL_APPS);
  await expect(page.locator(".filter-status-device")).toHaveCount(0);
  await expect(picker(page)).toContainText("All devices");
});

browserFlow(
  "two devices can be selected at once, excluding the unattached bucket",
  async ({ page }) => {
    // The motivating case for making this multi-select: "if there's
    // three and we want to look at just two".
    await page.goto("/dashboard/apps");
    await openPicker(page);
    await pickerRow(page, "Not tied to a device").click();
    await page.keyboard.press("Escape");

    await expect(trackedCards(page)).toHaveCount(PHONE_APPS + TABLET_APPS);
    await expect(page.locator(".page-subtitle")).toHaveText(
      `${PHONE_APPS + TABLET_APPS} apps tracked`
    );
    await expect(picker(page)).toContainText("2 selected");
  }
);

browserFlow(
  "apps tied to no device are selectable on their own",
  async ({ page }) => {
    // Manual and CSV imports have no device link. They get their own
    // bucket precisely so that picking a device doesn't make them
    // vanish with no explanation.
    await page.goto("/dashboard/apps");
    await openPicker(page);
    await pickerRow(page, PHONE_NAME).click();
    await pickerRow(page, TABLET_NAME).click();
    await page.keyboard.press("Escape");

    await expect(trackedCards(page)).toHaveCount(UNATTACHED_APPS);
    await expect(page.locator(".page-subtitle")).toHaveText(
      `${UNATTACHED_APPS} apps tracked`
    );
    await expect(picker(page)).toContainText("Not tied to a device");
  }
);

browserFlow(
  "exports stay whole-install, and say so while a scope is active",
  async ({ page }) => {
    // The decision: an export is a record of the install, and whoever
    // opens the file cannot tell a partial one from a complete one — so
    // exports ignore the scope. That is only defensible if the user is
    // told, otherwise Stats reads "N apps" directly above a download
    // containing every app, with nothing reconciling the two.
    await page.goto("/dashboard/stats");
    const note = page.locator(".scope-export-note");
    // Unscoped: nothing to reconcile, so no disclaimer.
    await expect(page.getByText("Apps Tracked")).toBeVisible();
    await expect(note).toHaveCount(0);

    await openPicker(page);
    await pickerRow(page, PHONE_NAME).click();
    await pickerRow(page, "Not tied to a device").click();
    await page.keyboard.press("Escape");

    await expect(
      page.locator(".stat-card", { hasText: "Apps Tracked" })
    ).toContainText(String(TABLET_APPS));
    // Scoped: the page shows one device, the export covers all of them,
    // and the note is what admits it.
    await expect(note).toBeVisible();
    await expect(note).toContainText(TABLET_NAME);

    // The export link itself must stay unscoped — no `devices=` param.
    const csv = page.locator('a[href*="/api/export"][href*="csv"]');
    await expect(csv).toHaveAttribute("href", "/api/export?format=csv");

    // Settings → Export Data ships the same files from a second place.
    // It was nearly missed when this disclosure was added, which is
    // exactly why it is pinned: one surface admitting the mismatch and
    // another staying quiet is worse than neither doing it.
    await page.goto("/dashboard/settings/admin");
    const exportSection = page.locator("#export-data");
    await expect(exportSection).toBeVisible();
    await expect(exportSection.locator(".scope-export-note")).toContainText(
      TABLET_NAME
    );
  }
);

browserFlow(
  "Escape closes the picker and returns focus to its trigger",
  async ({ page }) => {
    await page.goto("/dashboard/apps");
    const trigger = await openPicker(page);
    await page.keyboard.press("Escape");
    await expect(popover(page)).toHaveCount(0);
    await expect(trigger).toBeFocused();
  }
);

browserFlow(
  "phone width: the picker in the closed drawer takes no focus, and Escape unwinds one menu at a time",
  async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto("/dashboard/apps");
    const menu = page.locator(".nav-menu-trigger");
    const drawer = page.locator("#nav-drawer");
    const drawerPicker = drawer.locator(".device-scope-trigger");
    await expect(menu).toBeVisible();
    await expect(drawerPicker).toHaveCount(1);

    // Closed, the drawer is still laid out (it fades rather than
    // unmounting), and it sits right after the menu button in the DOM.
    // Tab from the button used to land on the invisible picker in it.
    await menu.focus();
    await page.keyboard.press("Tab");
    await expect(drawerPicker).not.toBeFocused();

    // Open it from the keyboard: the picker is the first stop inside.
    await menu.focus();
    await page.keyboard.press("Enter");
    await expect(drawer).toHaveClass(/nav-drawer-open/);
    await page.keyboard.press("Tab");
    await expect(drawerPicker).toBeFocused();

    // With the picker's own menu open, the first Escape closes only
    // that menu and leaves focus on the picker, inside the open drawer.
    await page.keyboard.press("Enter");
    const drawerPopover = drawer.locator(".device-scope-popover");
    await expect(drawerPopover).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(drawerPopover).toHaveCount(0);
    await expect(drawerPicker).toBeFocused();
    await expect(drawer).toHaveClass(/nav-drawer-open/);

    // The next closes the drawer and hands focus back to its button
    // rather than leaving it on a control that just went inert.
    await page.keyboard.press("Escape");
    await expect(drawer).not.toHaveClass(/nav-drawer-open/);
    await expect(menu).toBeFocused();
  }
);

browserFlow(
  "ownership groups the picker and offers a matching focus, preserving goals",
  async ({ page, request }) => {
    // Ownership is the piece that closes the original gap: scoping to a
    // relative's device used to leave the user in a self-audience focus
    // with no sign of it, which is what hides the reason the delete flow
    // refuses them several screens later.
    const setOwner = async (id: string, label: string, audience: string) => {
      const res = await request.patch(`/api/devices/${id}`, {
        headers: sameOriginHeaders,
        data: { ownerLabel: label, ownerAudience: audience },
      });
      await expect(res).toBeOK();
    };
    await setOwner(phoneId, "Me", "self");
    await setOwner(tabletId, "Mum", "loved_one");

    try {
      await page.goto("/dashboard/apps");
      await openPicker(page);
      await expect(
        popover(page).locator(".device-scope-group-heading")
      ).toContainText([/Me|Mum/, /Me|Mum/]);

      // Narrow to the tablet alone so the scope resolves to exactly one
      // owner — the prompt is deliberately strict and stays silent on a
      // mixed or ambiguous selection.
      await pickerRow(page, PHONE_NAME).click();
      await pickerRow(page, "Not tied to a device").click();

      const prompt = popover(page).locator(".device-scope-prompt");
      await expect(prompt).toBeVisible();
      await expect(prompt).toContainText("Mum");

      await prompt.getByRole("button", { name: "Switch" }).click();
      await expect(prompt).toHaveCount(0);

      const focus = await (
        await request.get("/api/focus", { headers: sameOriginHeaders })
      ).json();
      expect(focus.audience).toBe("loved_one");

      // The attestation. Now that the mode matches the tablet's owner,
      // the ONLY thing between the user and removing apps from it is
      // whether they have said they are allowed to. Set an ECID so the
      // gate can resolve the device, ask it, give the attestation, ask
      // again. The device-actions route is a plain GET, so this is the
      // gate's real decision, not a unit-level stand-in.
      const ECID = "0xE2E0000000000001";
      const withEcid = await request.post("/api/devices", {
        headers: sameOriginHeaders,
        data: {
          name: "Gate iPad",
          ecid: ECID,
          ownerLabel: "Mum",
          ownerAudience: "loved_one",
        },
      });
      await expect(withEcid).toBeOK();
      const gateId = (await withEcid.json()).device.id as string;
      const before = await (
        await request.get(
          `/api/device-actions/uninstall?ecid=${ECID}&acknowledgeNoBackup=1`,
          { headers: sameOriginHeaders }
        )
      ).json();
      expect(before.allowed).toBe(false);
      expect(before.reason).toBe("permission_unacknowledged");
      expect(before.ownerLabel).toBe("Mum");

      const ack = await request.patch(`/api/devices/${gateId}`, {
        headers: sameOriginHeaders,
        data: { permissionAcknowledged: true },
      });
      await expect(ack).toBeOK();
      expect((await ack.json()).device.permissionAcknowledgedAt).toBeTruthy();

      const after = await (
        await request.get(
          `/api/device-actions/uninstall?ecid=${ECID}&acknowledgeNoBackup=1`,
          { headers: sameOriginHeaders }
        )
      ).json();
      // Ownership and permission both satisfied. What the gate says NEXT
      // — the feature flag, a backup, or outright allowed — depends on
      // what earlier specs left behind and is not this test's subject.
      // The assertion is that neither ownership reason is returned any
      // more: the attestation was the thing in the way, and it isn't.
      expect(after.reason).not.toBe("permission_unacknowledged");
      expect(after.reason).not.toBe("device_owner");
      await request.delete(`/api/devices/${gateId}`, {
        headers: sameOriginHeaders,
      });
      // The switch is a read-modify-write precisely because POST
      // /api/focus coerces absent goal flags to false — posting the
      // audience alone would quietly wipe the user's setup.
      expect(focus.monitor).toBe(true);
      expect(focus.cleanup).toBe(true);
      expect(focus.accessibility).toBe(true);
    } finally {
      // Leave the fixture as the other tests expect it: no ownership,
      // audience back to self. Ordering between spec files is
      // alphabetical, not guaranteed-isolated, so clean up after
      // ourselves rather than relying on the next reset.
      await request.patch(`/api/devices/${phoneId}`, {
        headers: sameOriginHeaders,
        data: { ownerLabel: null, ownerAudience: null },
      });
      await request.patch(`/api/devices/${tabletId}`, {
        headers: sameOriginHeaders,
        data: { ownerLabel: null, ownerAudience: null },
      });
      await request.post("/api/focus", {
        headers: sameOriginHeaders,
        data: {
          audience: "self",
          monitor: true,
          cleanup: true,
          minimal: false,
          accessibility: true,
        },
      });
    }
  }
);
