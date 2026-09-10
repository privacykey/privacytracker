/**
 * Guards on how client code reads feature flags.
 *
 * Background: client components used to gate UI on `useFlag`
 * (lib/feature-flags-hooks.ts), which resolved against the in-memory
 * resolver context in `lib/feature-flags.ts`. Nothing primes that context
 * in the browser — and after the Rust-core Phase 0 static-shell migration
 * nothing *can*, because there is no per-request server render left to do
 * it. So every such call fell through to `HARD_DEFAULTS[key]`, ignoring
 * both focus rules and user overrides while typechecking perfectly. The
 * hook has been deleted; `lib/use-flag-bundle.ts` (over
 * `GET /api/feature-flags`) is the only client-side flag reader.
 *
 * Three ways that can silently regress, one test each:
 *
 *  1. The resolver hooks come back, or a client component imports the
 *     resolver directly. Same bug, new spelling.
 *  2. A tri-state flag is read through a hook that coerces to boolean.
 *     `flag.detail.annotations_sidebar` and
 *     `flag.devopts.advanced_accordion` both default to `"collapsed"`,
 *     so `value === "on"` reads the DEFAULT as off and hides the surface
 *     for everyone.
 *  3. A typo'd key. `useFlagValues*` are typed to `FlagKey`, so tsc
 *     catches those — but `useFlagBundle` / `useResolvedFlag` accept any
 *     string, and an unknown key resolves to `false` with no error.
 *
 * All three are static scans, deliberately: they cost nothing and they
 * fire on the PR that introduces the mistake rather than in a browser
 * months later.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import {
  ACCESSIBILITY_RULES,
  AUDIENCE_RULES,
  type FlagKey,
  type FlagValue,
  GOAL_RULES,
  HARD_DEFAULTS,
} from "../../lib/feature-flag-rules";

const ROOTS = ["app", "lib"];
const SKIP_DIRS = new Set(["node_modules", ".next", "__snapshots__"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) {
      continue;
    }
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (/\.tsx?$/.test(full) && !full.endsWith(".stories.tsx")) {
      out.push(full);
    }
  }
  return out;
}

const REPO_ROOT = process.cwd();
const SOURCES = ROOTS.flatMap((root) => walk(join(REPO_ROOT, root))).map(
  (full) => ({
    // Repo-relative so a failure message is readable and stable across
    // checkouts (worktrees make the absolute path very long).
    path: relative(REPO_ROOT, full),
    text: readFileSync(full, "utf8"),
  })
);

test("source scan actually found files", () => {
  // A broken walk would make every assertion below vacuously pass.
  assert.ok(
    SOURCES.length > 200,
    `expected to scan the app, found ${SOURCES.length} files`
  );
});

// ---------------------------------------------------------------------------
// 1. The unprimed-resolver path stays closed
// ---------------------------------------------------------------------------

test("no client-side resolver hooks", () => {
  const offenders = SOURCES.filter(({ text }) =>
    /feature-flags-hooks/.test(text)
  ).map(({ path }) => path);
  assert.deepEqual(
    offenders,
    [],
    "lib/feature-flags-hooks.ts was deleted because its hooks always " +
      "returned HARD_DEFAULTS in the browser. Read flags with " +
      "lib/use-flag-bundle.ts instead."
  );
});

test("no 'use client' module imports the resolver", () => {
  // `resolveFlag`/`getCachedContext` are server-safe but context-bound.
  // Reaching for them from a client module reintroduces the same bug by
  // another route, since the context is never populated there.
  const offenders = SOURCES.filter(({ text }) => {
    if (!/^\s*["']use client["']/m.test(text)) {
      return false;
    }
    return /from\s+["'](?:@\/lib|\.{1,2}\/(?:\.\.\/)*lib)\/feature-flags["']/.test(
      text
    );
  }).map(({ path }) => path);
  assert.deepEqual(
    offenders,
    [],
    "client modules must not import the resolver"
  );
});

// ---------------------------------------------------------------------------
// 2. Tri-state flags are never read through a boolean hook
// ---------------------------------------------------------------------------

/** Every value a flag can take across the hard defaults and rule tables. */
function possibleValues(key: FlagKey): Set<FlagValue> {
  const seen = new Set<FlagValue>([HARD_DEFAULTS[key]]);
  for (const table of Object.values(AUDIENCE_RULES)) {
    const value = table[key];
    if (value !== undefined) {
      seen.add(value);
    }
  }
  for (const table of Object.values(GOAL_RULES)) {
    const value = table[key];
    if (value !== undefined) {
      seen.add(value);
    }
  }
  const a11y = ACCESSIBILITY_RULES[key];
  if (a11y !== undefined) {
    seen.add(a11y);
  }
  return seen;
}

