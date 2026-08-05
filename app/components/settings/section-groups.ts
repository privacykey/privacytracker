/**
 * The Settings taxonomy: which sections exist, and which group owns each.
 *
 * This is the single source of truth behind three things that must agree —
 * the sidebar's links, the per-group routes, and the redirect that keeps
 * old `#section` anchors working. They used to agree only by coincidence,
 * because the grouping lived inside SettingsSidebar and nothing else could
 * see it.
 *
 * Section ids are load-bearing beyond navigation: they are the anchor ids
 * rendered by each section component, `/privacy-policy` deep-links to
 * `#ai-summaries`, and bell notifications link to `#ai-timeouts`. See
 * ./README.md.
 */

/** The four buckets Settings has always been organised into. Each one is a
 *  route segment under /dashboard/settings. */
export const SETTINGS_GROUPS = ["you", "sync", "policies", "admin"] as const;

export type SettingsGroup = (typeof SETTINGS_GROUPS)[number];

/**
 * Every section that renders, in document order, keyed by its owning group.
 * Order matters twice: it is the order the page paints, and the scroll-spy
 * assumes sidebar order matches document order.
 *
 * This lists all 23 sections, not the 19 the sidebar advertises. Four —
 * date-format, accessibility-labels, review-queue-preferences and
 * policy-scrape-disabled — render without a sidebar entry. They are here
 * so their anchors still resolve to the right route: someone who bookmarked
 * `#date-format` should not land nowhere just because the sidebar never
 * offered them the link.
 *
 * Sections that already have their own route (focus, import-history) still
 * appear — the landing shows a link card in their slot.
 */
export const GROUP_SECTIONS: Record<SettingsGroup, readonly string[]> = {
  you: [
    "focus",
    "date-format",
    "language",
    "privacy-profile",
    "accessibility-profile",
    "notifications",
  ],
  sync: [
    "sync-schedule",
    "region",
    "accessibility-labels",
    "review-queue-preferences",
    "sync-status",
  ],
  policies: [
    "ai-summaries",
    "privacy-policies-bulk",
    "policy-alerts",
    "policy-scrape-disabled",
    "policy-scrape-throttle",
  ],
  admin: [
    "import-history",
    "deployment-diagnostics",
    "backup",
    "wayback-import",
    "export-data",
    "developer",
    "reset",
  ],
};

/** i18n key under `settings.sidebar.*` for each group's divider label. */
export const GROUP_LABEL_KEYS: Record<SettingsGroup, string> = {
  you: "group_you",
  sync: "group_data_sync",
  policies: "group_policies_ai",
  admin: "group_admin",
};

const SECTION_TO_GROUP = new Map<string, SettingsGroup>(
  SETTINGS_GROUPS.flatMap((group) =>
    GROUP_SECTIONS[group].map((id) => [id, group] as const)
  )
);

/** Which group owns a section id, or null if the id is not a section. */
export function groupForSection(id: string): SettingsGroup | null {
  return SECTION_TO_GROUP.get(id) ?? null;
}

/**
 * Where a section lives now, as a path + anchor.
 *
 * Returns null for unknown ids so callers can leave a stray hash alone
 * rather than redirecting somewhere arbitrary — `#ai-timeouts`, for one,
 * is an anchor *inside* a section rather than a section itself, and is
 * handled by the caller.
 */
export function sectionHref(id: string): string | null {
  const group = groupForSection(id);
  return group ? `/dashboard/settings/${group}#${id}` : null;
}

export function isSettingsGroup(value: string): value is SettingsGroup {
  return (SETTINGS_GROUPS as readonly string[]).includes(value);
}
