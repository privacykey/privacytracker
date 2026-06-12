"use client";

import Image from "next/image";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { setDockBadge } from "../../lib/desktop";
import { useFlag } from "../../lib/feature-flags-hooks";
import {
  classifyNotificationType,
  DEFAULT_NOTIFICATION_PREFS,
  type NotificationPrefs,
  type NotificationTypeKey,
  resolvePrefs as resolveNotificationPrefs,
} from "../../lib/notification-prefs";

interface NotifEntry {
  app_id: string;
  app_name: string;
  change_summary: { type: string; description: string }[];
  created_at: number;
  iconUrl?: string;
  id: string;
  read: number;
  /**
   * Flipped to 1 when the import item that produced this notification has
   * since been rewired to a different App Store listing (see
   * `markNotificationsStaleForApp` in lib/notifications.ts). The bell still
   * shows the row but renders it faded + struck-through so the user can see
   * it refers to an app they no longer actively track through that import.
   */
  stale?: number;
}

// Synthetic app_id used by AI-timeout notifications — must stay in sync with
// AI_TIMEOUT_NOTIFICATION_APP_ID in lib/notifications.ts. Clicking a row with
// this id routes to the timeout settings instead of an app detail page.
const AI_TIMEOUT_NOTIFICATION_APP_ID = "__ai_timeout__";

// Synthetic app_id used by the "unmatched rows, consider manual apps" prompt
// fired after an import finishes — mirrors MANUAL_APPS_NOTIFICATION_APP_ID in
// lib/notifications.ts. Clicking lands the user on the manual-apps editor.
const MANUAL_APPS_NOTIFICATION_APP_ID = "__manual_apps__";

// Synthetic app_id used by the per-import completion notification — mirrors
// IMPORT_COMPLETION_NOTIFICATION_APP_ID in lib/notifications.ts. Clicking
// jumps to Settings → Import history so the user can inspect the run.
const IMPORT_COMPLETION_NOTIFICATION_APP_ID = "__import__";

// Synthetic app_ids for the three crash-safe bulk-job resume notifications,
// raised by `instrumentation.ts` after a server restart. They don't
// correspond to a real Apple track id, so the bell must route them to the
// matching Settings section — otherwise the default `/apps/<id>` path 404s.
// Must stay in sync with the *_RESUME_NOTIFICATION_APP_ID constants in
// lib/notifications.ts.
const WAYBACK_RESUME_NOTIFICATION_APP_ID = "__wayback_resume__";
const SYNC_RESUME_NOTIFICATION_APP_ID = "__sync_resume__";
const POLICY_RESUME_NOTIFICATION_APP_ID = "__policy_resume__";

// Shape of a resume notification's first change-summary entry. The bell
// reads only `type` + `description`, but typing it lets the renderer tell
// the "stuck lock cleared" variant apart from a normal resume without
// re-parsing the description string.
type ResumeEntryType =
  | "wayback_resumed"
  | "wayback_stale_cleared"
  | "sync_resumed"
  | "sync_stale_cleared"
  | "policy_resumed"
  | "policy_stale_cleared";

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) {
    return "just now";
  }
  if (s < 3600) {
    return `${Math.floor(s / 60)}m ago`;
  }
  if (s < 86_400) {
    return `${Math.floor(s / 3600)}h ago`;
  }
  return `${Math.floor(s / 86_400)}d ago`;
}

interface NotificationBellProps {
  /**
   * When false the 30-second poll is skipped and the bell is read-only
   * (the dropdown still works on click). Default true. Drives by
   * `flag.notifications.bell.polling`.
   */
  pollingEnabled?: boolean;
}

