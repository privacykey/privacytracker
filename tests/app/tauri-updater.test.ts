/**
 * Pins the desktop "Install & restart" path (lib/tauri-updater.ts, read by
 * UpdateBanner).
 *
 * checkAndInstall() installs an update through the updater plugin, then
 * calls relaunch() from @tauri-apps/plugin-process. The Rust shell used to
 * ship without that plugin, so every relaunch was rejected with "Plugin not
 * found" after the update had already installed, and the banner reported a
 * failed install and pointed the user at a manual download.
 *
 * Either half can bring that back on its own, so both are pinned:
 *   1. The TypeScript contract, driven through the real plugin packages over
 *      Tauri's own IPC mock: once the install succeeds the result is
 *      `installed: true`, and a relaunch failure lands in `relaunchError`,
 *      never in `error`.
 *   2. The Rust wiring: every @tauri-apps/plugin-* package the frontend
 *      depends on has its crate in Cargo.toml, is registered with
 *      .plugin(...) in main.rs, and is granted in the main capability.
 *
 * The install itself goes through the shell's `install_verified_update`
 * command (src-tauri/src/update_guard.rs), because the version in the
 * update manifest is not signed: the shell reads the version from the
 * signed archive and from the installed bundle, and refuses anything not
 * newer than the running app. So these also pin that nothing relaunches
 * unless that command confirmed a newer version, and that the page is
 * granted the plugin's `check` and nothing that installs.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { checkAndInstall } from "../../lib/tauri-updater";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

// What the unfixed shell answered, verbatim: invoke() rejects with a string.
const RESTART_NOT_ALLOWED = "process.restart not allowed. Plugin not found";
// Newer than any real package.json version, so the downgrade guard passes.
const NEWER = "99.0.0";
const RUNNING = "0.3.0";
const UPDATE_RID = 7;

/**
 * Stands in for the Rust side of the updater and process plugins and the
 * shell's install command. Each handler returns the command's result or a
 * rejected promise, the way a failing Tauri command reaches invoke().
 */
function mockDesktop(
  t: TestContext,
  handlers: {
    check?: () => unknown;
    install?: (args: Record<string, unknown>) => unknown;
    restart?: () => unknown;
  }
): string[] {
  const calls: string[] = [];
  // checkAndInstall() only runs inside a Tauri webview, which it detects via
  // window.__TAURI_INTERNALS__; mockIPC installs that on `window`.
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: globalThis,
  });
  mockIPC((cmd, args) => {
    calls.push(cmd);
    switch (cmd) {
      case "plugin:updater|check":
        return handlers.check
          ? handlers.check()
          : {
              rid: UPDATE_RID,
              currentVersion: RUNNING,
              version: NEWER,
              body: "notes",
            };
      case "install_verified_update":
        return handlers.install
          ? handlers.install((args ?? {}) as Record<string, unknown>)
          : { installedVersion: NEWER, runningVersion: RUNNING };
      case "plugin:process|restart":
        return handlers.restart?.();
      default:
        return Promise.reject(`unexpected IPC command ${cmd}`);
    }
  });
  t.after(() => {
    clearMocks();
    Reflect.deleteProperty(globalThis, "__TAURI_INTERNALS__");
    Reflect.deleteProperty(globalThis, "__TAURI_EVENT_PLUGIN_INTERNALS__");
    Reflect.deleteProperty(globalThis, "window");
  });
  return calls;
}

test("a relaunch rejected after the install reports installed, not a failed install", async (t) => {
  const calls = mockDesktop(t, {
    restart: () => Promise.reject(RESTART_NOT_ALLOWED),
  });

  const result = await checkAndInstall();

  assert.equal(result.installed, true);
  assert.equal(result.available, true);
  assert.equal(result.version, NEWER);
  assert.equal(result.relaunchError, RESTART_NOT_ALLOWED);
  assert.equal(result.error, undefined);
  assert.deepEqual(calls, [
    "plugin:updater|check",
    "install_verified_update",
    "plugin:process|restart",
  ]);
});

test("the shell installs the update the check found", async (t) => {
  let installArgs: Record<string, unknown> | undefined;
  mockDesktop(t, {
    install: (args) => {
      installArgs = args;
      return { installedVersion: NEWER, runningVersion: RUNNING };
    },
  });

  const result = await checkAndInstall();

  assert.equal(result.installed, true);
  // The resource id check() returned, so the shell downloads the same
  // update the page was offered.
  assert.deepEqual(installArgs, { rid: UPDATE_RID });
});

test("an update the shell refuses as not newer is not installed and never relaunches", async (t) => {
  // What update_guard.rs rejects with when the signed archive holds an
  // older build than the manifest claims.
  const refusal =
    "The downloaded update is version 0.1.2, which is not newer than the version you are running (0.3.0). It was not installed.";
  const calls = mockDesktop(t, { install: () => Promise.reject(refusal) });

  const result = await checkAndInstall();

  assert.equal(result.installed, false);
  assert.equal(result.error, refusal);
  assert.equal(result.relaunchError, undefined);
  assert.ok(!calls.includes("plugin:process|restart"));
});

