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

/**
 * Stands in for the Rust side of the updater and process plugins. Each
 * handler returns the command's result or a rejected promise, the way a
 * failing Tauri command reaches invoke().
 */
function mockDesktop(
  t: TestContext,
  handlers: {
    check?: () => unknown;
    install?: () => unknown;
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
  mockIPC((cmd) => {
    calls.push(cmd);
    switch (cmd) {
      case "plugin:updater|check":
        return handlers.check
          ? handlers.check()
          : { rid: 1, currentVersion: "0.0.1", version: NEWER, body: "notes" };
      case "plugin:updater|download_and_install":
        return handlers.install?.();
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
    "plugin:updater|download_and_install",
    "plugin:process|restart",
  ]);
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

test("the process plugin is granted restart and nothing broader", () => {
  // relaunch() needs only restart. Nothing calls exit, so neither it nor
  // process:default (which includes it) is granted.
  assert.deepEqual(
    grantedPermissions().filter((p) => p.startsWith("process:")),
    ["process:allow-restart"]
  );
});
