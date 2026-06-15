/**
 * Feature flag rules — v1
 *
 * Hand-authored rule tables that drive the feature-flag system described at
 * https://privacytracker-docs.privacykey.org/develop/feature-flags. Each flag has a hard default; some have
 * additional rules that activate based on the user's audience, goals, or
 * accessibility modifier.
 *
 * Resolution order (last layer wins):
 *   HARD_DEFAULTS[key]
 *   ← AUDIENCE_RULES[audience][key]
 *   ← GOAL_RULES[goal][key] for each active primary goal
 *   ← ACCESSIBILITY_RULES[key] (if goal.accessibility is on)
 *   ← user override (final word)
 *
 * Rules are sparse — most flags appear in zero or one table.
 *
 * To add a flag:
 *   1. Add its key to the FlagKey union below
 *   2. Add a HARD_DEFAULTS entry (mandatory)
 *   3. Add rules to the relevant tables only if its behaviour differs from default
 *
 * The companion file `lib/feature-flags.ts` (round 3) re-exports `FlagKey`
 * and provides the resolver itself.
 */

// ============================================================================
// Types
// ============================================================================

export type FlagValue = "on" | "off" | "collapsed";
export type Audience = "self" | "loved_one" | "guardian";
export type PrimaryGoal = "monitor" | "cleanup" | "minimal";
export type Modifier = "accessibility";

/**
 * Active focus state. Read from `app_settings` via the storage module.
 * `aiConfigured` is a derived flag (from `ai_provider`) used by tour-step
 * inclusion and a few rule conditions.
 */
export interface FocusState {
  aiConfigured: boolean;
  audience: Audience;
  goals: Set<PrimaryGoal | Modifier>;
}

// ============================================================================
// FlagKey — every registered flag in v1 (~204 keys)
// ============================================================================

