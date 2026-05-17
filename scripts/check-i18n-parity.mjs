#!/usr/bin/env node
/**
 * Sanity check that locales/*.json are key-for-key with locales/en.json.
 *
 * Why this exists:
 *   - next-intl falls back to the source bundle (en.json) for any key
 *     missing from the active locale. That's a sane runtime behaviour
 *     but it means a missing zh key shows English in the zh UI without
 *     any visible warning. This script fails CI when that happens.
 *   - Conversely, a stray zh-only key is dead code — every key in any
 *     translated bundle MUST have a matching key in en.json so the
 *     source-of-truth side knows about it.
 *
 * Run: `node scripts/check-i18n-parity.mjs`
 *      (also wired into `npm run lint:i18n` if you add the script).
 *
 * Output:
 *   - Exit 0 + brief "all parity" summary on success.
 *   - Exit 1 with a sorted list of missing/extra keys per locale.
 *
 * The list is sorted by namespace path so the diff reads naturally —
 * grouped by surface, not by hash order.
 */

import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const localesDir = join(__dirname, "..", "locales");

/** Recursively flatten a nested object into dotted keys. */
function flatten(obj, prefix = "") {
  const out = new Set();
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      for (const child of flatten(v, path)) {
        out.add(child);
      }
    } else {
      out.add(path);
    }
  }
  return out;
}

/** Read + flatten a locale bundle, throwing a useful error on bad JSON. */
function loadLocale(file) {
  const path = join(localesDir, file);
  let raw;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (e) {
    throw new Error(`Couldn't read ${file}: ${e.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Couldn't parse ${file}: ${e.message}`);
  }
  return flatten(parsed);
}

const localeFiles = readdirSync(localesDir).filter((f) => f.endsWith(".json"));
if (!localeFiles.includes("en.json")) {
  console.error("No locales/en.json found — nothing to compare against.");
  process.exit(2);
}

const enKeys = loadLocale("en.json");
const targets = localeFiles.filter((f) => f !== "en.json");

let problems = 0;

for (const file of targets) {
  const langKeys = loadLocale(file);

  const missing = [...enKeys].filter((k) => !langKeys.has(k)).sort();
  const extra = [...langKeys].filter((k) => !enKeys.has(k)).sort();

  if (missing.length === 0 && extra.length === 0) {
    console.log(`✓ ${file} — ${enKeys.size} keys, parity with en.json`);
    continue;
  }

  problems += missing.length + extra.length;
  console.log(`\n✗ ${file} — out of parity`);
  if (missing.length > 0) {
    console.log(
      `  ${missing.length} key(s) present in en.json but missing here:`
    );
    for (const k of missing) {
      console.log(`    - ${k}`);
    }
  }
  if (extra.length > 0) {
    console.log(
      `  ${extra.length} key(s) present here but absent from en.json:`
    );
    for (const k of extra) {
      console.log(`    + ${k}`);
    }
  }
}

if (problems > 0) {
  console.log(
    `\nFound ${problems} parity issue(s). Crowdin's "all approved" pull would silently leave the gaps in place — fix or delete the rogue keys before merging.`
  );
  process.exit(1);
}

console.log(
  `\nAll ${targets.length} target locale(s) at parity with en.json (${enKeys.size} keys each).`
);
