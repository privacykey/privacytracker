/**
 * External parental-control resources for the guardian age-rating feature.
 * URLs live here (not in locales/*.json) so translators never edit links;
 * each entry's title/copy comes from `help_parental.<key>_title` /
 * `<key>_copy` in the locale bundles.
 *
 * Apple support links use the stable numeric/HT ids — Apple redirects
 * retired ids to their replacements, so these survive their doc reshuffles.
 */

export interface ParentalResource {
  /** i18n key fragment under `help_parental.*` AND React list key. */
  key: string;
  url: string;
}

export const PARENTAL_RESOURCES: readonly ParentalResource[] = [
  // Apple's umbrella page for family features — best single starting point.
  { key: "family_hub", url: "https://www.apple.com/families/" },
  // Content & privacy restrictions: app age-rating limits, web filters,
  // explicit-content blocks.
  { key: "parental_controls", url: "https://support.apple.com/105121" },
  // Screen Time: downtime, per-app time limits, communication limits.
  { key: "screen_time", url: "https://support.apple.com/en-us/HT208982" },
  // Child Apple Account inside a Family Sharing group (what makes the
  // age-appropriate defaults + Ask to Buy possible).
  { key: "child_account", url: "https://support.apple.com/en-us/HT201084" },
  // Ask to Buy — purchase/download approval requests sent to the parent.
  { key: "ask_to_buy", url: "https://support.apple.com/en-us/HT201089" },
  // Australian eSafety Commissioner — independent parent guidance on
  // screen time, app safety, and talking to kids about being online.
  { key: "esafety", url: "https://www.esafety.gov.au/parents" },
];