export type FlagKey =
  // ----- Global / cross-cutting
  | "flag.global.keyboard_shortcuts"
  | "flag.global.accessibility_toggles"
  | "flag.global.site_info_hint"
  | "flag.global.info_tooltips"
  | "flag.global.label_hints"
  | "flag.global.about_modal"
  | "flag.global.social_share"
  | "flag.global.live_text_modal"

  // ----- Navigation
  | "flag.nav.app_count_badge"
  | "flag.nav.notification_bell"
  | "flag.nav.task_center_trigger"
  | "flag.nav.task_list_icon"
  | "flag.nav.mobile_drawer"

  // ----- Dashboard (HomeView)
  | "flag.dashboard.focus_strip"
  | "flag.dashboard.hero.quiet_state"
  | "flag.dashboard.hero.attention_state"
  | "flag.dashboard.manual_apps_banner"
  | "flag.dashboard.risk_section"
  | "flag.dashboard.callout.declutter"
  | "flag.dashboard.callout.guardian"
  // "N apps rated above your child's age range" callout. Depends on the
  // flag.guardian.age_rating master (FLAG_DEPENDENCIES below).
  | "flag.dashboard.callout.age_rating"
  // Master switch for the guardian child-age-band feature: the band picker
  // in the focus form, the grid badge + filter, and the detail verdict row
  // all check this key. Off by default; the guardian audience turns it on.
  | "flag.guardian.age_rating"
  | "flag.dashboard.callout.understand_declutter"
  | "flag.dashboard.callout.understand_only"
  | "flag.dashboard.glance_section"
  | "flag.dashboard.review_section"
  | "flag.dashboard.profile_mismatch_section"
  | "flag.dashboard.stale_section"
  | "flag.dashboard.activity_section"
  | "flag.dashboard.risk_tier_legend"
  | "flag.dashboard.sample_data_banner"
  // Tauri desktop "keep running in background" wizard. Off on the web
  // build by default — the callout component also runtime-gates on
  // `isDesktop()` so the flag-on web case still renders nothing.
  | "flag.dashboard.background_mode_wizard"
  // User-facing task list (inline panel + nav icon — see flag.nav.task_list_icon).
  // Audience-aware "things worth trying" panel rendered at the top of HomeView.
  // Per-task `includedWhen` predicates handle the audience tailoring — flipping
  // this off is a global kill-switch for the inline surface only; the nav icon
  // has its own flag.
  | "flag.dashboard.task_list"
  // Journey-strip rendering of the tasks panel: same resolved tasks, drawn
  // as a stepped path (done → current → upcoming) with one detail card for
  // the current step, instead of the flat row list. Off falls back to the
  // legacy list rendering — this flag is the kill-switch for the strip
  // VISUAL only; `flag.dashboard.task_list` still controls whether the
  // panel exists at all.
  | "flag.dashboard.task_journey"
  // Device-aware re-sync CTAs. Off hides the "Re-sync from this device"
  // button on the Review wizard's Action step and the Tasks-panel chip;
  // the Devices settings page has its own flag.
  | "flag.dashboard.device_resync_cta"
  // Editable home-dashboard layout. Flipping off hides the "Customise
  // dashboard…" footer link AND short-circuits the editor route. The
  // dashboard still renders whatever layout the user saved last — the
  // flag gates the editor surface, not the consumer.
  | "flag.dashboard.layout_editor.visible"

  // ----- App Grid
  | "flag.appgrid.filter.search"
  | "flag.appgrid.filter.sort_tabs"
  | "flag.appgrid.filter.risk_buttons"
  | "flag.appgrid.filter.profile_mismatch"
  | "flag.appgrid.filter.accessibility"
  // Device-scope dropdown — filters the grid to apps from a single
  // cfgutil device (or "Unknown" placeholder for legacy/manual apps).
  // Auto-hidden by the client when fewer than 2 devices exist, so
  // single-device users don't see a no-op control.
  | "flag.appgrid.filter.device"
  | "flag.appgrid.filter.active_banners"
  | "flag.appgrid.actions.sync_filtered"
  | "flag.appgrid.actions.sync_all"
  | "flag.appgrid.actions.compare_mode"
  | "flag.appgrid.actions.custom_apps_nav"
  | "flag.appgrid.actions.add_apps"
  | "flag.appgrid.card.change_dot"
  | "flag.appgrid.card.profile_badge"
  | "flag.appgrid.card.freshness_chip"
  | "flag.appgrid.card.risk_pill"
  | "flag.appgrid.card.risk_chips"
  | "flag.appgrid.card.resync_button"
  | "flag.appgrid.card.delete_button"
  | "flag.appgrid.card.verdict_pill"
  | "flag.appgrid.empty_state"
  // Review-queue mode (Tinder-style sequential verdict picker over the
  // currently-filtered grid). Master flag gates the [Queue] mode toggle and
  // the carousel + preflight UI; sub-flags gate bulk select and the
  // end-of-session cfgutil offer independently.
  | "flag.appgrid.review_queue.enabled"
  | "flag.appgrid.review_queue.bulk_select"
  | "flag.appgrid.review_queue.cfgutil_uninstall"

  // ----- App Detail — privacy labels
  | "flag.detail.labels.cards"
  | "flag.detail.labels.profile_mismatch_badges"
  | "flag.detail.labels.no_details_warning"

  // ----- App Detail — timeline
  | "flag.detail.timeline.live_rows"
  | "flag.detail.timeline.wayback_rows"
  | "flag.detail.timeline.wayback_toggle"
  | "flag.detail.timeline.policy_preview_toggle"
  | "flag.detail.timeline.policy_diff_toggle"
  | "flag.detail.timeline.trigger_pills"
  | "flag.detail.timeline.version_chip"
  | "flag.detail.timeline.matches_live_sync_badge"
  | "flag.detail.timeline.review_rows"
  | "flag.detail.timeline.review_snapshot_chips"

  // ----- App Detail — charts
  | "flag.detail.charts.category_trend"
  | "flag.detail.charts.trend_presets"
  | "flag.detail.charts.trend_legend"

  // ----- App Detail — policy tab
  | "flag.detail.policy.panel"
  | "flag.detail.policy.rescrape_button"
  | "flag.detail.policy.summarise_button"
  | "flag.detail.policy.rescrape_summarise_button"
  | "flag.detail.policy.preview_toggle"
  | "flag.detail.policy.ai_summary"
  | "flag.detail.policy.ai_summary_disclaimer"
  | "flag.detail.policy.highlights"
  | "flag.detail.policy.lens_grid"
  | "flag.detail.policy.safety_summary"
  | "flag.detail.policy.whats_new"
  | "flag.detail.policy.recent_change_banner"
  | "flag.detail.policy.change_strip"
  | "flag.detail.policy.chunk_notes"
  | "flag.detail.policy.run_log_strip"
  | "flag.detail.policy.run_log_details"
  | "flag.detail.policy.fallback_references"
  | "flag.detail.policy.wayback_backup_link"
  | "flag.detail.policy.source_policy_link"

  // ----- App Detail — accessibility tab
  | "flag.detail.a11y.panel"
  | "flag.detail.a11y.preference_highlights"
  | "flag.detail.header.a11y_count_chip"

  // ----- App Detail — change review
  | "flag.detail.review.panel"
  | "flag.detail.review.mark_reviewed"
  | "flag.detail.review.dismiss"
  | "flag.detail.review.snooze_menu"
  | "flag.detail.review.snoozed_panel"

  // ----- App Detail — actions / header / footer
  | "flag.detail.actions.resync_button"
  | "flag.detail.actions.delete_button"
  | "flag.detail.header.freshness_badge"
  | "flag.detail.header.tracked_on_chips"
  | "flag.detail.header.change_count_badge"
  | "flag.detail.footer.import_provenance"
  | "flag.detail.tabs.compare"
  | "flag.detail.annotations_sidebar"
  | "flag.dashboard.annotation_banner"
  | "flag.appgrid.card.annotation_highlight"

  // ----- App Detail — manual apps
  | "flag.detail.manual.scrape_button"
  | "flag.detail.manual.current_version_metadata"
  | "flag.detail.manual.show_captured_text"
  | "flag.detail.manual.edit_details"
  | "flag.detail.manual.changelog"

  // ----- Onboarding — pre-wizard
  | "flag.onboarding.audience_picker"
  | "flag.onboarding.audience_picker.skip"
  | "flag.onboarding.goals_picker"
  | "flag.onboarding.goals_picker.skip"
  | "flag.onboarding.goals_picker.minimal_option"
  | "flag.onboarding.goals_picker.accessibility_modifier"
  | "flag.onboarding.privacy_profile_setup"
  | "flag.onboarding.accessibility_profile_setup"
  | "flag.onboarding.sample_data_button"
  | "flag.onboarding.coachmark_tour"
  | "flag.onboarding.device_name_step"

  // ----- Onboarding — wizard steps + methods
  | "flag.onboarding.step.choose_method"
  | "flag.onboarding.method.manual_entry"
  | "flag.onboarding.method.file_upload"
  | "flag.onboarding.method.configurator"
  | "flag.onboarding.method.screenshot_ocr"
  | "flag.onboarding.method.live_text_help"
  | "flag.onboarding.method.restore_backup"
  | "flag.onboarding.method.import_audit_bundle"
  | "flag.onboarding.step.app_store_region"
  | "flag.onboarding.step.accessibility_toggle"
  | "flag.onboarding.step.confirm_matches"
  | "flag.onboarding.confirm.hide_tracked_toggle"
  | "flag.onboarding.step.import_progress"
  | "flag.onboarding.import.rate_limit_handoff"
  | "flag.onboarding.step.ai_summaries"
  | "flag.onboarding.ai.summarize_on_import"
  | "flag.onboarding.post.dashboard_skip"
  | "flag.onboarding.post.background_worker"

  // ----- Settings (user-facing)
  | "flag.settings.sync.schedule"
  | "flag.settings.sync.region"
  | "flag.settings.ai.enabled"
  | "flag.settings.ai.provider_selector"
  | "flag.settings.ai.timeout_config"
  | "flag.settings.ai.summarize_on_import"
  | "flag.settings.ai.debug_logging"
  | "flag.settings.policies.throttle"
  | "flag.settings.policies.wayback_import"
  | "flag.settings.notifications.prefs"
  | "flag.settings.profiles.privacy"
  | "flag.settings.devices_page"
  | "flag.settings.profiles.accessibility"
  | "flag.settings.focus.picker"
  | "flag.settings.import.history"
  | "flag.settings.admin.backup"
  | "flag.settings.admin.export"
  | "flag.settings.admin.export.audit_bundle"
  | "flag.settings.admin.export.audit_pdf"
  | "flag.settings.admin.reset"
  | "flag.settings.admin.start_over"

  // ----- Developer Options
  | "flag.devopts.visible"
  | "flag.devopts.ai.debug_logging"
  | "flag.devopts.feature_flag_panel"
  | "flag.devopts.feature_flag_system.enabled"
  | "flag.devopts.activity_log"
  | "flag.devopts.activity_log.retention_days"
  | "flag.devopts.advanced_accordion"
  | "flag.devopts.feature_flag_presets"
  // Phase 3 of the audit-bundle action flow. When 'on' AND the active
  // audience is 'self', the Apps grid surfaces a "Review & uninstall"
  // entry point and the device-side workflow can call the
  // `run_cfgutil_remove_app` Tauri command. Off by default — explicit
  // opt-in under Developer Options because it deletes apps from a
  // physical device. The audience check is a separate hard gate
  // enforced in code, not just a default rule, so flipping this flag
  // on while the audience is 'loved_one' or 'guardian' still keeps
  // the destructive UI hidden.
  | "flag.devopts.cfgutil_uninstall"
  | "flag.settings.date_format.user_preference"

  // ----- Stats
  | "flag.stats.viz.heatmap"
  | "flag.stats.viz.timeline"
  | "flag.stats.viz.radar"
  | "flag.stats.viz.sankey"
  | "flag.stats.viz.small_multiples"
  | "flag.stats.viz.compare"
  | "flag.stats.viz.category_bars"
  | "flag.stats.viz.accessibility_bars"
  | "flag.stats.recent_changes.filter"
  | "flag.stats.off_profile_card"

  // ----- Shortlist
  | "flag.shortlist.actions.remove"
  | "flag.shortlist.actions.preview"
  | "flag.shortlist.actions.share"
  | "flag.shortlist.actions.export"
  | "flag.shortlist.actions.print"
  | "flag.shortlist.actions.reset"
  | "flag.shortlist.actions.undo"
  | "flag.shortlist.detailed_view"
  | "flag.shortlist.live_badge_prefetch"
  | "flag.shortlist.profile_mismatch_pill"
  | "flag.shortlist.installed_grouping"

  // ----- Notifications & Task Center
  | "flag.notifications.bell"
  | "flag.notifications.bell.polling"
  | "flag.notifications.types.label_changes"
  | "flag.notifications.types.policy_updates"
  | "flag.notifications.types.accessibility_changes"
  | "flag.notifications.types.new_privacy_types"
  | "flag.notifications.resume.enabled"
  | "flag.notifications.quiet_hours"
  | "flag.taskcenter.widget"
  | "flag.taskcenter.auto_dismiss"
  | "flag.taskcenter.resume_cards"
  | "flag.taskcenter.polling"

  // ----- Secondary pages
  | "flag.page.compare"
  | "flag.page.manual_apps"
  | "flag.page.privacy_map"
  | "flag.page.stats"
  | "flag.page.shortlist"
  | "flag.help.label_definitions"
  | "flag.help.export_guide"
  | "flag.help.focus"
  | "flag.about.ai_disclosure"
  | "flag.legal.privacy_policy_page"
  | "flag.legal.terms_page"
  | "flag.legal.audit_bundle_note"
  | "flag.desktop.app_section";

