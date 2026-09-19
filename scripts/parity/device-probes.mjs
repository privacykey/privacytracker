/**
 * Live probe for the five device routes (Rust core Phase 6, batch 2a).
 *
 * The differ quarantines them: the backup check and the uninstall gate
 * read the host's MobileSync folder, and the device-sync pair act on a
 * client's app list. Their behaviour is pinned by the device-routes oracle
 * (core/scripts/extract-device-routes-cases.mjs); this probe holds what
 * both servers answer on the same host and the same fixture library:
 *
 *   - the uninstall gate, read with and without an ECID;
 *   - the backup's refusals, the artifact one included (a path that is
 *     not there reads the same host folder from both servers, whatever
 *     that folder holds);
 *   - the uninstall log refused while its flag is off;
 *   - the device-sync preview's refusals, and a real diff over a fixture
 *     device;
 *   - the commit's refusals. A commit that lands is left to the oracle: it
 *     stamps the device with each server's own clock.
 */

export async function probeDeviceRoutes(nodeBase, rustBase, token) {
  let ok = true;
  const check = (claim, pass, detail = "") => {
    console.log(`  ${pass ? "✔" : "✘"} devices: ${claim}`);
    if (!pass && detail) {
      console.log(`    ${detail}`);
    }
    ok = pass && ok;
    return pass;
  };
  const send = async (base, method, route, body) => {
    const res = await fetch(`${base}${route}`, {
      method,
      headers: {
        origin: base,
        "x-auditor-admin-token": token,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body,
    });
    return {
      status: res.status,
      text: await res.text(),
      type: res.headers.get("content-type"),
    };
  };
  const both = (method, route, body) =>
    Promise.all([
      send(nodeBase, method, route, body),
      send(rustBase, method, route, body),
    ]);
  const short = (r) => JSON.stringify(r).slice(0, 400);
  const same = (a, b) =>
    a.status === b.status && a.text === b.text && a.type === b.type;
  const expect = async (claim, method, route, body, status) => {
    const [a, b] = await both(method, route, body);
    return check(
      `${claim} (HTTP ${a.status})`,
      a.status === status && same(a, b),
      `node=${short(a)} rust=${short(b)}`
    );
  };
  const json = (value) => JSON.stringify(value);
  const ECID = "0x9118908BB6027";

  await expect(
    "the uninstall gate needs an ECID",
    "GET",
    "/api/device-actions/uninstall",
    undefined,
    400
  );
  await expect(
    "the uninstall gate reads alike",
    "GET",
    `/api/device-actions/uninstall?ecid=${ECID}&acknowledgeNoBackup=1`,
    undefined,
    200
  );
  await expect(
    "a backup with no valid ECID is refused alike",
    "POST",
    "/api/device-actions/backup",
    json({ ecid: "zz", path: "/x" }),
    400
  );
  await expect(
    "a backup that is not there is refused alike",
    "POST",
    "/api/device-actions/backup",
    json({ ecid: ECID, path: "/pt-parity-probe/no-such-backup" }),
    422
  );
  await expect(
    "an uninstall is refused alike while its flag is off",
    "POST",
    "/api/device-actions/uninstall",
    json({ ecid: ECID, bundleId: "com.example.app", ok: true }),
    403
  );
  await expect(
    "a preview for no device is refused alike",
    "POST",
    "/api/device-sync/preview",
    json({ deviceId: "pt-parity-no-device", currentImport: [] }),
    404
  );
  await expect(
    "a commit with no arrays is refused alike",
    "POST",
    "/api/device-sync/commit",
    json({ deviceId: "x" }),
    400
  );
  await expect(
    "a commit for no device is refused alike",
    "POST",
    "/api/device-sync/commit",
    json({ deviceId: "pt-parity-no-device", addAppIds: [], removeAppIds: [] }),
    404
  );

  // A real diff: the fixture library's first device, told it now holds
  // the library's first two apps and one it has never seen.
  const devices = await (
    await fetch(`${nodeBase}/api/devices`, {
      headers: { "x-auditor-admin-token": token },
    })
  ).json();
  const apps = await (
    await fetch(`${nodeBase}/api/apps`, {
      headers: { "x-auditor-admin-token": token },
    })
  ).json();
  const device = (devices.devices ?? devices)[0];
  if (
    check(
      "the fixture library has a device and apps",
      Boolean(device?.id) && Array.isArray(apps) && apps.length >= 2
    )
  ) {
    await expect(
      "a preview diffs the same on both",
      "POST",
      "/api/device-sync/preview",
      json({
        deviceId: device.id,
        currentImport: [
          { appId: apps[0].id, name: apps[0].name },
          { appId: apps[1].id },
          {
            appId: "999000001",
            name: "Unseen",
            bundleId: "com.example.unseen",
          },
        ],
      }),
      200
    );
  }
  return ok;
}
