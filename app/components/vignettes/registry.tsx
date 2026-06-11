import type { ReactNode } from "react";
import MotifContactForm from "./clean-slate/MotifContactForm";
import MotifContactsPermission from "./clean-slate/MotifContactsPermission";
import MotifCrashReport from "./clean-slate/MotifCrashReport";
import MotifFinancialAssets from "./clean-slate/MotifFinancialAssets";
import MotifHealthApp from "./clean-slate/MotifHealthApp";
import MotifIdentifiersFingerprint from "./clean-slate/MotifIdentifiersFingerprint";
import MotifOtherBucket from "./clean-slate/MotifOtherBucket";
import MotifPhotoLibrary from "./clean-slate/MotifPhotoLibrary";
import MotifReceipt from "./clean-slate/MotifReceipt";
import MotifScreenTime from "./clean-slate/MotifScreenTime";
import MotifSearchQuery from "./clean-slate/MotifSearchQuery";
import MotifSensitiveInfer from "./clean-slate/MotifSensitiveInfer";
import NotLinkedBrowsing from "./clean-slate/NotLinkedBrowsing";
import NotLinkedContacts from "./clean-slate/NotLinkedContacts";
import NotLinkedFinancial from "./clean-slate/NotLinkedFinancial";
import NotLinkedHealth from "./clean-slate/NotLinkedHealth";
import NotLinkedIdentifiers from "./clean-slate/NotLinkedIdentifiers";
import NotLinkedLocation from "./clean-slate/NotLinkedLocation";
import OutputBrowsingLinkedFeed from "./clean-slate/OutputBrowsingLinkedFeed";
import OutputBrowsingRetarget from "./clean-slate/OutputBrowsingRetarget";
import OutputContactInfoAccount from "./clean-slate/OutputContactInfoAccount";
import OutputContactInfoNotLinked from "./clean-slate/OutputContactInfoNotLinked";
import OutputContactInfoSpam from "./clean-slate/OutputContactInfoSpam";
import OutputContactsLinkedFriends from "./clean-slate/OutputContactsLinkedFriends";
import OutputContactsShadow from "./clean-slate/OutputContactsShadow";
import OutputContentAITrain from "./clean-slate/OutputContentAITrain";
import OutputContentBackup from "./clean-slate/OutputContentBackup";
import OutputContentNotLinked from "./clean-slate/OutputContentNotLinked";
import OutputDiagFingerprint from "./clean-slate/OutputDiagFingerprint";
import OutputDiagNotLinked from "./clean-slate/OutputDiagNotLinked";
import OutputDiagSupport from "./clean-slate/OutputDiagSupport";
import OutputFinancialLinkedWallet from "./clean-slate/OutputFinancialLinkedWallet";
import OutputFinancialPrice from "./clean-slate/OutputFinancialPrice";
import OutputHealthLinkedTrends from "./clean-slate/OutputHealthLinkedTrends";
import OutputHealthPremium from "./clean-slate/OutputHealthPremium";
import OutputIdentifiersLinkedSync from "./clean-slate/OutputIdentifiersLinkedSync";
import OutputIdentifiersUnified from "./clean-slate/OutputIdentifiersUnified";
import OutputLocationHome from "./clean-slate/OutputLocationHome";
import OutputLocationLinkedCommute from "./clean-slate/OutputLocationLinkedCommute";
import OutputOtherDossier from "./clean-slate/OutputOtherDossier";
import OutputOtherLinked from "./clean-slate/OutputOtherLinked";
import OutputOtherNotLinked from "./clean-slate/OutputOtherNotLinked";
import OutputPurchasesLifeEvent from "./clean-slate/OutputPurchasesLifeEvent";
import OutputPurchasesNotLinked from "./clean-slate/OutputPurchasesNotLinked";
import OutputPurchasesOrders from "./clean-slate/OutputPurchasesOrders";
import OutputSearchLinked from "./clean-slate/OutputSearchLinked";
import OutputSearchNotLinked from "./clean-slate/OutputSearchNotLinked";
import OutputSearchTrack from "./clean-slate/OutputSearchTrack";
import OutputSensitiveLinked from "./clean-slate/OutputSensitiveLinked";
import OutputSensitiveNotLinked from "./clean-slate/OutputSensitiveNotLinked";
import OutputSensitiveSegment from "./clean-slate/OutputSensitiveSegment";
import OutputUsageContinue from "./clean-slate/OutputUsageContinue";
import OutputUsageNotLinked from "./clean-slate/OutputUsageNotLinked";
import OutputUsageRehook from "./clean-slate/OutputUsageRehook";
import MotifBrowsingHistory from "./MotifBrowsingHistory";
import MotifLocation from "./MotifLocation";