// ============================================================================
// HARD_DEFAULTS — baseline value for every registered flag
// ============================================================================
//
// Most existing user-facing features default to 'on'. Diagnostic/debug surfaces
// default to 'off'. A handful default to 'collapsed' (visible-but-not-expanded).
// New unshipped capabilities default to 'off' until activated by an audience or
// goal rule below.

export const HARD_DEFAULTS: Record<FlagKey, FlagValue> = {
  // Global / cross-cutting
  "flag.global.keyboard_shortcuts": "on", // power-user nav, baseline
  "flag.global.accessibility_toggles": "on", // floating a11y panel — universal benefit
  "flag.global.site_info_hint": "on", // legal/privacy footer pill — compliance
  "flag.global.info_tooltips": "on", // help with discovery for new users
  "flag.global.label_hints": "on", // skeuomorphic hover vignettes on privacy data labels
  "flag.global.about_modal": "on", // version + creator info
  "flag.global.social_share": "off", // off-by-default; loved_one elevates
  "flag.global.live_text_modal": "on", // mobile import helper

  // Navigation
  "flag.nav.app_count_badge": "on", // count of tracked apps next to nav link
  "flag.nav.notification_bell": "on", // bell is core
  "flag.nav.task_center_trigger": "on", // task widget trigger
  "flag.nav.task_list_icon": "on", // user-facing task list nav icon
  "flag.nav.mobile_drawer": "on", // mobile-only menu drawer

  // Dashboard
  "flag.dashboard.focus_strip": "on", // shows current focus chips
  "flag.dashboard.hero.quiet_state": "on", // 'nothing new' state
  "flag.dashboard.hero.attention_state": "on", // '⚡ things need attention' state
  "flag.dashboard.manual_apps_banner": "on", // "not everything is on App Store" CTA
  "flag.dashboard.risk_section": "on", // higher-risk apps watchlist
  "flag.dashboard.callout.declutter": "off", // declutter goal turns this on
  "flag.dashboard.callout.age_rating": "off", // guardian audience turns this on
  "flag.guardian.age_rating": "off", // guardian audience turns this on
  "flag.dashboard.callout.guardian": "off", // guardian audience turns this on
  "flag.dashboard.callout.understand_declutter": "off", // (understand AND declutter) turns this on
  "flag.dashboard.callout.understand_only": "off", // (understand AND NOT declutter) turns this on
  "flag.dashboard.glance_section": "on", // at-a-glance stats grid
  "flag.dashboard.review_section": "on", // 'changes to review'
  "flag.dashboard.profile_mismatch_section": "on", // 'consider replacing'
  "flag.dashboard.stale_section": "on", // stale apps list
  "flag.dashboard.activity_section": "on", // 'this week's activity'
  "flag.dashboard.risk_tier_legend": "collapsed", // reference details, expandable
  "flag.dashboard.sample_data_banner": "off", // only on while sample apps present
  "flag.dashboard.background_mode_wizard": "on", // Tauri-only callout — runtime-gated on isDesktop()
  "flag.dashboard.task_list": "on", // audience-aware tasks panel at the top of HomeView
  "flag.dashboard.task_journey": "on", // journey-strip rendering of the tasks panel (off = legacy flat list)
  "flag.dashboard.device_resync_cta": "on", // "Re-sync from this device" CTAs on Review wizard + Tasks chip
  "flag.dashboard.layout_editor.visible": "on", // "Customise dashboard…" footer link + editor route gate

  // App Grid
  "flag.appgrid.filter.search": "on", // text filter
  "flag.appgrid.filter.sort_tabs": "on", // sort tabs
  "flag.appgrid.filter.risk_buttons": "on", // risk-tier filter row
  "flag.appgrid.filter.profile_mismatch": "on", // mismatch filter toggle
  "flag.appgrid.filter.accessibility": "off", // a11y filter row — only when modifier on
  "flag.appgrid.filter.device": "on", // device-scope dropdown (auto-hidden when <2 devices)
  "flag.appgrid.filter.active_banners": "on", // active-filter status banners
  "flag.appgrid.actions.sync_filtered": "on", // sync-filtered context button
  "flag.appgrid.actions.sync_all": "on", // sync-all header button
  "flag.appgrid.actions.compare_mode": "on", // compare-mode toggle
  "flag.appgrid.actions.custom_apps_nav": "on", // custom apps shortcut
  "flag.appgrid.actions.add_apps": "on", // primary add-apps CTA
  "flag.appgrid.card.change_dot": "on", // change indicator dot
  "flag.appgrid.card.profile_badge": "on", // profile-match badge
  "flag.appgrid.card.freshness_chip": "on", // 'synced N days ago'
  "flag.appgrid.card.risk_pill": "on", // risk classification pill
  "flag.appgrid.card.risk_chips": "on", // unlinked/linked/track mini-chips
  "flag.appgrid.card.resync_button": "on", // per-card refresh
  "flag.appgrid.card.delete_button": "on", // per-card delete
  "flag.appgrid.card.verdict_pill": "on", // per-card user verdict pill (Safe/Replace/Uninstall)
  "flag.appgrid.empty_state": "on", // empty/filter-miss CTA
  "flag.appgrid.review_queue.enabled": "on", // master — Tinder-style verdict carousel
  "flag.appgrid.review_queue.bulk_select": "on", // bulk-mark mode toggle
  "flag.appgrid.review_queue.cfgutil_uninstall": "off", // Tauri-only end-of-session offer; opt-in

  // App Detail — privacy labels
  "flag.detail.labels.cards": "on", // expandable label-type cards
  "flag.detail.labels.profile_mismatch_badges": "on", // mismatch chips on category cards
  "flag.detail.labels.no_details_warning": "on", // 'developer hasn't provided labels' warning

  // App Detail — timeline
  "flag.detail.timeline.live_rows": "on", // live-sync rows
  "flag.detail.timeline.wayback_rows": "on", // wayback-imported rows
  "flag.detail.timeline.wayback_toggle": "on", // 'show wayback imports' checkbox
  "flag.detail.timeline.policy_preview_toggle": "on", // per-row policy text preview
  "flag.detail.timeline.policy_diff_toggle": "on", // per-row diff toggle
  "flag.detail.timeline.trigger_pills": "on", // 'manual sync' / 'scheduled' badges
  "flag.detail.timeline.version_chip": "on", // 'v1.2.3' chip on snapshots
  "flag.detail.timeline.matches_live_sync_badge": "on", // 'matches live sync' on wayback rows
  "flag.detail.timeline.review_rows": "on", // reviewed/dismissed/snoozed audit rows
  "flag.detail.timeline.review_snapshot_chips": "on", // '↳ change #N' refs in review rows

  // App Detail — charts
  "flag.detail.charts.category_trend": "on", // category trend sparkline
  "flag.detail.charts.trend_presets": "on", // 30d/90d/6m presets
  "flag.detail.charts.trend_legend": "on", // chart legend

  // App Detail — policy tab
  "flag.detail.policy.panel": "on", // policy tab body
  "flag.detail.policy.rescrape_button": "on", // rescrape policy
  "flag.detail.policy.summarise_button": "on", // ✨ summarise via AI
  "flag.detail.policy.rescrape_summarise_button": "on", // combined ⟲ rescrape + summarise
  "flag.detail.policy.preview_toggle": "on", // preview captured text
  "flag.detail.policy.ai_summary": "off", // off until a goal turns it on (understand/declutter)
  "flag.detail.policy.ai_summary_disclaimer": "on", // 'AI-generated' warning when summary is shown
  "flag.detail.policy.highlights": "on", // pill list under summary
  "flag.detail.policy.lens_grid": "off", // off until a goal turns it on
  "flag.detail.policy.safety_summary": "off", // new — guardian audience turns this on
  "flag.detail.policy.whats_new": "on", // release notes section
  "flag.detail.policy.recent_change_banner": "on", // 'policy text changed N days ago' alert
  "flag.detail.policy.change_strip": "on", // lens-shift since last analysis
  "flag.detail.policy.chunk_notes": "collapsed", // per-chunk summaries — diagnostic
  "flag.detail.policy.run_log_strip": "collapsed", // phase trace strip — diagnostic
  "flag.detail.policy.run_log_details": "collapsed", // expandable trace details
  "flag.detail.policy.fallback_references": "on", // ToS;DR / PrivacySpy safety net
  "flag.detail.policy.wayback_backup_link": "on", // 'wayback backup ↗' link
  "flag.detail.policy.source_policy_link": "on", // 'open source policy ↗' link

  // App Detail — accessibility tab
  "flag.detail.a11y.panel": "collapsed", // visible but not expanded; accessibility goal expands
  "flag.detail.a11y.preference_highlights": "on", // teal borders on preferred features
  "flag.detail.header.a11y_count_chip": "on", // 'N accessibility features' chip in header

  // App Detail — change review
  "flag.detail.review.panel": "on", // 'what's changed' panel
  "flag.detail.review.mark_reviewed": "on", // ✓ button
  "flag.detail.review.dismiss": "on", // ✕ button
  "flag.detail.review.snooze_menu": "on", // 1d/1w/1m menu
  "flag.detail.review.snoozed_panel": "on", // collapsed snoozed state

  // App Detail — actions / header / footer
  "flag.detail.actions.resync_button": "on", // rescrape live labels
  "flag.detail.actions.delete_button": "on", // stop tracking app
  "flag.detail.header.freshness_badge": "on", // 'last synced N days ago'
  "flag.detail.header.tracked_on_chips": "on", // "Tracked on: iPhone · iPad" chip strip
  "flag.detail.header.change_count_badge": "on", // red 'N changes'
  "flag.detail.footer.import_provenance": "on", // 'imported via … on DATE'
  "flag.detail.tabs.compare": "on", // compare tab visibility
  "flag.detail.annotations_sidebar": "collapsed", // right-rail notes — collapsed for self; loved_one expands; guardian/minimal hide
  "flag.dashboard.annotation_banner": "off", // off until a bundle import populates annotations
  "flag.appgrid.card.annotation_highlight": "off", // off-by-default; loved_one + post-import users see gold border

  // App Detail — manual apps
  "flag.detail.manual.scrape_button": "on", // scrape now
  "flag.detail.manual.current_version_metadata": "on", // captured/wordcount strips
  "flag.detail.manual.show_captured_text": "on", // per-row text toggle
  "flag.detail.manual.edit_details": "on", // edit metadata link
  "flag.detail.manual.changelog": "on", // unified scrape+field timeline

  // Onboarding — pre-wizard
  "flag.onboarding.audience_picker": "on", // screen 1 — WHO
  "flag.onboarding.audience_picker.skip": "on", // screen 1 'skip' link
  "flag.onboarding.goals_picker": "on", // screen 2 — WHY
  "flag.onboarding.goals_picker.skip": "on", // screen 2 'skip' link
  "flag.onboarding.goals_picker.minimal_option": "on", // 'just the basics' alternative
  "flag.onboarding.goals_picker.accessibility_modifier": "on", // a11y modifier checkbox
  "flag.onboarding.privacy_profile_setup": "off", // declutter goal turns this on
  "flag.onboarding.accessibility_profile_setup": "off", // accessibility modifier turns this on
  "flag.onboarding.sample_data_button": "on", // 'try with sample data' button on screen 1
  "flag.onboarding.coachmark_tour": "on", // post-import dashboard tour
  "flag.onboarding.device_name_step": "on", // "Name your device" gating in OnboardWizard

  // Onboarding — wizard steps + methods
  "flag.onboarding.step.choose_method": "on", // method picker step
  "flag.onboarding.method.manual_entry": "on", // typed names
  "flag.onboarding.method.file_upload": "on", // CSV/TXT
  "flag.onboarding.method.configurator": "off", // Tauri desktop runtime turns this on
  "flag.onboarding.method.screenshot_ocr": "on", // screenshot OCR
  "flag.onboarding.method.live_text_help": "on", // iOS Live Text helper modal
  "flag.onboarding.method.restore_backup": "on", // restore from backup link
  "flag.onboarding.method.import_audit_bundle": "off", // new — only loved_one's recipient sees it elevated
  "flag.onboarding.step.app_store_region": "on", // region/country dropdown
  "flag.onboarding.step.accessibility_toggle": "on", // 'track accessibility labels' checkbox
  "flag.onboarding.step.confirm_matches": "on", // App Store confirm grid
  "flag.onboarding.confirm.hide_tracked_toggle": "on", // 'hide already-tracked' filter
  "flag.onboarding.step.import_progress": "on", // live scrape list
  "flag.onboarding.import.rate_limit_handoff": "on", // Apple-rate-limit handoff banner
  "flag.onboarding.step.ai_summaries": "on", // optional AI step
  "flag.onboarding.ai.summarize_on_import": "off", // off-by-default; user opts in
  "flag.onboarding.post.dashboard_skip": "on", // 'skip AI, go to dashboard'
  "flag.onboarding.post.background_worker": "on", // background queue worker for queued imports

  // Settings (user-facing)
  "flag.settings.sync.schedule": "on", // sync schedule controls
  "flag.settings.sync.region": "on", // App Store region
  "flag.settings.ai.enabled": "on", // master AI toggle (still off in app config until user picks provider)
  "flag.settings.ai.provider_selector": "on", // OpenAI / Anthropic / custom picker
  "flag.settings.ai.timeout_config": "on", // per-phase timeouts
  "flag.settings.ai.summarize_on_import": "on", // auto-summarise toggle
  "flag.settings.ai.debug_logging": "off", // off-by-default; debug-only
  "flag.settings.policies.throttle": "on", // policy scrape throttle
  "flag.settings.policies.wayback_import": "on", // wayback import controls
  "flag.settings.notifications.prefs": "on", // notification prefs entry
  "flag.settings.profiles.privacy": "on", // privacy profile editor
  "flag.settings.devices_page": "on", // Settings → Devices management page
  "flag.settings.profiles.accessibility": "on", // accessibility profile editor
  "flag.settings.focus.picker": "on", // 'Your focus' card
  "flag.settings.import.history": "on", // import history sub-page
  "flag.settings.admin.backup": "on", // backup/restore
  "flag.settings.admin.export": "on", // CSV export
  "flag.settings.admin.export.audit_bundle": "off", // off-by-default; loved_one elevates
  "flag.settings.admin.export.audit_pdf": "off", // deferred to v0.1.0; flag in registry only
  "flag.settings.admin.reset": "on", // delete-all-data
  "flag.settings.admin.start_over": "on", // start-over button (full wipe)

  // Developer Options
  "flag.devopts.visible": "on", // sidebar entry visibility
  "flag.devopts.ai.debug_logging": "off", // diagnostic; off-by-default
  "flag.devopts.cfgutil_uninstall": "off", // off-by-default — destructive opt-in
  "flag.devopts.feature_flag_panel": "on", // the new feature-flag panel
  "flag.devopts.feature_flag_system.enabled": "on", // KILL SWITCH — turns the whole flag system off
  "flag.devopts.activity_log": "on", // activity-log accordion
  "flag.devopts.activity_log.retention_days": "off", // numeric flag — deferred to v0.1.0; v1 doesn't prune
  "flag.devopts.advanced_accordion": "collapsed", // Advanced accordion in dev opts
  "flag.devopts.feature_flag_presets": "on", // on by default; loved_one/guardian/minimal turn off (preset workflow is self-audience-coded)
  "flag.settings.date_format.user_preference": "on", // user can override locale-default (auto/24h/12h) in Settings; actual preference in app_settings.date_format_preference

  // Stats
  "flag.stats.viz.heatmap": "on", // heatmap viz
  "flag.stats.viz.timeline": "on", // global timeline
  "flag.stats.viz.radar": "on", // radar chart
  "flag.stats.viz.sankey": "on", // data-flow sankey
  "flag.stats.viz.small_multiples": "on", // per-app sparkline grid
  "flag.stats.viz.compare": "on", // multi-app compare
  "flag.stats.viz.category_bars": "on", // category bars
  "flag.stats.viz.accessibility_bars": "on", // a11y feature bars
  "flag.stats.recent_changes.filter": "on", // 3-way filter visibility (filter VALUE is separate state)
  "flag.stats.off_profile_card": "on", // off-profile summary card

  // Shortlist
  "flag.shortlist.actions.remove": "on", // remove from shortlist
  "flag.shortlist.actions.preview": "on", // preview an item
  "flag.shortlist.actions.share": "on", // share shortlist
  "flag.shortlist.actions.export": "on", // export shortlist
  "flag.shortlist.actions.print": "on", // print shortlist
  "flag.shortlist.actions.reset": "on", // reset shortlist
  "flag.shortlist.actions.undo": "on", // undo last removal
  "flag.shortlist.detailed_view": "on", // detailed vs compact view
  "flag.shortlist.live_badge_prefetch": "on", // background badge prefetch
  "flag.shortlist.profile_mismatch_pill": "on", // mismatch pill
  "flag.shortlist.installed_grouping": "on", // installed-vs-not grouping

  // Notifications & Task Center
  "flag.notifications.bell": "on", // bell trigger
  "flag.notifications.bell.polling": "on", // 30s polling
  "flag.notifications.types.label_changes": "on", // label-changes notification type
  "flag.notifications.types.policy_updates": "on", // policy-updates notification type
  "flag.notifications.types.accessibility_changes": "off", // off until accessibility modifier on
  "flag.notifications.types.new_privacy_types": "on", // new privacy-types appearing
  "flag.notifications.resume.enabled": "on", // 'resumed after restart' notifications
  "flag.notifications.quiet_hours": "off", // off-by-default; loved_one/guardian rules turn on with default windows
  "flag.taskcenter.widget": "on", // task center widget itself
  "flag.taskcenter.auto_dismiss": "on", // auto-dismiss completed rows
  "flag.taskcenter.resume_cards": "on", // resume-after-restart job cards
  "flag.taskcenter.polling": "on", // 4s polling

  // Secondary pages
  "flag.page.compare": "on", // /dashboard/compare
  "flag.page.manual_apps": "on", // /dashboard/manual-apps
  "flag.page.privacy_map": "on", // /dashboard/privacy
  "flag.page.stats": "on", // /dashboard/stats
  "flag.page.shortlist": "on", // /dashboard/shortlist
  "flag.help.label_definitions": "on", // /help/definitions
  "flag.help.export_guide": "on", // /help/export-app-list
  "flag.help.focus": "on", // /help/focus (new)
  "flag.about.ai_disclosure": "on", // /dashboard/about/ai-disclosure
  "flag.legal.privacy_policy_page": "on", // /privacy-policy
  "flag.legal.terms_page": "on", // /legal
  "flag.legal.audit_bundle_note": "off", // off-by-default; loved_one elevates
  "flag.desktop.app_section": "off", // off on web; Tauri build flips on at startup
};

