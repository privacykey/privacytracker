// Run with node --import tsx. These are wire labels, not translated UI text.
import { writeFileSync } from "node:fs";
import { CANONICAL_ACCESSIBILITY_FEATURES } from "../../lib/accessibility-types.ts";
import {
  POLICY_LENSES,
  POLICY_RATINGS,
} from "../../lib/policy-summary-meta.ts";
import {
  CATEGORY_META,
  PRIVACY_TYPE_DISPLAY_ORDER,
  SEVERITY_CONFIG,
} from "../../lib/privacy-meta.ts";

const metadata = {
  categories: Object.entries(CATEGORY_META).map(([identifier, meta]) => ({
    identifier,
    label: meta.label,
  })),
  severities: PRIVACY_TYPE_DISPLAY_ORDER.map((identifier) => ({
    identifier,
    label: SEVERITY_CONFIG[identifier].label,
  })),
  axes: POLICY_LENSES,
  ratings: POLICY_RATINGS,
  accessibility: CANONICAL_ACCESSIBILITY_FEATURES.map(
    ({ identifier, title }) => ({ identifier, title })
  ),
};
writeFileSync(
  new URL("../src/server/stats_meta.json", import.meta.url),
  `${JSON.stringify(metadata, null, 2)}\n`
);
