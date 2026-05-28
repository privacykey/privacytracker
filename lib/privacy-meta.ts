// Centralized Data Definitions for Privacy Label Severities and Categories

export interface CategoryMetaInfo {
  color: string;
  description: string;
  icon: string;
  label: string;
}

export interface SeverityMetaInfo {
  cls: string;
  description: string;
  label: string;
}

export const CATEGORY_META: Record<string, CategoryMetaInfo> = {
  CONTACT_INFO: {
    icon: "📇",
    label: "Contact Info",
    color: "var(--blue)",
    description:
      "Information such as name, email address, phone number, physical address, or other contact information.",
  },
  HEALTH_AND_FITNESS: {
    icon: "💖",
    label: "Health & Fitness",
    color: "var(--red)",
    description:
      "Data related to health, medical records, fitness routines, and exercise data.",
  },
  FINANCIAL_INFO: {
    icon: "💳",
    label: "Financial Info",
    color: "var(--orange)",
    description:
      "Payment information (e.g., credit card number), credit information, or other financial details like salary, income, assets, or debts.",
  },
  LOCATION: {
    icon: "📍",
    label: "Location",
    color: "var(--red)",
    description:
      "Precise location (e.g., latitude/longitude) or approximate location data.",
  },
  SENSITIVE_INFO: {
    icon: "🔒",
    label: "Sensitive Info",
    color: "var(--red)",
    description:
      "Data such as racial or ethnic data, sexual orientation, pregnancy or childbirth information, disability, religious or philosophical beliefs, trade union membership, political opinion, genetic information, or biometric data.",
  },
  CONTACTS: {
    icon: "👥",
    label: "Contacts",
    color: "var(--blue)",
    description:
      "Information accessed from your address book, friend lists, or social graph.",
  },
  USER_CONTENT: {
    icon: "📝",
    label: "User Content",
    color: "var(--orange)",
    description:
      "Photos, videos, audio recordings, emails, messages, or other content created or provided by the user within the app.",
  },
  BROWSING_HISTORY: {
    icon: "🌐",
    label: "Browsing History",
    color: "var(--orange)",
    description:
      "Information about content you have viewed that is not part of the app itself, such as websites visited.",
  },
  SEARCH_HISTORY: {
    icon: "🔍",
    label: "Search History",
    color: "var(--orange)",
    description: "Information about searches performed within the app.",
  },
  IDENTIFIERS: {
    icon: "🆔",
    label: "Identifiers",
    color: "var(--red)",
    description:
      "User or account-level IDs (e.g., account ID, user ID, customer number) and device-level IDs (e.g., advertising identifier).",
  },
  PURCHASES: {
    icon: "🛍️",
    label: "Purchases",
    color: "var(--blue)",
    description: "Records of purchases or transaction history.",
  },
  USAGE_DATA: {
    icon: "📈",
    label: "Usage Data",
    color: "var(--orange)",
    description:
      "Information about how you interact with the app, such as feature usage, product interaction, or performance metrics.",
  },
  DIAGNOSTICS: {
    icon: "🛠️",
    label: "Diagnostics",
    color: "var(--text-3)",
    description:
      "Technical data like crash logs, launch time, hang rate, energy use, or other information used to measure app performance.",
  },
  OTHER: {
    icon: "📦",
    label: "Other Data",
    color: "var(--text-3)",
    description:
      "Any data that does not fit into the other specific categories.",
  },
};

export const PRIVACY_TYPE_DISPLAY_ORDER = [
  "DATA_NOT_LINKED_TO_YOU",
  "DATA_LINKED_TO_YOU",
  "DATA_USED_TO_TRACK_YOU",
] as const;

const PRIVACY_TYPE_DISPLAY_RANK: Record<string, number> = {
  DATA_NOT_LINKED_TO_YOU: 0,
  DATA_LINKED_TO_YOU: 1,
  DATA_USED_TO_TRACK_YOU: 2,
};

export function comparePrivacyTypeDisplayOrder(a: string, b: string): number {
  return (
    (PRIVACY_TYPE_DISPLAY_RANK[a] ?? Number.MAX_SAFE_INTEGER) -
    (PRIVACY_TYPE_DISPLAY_RANK[b] ?? Number.MAX_SAFE_INTEGER)
  );
}

export function sortPrivacyTypesForDisplay<T extends { identifier: string }>(
  items: readonly T[]
): T[] {
  return [...items].sort((a, b) =>
    comparePrivacyTypeDisplayOrder(a.identifier, b.identifier)
  );
}

export const SEVERITY_CONFIG: Record<string, SeverityMetaInfo> = {
  DATA_NOT_LINKED_TO_YOU: {
    label: "Data Not Linked to You",
    cls: "severity-unlinked",
    description:
      "Data the app collects but says is not tied back to your identity, usually because direct identifiers are removed before collection.",
  },
  DATA_LINKED_TO_YOU: {
    label: "Data Linked to You",
    cls: "severity-linked",
    description:
      "Data the app can connect back to you, such as through your account, device, contact details, user ID, or another identifier.",
  },
  DATA_USED_TO_TRACK_YOU: {
    label: "Data Used to Track You",
    cls: "severity-track",
    description:
      "Data the app or its partners use to recognize you across other companies' apps, websites, offline data sources, or data brokers.",
  },
};