// ============================================================================
// AUDIENCE_RULES — moderate-weight overlay
// ============================================================================
//
// `self` is the baseline (no rules). `loved_one` elevates share/export. `guardian`
// trims power-user surfaces (carers rarely need them). `goal.declutter` will
// re-enable some `guardian` hides — see GOAL_RULES.cleanup below.

export const AUDIENCE_RULES: Record<
  Audience,
  Partial<Record<FlagKey, FlagValue>>
> = {
  // ----- self: baseline, no overrides
  self: {},

  // ----- loved_one: recommender — elevate sharing, exporting, comparing
  loved_one: {
    "flag.global.social_share": "on", // share modal — recommenders share findings
    "flag.shortlist.actions.print": "on", // print recommendations to hand over
    "flag.shortlist.actions.export": "on", // export to share
    "flag.settings.admin.export": "on", // CSV export elevated
    "flag.settings.admin.export.audit_bundle": "on", // audit bundle is THE recommender feature
    "flag.settings.admin.export.audit_pdf": "on", // deferred-to-v0.1.0 but flagged-on for that audience
    "flag.legal.audit_bundle_note": "on", // privacy-policy paragraph re bundle sharing
    "flag.page.compare": "on", // compare side-by-side recommendations
    "flag.detail.tabs.compare": "on", // compare tab in App Detail
    "flag.onboarding.method.import_audit_bundle": "on", // (for the loved_one's RECIPIENT — same flag covers both ends)
    "flag.detail.annotations_sidebar": "on", // recommender writes notes — sidebar expanded
    "flag.dashboard.annotation_banner": "on", // banner showing annotation count post-import
    "flag.appgrid.card.annotation_highlight": "on", // gold border on annotated cards
    "flag.notifications.quiet_hours": "on", // loved_one default 21:00-08:00 (window in app_settings)
    "flag.devopts.feature_flag_presets": "off", // not relevant for recommender workflow
  },

  // ----- guardian: carer — trim power-user surfaces by default
  guardian: {
    "flag.global.keyboard_shortcuts": "off", // carers rarely know keyboard shortcuts
    "flag.global.info_tooltips": "off", // less hover help needed in simpler workflow
    "flag.global.label_hints": "off", // animated label hints muted for carer workflow
    "flag.devopts.ai.debug_logging": "off", // diagnostic noise
    "flag.settings.ai.debug_logging": "off", // diagnostic noise (settings copy)
    "flag.settings.policies.wayback_import": "off", // archive deep-dive isn't a carer concern
    "flag.desktop.app_section": "off", // hide desktop config even on Tauri
    "flag.devopts.visible": "off", // hide dev opts entirely (search still finds it — §5.8)
    "flag.page.compare": "off", // recipe/research feature not for daily safety check
    "flag.page.privacy_map": "off", // category-explorer is power-user terrain
    "flag.page.manual_apps": "off", // sideload tracking — niche for carers
    "flag.taskcenter.widget": "off", // background-job widget too technical
    "flag.notifications.resume.enabled": "off", // 'resumed after restart' is debug-y for carers
    "flag.detail.policy.safety_summary": "on", // NEW: 'is this safe for them?' summary pinned at top
    "flag.guardian.age_rating": "on", // child age band vs app age ratings
    "flag.dashboard.callout.age_rating": "on", // 'apps above the child's range' callout
    "flag.detail.policy.run_log_strip": "off", // diagnostic
    "flag.detail.policy.run_log_details": "off", // diagnostic
    "flag.detail.policy.chunk_notes": "off", // per-chunk debug
    "flag.detail.annotations_sidebar": "off", // not relevant for carer workflow
    "flag.dashboard.annotation_banner": "off", // ditto
    "flag.appgrid.card.annotation_highlight": "off", // ditto
    "flag.notifications.quiet_hours": "on", // guardian default 22:00-07:00 (window in app_settings)
    "flag.devopts.feature_flag_presets": "off", // not relevant for carer workflow
  },
};

