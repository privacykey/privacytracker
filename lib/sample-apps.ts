/**
 * Sample-data demo for first-run users.
 *
 * Stored in sessionStorage (so it dies with the tab), the 10-app set has
 * varied privacy profiles + risk classifications + accessibility coverage so
 * a demo user gets a realistic feel without configuring anything.
 *
 * AI summaries are hand-written (not generated) to avoid requiring an AI
 * provider during the demo. They look like real summaries for educational
 * value — see https://privacytracker-docs.privacykey.org/develop/feature-flags.
 *
 * Components that read tracked apps merge sessionStorage results with the
 * DB results when the sample-data flag is on (wiring lands in PR 3).
 */

/**
 * Canonical privacy-type identifiers — same strings the live App Store
 * scraper produces (see `TYPE_IDENTIFIER_TO_TIER` in `lib/privacy-profile.ts`).
 * Using the canonical form here means seeded sample apps go through the
 * same mismatch-detection codepaths as scraped apps.
 */
export type SamplePrivacyTypeIdentifier =
  | 'DATA_USED_TO_TRACK_YOU'
  | 'DATA_LINKED_TO_YOU'
  | 'DATA_NOT_LINKED_TO_YOU';

export interface SampleAppPrivacyType {
  identifier: SamplePrivacyTypeIdentifier;
  title: string;
  /**
   * Categories under this type. Each entry is a canonical
   * `CATEGORY_META` key from `lib/privacy-meta.ts` (e.g. `'CONTACT_INFO'`,
   * `'HEALTH_AND_FITNESS'`). The seed route looks up the human label
   * from `CATEGORY_META[key].label` when writing rows to the DB.
   */
  categories: string[];
}

export interface SampleAppPolicySummary {
  paragraph: string;
  highlights: string[];
  /** Keyed by lens id ('collection_scope', 'ads_marketing', etc.). */
  lenses: Record<string, 'concerning' | 'mixed' | 'unclear' | 'favorable'>;
  promptVersion: number;
}

/**
 * One back-dated snapshot in a sample app's synthetic timeline. Each step
 * is rendered as a row in the changelog with a real diff (via
 * `diffSnapshots`) computed against the previous step, so the timeline
 * looks identical to one produced by actual scrapes — same row chrome,
 * trigger pill, version chip, and (where set) wayback badge.
 *
 * The current "today" state is built from the parent SampleApp's
 * `privacyTypes` field, so a history array with `daysAgo: [120, 60, 14]`
 * produces four total rows (three back-dated + today's import row).
 *
 * Hand-crafted rather than auto-generated so high-risk apps show varied,
 * plausible changes (added category in tracked tier, removed unlinked
 * category, etc.) and minimal apps stay quiet (one import row, no churn).
 */
export interface SampleHistoryStep {
  /** How many days ago this snapshot ran. Must be > 0 — "today" is the
   *  parent app's current `privacyTypes` and gets written automatically. */
  daysAgo: number;
  /** Snapshot of privacy types at this point in time. */
  privacyTypes: SampleAppPrivacyType[];
  /** Optional version chip the timeline shows next to the row, e.g. "7.22". */
  version?: string;
  /** Provenance pill. Defaults to 'scheduled' for non-first rows;
   *  the OLDEST row falls back to 'import' so the timeline reads as
   *  "user added the app on day 0, then sync events filled in later". */
  triggeredBy?: 'scheduled' | 'manual' | 'import' | 'wayback';
  /** When set, the row renders as a Wayback-archive snapshot — purple
   *  dot, clock glyph, View on Wayback link. Use for one or two high-
   *  risk apps to demonstrate the Historical Import surface. */
  waybackUrl?: string;
}