/**
 * Apple privacy category identifiers that have a registered vignette.
 * Keep in sync with `CATEGORY_META` from `lib/privacy-meta.ts`.
 */
export type VignetteIdentifier =
  | "CONTACT_INFO"
  | "HEALTH_AND_FITNESS"
  | "FINANCIAL_INFO"
  | "LOCATION"
  | "SENSITIVE_INFO"
  | "CONTACTS"
  | "USER_CONTENT"
  | "BROWSING_HISTORY"
  | "SEARCH_HISTORY"
  | "IDENTIFIERS"
  | "PURCHASES"
  | "USAGE_DATA"
  | "DIAGNOSTICS"
  | "OTHER";

/**
 * Apple severity identifiers — which tier's story plays. Always mirrors
 * `SEVERITY_CONFIG` in `lib/privacy-meta.ts`.
 */
export type VignetteSeverity =
  | "DATA_USED_TO_TRACK_YOU"
  | "DATA_LINKED_TO_YOU"
  | "DATA_NOT_LINKED_TO_YOU";

/**
 * One renderable vignette: an optional left-hand capture motif plus the
 * right-hand destination/output scene. `motif` is `null` for the
 * not-linked tier because those scenes are self-contained full-stage
 * compositions (raw log → strike → aggregate) with their own capture.
 */
export interface VignetteScene {
  destination: ReactNode;
  motif: ReactNode | null;
}

/**
 * The clean-slate vignette set — one capture motif per label (shared by
 * the track + linked tiers) and one bespoke output per severity tier:
 *
 *   - `track`     → "Data used to track you": the dramatic real-world
 *     consequence (the ad that follows you, the recalculated premium,
 *     the dossier on a non-user, the fingerprint that picks you out).
 *   - `linked`    → "Data linked to you": the calmer same-company
 *     outcome — filed into App A's own profile of you, not sold on.
 *   - `notLinked` → "Data not linked to you": identifiers struck at
 *     source, leaving only aggregates. Full-stage scenes (no motif).
 *
 * All animation classes live in `clean-slate.css` (plus
 * `data-label-hint.css` for the two shared capture motifs). Every
 * animation is play-once with `both` fill — remounting the SVG replays
 * it, which `DataLabelHint` exploits by keying its stage on
 * (identifier, severity).
 */
const VIGNETTES: Record<
  VignetteIdentifier,
  {
    linked: () => ReactNode;
    motif: () => ReactNode;
    notLinked: () => ReactNode;
    track: () => ReactNode;
  }
