/**
 * Pure types and constants for the accessibility-labels surface. Safe to
 * import from Client Components — no server-side imports (no `db`, no fs)
 * so Next.js's bundler never tries to drag `better-sqlite3` into the
 * browser bundle.
 *
 * The matching server-only module `lib/accessibility.ts` re-exports these
 * names for server callers so extraction/diff/persistence code only has
 * to reach for one module. Keep the shapes in sync.
 */

/**
 * A single accessibility feature as it appears on an app's listing. Mirrors
 * `AccessibilityFeatureRecord` in `lib/accessibility.ts`.
 */
export interface AccessibilityFeature {
  description: string | null;
  /** SF Symbol template URI, e.g. "systemimage://voiceover". Null on legacy rows. */
  iconTemplate: string | null;
  identifier: string;
  title: string;
}

/**
 * Canonical feature catalogue. Kept in sync with `CANONICAL_ACCESSIBILITY_FEATURES`
 * in `lib/accessibility.ts` (the server module re-exports this one). The UI
 * uses it for:
 *   - the legend on the app detail page, so a user can see at a glance which
 *     features a given app is MISSING (not just which it declares);
 *   - the stats chart, so every canonical bar is present even when no tracked
 *     app supports a feature (preventing a misleadingly short chart).
 *
 * `fallbackDescription` is shown when Apple's own description field is
 * absent on the scraped listing.
 */
export interface CanonicalAccessibilityFeature {
  fallbackDescription: string;
  /**
   * Emoji used in the UI when Apple's own artwork URL isn't available
   * (e.g. canonical-only rows where no app has declared the feature yet,
   * or legacy DB rows pre-dating the icon_template column). SF Symbol
   * URIs (systemimage://…) can't be rendered in a browser, so without
   * this fallback we'd have no glyph to show in the icon column.
   */
  fallbackEmoji: string;
  iconTemplate: string;
  identifier: string;
  title: string;
}

/**
 * Resolve an Apple artwork URL template into a concrete img src. The feed
 * ships templates like `https://is1-ssl.mzstatic.com/…/{w}x{h}{c}.{f}` where
 * `{w}`, `{h}`, `{c}` (optional crop tag), and `{f}` (format extension) are
 * placeholders. We fix the size to a small rasterisation that's crisp on
 * 2x displays, drop the crop tag, and use PNG. Returns null for SF Symbol
 * pseudo-URIs (`systemimage://…`) and anything that doesn't look like a
 * real HTTP template — callers should fall back to the canonical emoji
 * in that case.
 */
export function resolveAppleArtworkUrl(
  template: string | null | undefined,
  size = 40
): string | null {
  if (!template) {
    return null;
  }
  if (/^systemimage:\/\//i.test(template)) {
    return null;
  }
  if (!/^https?:\/\//i.test(template)) {
    return null;
  }
  const replaced = template
    .replace(/\{w\}/g, String(size))
    .replace(/\{h\}/g, String(size))
    .replace(/\{c\}/g, "")
    .replace(/\{f\}/g, "png");
  // If any placeholder somehow remained, bail rather than ship a broken URL.
  if (/\{[a-z]\}/i.test(replaced)) {
    return null;
  }
  return replaced;
}

export const CANONICAL_ACCESSIBILITY_FEATURES: readonly CanonicalAccessibilityFeature[] =
  [
    {
      identifier: "voiceover",
      title: "VoiceOver",
      iconTemplate: "systemimage://voiceover",
      fallbackDescription:
        "Navigate and explore the app using gestures, braille, and speech output.",
      fallbackEmoji: "🔊",
    },
    {
      identifier: "voice_control",
      title: "Voice Control",
      iconTemplate: "systemimage://voice.control",
      fallbackDescription:
        "Navigate and interact with the app using your voice to tap, swipe, type, and more.",
      fallbackEmoji: "🎙️",
    },
    {
      identifier: "larger_text",
      title: "Larger Text",
      iconTemplate: "systemimage://textformat.size",
      fallbackDescription: "Increase the text size in the app to 200% or more.",
      fallbackEmoji: "🔠",
    },
    {
      identifier: "dark_interface",
      title: "Dark Interface",
      iconTemplate: "systemimage://appearance.darkmode",
      fallbackDescription:
        "Apply a dark color scheme to the screens, menus, and controls to reduce eye strain.",
      fallbackEmoji: "🌙",
    },
    {
      identifier: "differentiate_without_color_alone",
      title: "Differentiate Without Color Alone",
      iconTemplate: "systemimage://xmark.triangle.circle.square.fill",
      fallbackDescription:
        "Use shapes or text, in addition to or instead of color, to distinguish key information.",
      fallbackEmoji: "🎨",
    },
    {
      identifier: "sufficient_contrast",
      title: "Sufficient Contrast",
      iconTemplate: "systemimage://circle.lefthalf.filled.inverse",
      fallbackDescription:
        "Increase or adjust the contrast between text or iconography and background.",
      fallbackEmoji: "🔆",
    },
    {
      identifier: "reduced_motion",
      title: "Reduced Motion",
      iconTemplate: "systemimage://circle.dotted.and.circle",
      fallbackDescription:
        "Modify or reduce certain types of animation that may cause motion sickness or discomfort.",
      fallbackEmoji: "〰️",
    },
    {
      identifier: "captions",
      title: "Captions",
      iconTemplate: "systemimage://captions.bubble",
      fallbackDescription:
        "Display captions for dialogue and significant sound effects in video content.",
      fallbackEmoji: "💬",
    },
    {
      identifier: "audio_descriptions",
      title: "Audio Descriptions",
      iconTemplate: "systemimage://ear",
      fallbackDescription:
        "Describe important visual content in video via an audio narration track.",
      fallbackEmoji: "🎧",
    },
  ];
