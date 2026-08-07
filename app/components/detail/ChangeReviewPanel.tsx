"use client";

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import type {
  ChangeEntry,
  ReviewAction,
  SnoozeDays,
  UnacknowledgedChangeEvent,
  UnacknowledgedChanges,
} from "../../../lib/changelog-types";
import { SNOOZE_DAYS_OPTIONS } from "../../../lib/changelog-types";
import { CATEGORY_META, SEVERITY_CONFIG } from "../../../lib/privacy-meta";
import type { App } from "./types";

// ── Change Review Panel ───────────────────────────────────────────────
//
// Surfaces the most recent unacknowledged sync events. Lets the user
// mark them reviewed which clears the change dot on the app card AND
// any related notifications, turning the bell into an inbox instead
// of a permanent red signal.

interface ChangeClassification {
  categoryIcon?: string;
  categoryLabel?: string;
  severity: "track" | "linked" | "unlinked" | "none";
  severityLabel: string;
}

// Map a raw ChangeEntry description back to its severity class via the
// privacy type title (the description starts with the type title in quotes,
// e.g. `"Data Used to Track You" now collects: Contact Info`). This lets
// us colour each change by how sensitive the data category is.
function classifyChange(entry: ChangeEntry): ChangeClassification {
  const description = entry.description;
  let severity: ChangeClassification["severity"] = "none";
  let severityLabel = "";

  for (const key of Object.keys(SEVERITY_CONFIG)) {
    const meta = SEVERITY_CONFIG[key];
    if (description.includes(meta.label)) {
      severity =
        key === "DATA_USED_TO_TRACK_YOU"
          ? "track"
          : key === "DATA_LINKED_TO_YOU"
            ? "linked"
            : "unlinked";
      severityLabel = meta.label;
      break;
    }
  }

  // Try to extract the category label from "... now collects: Foo" or
  // "... no longer collects: Foo" so we can add its icon.
  const catMatch = description.match(/collects?: (.+)$/);
  let categoryLabel: string | undefined;
  let categoryIcon: string | undefined;
  if (catMatch) {
    const name = catMatch[1].trim();
    categoryLabel = name;
    for (const meta of Object.values(CATEGORY_META)) {
      if (meta.label.toLowerCase() === name.toLowerCase()) {
        categoryIcon = meta.icon;
        break;
      }
    }
  }

  return { severity, severityLabel, categoryLabel, categoryIcon };
}

/**
 * Format a change-review event timestamp. Deterministic by design: every
 * field is built by hand rather than going through `Intl.DateTimeFormat`,
 * so the string is byte-for-byte identical between the Node server (using
 * its bundled ICU) and the WebKit/Chromium client (using the system ICU).
 *
 * The previous implementation used `Intl.DateTimeFormat('en-AU', { day:
 * 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute:
 * '2-digit' })` and produced "8 May 2026, 02:44 pm" on Node 24 but
 * "8 May 2026 at 02:44 pm" on recent WebKit — same options, different
 * CLDR/ICU data. React's hydration step then bailed with
 *   "Hydration failed because the server rendered text didn't match
 *    the client. … 8 May 2026 at 02:44 pm vs 8 May 2026, 02:44 pm"
 * and re-rendered the whole subtree on the client, which is wasted
 * work + a console error.
 *
 * We keep the visual layout the previous output had on Node (day, short
 * month, year, two-digit 12-hour clock with am/pm) and ship the literal
 * separator chars as a constant in this file. Loss of i18n flexibility
 * is a non-issue: the original call was hardcoded to 'en-AU' anyway.
 */
const SHORT_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

function formatEventDate(ts: number) {
  const d = new Date(ts);
  const day = d.getDate();
  const month = SHORT_MONTHS[d.getMonth()];
  const year = d.getFullYear();
  const hours24 = d.getHours();
  const ampm = hours24 >= 12 ? "pm" : "am";
  // 12-hour clock with explicit zero-padding so 02:44 pm doesn't flip to
  // " 2:44 pm" depending on the runtime's whitespace handling.
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12;
  const hh = hours12.toString().padStart(2, "0");
  const mm = d.getMinutes().toString().padStart(2, "0");
  return `${day} ${month} ${year}, ${hh}:${mm} ${ampm}`;
}