export interface SampleApp {
  id: string;
  name: string;
  developer: string;
  iconEmoji: string;
  /** 'high' | 'moderate' | 'low' | 'minimal' */
  riskTier: 'high' | 'moderate' | 'low' | 'minimal';
  hasPrivacyDetails: boolean;
  hasAccessibilityLabels: boolean;
  privacyTypes: SampleAppPrivacyType[];
  /** Pre-baked AI summary (no provider needed). */
  aiSummary: SampleAppPolicySummary;
  /** Synthetic timeline. Reverse-chronological order doesn't matter —
   *  the seeder sorts oldest-first before walking. Empty / omitted means
   *  the app has only a "first import" row in the timeline. */
  history?: SampleHistoryStep[];
}

export const SAMPLE_APPS: SampleApp[] = [
  {
    id: 'sample-instagram',
    name: 'Instagram',
    developer: 'Meta Platforms, Inc.',
    iconEmoji: '📷',
    riskTier: 'high',
    hasPrivacyDetails: true,
    hasAccessibilityLabels: true,
    privacyTypes: [
      { identifier: 'DATA_USED_TO_TRACK_YOU', title: 'Data Used to Track You', categories: ['IDENTIFIERS', 'LOCATION', 'PURCHASES', 'SEARCH_HISTORY', 'CONTACT_INFO', 'OTHER'] },
      { identifier: 'DATA_LINKED_TO_YOU', title: 'Data Linked to You', categories: ['HEALTH_AND_FITNESS', 'FINANCIAL_INFO', 'SENSITIVE_INFO', 'USER_CONTENT'] },
      { identifier: 'DATA_NOT_LINKED_TO_YOU', title: 'Data Not Linked to You', categories: ['DIAGNOSTICS', 'USAGE_DATA'] },
    ],
    aiSummary: {
      paragraph: 'Instagram collects an extensive range of personal data — identifiers, location, browsing and search history — and uses much of it to track users across other companies\u2019 apps and websites. The privacy policy permits sharing with Meta\u2019s ad partners and acknowledges that some data may be retained for years even after account deletion.',
      highlights: [
        'Tracks users across third-party apps for advertising',
        'Collects precise location and contact information',
        'Shares data with Meta\u2019s broader advertising network',
        'Account deletion does not immediately remove all data',
      ],
      lenses: {
        collection_scope: 'concerning',
        ads_marketing: 'concerning',
        third_party_sharing: 'concerning',
        retention: 'mixed',
        user_rights: 'mixed',
        security_posture: 'favorable',
      },
      promptVersion: 1,
    },
    history: [
      {
        daysAgo: 180,
        triggeredBy: 'wayback',
        waybackUrl: 'https://web.archive.org/web/20251028000000id_/https://apps.apple.com/us/app/instagram/id389801252',
        version: '329.0',
        privacyTypes: [
          { identifier: 'DATA_USED_TO_TRACK_YOU', title: 'Data Used to Track You', categories: ['IDENTIFIERS', 'LOCATION', 'PURCHASES', 'CONTACT_INFO'] },
          { identifier: 'DATA_LINKED_TO_YOU', title: 'Data Linked to You', categories: ['FINANCIAL_INFO', 'USER_CONTENT'] },
          { identifier: 'DATA_NOT_LINKED_TO_YOU', title: 'Data Not Linked to You', categories: ['DIAGNOSTICS', 'USAGE_DATA'] },
        ],
      },
      {
        daysAgo: 120,
        triggeredBy: 'scheduled',
        version: '335.0',
        privacyTypes: [
          { identifier: 'DATA_USED_TO_TRACK_YOU', title: 'Data Used to Track You', categories: ['IDENTIFIERS', 'LOCATION', 'PURCHASES', 'SEARCH_HISTORY', 'CONTACT_INFO'] },
          { identifier: 'DATA_LINKED_TO_YOU', title: 'Data Linked to You', categories: ['FINANCIAL_INFO', 'SENSITIVE_INFO', 'USER_CONTENT'] },
          { identifier: 'DATA_NOT_LINKED_TO_YOU', title: 'Data Not Linked to You', categories: ['DIAGNOSTICS', 'USAGE_DATA'] },
        ],
      },
      {
        daysAgo: 21,
        triggeredBy: 'scheduled',
        version: '341.2',
        privacyTypes: [
          { identifier: 'DATA_USED_TO_TRACK_YOU', title: 'Data Used to Track You', categories: ['IDENTIFIERS', 'LOCATION', 'PURCHASES', 'SEARCH_HISTORY', 'CONTACT_INFO', 'OTHER'] },
          { identifier: 'DATA_LINKED_TO_YOU', title: 'Data Linked to You', categories: ['HEALTH_AND_FITNESS', 'FINANCIAL_INFO', 'SENSITIVE_INFO', 'USER_CONTENT'] },
          { identifier: 'DATA_NOT_LINKED_TO_YOU', title: 'Data Not Linked to You', categories: ['DIAGNOSTICS', 'USAGE_DATA'] },
        ],
      },
    ],
  },
  {
    id: 'sample-tiktok',
    name: 'TikTok',
    developer: 'TikTok Ltd.',
    iconEmoji: '🎵',
    riskTier: 'high',
    hasPrivacyDetails: true,
    hasAccessibilityLabels: false,
    privacyTypes: [
      { identifier: 'DATA_USED_TO_TRACK_YOU', title: 'Data Used to Track You', categories: ['IDENTIFIERS', 'LOCATION', 'USAGE_DATA', 'BROWSING_HISTORY'] },
      { identifier: 'DATA_LINKED_TO_YOU', title: 'Data Linked to You', categories: ['CONTACT_INFO', 'USER_CONTENT', 'IDENTIFIERS', 'LOCATION', 'SEARCH_HISTORY'] },
      { identifier: 'DATA_NOT_LINKED_TO_YOU', title: 'Data Not Linked to You', categories: ['DIAGNOSTICS', 'OTHER'] },
    ],
    aiSummary: {
      paragraph: 'TikTok\u2019s privacy practices are wide-ranging: it collects identifiers, location, viewing patterns, and content interactions, and uses much of this for cross-app tracking and ad targeting. The policy describes complex data flows including overseas transfers that some regulators have flagged.',
      highlights: [
        'Builds detailed engagement profiles from viewing behaviour',
        'Tracks across third-party apps and websites',
        'Transfers data internationally including outside the EU/US',
        'Limited control over algorithmic content personalisation',
      ],
      lenses: {
        collection_scope: 'concerning',
        ads_marketing: 'concerning',
        third_party_sharing: 'concerning',
        retention: 'mixed',
        user_rights: 'mixed',
        security_posture: 'mixed',
      },
      promptVersion: 1,
    },
    history: [
      {
        daysAgo: 90,
        triggeredBy: 'manual',
        version: '32.5',
        privacyTypes: [
          { identifier: 'DATA_USED_TO_TRACK_YOU', title: 'Data Used to Track You', categories: ['IDENTIFIERS', 'USAGE_DATA'] },
          { identifier: 'DATA_LINKED_TO_YOU', title: 'Data Linked to You', categories: ['CONTACT_INFO', 'USER_CONTENT', 'IDENTIFIERS', 'LOCATION'] },
          { identifier: 'DATA_NOT_LINKED_TO_YOU', title: 'Data Not Linked to You', categories: ['DIAGNOSTICS'] },
        ],
      },
      {
        daysAgo: 30,
        triggeredBy: 'scheduled',
        version: '34.1',
        privacyTypes: [
          { identifier: 'DATA_USED_TO_TRACK_YOU', title: 'Data Used to Track You', categories: ['IDENTIFIERS', 'LOCATION', 'USAGE_DATA', 'BROWSING_HISTORY'] },
          { identifier: 'DATA_LINKED_TO_YOU', title: 'Data Linked to You', categories: ['CONTACT_INFO', 'USER_CONTENT', 'IDENTIFIERS', 'LOCATION', 'SEARCH_HISTORY'] },
          { identifier: 'DATA_NOT_LINKED_TO_YOU', title: 'Data Not Linked to You', categories: ['DIAGNOSTICS', 'OTHER'] },
        ],
      },
    ],
  },
  {
    id: 'sample-spotify',
    name: 'Spotify',
    developer: 'Spotify AB',
    iconEmoji: '🎧',
    riskTier: 'moderate',
    hasPrivacyDetails: true,
    hasAccessibilityLabels: true,
    privacyTypes: [
      { identifier: 'DATA_USED_TO_TRACK_YOU', title: 'Data Used to Track You', categories: ['IDENTIFIERS', 'USAGE_DATA'] },
      { identifier: 'DATA_LINKED_TO_YOU', title: 'Data Linked to You', categories: ['PURCHASES', 'CONTACT_INFO', 'USER_CONTENT', 'LOCATION'] },
      { identifier: 'DATA_NOT_LINKED_TO_YOU', title: 'Data Not Linked to You', categories: ['DIAGNOSTICS'] },
    ],
    aiSummary: {
      paragraph: 'Spotify collects listening behaviour, identifiers, and contact info to personalise recommendations and serve advertising on the free tier. Premium users see less ad-related processing. The policy is clear about what\u2019s collected and why.',
      highlights: [
        'Listening data drives personalised recommendations',
        'Free-tier users have ad data shared with partners',
        'Clear opt-outs available for marketing communications',
        'Standard 30-day deletion window after account closure',
      ],
      lenses: {
        collection_scope: 'mixed',
        ads_marketing: 'mixed',
        third_party_sharing: 'mixed',
        retention: 'favorable',
        user_rights: 'favorable',
        security_posture: 'favorable',
      },
      promptVersion: 1,
    },
    history: [
      {
        daysAgo: 75,
        triggeredBy: 'import',
        version: '8.9.30',
        privacyTypes: [
          { identifier: 'DATA_USED_TO_TRACK_YOU', title: 'Data Used to Track You', categories: ['IDENTIFIERS', 'USAGE_DATA'] },
          { identifier: 'DATA_LINKED_TO_YOU', title: 'Data Linked to You', categories: ['PURCHASES', 'CONTACT_INFO', 'LOCATION'] },
          { identifier: 'DATA_NOT_LINKED_TO_YOU', title: 'Data Not Linked to You', categories: ['DIAGNOSTICS'] },
        ],
      },
      {
        daysAgo: 14,
        triggeredBy: 'scheduled',
        version: '9.0.10',
        privacyTypes: [
          { identifier: 'DATA_USED_TO_TRACK_YOU', title: 'Data Used to Track You', categories: ['IDENTIFIERS', 'USAGE_DATA'] },
          { identifier: 'DATA_LINKED_TO_YOU', title: 'Data Linked to You', categories: ['PURCHASES', 'CONTACT_INFO', 'USER_CONTENT', 'LOCATION'] },
          { identifier: 'DATA_NOT_LINKED_TO_YOU', title: 'Data Not Linked to You', categories: ['DIAGNOSTICS'] },
        ],
      },
    ],
  },
  {
    id: 'sample-whatsapp',
    name: 'WhatsApp',
    developer: 'Meta Platforms, Inc.',
    iconEmoji: '💬',
    riskTier: 'moderate',
    hasPrivacyDetails: true,
    hasAccessibilityLabels: true,
    privacyTypes: [
      { identifier: 'DATA_LINKED_TO_YOU', title: 'Data Linked to You', categories: ['CONTACT_INFO', 'IDENTIFIERS', 'USAGE_DATA', 'USER_CONTENT'] },
      { identifier: 'DATA_NOT_LINKED_TO_YOU', title: 'Data Not Linked to You', categories: ['DIAGNOSTICS'] },
    ],
    aiSummary: {
      paragraph: 'WhatsApp uses end-to-end encryption for message content, but collects metadata — who you talk to, how often, from where. Phone number and contacts are linked to your identity and shared with Meta\u2019s broader infrastructure for ad personalisation outside the message stream itself.',
      highlights: [
        'Message content end-to-end encrypted',
        'Metadata (contacts, frequency, location) shared with Meta',
        'Phone numbers linked across Meta\u2019s ad platforms',
        'Limited data retention policies for metadata',
      ],
      lenses: {
        collection_scope: 'mixed',
        ads_marketing: 'mixed',
        third_party_sharing: 'concerning',
        retention: 'mixed',
        user_rights: 'mixed',
        security_posture: 'favorable',
      },
      promptVersion: 1,
    },
    history: [
      {
        daysAgo: 100,
        triggeredBy: 'import',
        version: '24.4',
        privacyTypes: [
          { identifier: 'DATA_LINKED_TO_YOU', title: 'Data Linked to You', categories: ['CONTACT_INFO', 'IDENTIFIERS', 'USAGE_DATA'] },
          { identifier: 'DATA_NOT_LINKED_TO_YOU', title: 'Data Not Linked to You', categories: ['DIAGNOSTICS'] },
        ],
      },
      {
        daysAgo: 35,
        triggeredBy: 'scheduled',
        version: '24.18',
        privacyTypes: [
          { identifier: 'DATA_LINKED_TO_YOU', title: 'Data Linked to You', categories: ['CONTACT_INFO', 'IDENTIFIERS', 'USAGE_DATA', 'USER_CONTENT'] },
          { identifier: 'DATA_NOT_LINKED_TO_YOU', title: 'Data Not Linked to You', categories: ['DIAGNOSTICS'] },
        ],
      },
    ],
  },
  {
    id: 'sample-gmail',
    name: 'Gmail',
    developer: 'Google LLC',
    iconEmoji: '📧',
    riskTier: 'moderate',
    hasPrivacyDetails: true,
    hasAccessibilityLabels: true,
    privacyTypes: [
      { identifier: 'DATA_LINKED_TO_YOU', title: 'Data Linked to You', categories: ['CONTACT_INFO', 'USER_CONTENT', 'IDENTIFIERS', 'USAGE_DATA', 'LOCATION'] },
      { identifier: 'DATA_NOT_LINKED_TO_YOU', title: 'Data Not Linked to You', categories: ['DIAGNOSTICS'] },
    ],
    aiSummary: {
      paragraph: 'Gmail processes email content for spam filtering, security threat detection, and feature suggestions like Smart Compose. Google has stated it does not use email content for advertising, though metadata around your account is part of the broader Google ad-targeting profile.',
      highlights: [
        'Email content processed for spam and security',
        'Smart Compose / Smart Reply use ML on your messages',
        'Google does not target ads based on email content',
        'Google account profile incorporates Gmail usage signals',
      ],
      lenses: {
        collection_scope: 'mixed',
        ads_marketing: 'favorable',
        third_party_sharing: 'mixed',
        retention: 'mixed',
        user_rights: 'favorable',
        security_posture: 'favorable',
      },
      promptVersion: 1,
    },
    history: [
      {
        daysAgo: 60,
        triggeredBy: 'import',
        version: '6.0.241201',
        privacyTypes: [
          { identifier: 'DATA_LINKED_TO_YOU', title: 'Data Linked to You', categories: ['CONTACT_INFO', 'USER_CONTENT', 'IDENTIFIERS', 'USAGE_DATA', 'LOCATION'] },
          { identifier: 'DATA_NOT_LINKED_TO_YOU', title: 'Data Not Linked to You', categories: ['DIAGNOSTICS'] },
        ],
      },
    ],
  },
  {
    id: 'sample-apple-music',
    name: 'Apple Music',
    developer: 'Apple, Inc.',
    iconEmoji: '🎶',
    riskTier: 'low',
    hasPrivacyDetails: true,
    hasAccessibilityLabels: true,
    privacyTypes: [
      { identifier: 'DATA_LINKED_TO_YOU', title: 'Data Linked to You', categories: ['PURCHASES', 'IDENTIFIERS', 'USER_CONTENT'] },
      { identifier: 'DATA_NOT_LINKED_TO_YOU', title: 'Data Not Linked to You', categories: ['DIAGNOSTICS'] },
    ],
    aiSummary: {
      paragraph: 'Apple Music collects only listening behaviour, library content, and identifiers needed for the service. No third-party tracking, no ad targeting. Standard Apple privacy posture.',
      highlights: [
        'No data used for cross-app tracking',
        'No third-party advertising',
        'Listening history kept on-device where possible',
        'Standard Apple ID deletion controls',
      ],
      lenses: {
        collection_scope: 'favorable',
        ads_marketing: 'favorable',
        third_party_sharing: 'favorable',
        retention: 'favorable',
        user_rights: 'favorable',
        security_posture: 'favorable',
      },
      promptVersion: 1,
    },
    history: [
      {
        daysAgo: 45,
        triggeredBy: 'import',
        version: '4.6',
        privacyTypes: [
          { identifier: 'DATA_LINKED_TO_YOU', title: 'Data Linked to You', categories: ['PURCHASES', 'IDENTIFIERS', 'USER_CONTENT'] },
          { identifier: 'DATA_NOT_LINKED_TO_YOU', title: 'Data Not Linked to You', categories: ['DIAGNOSTICS'] },
        ],
      },
    ],
  },
  {
    id: 'sample-maps',
    name: 'Apple Maps',
    developer: 'Apple, Inc.',
    iconEmoji: '🗺️',
    riskTier: 'low',
    hasPrivacyDetails: true,
    hasAccessibilityLabels: true,
    privacyTypes: [
      { identifier: 'DATA_NOT_LINKED_TO_YOU', title: 'Data Not Linked to You', categories: ['LOCATION', 'SEARCH_HISTORY', 'DIAGNOSTICS'] },
    ],
    aiSummary: {
      paragraph: 'Apple Maps processes location and search queries with random rotating identifiers — your searches are not tied to your Apple ID and are stripped of identifiers within 24 hours. One of the more privacy-preserving mapping options.',
      highlights: [
        'Searches not linked to Apple ID',
        'Identifiers rotated to avoid long-term profiling',
        'Location data processed locally where possible',
        'Personalised features available without identification',
      ],
      lenses: {
        collection_scope: 'favorable',
        ads_marketing: 'favorable',
        third_party_sharing: 'favorable',
        retention: 'favorable',
        user_rights: 'favorable',
        security_posture: 'favorable',
      },
      promptVersion: 1,
    },
    history: [
      {
        daysAgo: 30,
        triggeredBy: 'import',
        version: '7.0',
        privacyTypes: [
          { identifier: 'DATA_NOT_LINKED_TO_YOU', title: 'Data Not Linked to You', categories: ['LOCATION', 'SEARCH_HISTORY', 'DIAGNOSTICS'] },
        ],
      },
    ],
  },
  {
    id: 'sample-notes',
    name: 'Notes',
    developer: 'Apple, Inc.',
    iconEmoji: '📝',
    riskTier: 'minimal',
    hasPrivacyDetails: true,
    hasAccessibilityLabels: true,
    privacyTypes: [
      { identifier: 'DATA_NOT_LINKED_TO_YOU', title: 'Data Not Linked to You', categories: ['DIAGNOSTICS'] },
    ],
    aiSummary: {
      paragraph: 'Notes stores content on-device by default, with end-to-end encrypted iCloud sync as opt-in. No advertising data, no analytics on note content, no third-party processors.',
      highlights: [
        'Note content stored on-device or end-to-end encrypted',
        'No content analysis or advertising',
        'Sync requires explicit iCloud opt-in',
      ],
      lenses: {
        collection_scope: 'favorable',
        ads_marketing: 'favorable',
        third_party_sharing: 'favorable',
        retention: 'favorable',
        user_rights: 'favorable',
        security_posture: 'favorable',
      },
      promptVersion: 1,
    },
    history: [
      {
        daysAgo: 14,
        triggeredBy: 'import',
        version: '4.10',
        privacyTypes: [
          { identifier: 'DATA_NOT_LINKED_TO_YOU', title: 'Data Not Linked to You', categories: ['DIAGNOSTICS'] },
        ],
      },
    ],
  },
  {
    id: 'sample-calendar',
    name: 'Calendar',
    developer: 'Apple, Inc.',
    iconEmoji: '📅',
    riskTier: 'minimal',
    hasPrivacyDetails: true,
    hasAccessibilityLabels: true,
    privacyTypes: [
      { identifier: 'DATA_NOT_LINKED_TO_YOU', title: 'Data Not Linked to You', categories: ['DIAGNOSTICS'] },
    ],
    aiSummary: {
      paragraph: 'Calendar stores events locally with optional iCloud sync. No event-content analysis, no advertising. Suggested events from email use on-device parsing only.',
      highlights: [
        'On-device storage with optional encrypted sync',
        'Event content not analysed for advertising',
        'Email-based suggestions processed locally',
      ],
      lenses: {
        collection_scope: 'favorable',
        ads_marketing: 'favorable',
        third_party_sharing: 'favorable',
        retention: 'favorable',
        user_rights: 'favorable',
        security_posture: 'favorable',
      },
      promptVersion: 1,
    },
    history: [
      {
        daysAgo: 14,
        triggeredBy: 'import',
        version: '17.0',
        privacyTypes: [
          { identifier: 'DATA_NOT_LINKED_TO_YOU', title: 'Data Not Linked to You', categories: ['DIAGNOSTICS'] },
        ],
      },
    ],
  },
  {
    id: 'sample-weather',
    name: 'Weather',
    developer: 'Apple, Inc.',
    iconEmoji: '☀️',
    riskTier: 'minimal',
    hasPrivacyDetails: true,
    hasAccessibilityLabels: true,
    privacyTypes: [
      { identifier: 'DATA_NOT_LINKED_TO_YOU', title: 'Data Not Linked to You', categories: ['LOCATION', 'DIAGNOSTICS'] },
    ],
    aiSummary: {
      paragraph: 'Weather requests current location for forecasts but does not link the location to your Apple ID. The forecast service uses rotating tokens to ensure your location queries are not traceable to you.',
      highlights: [
        'Location used only for the current forecast',
        'No persistent location history retained',
        'Queries not linked to Apple ID',
      ],
      lenses: {
        collection_scope: 'favorable',
        ads_marketing: 'favorable',
        third_party_sharing: 'favorable',
        retention: 'favorable',
        user_rights: 'favorable',
        security_posture: 'favorable',
      },
      promptVersion: 1,
    },
    history: [
      {
        daysAgo: 14,
        triggeredBy: 'import',
        version: '5.0',
        privacyTypes: [
          { identifier: 'DATA_NOT_LINKED_TO_YOU', title: 'Data Not Linked to You', categories: ['LOCATION', 'DIAGNOSTICS'] },
        ],
      },
    ],
  },
];