const TRI_STATE = (Object.keys(HARD_DEFAULTS) as FlagKey[]).filter((key) =>
  possibleValues(key).has("collapsed")
);

test("the tri-state set is non-empty (the guard below has something to guard)", () => {
  assert.ok(
    TRI_STATE.includes("flag.devopts.advanced_accordion"),
    "expected flag.devopts.advanced_accordion among the tri-state flags"
  );
});

/**
 * String literals passed to the hooks that coerce a flag to
 * `value === "on"`, plus `RequireFlagGate`'s `flag=` prop.
 *
 * Matches the literal arguments only — a variable or prop-supplied key
 * can't be resolved statically, which is fine: the call sites that carry
 * a hardcoded key are the ones a person writes by hand and gets wrong.
 */
function booleanHookKeys(text: string): string[] {
  const keys: string[] = [];
  const callSites = text.matchAll(
    /\b(?:useFlagBundle|useResolvedFlag)\s*\(([\s\S]{0,600}?)\)/g
  );
  for (const call of callSites) {
    for (const literal of call[1].matchAll(/["'](flag\.[^"']+)["']/g)) {
      keys.push(literal[1]);
    }
  }
  for (const gate of text.matchAll(/\bflag=["'](flag\.[^"']+)["']/g)) {
    keys.push(gate[1]);
  }
  return keys;
}

/** Literal keys handed to the raw-value hooks — checked for typos only. */
function rawHookKeys(text: string): string[] {
  const keys: string[] = [];
  const callSites = text.matchAll(
    /\b(?:useFlagValues|useFlagValuesWithDefaults)\s*\(([\s\S]{0,2000}?)\)/g
  );
  for (const call of callSites) {
    for (const literal of call[1].matchAll(/["'](flag\.[^"']+)["']/g)) {
      keys.push(literal[1]);
    }
  }
  return keys;
}

test("no tri-state flag is read through a boolean flag hook", () => {
  const offenders: string[] = [];
  for (const { path, text } of SOURCES) {
    for (const key of booleanHookKeys(text)) {
      if (TRI_STATE.includes(key as FlagKey)) {
        offenders.push(`${path}: ${key}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "these flags can resolve to 'collapsed', which a boolean hook reads " +
      "as off — use useFlagValues / useFlagValuesWithDefaults instead"
  );
});

// ---------------------------------------------------------------------------
// 3. Every literal key exists
// ---------------------------------------------------------------------------

test("every literal flag key passed to a bundle hook is registered", () => {
  const offenders: string[] = [];
  for (const { path, text } of SOURCES) {
    for (const key of [...booleanHookKeys(text), ...rawHookKeys(text)]) {
      if (!(key in HARD_DEFAULTS)) {
        offenders.push(`${path}: ${key}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "unknown flag keys resolve to undefined/false with no error at runtime"
  );
});

test("the key scan finds the migrated call sites", () => {
  // Pins the regexes themselves: if they stop matching, tests 2 and 3
  // above go quiet without failing.
  const found = new Set(
    SOURCES.flatMap(({ text }) => [
      ...booleanHookKeys(text),
      ...rawHookKeys(text),
    ])
  );
  for (const key of [
    "flag.global.label_hints",
    "flag.devopts.advanced_accordion",
    "flag.settings.policies.wayback_import",
    "flag.onboarding.method.import_audit_bundle",
  ]) {
    assert.ok(found.has(key), `expected the scan to see ${key}`);
  }
});
