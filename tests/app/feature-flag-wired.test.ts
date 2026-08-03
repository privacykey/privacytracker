/**
 * Keeps `WIRED_FLAGS` honest.
 *
 * That set is hand-maintained, and the Dev Options panel renders a
 * "(no effect yet)" badge from it. When it drifts, the panel lies in one
 * of two directions: a flag that works looks inert, or an inert flag
 * looks live. Either one wastes a tester's time, and neither is visible
 * from a typecheck — the set is just a `Set<FlagKey>`, so every entry is
 * valid whether or not any code reads it.
 *
 * The audit that added this test found 14 flags of the first kind and 1
 * of the second.
 *
 * The scan is deliberately a *superset* matcher: any `"flag.…"` string
 * literal anywhere under app/ or lib/ counts as a read. Flags are
 * consumed several ways in this codebase and a narrower pattern produces
 * false failures:
 *
 *   useFlag("flag.x")                       // client component
 *   const r = (k) => resolveFlagFromDb(k)   // server page, aliased
 *   r("flag.x")
 *   { key: "a11y", flag: "flag.x" }         // table-driven, YourFocusCard
 *
 * The cost of the superset is that a key mentioned only in a comment
 * would count as read. That is the right trade: a false "this is wired"
 * is a stale badge, while a false "this is dead" invites deleting live
 * wiring.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { HARD_DEFAULTS } from "../../lib/feature-flag-rules";
import { WIRED_FLAGS } from "../../lib/feature-flag-wired";

/** Files that define the registry rather than consume it. */
const REGISTRY_FILES = new Set([
  "lib/feature-flag-rules.ts",
  "lib/feature-flag-wired.ts",
  "lib/feature-flag-usage.ts",
]);

const FLAG_LITERAL = /"(flag\.[a-z0-9_.]+)"/g;

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry.startsWith(".")) {
      continue;
    }
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (/\.tsx?$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

function flagsReferencedInCode(): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of [...walk("app"), ...walk("lib")]) {
    if (REGISTRY_FILES.has(file)) {
      continue;
    }
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(FLAG_LITERAL)) {
      if (!found.has(m[1])) {
        found.set(m[1], file);
      }
    }
  }
  return found;
}

test("every registered flag that code reads is marked wired", () => {
  const referenced = flagsReferencedInCode();
  const registry = new Set(Object.keys(HARD_DEFAULTS));
  const missing: string[] = [];
  for (const [key, file] of referenced) {
    // `flag.focus.*` are persistence keys in feature-flag-storage.ts, not
    // gates — they are deliberately absent from HARD_DEFAULTS, and the
    // registry check below is what keeps them out of this assertion.
    if (registry.has(key) && !WIRED_FLAGS.has(key as never)) {
      missing.push(`${key}  (read in ${file})`);
    }
  }
  assert.deepEqual(
    missing,
    [],
    `${missing.length} flag(s) are read by code but missing from WIRED_FLAGS, so Dev Options badges them "(no effect yet)" when they in fact work. Add them to lib/feature-flag-wired.ts:\n  ${missing.join("\n  ")}`
  );
});

test("every flag marked wired is actually referenced by code", () => {
  const referenced = flagsReferencedInCode();
  const stale = [...WIRED_FLAGS].filter((key) => !referenced.has(key));
  assert.deepEqual(
    stale,
    [],
    `${stale.length} flag(s) are in WIRED_FLAGS but nothing under app/ or lib/ mentions them, so Dev Options claims they work when toggling them does nothing. Remove them from lib/feature-flag-wired.ts (or wire them up):\n  ${stale.join("\n  ")}`
  );
});

test("WIRED_FLAGS contains only registered flags", () => {
  const registry = new Set(Object.keys(HARD_DEFAULTS));
  const unregistered = [...WIRED_FLAGS].filter((key) => !registry.has(key));
  assert.deepEqual(
    unregistered,
    [],
    `WIRED_FLAGS names ${unregistered.length} key(s) with no HARD_DEFAULTS entry, so they can never resolve:\n  ${unregistered.join("\n  ")}`
  );
});