test("an installed version that is not newer never relaunches", async (t) => {
  // The shell refuses this itself; the page checks its answer again
  // because relaunching is the step that would start an older build.
  for (const installedVersion of [RUNNING, "0.1.2", "0.3.0-rc.1"]) {
    await t.test(installedVersion, async (st) => {
      const calls = mockDesktop(st, {
        install: () => ({ installedVersion, runningVersion: RUNNING }),
      });

      const result = await checkAndInstall();

      assert.equal(result.installed, false);
      assert.match(result.error ?? "", /did not restart/);
      assert.ok(!calls.includes("plugin:process|restart"));
    });
  }
});

test("an answer without the installed version never relaunches", async (t) => {
  const calls = mockDesktop(t, { install: () => null });

  const result = await checkAndInstall();

  assert.equal(result.installed, false);
  assert.match(result.error ?? "", /did not restart/);
  assert.ok(!calls.includes("plugin:process|restart"));
});

test("a manifest that doesn't claim a newer version downloads nothing", async (t) => {
  const calls = mockDesktop(t, {
    check: () => ({
      rid: UPDATE_RID,
      currentVersion: RUNNING,
      version: "0.0.1",
    }),
  });

  const result = await checkAndInstall();

  assert.equal(result.installed, false);
  assert.match(result.error ?? "", /not newer/);
  assert.deepEqual(calls, ["plugin:updater|check"]);
});

test("a relaunch that goes through reports installed with nothing to fix", async (t) => {
  // tauri-plugin-process answers restart before the app exits, so the
  // promise resolves and this result is what the banner briefly paints.
  mockDesktop(t, {});

  const result = await checkAndInstall();

  assert.equal(result.installed, true);
  assert.equal(result.relaunchError, undefined);
  assert.equal(result.error, undefined);
});

test("a failed download is a failed install and never relaunches", async (t) => {
  // The shell's command downloads through the plugin, so a plugin error
  // arrives from it verbatim.
  const failure = "Download request failed with status: 404 Not Found";
  const calls = mockDesktop(t, { install: () => Promise.reject(failure) });

  const result = await checkAndInstall();

  assert.equal(result.installed, false);
  assert.equal(result.error, failure);
  assert.equal(result.relaunchError, undefined);
  assert.ok(!calls.includes("plugin:process|restart"));
});

test("no update available installs and relaunches nothing", async (t) => {
  const calls = mockDesktop(t, { check: () => null });

  const result = await checkAndInstall();

  assert.deepEqual(result, { available: false, installed: false });
  assert.deepEqual(calls, ["plugin:updater|check"]);
});

function read(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), "utf8");
}

function grantedPermissions(): string[] {
  const capability = JSON.parse(read("src-tauri/capabilities/main.json")) as {
    permissions: Array<string | { identifier: string }>;
  };
  return capability.permissions.map((p) =>
    typeof p === "string" ? p : p.identifier
  );
}

test("every @tauri-apps/plugin-* package is registered and granted in the desktop shell", () => {
  const pkg = JSON.parse(read("package.json")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const plugins = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })
    .filter((name) => name.startsWith("@tauri-apps/plugin-"))
    .map((name) => name.slice("@tauri-apps/plugin-".length));
  // Guards the loop below against passing vacuously.
  assert.ok(plugins.includes("process"), "expected @tauri-apps/plugin-process");

  const cargo = read("src-tauri/Cargo.toml");
  // Line comments stripped so a commented-out registration doesn't count.
  const main = read("src-tauri/src/main.rs").replace(/\/\/.*$/gm, "");
  const permissions = grantedPermissions();

  // assert.ok rather than assert.match: a failed match prints the whole file.
  for (const name of plugins) {
    const crate = `tauri-plugin-${name}`;
    const rustPath = crate.replaceAll("-", "_");
    assert.ok(
      new RegExp(`^${crate}\\s*=`, "m").test(cargo),
      `${crate} is missing from src-tauri/Cargo.toml`
    );
    assert.ok(
      new RegExp(`\\.plugin\\(\\s*${rustPath}::`).test(main),
      `${rustPath} is not registered with .plugin(...) in src-tauri/src/main.rs`
    );
    assert.ok(
      permissions.some((p) => p.startsWith(`${name}:`)),
      `src-tauri/capabilities/main.json grants no ${name}:* permission`
    );
  }
});

test("the updater plugin is granted check and nothing that installs", () => {
  // Installing goes through install_verified_update, which checks the
  // version inside the signed archive. A grant of the plugin's download or
  // install would let the page skip that check.
  assert.deepEqual(
    grantedPermissions().filter((p) => p.startsWith("updater:")),
    ["updater:allow-check"]
  );
  assert.ok(grantedPermissions().includes("allow-install-verified-update"));
});

test("the process plugin is granted restart and nothing broader", () => {
  // relaunch() needs only restart. Nothing calls exit, so neither it nor
  // process:default (which includes it) is granted.
  assert.deepEqual(
    grantedPermissions().filter((p) => p.startsWith("process:")),
    ["process:allow-restart"]
  );
});