// ============================================================================
// GOAL_RULES — primary goal overlays
// ============================================================================
//
// Multiple goal tiles can be active (e.g. monitor AND cleanup). Goals are
// applied in the order [monitor, cleanup, minimal] — minimal ("Keep it
// minimal") is mutually exclusive with the others so it never coexists, but
// the order is fixed for determinism. `goal.accessibility` is a separate
// modifier — see ACCESSIBILITY_RULES below.

export const GOAL_RULES: Record<
  PrimaryGoal,
  Partial<Record<FlagKey, FlagValue>>
> = {
  // ----- monitor: tracking + comprehension (was "understand")
  monitor: {
    "flag.detail.policy.ai_summary": "on", // AI summaries are the comprehension lever
    "flag.detail.policy.lens_grid": "on", // lens cards expose policy stance
    "flag.detail.charts.category_trend": "on", // historical trends matter for tracking
    "flag.dashboard.callout.understand_only": "on", // 'new to privacy labels?' link (off when declutter ALSO on; see understand_declutter)
    "flag.notifications.bell": "on", // already on by default; explicit for clarity
    "flag.taskcenter.widget": "on", // already on by default; explicit
    "flag.detail.timeline.live_rows": "on", // explicit — tracking surface
    "flag.detail.timeline.wayback_rows": "on", // historical context for comprehension
  },

  // ----- cleanup: action — remove worst offenders, re-enable some guardian hides (was "declutter")
  cleanup: {
    "flag.dashboard.risk_section": "on", // already on; declutter emphasises (component reads goals)
    "flag.dashboard.callout.declutter": "on", // declutter-specific callout
    "flag.dashboard.callout.understand_only": "off", // suppress the understand-only callout when declutter is also on
    "flag.dashboard.callout.understand_declutter": "on", // combined-goals callout (the 'hygiene' case)
    // Decluttering means deciding which apps to remove based on what
    // they collect. Showing the privacy-profile setup step in onboarding
    // gives the user a way to define their tolerances up-front, which
    // then drives the mismatch flags the dashboard surfaces. The HARD_DEFAULTS
    // comment for `flag.onboarding.privacy_profile_setup` has long
    // promised this rule lives under declutter — it does now.
    "flag.onboarding.privacy_profile_setup": "on", // see HARD_DEFAULTS comment
    "flag.appgrid.card.risk_pill": "on", // risk visibility front-and-centre
    "flag.appgrid.card.profile_badge": "on", // mismatch visibility for delete decisions
    "flag.appgrid.card.risk_chips": "on", // breakdown chips
    "flag.appgrid.filter.risk_buttons": "on", // filter to the worst offenders
    "flag.appgrid.filter.profile_mismatch": "on", // mismatch filter
    "flag.dashboard.profile_mismatch_section": "on", // re-enable when guardian hid it
    "flag.detail.labels.profile_mismatch_badges": "on", // on App Detail too
    "flag.detail.policy.ai_summary": "on", // helps justify a delete
    "flag.detail.policy.lens_grid": "on", // see WHY an app is risky
    // Re-enable surfaces guardian would otherwise hide (per §4 'moderate re-enable')
    "flag.page.compare": "on", // declutterers compare to pick winners
    "flag.detail.tabs.compare": "on", // compare tab back on
  },

  // ----- minimal: simplest surface — strict superset of guardian hides, plus more
  minimal: {
    // Mirror guardian's hide list (minimal applies after audience layer — explicit re-state for self/loved_one users picking minimal)
    "flag.global.keyboard_shortcuts": "off", // hide power-user nav
    "flag.global.info_tooltips": "off", // less chrome
    "flag.global.label_hints": "off", // less chrome
    "flag.global.about_modal": "off", // about dialog is non-essential
    "flag.global.live_text_modal": "off", // hide unless actively needed
    "flag.devopts.visible": "off", // dev opts hidden
    "flag.devopts.ai.debug_logging": "off",
    "flag.settings.ai.debug_logging": "off",
    "flag.settings.policies.wayback_import": "off",
    "flag.desktop.app_section": "off",
    "flag.page.compare": "off",
    "flag.page.privacy_map": "off",
    "flag.page.manual_apps": "off",
    "flag.page.stats": "off", // simpler than guardian — stats page off entirely
    "flag.page.shortlist": "off", // shortlist hidden too
    "flag.taskcenter.widget": "off",
    "flag.notifications.resume.enabled": "off",
    "flag.detail.policy.run_log_strip": "off",
    "flag.detail.policy.run_log_details": "off",
    "flag.detail.policy.chunk_notes": "off",
    "flag.detail.policy.fallback_references": "off", // less chrome on policy tab
    "flag.detail.policy.lens_grid": "off", // simpler policy presentation
    "flag.detail.policy.change_strip": "off",
    // Minimal-specific extras (beyond guardian)
    "flag.notifications.bell.polling": "off", // manual refresh only
    "flag.detail.timeline.wayback_rows": "off", // hide wayback by default
    "flag.detail.timeline.wayback_toggle": "off", // toggle hidden too
    "flag.detail.a11y.preference_highlights": "off", // teal borders considered chrome
    "flag.appgrid.card.profile_badge": "off", // hide mismatch visualisation
    "flag.appgrid.card.change_dot": "off", // no pulsing indicators
    "flag.appgrid.card.freshness_chip": "off", // no freshness chip
    "flag.appgrid.card.risk_chips": "off", // no breakdown chips
    "flag.dashboard.profile_mismatch_section": "off", // hide entire section
    "flag.detail.labels.profile_mismatch_badges": "off", // and the per-card badges
    "flag.dashboard.callout.declutter": "off", // hide all callouts
    "flag.dashboard.callout.guardian": "off",
    "flag.dashboard.callout.understand_declutter": "off",
    "flag.dashboard.callout.understand_only": "off",
    "flag.dashboard.activity_section": "off", // less context
    "flag.dashboard.glance_section": "off", // hide glance grid
    "flag.dashboard.risk_tier_legend": "off", // hide legend
    "flag.detail.charts.category_trend": "off", // no charts
    "flag.detail.charts.trend_presets": "off",
    "flag.detail.charts.trend_legend": "off",
    "flag.detail.timeline.review_rows": "off", // hide audit trail
    "flag.detail.timeline.review_snapshot_chips": "off",
    "flag.detail.timeline.trigger_pills": "off", // less metadata
    "flag.detail.timeline.version_chip": "off",
    "flag.detail.timeline.matches_live_sync_badge": "off",
    "flag.detail.annotations_sidebar": "off", // hidden under minimal
    "flag.dashboard.annotation_banner": "off", // ditto
    "flag.appgrid.card.annotation_highlight": "off", // ditto
    "flag.devopts.feature_flag_presets": "off", // simpler surface — no preset workflow
    "flag.appgrid.review_queue.enabled": "off", // simpler grid; bulk verdict UI hidden
    "flag.appgrid.review_queue.bulk_select": "off",
  },
};

