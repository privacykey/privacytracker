/**
 * Tracks which flags are actually consumed by component code today vs
 * which exist in the registry but aren't wired to a rendering branch yet.
 *
 * The Dev Options panel uses this set to show a "(no effect yet)" badge
 * on flags that are toggleable but inert, so testers can see at a glance
 * whether their override should produce a visible change.
 *
 * See https://privacytracker-docs.privacykey.org/develop/feature-flags.
 */

import type { FlagKey } from "./feature-flag-rules";

/**
 * Flags whose values are read by at least one rendering / routing path
 * in the app. Toggling these in Dev Options produces an observable change.
 */
export const WIRED_FLAGS: ReadonlySet<FlagKey> = new Set<FlagKey>([
  // Dashboard callouts
  "flag.dashboard.callout.declutter",
  "flag.dashboard.callout.guardian",
  "flag.dashboard.callout.understand_declutter",
  "flag.dashboard.callout.understand_only",

  // Coachmark tour gate
  "flag.onboarding.coachmark_tour",

  // Onboarding method picker — each filters the matching ImportMethod card.
  "flag.onboarding.method.manual_entry",
  "flag.onboarding.method.file_upload",
  "flag.onboarding.method.configurator",
  "flag.onboarding.method.screenshot_ocr",
  "flag.onboarding.method.live_text_help",

  // App Detail
  "flag.detail.annotations_sidebar",

  // Settings + Dev Options
  "flag.settings.admin.export.audit_bundle",
  "flag.devopts.feature_flag_system.enabled",

  // Settings card-level flags. SettingsView gates each card section inline
  // via useFlag — hiding a card removes both the controls and the heading.
  "flag.settings.sync.schedule",
  "flag.settings.sync.region",
  "flag.settings.ai.enabled",
  "flag.settings.policies.throttle",
  "flag.settings.policies.wayback_import",
  "flag.settings.notifications.prefs",
  "flag.settings.profiles.privacy",
  "flag.settings.profiles.accessibility",
  "flag.settings.import.history",
  "flag.settings.admin.backup",
  "flag.settings.admin.export",
  "flag.settings.admin.reset",
  "flag.settings.admin.start_over",

  // Legal pages
  "flag.legal.privacy_policy_page",
  "flag.legal.terms_page",

  // Page-level gating
  "flag.page.compare",
  "flag.page.manual_apps",
  "flag.page.privacy_map",
  "flag.page.stats",
  "flag.page.shortlist",
  "flag.about.ai_disclosure",
  "flag.help.label_definitions",
  "flag.help.export_guide",
  "flag.help.focus",

  // Quiet hours — wired in lib/notifications.ts (create-time stamp + filter).
  "flag.notifications.quiet_hours",
  // Sample-data button writes sessionStorage from /welcome; dashboard
  // bypasses the redirect on ?sample=1 to render SampleModeView.
  "flag.onboarding.sample_data_button",

  // Layout / nav / global surfaces
  "flag.global.keyboard_shortcuts",
  "flag.global.about_modal",
  "flag.global.site_info_hint",
  "flag.global.accessibility_toggles",
  "flag.global.info_tooltips",
  // DataLabelHint short-circuits to null when off.
  "flag.global.label_hints",
  "flag.global.social_share",
  "flag.global.live_text_modal",
  "flag.dashboard.annotation_banner",
  "flag.dashboard.sample_data_banner",
  "flag.devopts.activity_log",
  "flag.devopts.advanced_accordion",
  "flag.devopts.ai.debug_logging",
  "flag.nav.app_count_badge",
  "flag.nav.notification_bell",
  "flag.nav.task_center_trigger",
  "flag.nav.mobile_drawer",

  // HomeView sections
  "flag.dashboard.focus_strip",
  "flag.dashboard.hero.quiet_state",
  "flag.dashboard.hero.attention_state",
  "flag.dashboard.manual_apps_banner",
  "flag.dashboard.risk_section",
  "flag.dashboard.glance_section",
  "flag.dashboard.review_section",
  "flag.dashboard.profile_mismatch_section",
  "flag.dashboard.stale_section",
  "flag.dashboard.activity_section",
  "flag.dashboard.risk_tier_legend",

  // AppGrid action buttons + filter rows + card chips
  "flag.appgrid.actions.sync_all",
  "flag.appgrid.actions.sync_filtered",
  "flag.appgrid.actions.compare_mode",
  "flag.appgrid.actions.custom_apps_nav",
  "flag.appgrid.actions.add_apps",
  "flag.appgrid.filter.search",
  "flag.appgrid.filter.sort_tabs",
  "flag.appgrid.filter.profile_mismatch",
  "flag.appgrid.filter.risk_buttons",
  "flag.appgrid.filter.accessibility",
  "flag.appgrid.filter.active_banners",
  "flag.appgrid.empty_state",
  "flag.appgrid.card.change_dot",
  "flag.appgrid.card.profile_badge",
  "flag.appgrid.card.freshness_chip",
  "flag.appgrid.card.risk_pill",
  "flag.appgrid.card.risk_chips",
  "flag.appgrid.card.resync_button",
  "flag.appgrid.card.delete_button",

  // App Detail surface
  "flag.detail.actions.resync_button",
  "flag.detail.actions.delete_button",
  "flag.detail.tabs.compare",
  "flag.detail.footer.import_provenance",
  "flag.detail.header.freshness_badge",
  "flag.detail.header.change_count_badge",
  "flag.detail.header.a11y_count_chip",
  "flag.detail.labels.cards",
  "flag.detail.labels.profile_mismatch_badges",
  "flag.detail.labels.no_details_warning",
  "flag.detail.policy.panel",
  "flag.detail.a11y.panel",
  "flag.detail.review.panel",
  "flag.detail.review.mark_reviewed",
  "flag.detail.review.dismiss",
  "flag.detail.review.snooze_menu",
  // Policy panel sub-sections + action buttons. Each maps to a single block
  // inside PolicySummaryPanel; flipping any off hides only that sub-surface.
  "flag.detail.policy.lens_grid",
  "flag.detail.policy.recent_change_banner",
  "flag.detail.policy.change_strip",
  "flag.detail.policy.chunk_notes",
  "flag.detail.policy.run_log_strip",
  "flag.detail.policy.fallback_references",
  "flag.detail.policy.wayback_backup_link",
  "flag.detail.policy.source_policy_link",
  "flag.detail.policy.rescrape_button",
  "flag.detail.policy.summarise_button",
  "flag.detail.policy.rescrape_summarise_button",
  "flag.detail.policy.preview_toggle",
  // ChangelogTimeline row + decoration gates. Row-kind flags filter the
  // merged timeline; the rest decorate each snapshot row independently.
  "flag.detail.timeline.live_rows",
  "flag.detail.timeline.wayback_rows",
  "flag.detail.timeline.wayback_toggle",
  "flag.detail.timeline.trigger_pills",
  "flag.detail.timeline.version_chip",
  "flag.detail.timeline.matches_live_sync_badge",
  "flag.detail.timeline.review_rows",
  "flag.detail.timeline.policy_preview_toggle",
  "flag.detail.timeline.policy_diff_toggle",
  // App Change Timeline chart inside HistoryStatsStrip
  "flag.detail.charts.category_trend",
  "flag.detail.charts.trend_presets",
  "flag.detail.charts.trend_legend",
  // Accessibility Panel preference highlights (teal borders on features
  // marked required/nice in the user's a11y profile).
  "flag.detail.a11y.preference_highlights",
  // ManualAppDetailView per-section gates
  "flag.detail.manual.scrape_button",
  "flag.detail.manual.current_version_metadata",
  "flag.detail.manual.show_captured_text",
  "flag.detail.manual.edit_details",
  "flag.detail.manual.changelog",

  // Dev Options panel itself
  "flag.devopts.feature_flag_panel",
  // NotificationBell short-circuits to null when off.
  "flag.notifications.bell",
  // TaskCenterTrigger short-circuits when off.
  "flag.taskcenter.widget",
  // Sidebar drops the Developer Options entry when off.
  "flag.devopts.visible",
  // Snoozed change-review panel
  "flag.detail.review.snoozed_panel",
  // Review-row "Linked to:" snapshot chip strip
  "flag.detail.timeline.review_snapshot_chips",
  // AI Settings sub-flags inside the AI Policy Summaries card
  "flag.settings.ai.provider_selector",
  "flag.settings.ai.timeout_config",
  "flag.settings.ai.summarize_on_import",
  "flag.settings.ai.debug_logging",
  // Focus card on Settings
  "flag.settings.focus.picker",
  // Onboarding focus form (WelcomeSplash → FocusPurposeForm, reused by the
  // Settings focus editor) sub-flags. Each filters one piece of the form;
  // hidden pickers fall back to the audience-aware silent default.
  "flag.onboarding.audience_picker",
  "flag.onboarding.audience_picker.skip",
  "flag.onboarding.goals_picker",
  "flag.onboarding.goals_picker.minimal_option",
  "flag.onboarding.goals_picker.accessibility_modifier",
  // Privacy-profile setup step (server gate redirects to /onboard when off).
  "flag.onboarding.privacy_profile_setup",
  // Step-3 "Hide already-tracked apps" inline toggle
  "flag.onboarding.confirm.hide_tracked_toggle",
  // Step-5 AI summaries gate
  "flag.onboarding.step.ai_summaries",
  "flag.onboarding.post.dashboard_skip",
  // Hand-off-to-background-worker button (worker still runs automatically).
  "flag.onboarding.post.background_worker",
  // Step-4 scrape rate-limit countdown banner
  "flag.onboarding.import.rate_limit_handoff",
  // Step-1 footer restore / audit-bundle import links
  "flag.onboarding.method.restore_backup",
  "flag.onboarding.method.import_audit_bundle",
  // Step-1 settings rows
  "flag.onboarding.step.app_store_region",
  "flag.onboarding.step.accessibility_toggle",
  // Policy run-log "Full trace" expandable details
  "flag.detail.policy.run_log_details",
  // Policy-tab + AI-summary blocks inside PolicySummaryPanel
  "flag.detail.policy.ai_summary",
  "flag.detail.policy.ai_summary_disclaimer",
  "flag.detail.policy.highlights",
  "flag.detail.policy.safety_summary",
  // Privacy-tab "What's New" section
  "flag.detail.policy.whats_new",
  // OnboardWizard step body wrappers
  "flag.onboarding.step.choose_method",
  "flag.onboarding.step.confirm_matches",
  "flag.onboarding.step.import_progress",
  // Onboarding-namespace AI-summarise gate (AND-ed against persisted setting).
  "flag.onboarding.ai.summarize_on_import",
  // /onboard/profile page accessibility-profile-setup OR-gate
  "flag.onboarding.accessibility_profile_setup",
  // /legal page audit-bundle-note paragraph
  "flag.legal.audit_bundle_note",
  // SettingsView placeholder controls
  "flag.settings.admin.export.audit_pdf",
  "flag.settings.date_format.user_preference",
  "flag.devopts.activity_log.retention_days",
  "flag.devopts.feature_flag_presets",
  "flag.desktop.app_section",
  // AppGrid card-level annotation highlight (gold-border treatment)
  "flag.appgrid.card.annotation_highlight",

  // Stats viz panels — gated inline in StatsView with values resolved in
  // app/dashboard/stats/page.tsx.
  "flag.stats.viz.heatmap",
  "flag.stats.viz.timeline",
  "flag.stats.viz.compare",
  "flag.stats.viz.small_multiples",
  "flag.stats.viz.sankey",
  "flag.stats.viz.radar",
  "flag.stats.viz.category_bars",
  "flag.stats.viz.accessibility_bars",
  "flag.stats.recent_changes.filter",
  "flag.stats.off_profile_card",
  // NotificationBell skips the 30s poll when off
  "flag.notifications.bell.polling",
  // Resume-notification helpers in lib/notifications.ts early-return when off
  "flag.notifications.resume.enabled",
  // Per-type filters projected through /api/notification-prefs.
  "flag.notifications.types.label_changes",
  "flag.notifications.types.policy_updates",
  "flag.notifications.types.accessibility_changes",
  "flag.notifications.types.new_privacy_types",
  // TaskCenterProvider skips the 4s active-tasks poll when off
  "flag.taskcenter.polling",
  "flag.taskcenter.auto_dismiss",
  "flag.taskcenter.resume_cards",

  // Shortlist surfaces — gated inline in ShortlistView via ShortlistFlagState
  // resolved in app/dashboard/shortlist/page.tsx.
  "flag.shortlist.actions.remove",
  "flag.shortlist.actions.preview",
  "flag.shortlist.actions.share",
  "flag.shortlist.actions.export",
  "flag.shortlist.actions.print",
  "flag.shortlist.actions.reset",
  "flag.shortlist.actions.undo",
  "flag.shortlist.detailed_view",
  "flag.shortlist.live_badge_prefetch",
  "flag.shortlist.profile_mismatch_pill",
  "flag.shortlist.installed_grouping",
]);

export function isWired(key: FlagKey): boolean {
  return WIRED_FLAGS.has(key);
}
