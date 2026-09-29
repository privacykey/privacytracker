/**
 * Pins what the desktop shell's main capability lets the page do
 * (src-tauri/capabilities/main.json).
 *
 * 1. Every app command is registered in all three places AGENTS.md lists:
 *    `generate_handler!` in src-tauri/src/main.rs, the AppManifest command
 *    list in src-tauri/build.rs, and an `allow-<command>` grant. Missing
 *    any one of them makes every invoke fail at runtime with an ACL error
 *    that only a desktop build shows.
 * 2. The page can't show or hide the main window itself. "Require Touch ID
 *    / password to open the window" is enforced by one gate in the shell
 *    (src-tauri/src/window_lock.rs); a page granted the window's show
 *    permission, or the window-state plugin's restore (which can show a
 *    window), could open it without asking.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

function read(rel: string): string {
  return readFileSync(path.join(repoRoot, rel), "utf8");
}

function stripLineComments(source: string): string {
  return source.replace(/\/\/.*$/gm, "");
}

function grantedPermissions(): string[] {
  const capability = JSON.parse(read("src-tauri/capabilities/main.json")) as {
    permissions: Array<string | { identifier: string }>;
  };
  return capability.permissions.map((p) =>
    typeof p === "string" ? p : p.identifier
  );
}

/** Command names inside the first `<marker>[ ... ]` list of `source`. */
function listAfter(source: string, marker: string): string[] {
  const start = source.indexOf(marker);
  assert.ok(start !== -1, `expected ${marker} in the source`);
  const open = source.indexOf("[", start);
  const close = source.indexOf("]", open);
  return source
    .slice(open + 1, close)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function handlerCommands(): string[] {
  const main = stripLineComments(read("src-tauri/src/main.rs"));
  // `commands::sidecar_base_url` → `sidecar_base_url`.
  return listAfter(main, "tauri::generate_handler!").map(
    (item) => item.split("::").at(-1) ?? item
  );
}

function manifestCommands(): string[] {
  const build = stripLineComments(read("src-tauri/build.rs"));
  return listAfter(build, "AppManifest::new().commands(&").map((item) =>
    item.replaceAll('"', "")
  );
}

function kebab(command: string): string {
  return command.replaceAll("_", "-");
}

test("every app command is registered, in the manifest, and granted", () => {
  const handler = handlerCommands();
  const manifest = manifestCommands();
  const granted = new Set(grantedPermissions());
  // Guards the comparisons below against passing vacuously.
  assert.ok(handler.includes("install_verified_update"), String(handler));

  assert.deepEqual(
    [...manifest].sort(),
    [...handler].sort(),
    "build.rs's AppManifest list must match generate_handler! in main.rs"
  );
  for (const command of handler) {
    assert.ok(
      granted.has(`allow-${kebab(command)}`),
      `capabilities/main.json doesn't grant allow-${kebab(command)}`
    );
  }
  // A grant for a command that doesn't exist fails the build's ACL check.
  const appGrants = [...granted].filter(
    (p) => p.startsWith("allow-") && !p.includes(":")
  );
  for (const grant of appGrants) {
    assert.ok(
      handler.some((command) => `allow-${kebab(command)}` === grant),
      `${grant} names no registered command`
    );
  }
});

test("the page can't show, hide or close the main window around the unlock gate", () => {
  const granted = grantedPermissions();
  const windowControls = granted.filter(
    (p) =>
      p.startsWith("core:window:") &&
      p !== "core:window:default" &&
      !p.startsWith("core:window:deny-")
  );
  assert.deepEqual(
    windowControls,
    [],
    "the page uses no window API; showing goes through window_lock"
  );
  assert.ok(
    !granted.some((p) => p.startsWith("window-state:")),
    "window-state's restore command can show a window"
  );
});

test("the window-state plugin never restores visibility", () => {
  // Restoring a window that was open at quit would show it at launch
  // before the gate could ask to unlock it.
  const main = stripLineComments(read("src-tauri/src/main.rs"));
  assert.match(
    main,
    /tauri_plugin_window_state::Builder::default\(\)\s*\.with_state_flags\(StateFlags::all\(\) & !StateFlags::VISIBLE\)/
  );
});

test("start at login uses the LaunchAgent launcher", () => {
  const main = stripLineComments(read("src-tauri/src/main.rs"));
  assert.match(
    main,
    /tauri_plugin_autostart::init\(\s*MacosLauncher::LaunchAgent,\s*Some\(vec!\["--hidden"\]\),?\s*\)/
  );
  assert.ok(!main.includes("MacosLauncher::AppleScript"));
});