export default function NotificationBell({
  pollingEnabled = true,
}: NotificationBellProps = {}) {
  // i18n — bell dropdown chrome plus the per-row headline / subline
  // composers. Server-stored `change_summary[i].description` strings
  // remain English for now (they're persisted in the DB and the
  // composer would need locale-aware regeneration); but the
  // headline buckets and the "{N} changes detected" shells now
  // localise.
  const t = useTranslations("notifications");
  const tHeadlines = useTranslations("notifications.headlines");
  const tSublines = useTranslations("notifications.sublines");
  // Wave I: belt-and-braces gate at the bell itself. The Nav already
  // gates on `flag.nav.notification_bell`; this hook gates on
  // `flag.notifications.bell` so the bell vanishes consistently even if
  // a future caller drops it into a different surface that doesn't read
  // the nav-level flag.
  const bellOn = useFlag("flag.notifications.bell") === "on";

  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [notifs, setNotifs] = useState<NotifEntry[]>([]);
  // Fully-resolved prefs map so every known type has a concrete boolean.
  // Defaults to all-on until we hear back from /api/notification-prefs — a
  // brief flash of "everything visible" is harmless and far better than
  // briefly hiding a row the user has turned on.
  const [notificationPrefs, setNotificationPrefs] = useState<
    Record<NotificationTypeKey, boolean>
  >({ ...DEFAULT_NOTIFICATION_PREFS });
  const dropRef = useRef<HTMLDivElement>(null);
  const bellBtnRef = useRef<HTMLButtonElement>(null);

  const fetchNotifs = useCallback(async () => {
    const res = await fetch("/api/notifications");
    const d = await res.json();
    setUnread(d.unreadCount ?? 0);
    setNotifs(d.notifications ?? []);
  }, []);

  // Load the user's per-type prefs on mount. We don't poll this — the settings
  // page is the only place it changes and a full page nav through the nav bar
  // remounts this component, so there's no missed-update risk in practice.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/notification-prefs");
        if (!res.ok) {
          return;
        }
        const data = await res.json();
        if (cancelled) {
          return;
        }
        const resolved =
          data?.prefs && typeof data.prefs === "object"
            ? resolveNotificationPrefs(data.prefs as NotificationPrefs)
            : { ...DEFAULT_NOTIFICATION_PREFS };
        setNotificationPrefs(resolved);
      } catch (error) {
        console.warn("[NotificationBell] loadNotificationPrefs failed:", error);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Poll every 30s — gated by `flag.notifications.bell.polling`. When off,
  // the initial fetch still runs (the bell shouldn't be empty on load) but
  // subsequent updates require a manual refresh / page navigation.
  useEffect(() => {
    fetchNotifs();
    if (!pollingEnabled) {
      return;
    }
    const id = setInterval(fetchNotifs, 30_000);
    return () => clearInterval(id);
  }, [fetchNotifs, pollingEnabled]);

  // Imperative refresh handle — anyone in the layout can dispatch
  // `window.dispatchEvent(new CustomEvent('notifications:refresh'))` and
  // the bell will re-fetch immediately. Used by the menu-bar "Mark All
  // Notifications as Read" item so the badge clears without waiting
  // for the next 30s poll. Also picked up after any other server-side
  // change that should reflect in the bell quickly.
  useEffect(() => {
    const onRefresh = () => {
      void fetchNotifs();
    };
    window.addEventListener("notifications:refresh", onRefresh);
    return () => window.removeEventListener("notifications:refresh", onRefresh);
  }, [fetchNotifs]);

  // Close on outside click or Escape
  useEffect(() => {
    if (!open) {
      return;
    }
    // `pointerdown` (not `mousedown`) so iOS Safari's touch interactions
    // close the dropdown reliably. Same fix pattern applied across every
    // outside-click handler in the codebase — see `AppDetailView.tsx` for
    // the canonical comment.
    const handler = (e: PointerEvent) => {
      if (dropRef.current && !dropRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    // Escape returns focus to the bell so keyboard users aren't dropped
    // at the document body after the dropdown unmounts.
    const keyHandler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        bellBtnRef.current?.focus();
      }
    };
    document.addEventListener("pointerdown", handler);
    document.addEventListener("keydown", keyHandler);
    return () => {
      document.removeEventListener("pointerdown", handler);
      document.removeEventListener("keydown", keyHandler);
    };
  }, [open]);

  // Apply the user's per-type filter. The server still stores every type
  // (so flipping a toggle back on re-surfaces them), we just hide rows
  // whose classified type is muted. The unread badge follows the filtered
  // list — hidden rows don't count toward "look at me!" volume.
  const { visibleNotifs, visibleUnread, hiddenUnread } = useMemo(() => {
    let vUnread = 0;
    let hUnread = 0;
    const visible: NotifEntry[] = [];
    for (const n of notifs) {
      const typeKey = classifyNotificationType(n.change_summary ?? []);
      if (notificationPrefs[typeKey]) {
        visible.push(n);
        if (n.read === 0) {
          vUnread += 1;
        }
      } else if (n.read === 0) {
        hUnread += 1;
      }
    }
    return {
      visibleNotifs: visible,
      visibleUnread: vUnread,
      hiddenUnread: hUnread,
    };
  }, [notifs, notificationPrefs]);

  // Cmd-Z undo for the bell's auto-mark-as-read. Stash the ids that
  // were unread BEFORE the open call into a small ring; on undo we
  // POST {action:'mark_unread', ids:[…]} to flip just those rows back.
  // Only one op needed at a time — re-opening the bell without an
  // intervening write is idempotent (everything is already read), so
  // the natural user flow is "open → realise mistake → Cmd-Z → done".
  const undoUnreadIdsRef = useRef<string[] | null>(null);

  const toggleOpen = async () => {
    if (!open && unread > 0) {
      // Snapshot the ids that are about to be flipped to read, BEFORE
      // we issue the mark-all-read POST. We capture from the visible
      // notif state (post-prefs filter, unread-only) — that matches
      // the user's mental model of "what was bold in the bell when I
      // opened it" — but the undo POST will only re-unread those
      // exact ids server-side, leaving rows the user marked read via
      // any other path (per-app review, reset) alone.
      const unreadIdsForUndo = notifs
        .filter((n) => n.read === 0)
        .map((n) => n.id);
      undoUnreadIdsRef.current = unreadIdsForUndo;

      // Mark read and refresh. We mark EVERY notification as read, including
      // hidden ones — the user has acknowledged the bell by opening it, and
      // re-enabling a hidden type later shouldn't resurrect "unread" spam
      // from events that fired while they were muted. The rows remain in
      // the list either way, just no longer bolded.
      await fetch("/api/notifications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "mark_read" }),
      });
      setUnread(0);
      setNotifs((prev) => prev.map((n) => ({ ...n, read: 1 })));
      // Push the new count straight to the macOS Dock badge. Without
      // this, the Rust-side notifications watcher only re-polls every
      // 15s, so the badge would stay on its old value for up to ~10-15
      // seconds after the user has clearly cleared their unread queue.
      // No-op on the web build — `setDockBadge` returns early when
      // `window.__TAURI__` isn't present.
      void setDockBadge(0);
    }
    setOpen(!open);
  };

  // app:undo handler — flips the captured ids back to read=0.
  // Listener is mounted unconditionally; the effect short-circuits
  // when there's no stashed snapshot (the user opened the bell with
  // no unreads, or the ring's already been consumed).
  useEffect(() => {
    const handler = () => {
      const stashed = undoUnreadIdsRef.current;
      if (!stashed || stashed.length === 0) {
        return;
      }
      // Consume the ring — we only ever undo the most recent
      // open-the-bell-and-clear-unread action, never further back.
      undoUnreadIdsRef.current = null;
      void (async () => {
        try {
          const res = await fetch("/api/notifications", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "mark_unread", ids: stashed }),
          });
          if (!res.ok) {
            return;
          }
          // Re-fetch the bell list so the badge + row styling pick
          // up the restored unread state. Cheaper than mutating
          // local state per-id, and we also pick up any new rows
          // that landed since the bell was last read.
          const refreshed = await fetch("/api/notifications")
            .then((r) => r.json())
            .catch(() => null);
          if (refreshed) {
            setNotifs(refreshed.notifications ?? []);
            setUnread(refreshed.unreadCount ?? 0);
            void setDockBadge(refreshed.unreadCount ?? 0);
          }
        } catch (err) {
          // Best-effort. The bell will recover on its own poll cycle
          // (30s) if the undo POST loses its race with anything else.
          console.warn("[notif-bell] undo failed:", err);
        }
      })();
    };
    window.addEventListener("app:undo", handler);
    return () => window.removeEventListener("app:undo", handler);
  }, []);

  // Compose an accessible label — screen readers need the unread count
  // announced with the button name, not only rendered as a coloured chip.
  const ariaLabel =
    visibleUnread > 0
      ? t("aria_with_unread", { count: visibleUnread })
      : t("title_aria");

  if (!bellOn) {
    return null;
  }

  return (
    <div className="notif-bell-wrap" ref={dropRef}>
      <button
        aria-controls="notif-dropdown"
        aria-expanded={open}
        aria-label={ariaLabel}
        className="notif-bell-btn"
        onClick={toggleOpen}
        ref={bellBtnRef}
        type="button"
      >
        <span aria-hidden="true">🔔</span>
        {visibleUnread > 0 && (
          <span aria-hidden="true" className="notif-badge">
            {visibleUnread > 9 ? "9+" : visibleUnread}
          </span>
        )}
      </button>

      {open && (
        // role="region" (not menu/dialog): the dropdown is a plain disclosure
        // of links — no menuitem children, no arrow-key navigation, no focus
        // trap — so stronger popup semantics would promise AT behaviour we
        // don't implement. Trigger keeps aria-expanded + aria-controls.
        <div
          aria-label={t("title_aria")}
          className="notif-dropdown"
          id="notif-dropdown"
          role="region"
        >
          <div className="notif-dropdown-header">
            <span className="notif-dropdown-title">{t("title")}</span>
            {visibleNotifs.length > 0 && (
              <Link
                className="btn btn-ghost btn-sm"
                href="/dashboard/stats"
                style={{ fontSize: 12 }}
              >
                {t("view_all")} →
              </Link>
            )}
          </div>

          <div className="notif-list">
            {visibleNotifs.length === 0 ? (
              <div className="notif-empty">
                {notifs.length === 0 ? (
                  t("empty_no_changes")
                ) : (
                  <>
                    {t("empty_hidden_prefix")}
                    <br />
                    <Link
                      href="/dashboard/settings#notifications"
                      onClick={() => setOpen(false)}
                      style={{
                        fontSize: 12,
                        marginTop: 6,
                        display: "inline-block",
                      }}
                    >
                      {t("empty_hidden_link")}
                    </Link>
                  </>
                )}
              </div>
            ) : (
              visibleNotifs.map((n) => {
                const isTimeout =
                  n.app_id === AI_TIMEOUT_NOTIFICATION_APP_ID ||
                  n.change_summary[0]?.type === "ai_timeout";
                const isManualAppsPrompt =
                  n.app_id === MANUAL_APPS_NOTIFICATION_APP_ID ||
                  n.change_summary[0]?.type === "manual_apps_prompt";
                const isImportCompletion =
                  n.app_id === IMPORT_COMPLETION_NOTIFICATION_APP_ID ||
                  n.change_summary[0]?.type === "import_completed";
                // Crash-safe resume notifications — one synthetic id per
                // bulk runner (wayback, App Store sync, privacy-policy
                // sync). The first change_summary entry carries the
                // specific `*_resumed` / `*_stale_cleared` variant so the
                // headline can distinguish "resumed after restart" from
                // "cleared a stuck lock".
                const resumeType = n.change_summary[0]?.type as
                  | ResumeEntryType
                  | undefined;
                const isWaybackResume =
                  n.app_id === WAYBACK_RESUME_NOTIFICATION_APP_ID ||
                  resumeType === "wayback_resumed" ||
                  resumeType === "wayback_stale_cleared";
                const isSyncResume =
                  n.app_id === SYNC_RESUME_NOTIFICATION_APP_ID ||
                  resumeType === "sync_resumed" ||
                  resumeType === "sync_stale_cleared";
                const isPolicyResume =
                  n.app_id === POLICY_RESUME_NOTIFICATION_APP_ID ||
                  resumeType === "policy_resumed" ||
                  resumeType === "policy_stale_cleared";
                const isResume =
                  isWaybackResume || isSyncResume || isPolicyResume;
                const isStaleHeal =
                  resumeType === "wayback_stale_cleared" ||
                  resumeType === "sync_stale_cleared" ||
                  resumeType === "policy_stale_cleared";
                // Pull the activity-log status off the completion payload so
                // the bell icon + headline can signal whether it succeeded,
                // partially succeeded, or blew up entirely.
                const importStatus = isImportCompletion
                  ? (
                      n.change_summary[0] as
                        | { status?: "ok" | "partial" | "error" }
                        | undefined
                    )?.status
                  : undefined;
                const href = isTimeout
                  ? "/dashboard/settings#ai-timeouts"
                  : isManualAppsPrompt
                    ? // "Unmatched apps to review" lands on Import History with
                      // an auto-applied `?filter=unmatched` so the user sees
                      // only the rows that need their attention, not every row
                      // ever imported. Older comment lived here re: why this
                      // isn't /dashboard/manual-apps — see git blame if needed.
                      "/dashboard/settings/import-history?filter=unmatched"
                    : isImportCompletion
                      ? // Import-completion notifications pick a filter that
                        // matches the run's status: clean runs land on the
                        // unfiltered list so the user sees everything that
                        // imported; partial/error runs pre-apply a "problems"
                        // filter (unmatched + error) so attention-worthy rows
                        // are surfaced immediately.
                        importStatus === "ok"
                        ? "/dashboard/settings/import-history"
                        : "/dashboard/settings/import-history?filter=problems"
                      : // Resume notifications deep-link to the Settings
                        // section that owns the live progress card for that
                        // runner, so the user lands directly on the status
                        // they're being told about. Anchors must match the
                        // section `id`s in SettingsView.tsx — without this,
                        // the default `/apps/<synthetic-id>` path 404s.
                        isWaybackResume
                        ? "/dashboard/settings#wayback-import"
                        : isSyncResume
                          ? "/dashboard/settings#sync-status"
                          : isPolicyResume
                            ? "/dashboard/settings#privacy-policies-bulk"
                            : // Profile-mismatch entries land on the
                              // privacy-types section of the app detail
                              // page (the section that visualises which
                              // categories exceed the user's profile).
                              // The hash drives a one-shot blue pulse so
                              // the user can find the relevant block at a
                              // glance — see AppDetailView's hash-pulse
                              // useEffect. Other change types still
                              // route to #what-changed (the timeline).
                              n.change_summary?.[0]?.type === "profile_mismatch"
                              ? `/apps/${n.app_id}#profile-mismatch`
                              : `/apps/${n.app_id}#what-changed`;
                const headline = isTimeout
                  ? tHeadlines("ai_timeout")
                  : isManualAppsPrompt
                    ? tHeadlines("unmatched_apps")
                    : isImportCompletion
                      ? importStatus === "ok"
                        ? tHeadlines("import_finished")
                        : importStatus === "partial"
                          ? tHeadlines("import_partially_finished")
                          : tHeadlines("import_needs_attention")
                      : isWaybackResume
                        ? isStaleHeal
                          ? tHeadlines("wayback_lock_cleared")
                          : tHeadlines("wayback_resumed")
                        : isSyncResume
                          ? isStaleHeal
                            ? tHeadlines("sync_lock_cleared")
                            : tHeadlines("sync_resumed")
                          : isPolicyResume
                            ? isStaleHeal
                              ? tHeadlines("policy_lock_cleared")
                              : tHeadlines("policy_resumed")
                            : n.app_name;
                const subline = isTimeout
                  ? (() => {
                      // Prefer the structured-data path when the notification
                      // carries phase + timeout + observed, so zh users see a
                      // localised sentence rather than the English `description`
                      // baked into the row at insert time. Old rows pre-dating
                      // the refactor still fall back to the stored description,
                      // then to the generic default.
                      const evt = n.change_summary[0] as
                        | {
                            phase?: string;
                            timeoutMs?: number;
                            observedMs?: number;
                            modelLabel?: string;
                            description?: string;
                          }
                        | undefined;
                      if (
                        evt?.phase &&
                        typeof evt.timeoutMs === "number" &&
                        typeof evt.observedMs === "number"
                      ) {
                        const budget = Math.max(
                          1,
                          Math.round(evt.timeoutMs / 1000)
                        );
                        const observed = Math.max(
                          0,
                          Math.round(evt.observedMs / 1000)
                        );
                        if (evt.modelLabel) {
                          return tSublines("ai_timeout_with_data_and_model", {
                            phase: evt.phase,
                            observed,
                            budget,
                            model: evt.modelLabel,
                          });
                        }
                        return tSublines("ai_timeout_with_data", {
                          phase: evt.phase,
                          observed,
                          budget,
                        });
                      }
                      return (
                        evt?.description ?? tSublines("ai_timeout_default")
                      );
                    })()
                  : isManualAppsPrompt
                    ? (() => {
                        // Same structured-data path as ai_timeout above.
                        // The notification row carries `unmatchedCount` and
                        // optionally `sourceLabel` (set by createManualAppsPrompt
                        // -Notification); newer bells use those for a localised
                        // template, older rows fall back to the English
                        // description, then to the generic localised default.
                        const evt = n.change_summary[0] as
                          | {
                              unmatchedCount?: number;
                              sourceLabel?: string | null;
                              description?: string;
                            }
                          | undefined;
                        if (typeof evt?.unmatchedCount === "number") {
                          if (evt.sourceLabel) {
                            return tSublines("manual_apps_prompt_with_source", {
                              count: evt.unmatchedCount,
                              source: evt.sourceLabel,
                            });
                          }
                          return tSublines("manual_apps_prompt_with_data", {
                            count: evt.unmatchedCount,
                          });
                        }
                        return (
                          evt?.description ??
                          tSublines("manual_apps_prompt_default")
                        );
                      })()
                    : isImportCompletion
                      ? (() => {
                          // Three import outcomes × optional source-label.
                          // The notification row carries the structured
                          // counts; the bell composes "{imported} of {total}
                          // from {source}" / partial / error templates from
                          // them. Old rows fall back to the stored
                          // description, then to the generic default.
                          const evt = n.change_summary[0] as
                            | {
                                status?: "ok" | "partial" | "error";
                                total?: number;
                                imported?: number;
                                errored?: number;
                                queued?: number;
                                unmatched?: number;
                                itemCount?: number;
                                sourceLabel?: string | null;
                                description?: string;
                              }
                            | undefined;
                          if (
                            evt &&
                            typeof evt.total === "number" &&
                            typeof evt.imported === "number"
                          ) {
                            const sep = tSublines("import_separator");
                            if (evt.status === "ok") {
                              return evt.sourceLabel
                                ? tSublines("import_ok_with_source", {
                                    imported: evt.imported,
                                    total: evt.total,
                                    source: evt.sourceLabel,
                                  })
                                : tSublines("import_ok", {
                                    imported: evt.imported,
                                    total: evt.total,
                                  });
                            }
                            if (evt.status === "partial") {
                              const main = evt.sourceLabel
                                ? tSublines("import_partial_main_with_source", {
                                    imported: evt.imported,
                                    total: evt.total,
                                    source: evt.sourceLabel,
                                  })
                                : tSublines("import_partial_main", {
                                    imported: evt.imported,
                                    total: evt.total,
                                  });
                              const tail: string[] = [];
                              if ((evt.queued ?? 0) > 0) {
                                tail.push(
                                  tSublines("import_partial_queued", {
                                    count: evt.queued!,
                                  })
                                );
                              }
                              if ((evt.errored ?? 0) > 0) {
                                tail.push(
                                  tSublines("import_partial_failed", {
                                    count: evt.errored!,
                                  })
                                );
                              }
                              if ((evt.unmatched ?? 0) > 0) {
                                tail.push(
                                  tSublines("import_partial_unmatched", {
                                    count: evt.unmatched!,
                                  })
                                );
                              }
                              return tail.length > 0
                                ? `${main}${sep}${tail.join(", ")}`
                                : main;
                            }
                            // status === 'error'
                            if (
                              (evt.total ?? 0) > 0 &&
                              (evt.itemCount ?? 0) === 0
                            ) {
                              return evt.sourceLabel
                                ? tSublines(
                                    "import_error_no_apps_with_source",
                                    { source: evt.sourceLabel }
                                  )
                                : tSublines("import_error_no_apps");
                            }
                            return evt.sourceLabel
                              ? tSublines(
                                  "import_error_with_counts_and_source",
                                  {
                                    total: evt.total,
                                    errored: evt.errored ?? 0,
                                    queued: evt.queued ?? 0,
                                    source: evt.sourceLabel,
                                  }
                                )
                              : tSublines("import_error_with_counts", {
                                  total: evt.total,
                                  errored: evt.errored ?? 0,
                                  queued: evt.queued ?? 0,
                                });
                          }
                          return (
                            evt?.description ??
                            tSublines("import_completed_default")
                          );
                        })()
                      : isResume
                        ? (() => {
                            // Three resume kinds × stale-heal vs in-flight.
                            // Each carries `appsRemaining` + `totalApps` from
                            // lib/notifications.ts; bells route on the resume
                            // type tag to pick the right template.
                            const evt = n.change_summary[0] as
                              | {
                                  appsRemaining?: number;
                                  totalApps?: number;
                                  description?: string;
                                }
                              | undefined;
                            if (isStaleHeal) {
                              if (isWaybackResume) {
                                return tSublines("wayback_stale_cleared");
                              }
                              if (isSyncResume) {
                                return tSublines("sync_stale_cleared");
                              }
                              if (isPolicyResume) {
                                return tSublines("policy_stale_cleared");
                              }
                            } else if (
                              typeof evt?.appsRemaining === "number" &&
                              typeof evt?.totalApps === "number"
                            ) {
                              const args = {
                                remaining: evt.appsRemaining,
                                total: evt.totalApps,
                              };
                              if (isWaybackResume) {
                                return tSublines(
                                  "wayback_resumed_with_data",
                                  args
                                );
                              }
                              if (isSyncResume) {
                                return tSublines(
                                  "sync_resumed_with_data",
                                  args
                                );
                              }
                              if (isPolicyResume) {
                                return tSublines(
                                  "policy_resumed_with_data",
                                  args
                                );
                              }
                            }
                            return (
                              evt?.description ?? tSublines("resume_default")
                            );
                          })()
                        : n.change_summary[0]
                          ? tSublines("n_changes_with_first", {
                              count: n.change_summary.length,
                              first: n.change_summary[0].description,
                            })
                          : tSublines("n_changes", {
                              count: n.change_summary.length,
                            });
                // Preserve scroll when hopping between app-detail pages from
                // a notification — the layouts match, so snapping to the top
                // of the new page is jarring. AppDetailView's own useEffect
                // still handles the `#what-changed` hash manually via
                // scrollIntoView, so deep-links keep working.
                const preserveScroll = href.startsWith("/apps/");
                const isStale = n.stale === 1;
                // Stale rows point at an app the user no longer tracks via
                // the import row that originated the notification. The app
                // may still exist (it could be attached to a different
                // import), but routing to /apps/<id> is semantically odd —
                // the user expected to see the app this import now points
                // at. We neutralise the click for stale rows so it just
                // closes the panel without navigating.
                const linkHref =
                  isStale && href.startsWith("/apps/") ? "#" : href;
                return (
                  <Link
                    aria-disabled={
                      isStale && linkHref === "#" ? true : undefined
                    }
                    className={`notif-item ${n.read === 0 ? "unread" : ""}${isStale ? " is-stale" : ""}`}
                    href={linkHref}
                    key={n.id}
                    onClick={() => setOpen(false)}
                    scroll={!preserveScroll}
                  >
                    {isTimeout ? (
                      <div
                        aria-hidden="true"
                        className="notif-icon-placeholder"
                      >
                        ⏱
                      </div>
                    ) : isManualAppsPrompt ? (
                      <div
                        aria-hidden="true"
                        className="notif-icon-placeholder"
                      >
                        🔖
                      </div>
                    ) : isImportCompletion ? (
                      <div
                        aria-hidden="true"
                        className="notif-icon-placeholder"
                      >
                        {importStatus === "ok"
                          ? "✓"
                          : importStatus === "partial"
                            ? "⚠"
                            : "⚠"}
                      </div>
                    ) : isResume ? (
                      // A resume is a background-continuation signal — use
                      // the refresh glyph for the normal "picked up where
                      // we left off" case and a warning for the stale-heal
                      // (stuck lock) branch so the two read differently
                      // at a glance.
                      <div
                        aria-hidden="true"
                        className="notif-icon-placeholder"
                      >
                        {isStaleHeal ? "⚠" : "↻"}
                      </div>
                    ) : n.iconUrl ? (
                      <Image
                        alt={n.app_name}
                        className="notif-icon"
                        height={32}
                        src={n.iconUrl}
                        unoptimized
                        width={32}
                      />
                    ) : (
                      <div className="notif-icon-placeholder">
                        {n.app_name[0]}
                      </div>
                    )}
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="notif-app-name">
                        {headline}
                        {isStale && (
                          <span
                            className="notif-stale-tag"
                            title={t("stale_app_title")}
                          >
                            stale
                          </span>
                        )}
                      </div>
                      <div className="notif-change-text">{subline}</div>
                      <div className="notif-time">{timeAgo(n.created_at)}</div>
                    </div>
                  </Link>
                );
              })
            )}
          </div>

          {/* Footer hint: when the user has muted one or more notification
              types, some rows are hidden. Surface a quiet reminder with a
              deep-link to the Settings section so they can tweak prefs
              without hunting through the sidebar. */}
          {visibleNotifs.length > 0 && hiddenUnread > 0 && (
            <div className="notif-dropdown-footer">
              {hiddenUnread} unread hidden by your preferences &middot;{" "}
              <Link
                href="/dashboard/settings#notifications"
                onClick={() => setOpen(false)}
              >
                Adjust
              </Link>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
