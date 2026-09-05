/**
 * Shared client-side types for the App Detail surface. These are the
 * shapes `AppDetailView` and its extracted section components exchange —
 * deliberately redeclared client-side (rather than imported from lib/)
 * where the server module would drag better-sqlite3 into the bundle.
 */
import type { AppPolicyAnalysis } from "../../../lib/policy-summary-meta";

export interface Category {
  id: string;
  identifier: string;
  title: string;
}
export interface PrivacyType {
  categories: Category[];
  detail?: string;
  id: string;
  identifier: string;
  title: string;
}
export interface App {
  /** Feature list Apple published on the accessibility shelf at last scrape. */
  accessibilityFeatures?: AccessibilityFeatureProp[];
  /** App Store age rating ("4+", "13+"); null = never captured. */
  ageRating?: string | null;
  changeCount: number;
  /** Latest App Store version string, e.g. "12.1.0". */
  currentVersion?: string | null;
  developer?: string;
  firstSeen: number;
  /**
   * 1 = developer declared at least one accessibility feature on the
   * App Store listing; 0 = accessibility shelf absent or empty; null =
   * legacy row scraped before we started tracking accessibility labels.
   */
  hasAccessibilityLabels?: number | null;
  /**
   * 1 = listing offers in-app purchases; 0 = parsed and no IAP found;
   * null = parser couldn't decide. Surfaced as a "· IAP" suffix on
   * the price chip when 1; silent in the 0 / null cases.
   */
  hasIap?: number | null;
  /**
   * 1 = developer declared privacy labels; 0 = Apple shows "No Details
   * Provided" on the page; null = parser couldn't decide (legacy rows).
   */
  hasPrivacyDetails?: number | null;
  iconUrl?: string;
  id: string;
  lastSynced: number;
  name: string;
  policyAnalysis?: AppPolicyAnalysis | null;
  /**
   * Phase 2 pricing snapshot. Populated by the iTunes Lookup endpoint
   * during sync; null on rows that haven't been re-synced since the
   * Phase 2 columns landed. Renderers use `lib/price-display.ts` to
   * collapse these fields into a single chip string.
   */
  priceAmount?: number | null;
  priceCurrency?: string | null;
  priceFormatted?: string | null;
  privacyPolicyUrl?: string;
  privacyTypes: PrivacyType[];
  syncCount: number;
  url: string;
  /** Epoch ms for the current version's release date. */
  versionUpdatedAt?: number | null;
  /** Release notes body for the current version. */
  whatsNew?: string | null;
}

/**
 * Client-side mirror of `AccessibilityFeatureRecord` from lib/accessibility.ts
 * — redeclared here so the client bundle never transitively imports the
 * server-only module (which pulls in better-sqlite3). Keep the fields in sync.
 */
export interface AccessibilityFeatureProp {
  description: string | null;
  iconTemplate: string | null;
  identifier: string;
  title: string;
}

export interface RecentPolicyChangeHint {
  changedAt: number;
  currentVersionId: string;
  previousVersionId: string;
}
