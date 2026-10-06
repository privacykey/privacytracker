/**
 * Pins the release profile that lets `tauri build` finish on macOS 27.
 *
 * `tauri build` sets MACOSX_DEPLOYMENT_TARGET from
 * bundle.macOS.minimumSystemVersion (13.5). Under that target the debuginfo
 * strip that release builds apply leaves a dylib's LINKEDIT string pool
 * 4-byte aligned, and macOS 27's dyld refuses to dlopen it ("mis-aligned
 * LINKEDIT string pool"). rustc loads every proc macro with dlopen, so the
 * build stopped at the first crate that uses one, as E0463 "can't find crate
 * for `ctor_proc_macro`" or a dlopen error naming the dylib. `tauri dev`
 * never showed it because debug builds don't strip.
 *
 * Proc macros and build scripts take the release profile's build-override,
 * so turning strip off there fixes it without touching what ships.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

/** The body of one `[table]` in a TOML file, comments dropped. */
function tomlTable(source: string, table: string): string | null {
  const lines = source.split("\n").map((line) => line.replace(/#.*$/, ""));
  const start = lines.findIndex((line) => line.trim() === `[${table}]`);
  if (start === -1) {
    return null;
  }
  const end = lines.findIndex(
    (line, i) => i > start && line.trim().startsWith("[")
  );
  return lines.slice(start + 1, end === -1 ? undefined : end).join("\n");
}

test("release builds leave proc macros and build scripts unstripped", () => {
  const cargo = readFileSync(
    path.join(repoRoot, "src-tauri", "Cargo.toml"),
    "utf8"
  );
  const override = tomlTable(cargo, "profile.release.build-override");
  assert.ok(
    override !== null,
    "src-tauri/Cargo.toml has no [profile.release.build-override] table"
  );
  assert.ok(
    /^\s*strip\s*=\s*(false|"none")\s*$/m.test(override),
    "[profile.release.build-override] must set strip = false"
  );
});