// ============================================================================
// ACCESSIBILITY_RULES — modifier (combines with any primary goal)
// ============================================================================
//
// `goal.accessibility` wins LOCALLY when combined with `goal.minimal` —
// accessibility elevations override minimal's hides for these specific flags.

export const ACCESSIBILITY_RULES: Partial<Record<FlagKey, FlagValue>> = {
  "flag.detail.a11y.panel": "on", // expanded (was 'collapsed' by default)
  "flag.detail.a11y.preference_highlights": "on", // teal borders even under minimal
  "flag.appgrid.filter.accessibility": "on", // accessibility filter row visible
  "flag.onboarding.accessibility_profile_setup": "on", // auto-show onboarding a11y step
  "flag.notifications.types.accessibility_changes": "on", // turn on the a11y-changes notification type
  "flag.global.accessibility_toggles": "on", // floating quick-toggles panel (already on; explicit)
};

// ============================================================================
// FLAG_DEPENDENCIES — child auto-off when parent is off/collapsed
// ============================================================================
//
// If a parent resolves to anything other than 'on', the dependent flag is
// treated as 'off' regardless of its own resolution. User overrides on the
// dependent flag still win — the dependency only suppresses defaults.
// Cycles are forbidden; the registry checks at startup.

export const FLAG_DEPENDENCIES: Partial<Record<FlagKey, FlagKey>> = {
  // Timeline sub-flags depend on parent rows
  "flag.detail.timeline.wayback_toggle": "flag.detail.timeline.wayback_rows",
  "flag.detail.timeline.matches_live_sync_badge":
    "flag.detail.timeline.wayback_rows",
  "flag.detail.timeline.policy_diff_toggle": "flag.detail.timeline.live_rows",
  "flag.detail.timeline.policy_preview_toggle":
    "flag.detail.timeline.live_rows",
  "flag.detail.timeline.trigger_pills": "flag.detail.timeline.live_rows",
  "flag.detail.timeline.version_chip": "flag.detail.timeline.live_rows",
  "flag.detail.timeline.review_snapshot_chips":
    "flag.detail.timeline.review_rows",

  // Policy tab sub-flags depend on the panel
  "flag.detail.policy.rescrape_button": "flag.detail.policy.panel",
  "flag.detail.policy.summarise_button": "flag.detail.policy.panel",
  "flag.detail.policy.rescrape_summarise_button": "flag.detail.policy.panel",
  "flag.detail.policy.preview_toggle": "flag.detail.policy.panel",
  "flag.detail.policy.run_log_strip": "flag.detail.policy.panel",
  "flag.detail.policy.run_log_details": "flag.detail.policy.run_log_strip",
  "flag.detail.policy.fallback_references": "flag.detail.policy.panel",
  "flag.detail.policy.wayback_backup_link": "flag.detail.policy.panel",
  "flag.detail.policy.source_policy_link": "flag.detail.policy.panel",
  "flag.detail.policy.recent_change_banner": "flag.detail.policy.panel",
  "flag.detail.policy.whats_new": "flag.detail.policy.panel",
  // AI summary sub-flags chain off ai_summary
  "flag.detail.policy.ai_summary_disclaimer": "flag.detail.policy.ai_summary",
  "flag.detail.policy.highlights": "flag.detail.policy.ai_summary",
  "flag.detail.policy.lens_grid": "flag.detail.policy.ai_summary",
  "flag.detail.policy.safety_summary": "flag.detail.policy.ai_summary",
  "flag.detail.policy.change_strip": "flag.detail.policy.ai_summary",
  "flag.detail.policy.chunk_notes": "flag.detail.policy.ai_summary",

  // Guardian age-rating: the dashboard callout chains off the master
  "flag.dashboard.callout.age_rating": "flag.guardian.age_rating",

  // A11y panel sub-flags
  "flag.detail.a11y.preference_highlights": "flag.detail.a11y.panel",

  // Review panel sub-flags
  "flag.detail.review.mark_reviewed": "flag.detail.review.panel",
  "flag.detail.review.dismiss": "flag.detail.review.panel",
  "flag.detail.review.snooze_menu": "flag.detail.review.panel",

  // Task center sub-flags
  "flag.taskcenter.auto_dismiss": "flag.taskcenter.widget",
  "flag.taskcenter.resume_cards": "flag.taskcenter.widget",
  "flag.taskcenter.polling": "flag.taskcenter.widget",

  // Notification bell sub-flags
  "flag.notifications.bell.polling": "flag.notifications.bell",

  // Review queue sub-flags chain off the master
  "flag.appgrid.review_queue.bulk_select": "flag.appgrid.review_queue.enabled",
  "flag.appgrid.review_queue.cfgutil_uninstall":
    "flag.appgrid.review_queue.enabled",

  // Stats viz depend on the page
  "flag.stats.viz.heatmap": "flag.page.stats",
  "flag.stats.viz.timeline": "flag.page.stats",
  "flag.stats.viz.radar": "flag.page.stats",
  "flag.stats.viz.sankey": "flag.page.stats",
  "flag.stats.viz.small_multiples": "flag.page.stats",
  "flag.stats.viz.compare": "flag.page.stats",
  "flag.stats.viz.category_bars": "flag.page.stats",
  "flag.stats.viz.accessibility_bars": "flag.page.stats",
  "flag.stats.recent_changes.filter": "flag.page.stats",
  "flag.stats.off_profile_card": "flag.page.stats",

  // Shortlist actions depend on the page
  "flag.shortlist.actions.remove": "flag.page.shortlist",
  "flag.shortlist.actions.preview": "flag.page.shortlist",
  "flag.shortlist.actions.share": "flag.page.shortlist",
  "flag.shortlist.actions.export": "flag.page.shortlist",
  "flag.shortlist.actions.print": "flag.page.shortlist",
  "flag.shortlist.actions.reset": "flag.page.shortlist",
  "flag.shortlist.actions.undo": "flag.page.shortlist",
  "flag.shortlist.detailed_view": "flag.page.shortlist",
  "flag.shortlist.live_badge_prefetch": "flag.page.shortlist",
  "flag.shortlist.profile_mismatch_pill": "flag.page.shortlist",
  "flag.shortlist.installed_grouping": "flag.page.shortlist",

  // Onboarding sub-method flags depend on choose_method
  "flag.onboarding.method.manual_entry": "flag.onboarding.step.choose_method",
  "flag.onboarding.method.file_upload": "flag.onboarding.step.choose_method",
  "flag.onboarding.method.configurator": "flag.onboarding.step.choose_method",
  "flag.onboarding.method.screenshot_ocr": "flag.onboarding.step.choose_method",
  "flag.onboarding.method.live_text_help": "flag.onboarding.step.choose_method",
  "flag.onboarding.method.restore_backup": "flag.onboarding.step.choose_method",
  "flag.onboarding.method.import_audit_bundle":
    "flag.onboarding.step.choose_method",

  // Goals picker sub-options depend on the picker
  "flag.onboarding.goals_picker.skip": "flag.onboarding.goals_picker",
  "flag.onboarding.goals_picker.minimal_option": "flag.onboarding.goals_picker",
  "flag.onboarding.goals_picker.accessibility_modifier":
    "flag.onboarding.goals_picker",
  "flag.onboarding.audience_picker.skip": "flag.onboarding.audience_picker",

  // Confirm-step sub-toggle
  "flag.onboarding.confirm.hide_tracked_toggle":
    "flag.onboarding.step.confirm_matches",
  "flag.onboarding.import.rate_limit_handoff":
    "flag.onboarding.step.import_progress",
  "flag.onboarding.ai.summarize_on_import": "flag.onboarding.step.ai_summaries",
};