/**
 * i18n keys (under `app_detail.change_review.snooze_options`) for the snooze
 * menu's preset labels. Mirrors `SNOOZE_DAYS_OPTIONS` in `lib/changelog.ts` —
 * kept as a parallel map rather than computing from the tuple so we can
 * phrase each option in natural language ("1 day", "1 week", "1 month")
 * instead of "N days".
 */
const SNOOZE_LABEL_KEYS: Record<SnoozeDays, string> = {
  1: "one_day",
  7: "one_week",
  30: "one_month",
};

function formatSnoozeDate(ts: number) {
  return new Intl.DateTimeFormat("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(ts));
}

export default function ChangeReviewPanel({
  app,
  unacknowledged,
  onAcknowledged,
  onSnoozed,
  onUnsnoozed,
  onRefreshHistory,
  onShowToast,
  onViewChange,
  showMarkReviewed = true,
  showDismiss = true,
  showSnoozeMenu = true,
  showSnoozedPanel = true,
}: {
  app: App;
  unacknowledged: UnacknowledgedChanges;
  onAcknowledged: () => void;
  onSnoozed: (until: number) => void;
  onUnsnoozed: () => void;
  onRefreshHistory: () => void;
  onShowToast: (msg: string) => void;
  /**
   * Fired when the user clicks "View policy change →" on a
   * privacy-policy entry. Parent flips its tab state to 'changelog'
   * so the diff button on the timeline row can reveal the full text.
   */
  onViewChange?: () => void;
  /**
   * Wave I — per-action gates. Each button stays in the layout when its
   * flag resolves on; flipping any of them off removes only that button
   * without disturbing the panel's other affordances. Defaults preserve
   * the legacy "all visible" behaviour for unflagged callers.
   */
  showMarkReviewed?: boolean;
  showDismiss?: boolean;
  showSnoozeMenu?: boolean;
  /**
   * Wave I — `flag.detail.review.snoozed_panel`. When false, a snoozed
   * panel renders nothing (rather than the "reminders snoozed" header),
   * matching the focus that hides snooze affordances entirely.
   */
  showSnoozedPanel?: boolean;
}) {
  // i18n — `change_review` namespace covers the snooze aria-label and any
  // other change-review-panel chrome that gets extracted in subsequent
  // passes. Captured at the top to satisfy hooks rules.
  const tDetail = useTranslations("app_detail");
  // `busy` is the single in-flight action — buttons disable as a group so we
  // don't end up with racing requests (e.g. Mark-reviewed fired twice because
  // the first POST hadn't landed yet).
  const [busy, setBusy] = useState<
    null | "reviewed" | "dismissed" | "snoozed" | "unsnoozed"
  >(null);
  const [snoozeMenuOpen, setSnoozeMenuOpen] = useState(false);

  // ── Cmd+Z undo for change-review actions ────────────────────────────
  // Each successful POST to /api/apps/<id>/acknowledge stashes the
  // returned action id + the apps-row pre-state snapshot in this
  // bounded stack. KeyboardShortcuts.tsx dispatches an `app:undo`
  // window event when the user hits Cmd/Ctrl+Z outside of a text
  // input; we listen for it while the panel is mounted and replay the
  // most-recent op via /api/apps/<id>/acknowledge/undo. Matches the
  // pattern in ShortlistView so a future undo-store refactor can fold
  // both surfaces into one helper without reshaping the UX.
  interface ReviewUndoOp {
    actionId: string;
    actionLabel: ReviewAction;
    preState: {
      changeCount: number;
      changesAcknowledgedAt: number;
      changesSnoozedUntil: number;
    };
  }
  const MAX_UNDO_OPS = 20;
  const [undoStack, setUndoStack] = useState<ReviewUndoOp[]>([]);

  const pushReviewUndo = useCallback((op: ReviewUndoOp) => {
    setUndoStack((prev) => {
      const next = [...prev, op];
      if (next.length > MAX_UNDO_OPS) {
        next.shift();
      }
      return next;
    });
  }, []);

  const handleReviewUndo = useCallback(async () => {
    const target = undoStack.at(-1);
    if (!target) {
      return;
    }
    setUndoStack((prev) => prev.slice(0, -1));
    try {
      const res = await fetch(`/api/apps/${app.id}/acknowledge/undo`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          actionId: target.actionId,
          preState: target.preState,
        }),
      });
      // 410 = the row's already gone (double-Cmd-Z, or another tab beat
      // us to it). Drop the op silently and tell the user nothing was
      // restored, rather than spamming an error toast.
      if (res.status === 410) {
        onShowToast(tDetail("toasts.review_undo_nothing"));
        return;
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const toastKeyMap: Record<ReviewAction, string> = {
        reviewed: "toasts.review_undo_reviewed",
        dismissed: "toasts.review_undo_dismissed",
        snoozed: "toasts.review_undo_snoozed",
        unsnoozed: "toasts.review_undo_unsnoozed",
      };
      onShowToast(tDetail(toastKeyMap[target.actionLabel]));
      // Tell the parent to refetch so the panel state realigns with the
      // restored db row. onAcknowledged is the wrong callback to fire
      // here (it would clear the unack state on the parent again);
      // onRefreshHistory is the lighter-weight refetch that pulls the
      // changelog timeline + unacknowledged changes together.
      onRefreshHistory();
    } catch (error) {
      console.error("[app-detail] review undo failed:", error);
      onShowToast(tDetail("toasts.review_undo_failed"));
    }
  }, [app.id, onRefreshHistory, onShowToast, undoStack]);

  // Listen at the window level. The KeyboardShortcuts component owns
  // the actual key handling and only dispatches `app:undo` outside of
  // text-input fields, so this listener won't interfere with native
  // undo in textareas or input boxes elsewhere on the page.
  useEffect(() => {
    const handler = () => {
      void handleReviewUndo();
    };
    window.addEventListener("app:undo", handler);
    return () => window.removeEventListener("app:undo", handler);
  }, [handleReviewUndo]);

  const postAction = async (
    action: ReviewAction,
    options: { snoozeDays?: SnoozeDays } = {}
  ): Promise<{ ok: boolean; snoozeUntil?: number | null }> => {
    setBusy(action);
    try {
      const res = await fetch(`/api/apps/${app.id}/acknowledge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, snoozeDays: options.snoozeDays }),
      });
      if (!res.ok) {
        const detail = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        throw new Error(detail?.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json().catch(() => null)) as {
        ok: boolean;
        record?: {
          id?: string;
          snooze_until: number | null;
          pre_state?: {
            changeCount: number;
            changesAcknowledgedAt: number;
            changesSnoozedUntil: number;
          };
        };
      } | null;
      // Stash the undo op only when we have BOTH the action's row id
      // and the pre-state snapshot. Either missing means the response
      // shape regressed (defensive) — log once and skip pushing rather
      // than queueing a half-formed op that would 400 on undo.
      if (data?.record?.id && data.record.pre_state) {
        pushReviewUndo({
          actionId: data.record.id,
          actionLabel: action,
          preState: data.record.pre_state,
        });
      }
      return { ok: true, snoozeUntil: data?.record?.snooze_until ?? null };
    } catch (error) {
      console.error(`[app-detail] ${action} failed:`, error);
      onShowToast(tDetail("toasts.review_action_failed", { action }));
      return { ok: false };
    } finally {
      setBusy(null);
    }
  };

  const handleReviewed = async () => {
    const result = await postAction("reviewed");
    if (result.ok) {
      onShowToast(tDetail("toasts.review_marked_reviewed"));
      onAcknowledged();
      onRefreshHistory();
    }
  };

  const handleDismiss = async () => {
    const result = await postAction("dismissed");
    if (result.ok) {
      onShowToast(tDetail("toasts.review_dismissed"));
      onAcknowledged();
      onRefreshHistory();
    }
  };

  const handleSnooze = async (days: SnoozeDays) => {
    setSnoozeMenuOpen(false);
    const result = await postAction("snoozed", { snoozeDays: days });
    if (result.ok && result.snoozeUntil) {
      onShowToast(
        tDetail("toasts.review_snoozed", {
          duration: tDetail(
            `change_review.snooze_options.${SNOOZE_LABEL_KEYS[days]}`
          ),
        })
      );
      onSnoozed(result.snoozeUntil);
      onRefreshHistory();
    }
  };

  const handleUnsnooze = async () => {
    const result = await postAction("unsnoozed");
    if (result.ok) {
      onShowToast(tDetail("toasts.review_unsnoozed"));
      onUnsnoozed();
      onRefreshHistory();
    }
  };

  const { totalCount, addedCount, removedCount, events, since, snoozedUntil } =
    unacknowledged;
  const isSnoozed = snoozedUntil > Date.now();

  // Collapsed state — reminders are snoozed. Still show the count so the user
  // knows what they deferred, plus a quick "Resume now" button.
  if (isSnoozed) {
    if (!showSnoozedPanel) {
      return null;
    }
    return (
      <section
        className="change-review-panel change-review-panel-snoozed"
        id="what-changed"
      >
        <div className="change-review-header">
          <div className="change-review-header-text">
            <div className="change-review-kicker">
              {tDetail("snoozed_kicker")}
            </div>
            <h2 className="change-review-title">
              {tDetail("snoozed_resume", {
                count: totalCount,
                date: formatSnoozeDate(snoozedUntil),
              })}
            </h2>
            <p className="change-review-sub">{tDetail("snoozed_sub")}</p>
          </div>
          <button
            className="btn btn-secondary change-review-ack-btn"
            disabled={busy !== null}
            onClick={handleUnsnooze}
            type="button"
          >
            {busy === "unsnoozed" ? (
              <>
                <span className="spinner-sm" /> {tDetail("snoozed_resuming")}
              </>
            ) : (
              tDetail("snoozed_resume_now")
            )}
          </button>
        </div>
      </section>
    );
  }

  const addedLabel =
    addedCount > 0 ? tDetail("review_added_label", { count: addedCount }) : "";
  const removedLabel =
    removedCount > 0
      ? tDetail("review_removed_label", { count: removedCount })
      : "";
  const countBlurb = [addedLabel, removedLabel].filter(Boolean).join(" · ");

  return (
    <section className="change-review-panel" id="what-changed">
      <div className="change-review-header">
        <div className="change-review-header-text">
          <div className="change-review-kicker">{tDetail("review_kicker")}</div>
          <h2 className="change-review-title">
            {tDetail("review_count", { count: totalCount })}
            {countBlurb && (
              <span className="change-review-count-blurb">
                {tDetail("review_count_blurb", { parts: countBlurb })}
              </span>
            )}
          </h2>
          <p className="change-review-sub">
            {since > 0
              ? tDetail("review_sub_with_since", {
                  events: events.length,
                  date: formatEventDate(since),
                })
              : tDetail("review_sub_no_since", { events: events.length })}
          </p>
        </div>
        <div
          className="change-review-actions"
          style={{
            display: "flex",
            gap: 8,
            flexWrap: "wrap",
            alignItems: "center",
            position: "relative",
          }}
        >
          {showMarkReviewed && (
            <button
              className="btn btn-primary change-review-ack-btn"
              disabled={busy !== null}
              onClick={handleReviewed}
              type="button"
            >
              {busy === "reviewed" ? (
                <>
                  <span className="spinner-sm" /> {tDetail("review_marking")}
                </>
              ) : (
                tDetail("review_mark_done")
              )}
            </button>
          )}
          {showDismiss && (
            <button
              className="btn btn-secondary"
              disabled={busy !== null}
              onClick={handleDismiss}
              title={tDetail("tooltips.clear_badge_no_review")}
              type="button"
            >
              {busy === "dismissed" ? (
                <>
                  <span className="spinner-sm" /> {tDetail("review_dismissing")}
                </>
              ) : (
                tDetail("review_dismiss")
              )}
            </button>
          )}
          {showSnoozeMenu && (
            <div className="snooze-menu-wrap">
              <button
                aria-expanded={snoozeMenuOpen}
                aria-haspopup="menu"
                className="btn btn-secondary"
                disabled={busy !== null}
                onClick={() => setSnoozeMenuOpen((open) => !open)}
                type="button"
              >
                {busy === "snoozed" ? (
                  <>
                    <span className="spinner-sm" /> {tDetail("review_snoozing")}
                  </>
                ) : (
                  tDetail("review_remind_later")
                )}
              </button>
              {snoozeMenuOpen && (
                <div
                  aria-label={tDetail("change_review.snooze_aria")}
                  className="snooze-menu"
                  onMouseLeave={() => setSnoozeMenuOpen(false)}
                  role="menu"
                >
                  {SNOOZE_DAYS_OPTIONS.map((days) => (
                    <button
                      className="snooze-menu-item"
                      key={days}
                      onClick={() => handleSnooze(days)}
                      role="menuitem"
                      type="button"
                    >
                      {tDetail(
                        `change_review.snooze_options.${SNOOZE_LABEL_KEYS[days]}`
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="change-review-events">
        {events.map((event) => (
          <ChangeReviewEvent
            event={event}
            key={event.id}
            onViewChange={onViewChange}
          />
        ))}
      </div>
    </section>
  );
}

/**
 * Map the `classifyChange` severity class back to the `severity.*` locale
 * namespace key, so the chip renders the localised label while the English
 * `SEVERITY_CONFIG.label` stays the matcher for the (English) server-side
 * change descriptions.
 */
const SEVERITY_I18N_KEY: Record<
  Exclude<ChangeClassification["severity"], "none">,
  string
> = {
  track: "data_used_to_track_you",
  linked: "data_linked_to_you",
  unlinked: "data_not_linked_to_you",
};

function ChangeReviewEvent({
  event,
  onViewChange,
}: {
  event: UnacknowledgedChangeEvent;
  onViewChange?: () => void;
}) {
  const tDetail = useTranslations("app_detail");
  const tSeverity = useTranslations("severity");
  return (
    <div className="change-review-event">
      <div className="change-review-event-date">
        {formatEventDate(event.scraped_at)}
      </div>
      <ul className="change-review-list">
        {event.changes.map((entry, idx) => {
          const cls = classifyChange(entry);
          const isPolicyChange = entry.category === "privacy-policy";
          return (
            <li
              className={`change-review-item change-review-item-${entry.type} change-review-sev-${cls.severity}`}
              key={idx}
            >
              <span aria-hidden="true" className="change-review-icon">
                {entry.type === "added"
                  ? "＋"
                  : entry.type === "removed"
                    ? "−"
                    : "~"}
              </span>
              <div className="change-review-body">
                <div className="change-review-desc">
                  {cls.categoryIcon && (
                    <span className="change-review-cat-icon">
                      {cls.categoryIcon}
                    </span>
                  )}
                  {entry.description}
                </div>
                {cls.severityLabel && (
                  <span
                    className={`change-review-sev-chip change-review-sev-chip-${cls.severity}`}
                  >
                    {cls.severity === "none"
                      ? cls.severityLabel
                      : tSeverity(SEVERITY_I18N_KEY[cls.severity])}
                  </span>
                )}
                {entry.details && entry.details.length > 0 && (
                  <div className="change-review-details">
                    {entry.details.join(", ")}
                  </div>
                )}
                {/* Privacy-policy entries get a "view change" button.
                    Marking as reviewed without seeing what changed
                    isn't really reviewing — the button flips the parent
                    tab to the changelog/history view where the diff
                    is rendered. Hidden when the parent didn't supply
                    a navigation handler (e.g. shared usage outside
                    AppDetailView). `align-self: flex-start` keeps the
                    button to its content width inside the column-flex
                    `.change-review-body` parent instead of stretching
                    across. */}
                {isPolicyChange && onViewChange && (
                  <button
                    className="btn btn-secondary btn-sm change-review-view-change"
                    onClick={onViewChange}
                    type="button"
                  >
                    {tDetail("change_review.view_policy_change")}
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