const SESSION_KEY = 'sample_apps';

/**
 * Seed sessionStorage with the sample apps. Called from the "Try with sample
 * data" button on screen 1. Survives navigation but dies on tab close.
 */
export function seedSampleApps(): void {
  if (typeof window === 'undefined') return;
  window.sessionStorage.setItem(
    SESSION_KEY,
    JSON.stringify({
      apps: SAMPLE_APPS,
      seededAt: Date.now(),
    }),
  );
}

/** Read seeded sample apps. Returns an empty array if nothing's seeded. */
export function readSampleApps(): SampleApp[] {
  if (typeof window === 'undefined') return [];
  const raw = window.sessionStorage.getItem(SESSION_KEY);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as { apps?: SampleApp[] };
    return parsed.apps ?? [];
  } catch {
    window.sessionStorage.removeItem(SESSION_KEY);
    return [];
  }
}

/** Clear seeded sample apps. Called when the user imports their first real app. */
export function clearSampleApps(): void {
  if (typeof window === 'undefined') return;
  window.sessionStorage.removeItem(SESSION_KEY);
}

/** True iff sample-app data is currently seeded in sessionStorage. */
export function hasSampleApps(): boolean {
  if (typeof window === 'undefined') return false;
  return window.sessionStorage.getItem(SESSION_KEY) !== null;
}