// ============================================================================
// TOUR_STEPS — goal-driven coachmark tour pool (react-joyride)
// ============================================================================
//
// Tour pulls from this pool on launch and includes only steps whose
// `includedWhen` predicate returns true for the user's current state. See
// https://privacytracker-docs.privacykey.org/develop/feature-flags.
//
// `i18nKey` resolves through next-intl with `{possessive}` interpolation so
// audience copy adapts ('your apps' / 'their apps' / 'your child's apps').

export interface TourStepDef {
  /** i18n key for the step body */
  i18nKey: string;
  id: string;
  /** Whether this step is included for the given state */
  includedWhen: (state: TourState) => boolean;
  /** CSS selector or react-joyride target */
  target: string;
}

export interface TourState {
  /** Whether the AI provider is configured (separate from `flag.settings.ai.enabled`) */
  aiConfigured: boolean;
  audience: Audience;
  goals: Set<PrimaryGoal | Modifier>;
}

const has = (state: TourState, goal: PrimaryGoal | Modifier) =>
  state.goals.has(goal);

export const TOUR_STEPS: TourStepDef[] = [
  {
    id: "task_list",
    target: '[data-tour="task-list"]',
    i18nKey: "tour.task_list",
    includedWhen: () => true, // tasks panel is the new entry point
  },
  {
    id: "focus_card",
    target: '[data-tour="focus-card"]',
    i18nKey: "tour.focus_card",
    includedWhen: () => true, // every audience sees this
  },
  {
    id: "app_card",
    target: '[data-tour="app-card-first"]',
    i18nKey: "tour.app_card",
    includedWhen: () => true, // every audience sees this
  },
  {
    id: "bell",
    target: '[data-tour="notification-bell"]',
    i18nKey: "tour.bell",
    includedWhen: (s) => has(s, "monitor"), // tracking surface
  },
  {
    id: "severity_pill",
    target: '[data-tour="severity-pill-first"]',
    i18nKey: "tour.severity_pill",
    includedWhen: (s) => has(s, "cleanup"), // declutter cares about risk
  },
  {
    id: "compare",
    target: '[data-tour="compare-button"]',
    i18nKey: "tour.compare",
    includedWhen: (s) => has(s, "cleanup"), // declutterers compare to pick winners
  },
  {
    id: "timeline",
    target: '[data-tour="timeline"]',
    i18nKey: "tour.timeline",
    includedWhen: (s) => has(s, "monitor"), // timeline = tracking
  },
  {
    id: "ai_summary",
    target: '[data-tour="ai-summary"]',
    i18nKey: "tour.ai_summary",
    includedWhen: (s) => has(s, "monitor") && s.aiConfigured, // only if user has an AI provider
  },
  {
    id: "a11y_filter",
    target: '[data-tour="accessibility-filter"]',
    i18nKey: "tour.a11y_filter",
    includedWhen: (s) => has(s, "accessibility"), // a11y modifier
  },
  {
    id: "resync",
    target: '[data-tour="resync-button"]',
    i18nKey: "tour.resync",
    includedWhen: () => true, // every audience sees this
  },
  {
    id: "export",
    target: '[data-tour="export-button"]',
    i18nKey: "tour.export",
    includedWhen: (s) => s.audience === "loved_one", // recommender-only step
  },
];

// ============================================================================
// Helpers (used by lib/feature-flags.ts in round 3)
// ============================================================================

/**
 * Compute the active goals as a Set, given the four focus boolean keys.
 * Caller is responsible for reading the keys from app_settings.
 */
export function activeGoalsFrom(input: {
  monitor: boolean;
  cleanup: boolean;
  minimal: boolean;
  accessibility: boolean;
}): Set<PrimaryGoal | Modifier> {
  const goals = new Set<PrimaryGoal | Modifier>();
  if (input.minimal) {
    goals.add("minimal"); // "Keep it minimal" — mutually exclusive with the goal tiles; caller validates
  } else {
    if (input.monitor) {
      goals.add("monitor");
    }
    if (input.cleanup) {
      goals.add("cleanup");
    }
    // No silent default: selecting no goal tiles is a valid empty state
    // (resolves to the hard-default baseline surface).
  }
  if (input.accessibility) {
    goals.add("accessibility");
  }
  return goals;
}