> = {
  LOCATION: {
    motif: () => <MotifLocation />,
    track: () => <OutputLocationHome />,
    linked: () => <OutputLocationLinkedCommute />,
    notLinked: () => <NotLinkedLocation />,
  },
  BROWSING_HISTORY: {
    motif: () => <MotifBrowsingHistory />,
    track: () => <OutputBrowsingRetarget />,
    linked: () => <OutputBrowsingLinkedFeed />,
    notLinked: () => <NotLinkedBrowsing />,
  },
  FINANCIAL_INFO: {
    motif: () => <MotifFinancialAssets />,
    track: () => <OutputFinancialPrice />,
    linked: () => <OutputFinancialLinkedWallet />,
    notLinked: () => <NotLinkedFinancial />,
  },
  HEALTH_AND_FITNESS: {
    motif: () => <MotifHealthApp />,
    track: () => <OutputHealthPremium />,
    linked: () => <OutputHealthLinkedTrends />,
    notLinked: () => <NotLinkedHealth />,
  },
  CONTACT_INFO: {
    motif: () => <MotifContactForm />,
    track: () => <OutputContactInfoSpam />,
    linked: () => <OutputContactInfoAccount />,
    notLinked: () => <OutputContactInfoNotLinked />,
  },
  CONTACTS: {
    motif: () => <MotifContactsPermission />,
    track: () => <OutputContactsShadow />,
    linked: () => <OutputContactsLinkedFriends />,
    notLinked: () => <NotLinkedContacts />,
  },
  IDENTIFIERS: {
    motif: () => <MotifIdentifiersFingerprint />,
    track: () => <OutputIdentifiersUnified />,
    linked: () => <OutputIdentifiersLinkedSync />,
    notLinked: () => <NotLinkedIdentifiers />,
  },
  SENSITIVE_INFO: {
    motif: () => <MotifSensitiveInfer />,
    track: () => <OutputSensitiveSegment />,
    linked: () => <OutputSensitiveLinked />,
    notLinked: () => <OutputSensitiveNotLinked />,
  },
  USER_CONTENT: {
    motif: () => <MotifPhotoLibrary />,
    track: () => <OutputContentAITrain />,
    linked: () => <OutputContentBackup />,
    notLinked: () => <OutputContentNotLinked />,
  },
  SEARCH_HISTORY: {
    motif: () => <MotifSearchQuery />,
    track: () => <OutputSearchTrack />,
    linked: () => <OutputSearchLinked />,
    notLinked: () => <OutputSearchNotLinked />,
  },
  PURCHASES: {
    motif: () => <MotifReceipt />,
    track: () => <OutputPurchasesLifeEvent />,
    linked: () => <OutputPurchasesOrders />,
    notLinked: () => <OutputPurchasesNotLinked />,
  },
  USAGE_DATA: {
    motif: () => <MotifScreenTime />,
    track: () => <OutputUsageRehook />,
    linked: () => <OutputUsageContinue />,
    notLinked: () => <OutputUsageNotLinked />,
  },
  DIAGNOSTICS: {
    motif: () => <MotifCrashReport />,
    track: () => <OutputDiagFingerprint />,
    linked: () => <OutputDiagSupport />,
    notLinked: () => <OutputDiagNotLinked />,
  },
  OTHER: {
    motif: () => <MotifOtherBucket />,
    track: () => <OutputOtherDossier />,
    linked: () => <OutputOtherLinked />,
    notLinked: () => <OutputOtherNotLinked />,
  },
};

/**
 * Compose the vignette for a given (identifier, severity) pair. This is
 * the single entry point `DataLabelHint` uses; callers should never
 * instantiate the scene components directly.
 *
 * Returns `null` when the identifier or severity isn't registered.
 */
export function renderVignette(
  identifier: string,
  severity: string
): VignetteScene | null {
  const entry = VIGNETTES[identifier as VignetteIdentifier];
  if (!entry) {
    return null;
  }
  switch (severity as VignetteSeverity) {
    case "DATA_USED_TO_TRACK_YOU":
      return { motif: entry.motif(), destination: entry.track() };
    case "DATA_LINKED_TO_YOU":
      return { motif: entry.motif(), destination: entry.linked() };
    case "DATA_NOT_LINKED_TO_YOU":
      return { motif: null, destination: entry.notLinked() };
    default:
      return null;
  }
}

/**
 * (identifier, severity) pairs that have a translated caption in
 * `data_label_hint.captions.*` AND a registered vignette. Used by
 * `DataLabelHint` to decide whether to render the trigger. Keep in
 * lockstep with {@link VIGNETTES} and the locale bundle.
 */
const ALL_SEVERITIES = new Set<VignetteSeverity>([
  "DATA_USED_TO_TRACK_YOU",
  "DATA_LINKED_TO_YOU",
  "DATA_NOT_LINKED_TO_YOU",
]);

export const REGISTERED_CAPTIONS: Partial<
  Record<VignetteIdentifier, Set<VignetteSeverity>>
> = {
  CONTACT_INFO: ALL_SEVERITIES,
  HEALTH_AND_FITNESS: ALL_SEVERITIES,
  FINANCIAL_INFO: ALL_SEVERITIES,
  LOCATION: ALL_SEVERITIES,
  SENSITIVE_INFO: ALL_SEVERITIES,
  CONTACTS: ALL_SEVERITIES,
  USER_CONTENT: ALL_SEVERITIES,
  BROWSING_HISTORY: ALL_SEVERITIES,
  SEARCH_HISTORY: ALL_SEVERITIES,
  IDENTIFIERS: ALL_SEVERITIES,
  PURCHASES: ALL_SEVERITIES,
  USAGE_DATA: ALL_SEVERITIES,
  DIAGNOSTICS: ALL_SEVERITIES,
  OTHER: ALL_SEVERITIES,
};

export function isRegistered(identifier: string, severity: string): boolean {
  const set = REGISTERED_CAPTIONS[identifier as VignetteIdentifier];
  return set?.has(severity as VignetteSeverity) ?? false;
}
