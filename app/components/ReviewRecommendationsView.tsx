"use client";

/**
 * Review-and-act wizard for Phase 3.
 *
 * Universal three-step flow that every user — web or desktop — sees:
 *
 *   1. Review     — confirm/refine the user's own verdict per row.
 *                   Compact pickers; notes show below the row;
 *                   profile-match badge replaces the verdict pill
 *                   so "is this still concerning?" lives next to
 *                   the title.
 *   2. Compare    — for apps marked Replace, jump to /dashboard/
 *                   compare with the source app pre-selected and
 *                   find a safer alternative.
 *   3. Save       — generate a printable checklist (groups by
 *                   replace / uninstall / safe), with clickable
 *                   App Store URLs in the printed PDF, plus a
 *                   "share with my iPhone" affordance via the
 *                   Web Share API.
 *
 * Optional desktop-only addon, gated by audience=self +
 * `flag.devopts.cfgutil_uninstall` on + the Tauri desktop build:
 *
 *   4. Backup     — pick a connected device, run cfgutil backup.
 *   5. Act        — for apps marked Uninstall, type DELETE and
 *                   run cfgutil remove-app.
 *
 * Hidden completely (no stepper button, no panel) when the addon
 * conditions aren't met. Devs flip the flag from the dev menu's
 * "On this page" group while testing the addon flow.
 *
 * Hard rules enforced *here* (the page-level gate is enforced
 * server-side in `lib/device-actions.ts`):
 *
 *   - Imported recommendations alone never trigger an uninstall —
 *     only the user's own user-source verdict does.
 *   - The Act step refuses to mount unless audience='self', the
 *     flag is on, the platform is desktop, AND a fresh backup
 *     landed within the freshness window.
 *   - Each per-row uninstall is a separate click + type-DELETE
 *     confirmation. There is no batch path.
 */

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Annotation } from "../../lib/annotations";
import {
  backupDeviceViaCfgutil,
  type ConnectedDevice,
  isDesktop,
  listConnectedDevices,
  removeAppViaCfgutil,
} from "../../lib/desktop";
import type { AppProfileBadge } from "../../lib/privacy-profile";
import { isSafeExternalHref } from "../../lib/safe-href";
import type { ShortlistEntry } from "../../lib/shortlist-types";
import { useModalFocus } from "../../lib/use-modal-focus";
import type { AppVerdict, VerdictValue } from "../../lib/verdict-types";
import VerdictPicker from "./VerdictPicker";

interface Row {
  bundleId: string | null;
  developer: string | null;
  iconUrl: string | null;
  id: string;
  importedVerdicts: AppVerdict[];
  name: string;
  /**
   * The user's existing notes for this app. Surfaced in the Compare
   * step as a compact read-only preview so users picking a
   * replacement see the context they captured earlier without
   * having to navigate to /apps/[id]. Server-rendered; the
   * client component never re-fetches them inline (an edit on
   * the detail page is the canonical write path).
   */
  notes: Annotation[];
  profileBadge: AppProfileBadge | null;
  /**
   * Existing shortlist candidates for this app — populated by the
   * server from /api/shortlist (the same data that drives
   * /dashboard/shortlist). The Compare step renders them inline
   * under each "Replace" row so users can see what they've already
   * saved without leaving the wizard.
   */
  shortlistCandidates: ShortlistEntry[];
  /** Real App Store URL. Used for tap-to-open links in the
   *  printable checklist + the share-to-iPhone payload. May be
   *  null for sample-data / manual-entry apps that don't have a
   *  store listing. */
  url: string | null;
  userVerdict: AppVerdict | null;
}

interface Props {
  audience: "self" | "loved_one" | "guardian";
  flagOn: boolean;
  rows: Row[];
  /**
   * `appId → ECID[]` for apps in the uninstall queue. Used to warn the
   * user when the *connected* cfgutil device's ECID doesn't match any
   * of the device(s) the app was originally imported from. Entries are
   * absent when the app's source device(s) have a NULL ecid (CSV /
   * manual imports) — those rows skip the match check entirely.
   */
  sourceDeviceEcids?: Record<string, string[]>;
}

/**
 * Five logical steps; the last two are conditionally rendered. The
 * stepper UI hides them when the addon conditions aren't met so the
 * user never sees a disabled step they can't reach.
 *
 * Step 3 is named `'action'` because every option on it is something
 * the user *does* with their decisions — print, share with their
 * phone, head into the desktop addon. Was previously called `'save'`
 * but only one of the affordances on the step is a save action; the
 * rest are share / proceed.
 */
type Step = "review" | "compare" | "action" | "backup" | "act";

interface BackupState {
  device: ConnectedDevice | null;
  error: string | null;
  finishedAt: number | null;
  path: string | null;
  status: "idle" | "running" | "done" | "error";
}

interface UninstallState {
  error: string | null;
  status: "idle" | "running" | "done" | "error";
}

export default function ReviewRecommendationsView({
  rows: initialRows,
  audience,
  flagOn,
  sourceDeviceEcids = {},
}: Props) {
  // i18n — every visible string in the wizard reads from
  // `review_rec.*`. Sub-translators are split per step block so
  // call-sites stay short (e.g. tReview('heading') not
  // tRoot('review.heading')).
  const t = useTranslations("review_rec");
  const tHero = useTranslations("review_rec.hero");
  const tGate = useTranslations("review_rec.audience_gate");
  const tSteps = useTranslations("review_rec.step_labels");
  const tReview = useTranslations("review_rec.review");
  const tCompare = useTranslations("review_rec.compare");
  const tAction = useTranslations("review_rec.action");
  const tBackup = useTranslations("review_rec.backup");
  const tAct = useTranslations("review_rec.act");
  const tConfirm = useTranslations("review_rec.confirm_modal");
  const tShareModal = useTranslations("review_rec.share_modal");
  const tMigrate = useTranslations("review_rec.migrate_modal");
  const tPrint = useTranslations("review_rec.print");
  const tPayload = useTranslations("review_rec.share_payload");
  const tVerdict = useTranslations("verdict");

  // Initial step honours `?step=` so the back-link from /dashboard/compare
  // (which passes `?step=compare`) lands the user back at Step 2 instead
  // of rebooting the wizard at Step 1. Defaults to 'review' for fresh
  // visits. Validate against the union so a malformed URL falls through
  // to the safe default rather than breaking the stepper render.
  const router = useRouter();
  const searchParams = useSearchParams();

  // Escape-to-close. The review queue lives at its own route
  // (/dashboard/review-recommendations) but visually feels like a
  // dialog stacked on top of the Apps grid — users routinely try to
  // dismiss it with Escape or by clicking the Apps nav link. Wire the
  // keystroke so both paths land on /dashboard/apps and the queue
  // "closes" the way they expect. Skipped while the user is typing
  // in an input/textarea so Escape doesn't fight in-page autocomplete
  // dismissals (line 2111).
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") {
        return;
      }
      const target = event.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
          return;
        }
        if (target.isContentEditable) {
          return;
        }
      }
      router.push("/dashboard/apps");
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [router]);
  const initialStep: Step = (() => {
    const raw = searchParams?.get("step");
    if (
      raw === "review" ||
      raw === "compare" ||
      raw === "action" ||
      raw === "backup" ||
      raw === "act"
    ) {
      return raw;
    }
    return "review";
  })();
  const [step, setStep] = useState<Step>(initialStep);
  const [rows, setRows] = useState<Row[]>(initialRows);
  const [devices, setDevices] = useState<ConnectedDevice[]>([]);
  const [selectedEcid, setSelectedEcid] = useState<string | null>(null);
  const [backup, setBackup] = useState<BackupState>({
    status: "idle",
    device: null,
    finishedAt: null,
    path: null,
    error: null,
  });
  const [uninstallStates, setUninstallStates] = useState<
    Record<string, UninstallState>
  >({});
  /**
   * Per-row free-text "replacing with" memo — captured during the
   * Compare step. Stored in component state only (not persisted) so
   * the v1 flow is "find an alternative, jot the name down, see it
   * in the printable checklist". The value carries through into the
   * PDF / share payload as part of the row's printed line.
   *
   * Auto-populates when the user clicks a shortlist candidate chip
   * (the candidate's name fills this field). Manually editing
   * after that overrides the auto-pick — stored as plain text
   * because the printed checklist line is plain text too.
   */
  const [replacements, setReplacements] = useState<Record<string, string>>({});
  /**
   * Step 2 → Step 3 escape hatch. When at least one Replace row
   * doesn't have a chosen `replacements[row.id]` value, the
   * "Continue to Action" button is disabled by default — the wizard
   * encourages users to pin down a single replacement per row before
   * moving on. Flipping this toggle on acknowledges "I'll decide
   * later" / "I have multiple options" and lets the user proceed
   * without picking. We deliberately don't persist this — it resets
   * every time the user lands on Step 2 fresh, so a future session
   * never opens with the gate already bypassed.
   */
  const [proceedDespiteMissingPick, setProceedDespiteMissingPick] =
    useState(false);
  /**
   * Migration wizard modal state. Opens from the "Set up the desktop
   * migration" CTA on the Action step. Tracks the export step's
   * status so the user gets a busy indicator while the bundle is
   * being built and a confirmation when it lands.
   */
  const [migrateOpen, setMigrateOpen] = useState(false);
  const [migrateExport, setMigrateExport] = useState<{
    status: "idle" | "busy" | "done" | "error";
    error: string | null;
  }>({ status: "idle", error: null });
  /**
   * Tracks whether the Web Share API has just succeeded so we can
   * flash a small status pill below the share button. Clears after
   * 3 seconds. Plain string + nonce to retrigger the timer on
   * consecutive identical messages.
   */
  const [shareStatus, setShareStatus] = useState<string | null>(null);
  /**
   * Last-resort share fallback. When neither Web Share nor the
   * Clipboard API works (e.g. desktop Firefox on an http:// origin,
   * older browsers), we render this in a modal with the payload
   * pre-selected so the user can manually Cmd-C / Ctrl-C it.
   */
  const [shareFallback, setShareFallback] = useState<{
    text: string;
    url: string;
  } | null>(null);
  const shareFallbackRef = useRef<HTMLTextAreaElement | null>(null);

  // ── Modal focus management (WCAG 2.4.3 / 2.1.2) ───────────────────
  const shareFallbackCardRef = useModalFocus<HTMLDivElement>({
    open: !!shareFallback,
    onClose: () => setShareFallback(null),
    closeOnEscape: true,
  });

  // Track desktop status via state rather than calling `isDesktop()`
  // inline. `isDesktop` depends on a Tauri global that's only
  // injected after mount on the desktop wrapper; reading it on
  // first render produces the wrong answer on SSR (always false).
  const [desktop, setDesktop] = useState(false);
  useEffect(() => {
    setDesktop(isDesktop());
  }, []);

  const audienceOk = audience === "self";
  const showDeviceAddon = audienceOk && flagOn && desktop;

  const uninstallQueue = useMemo(
    () => rows.filter((r) => r.userVerdict?.verdict === "uninstall"),
    [rows]
  );
  const replaceQueue = useMemo(
    () => rows.filter((r) => r.userVerdict?.verdict === "replace"),
    [rows]
  );
  const safeQueue = useMemo(
    () => rows.filter((r) => r.userVerdict?.verdict === "safe"),
    [rows]
  );

  /**
   * Device-match analysis for the uninstall queue.
   *
   * For each app, we have an ordered list of ECIDs the app was
   * originally imported from (via the `app_devices` junction). Apps
   * whose source-device ECIDs include the *currently connected* ECID
   * are clear to delete from this device; apps whose ECIDs don't
   * include it are "mismatched" — the user is about to try to
   * uninstall an app that wasn't on this phone.
   *
   * Apps missing from `sourceDeviceEcids` are "unknown source" — the
   * device row had a NULL ecid (CSV / manual / pre-junction installs)
   * so we can't verify either way. Those neither trip the warning nor
   * count as matched.
   */
  const deviceMatch = useMemo(() => {
    if (!selectedEcid) {
      return { matched: [], mismatched: [], unknown: uninstallQueue };
    }
    const matched: Row[] = [];
    const mismatched: Row[] = [];
    const unknown: Row[] = [];
    for (const row of uninstallQueue) {
      const ecids = sourceDeviceEcids[row.id];
      if (!ecids || ecids.length === 0) {
        unknown.push(row);
      } else if (ecids.includes(selectedEcid)) {
        matched.push(row);
      } else {
        mismatched.push(row);
      }
    }
    return { matched, mismatched, unknown };
  }, [uninstallQueue, sourceDeviceEcids, selectedEcid]);

  /**
   * Three-gate bulk-delete state machine. Replaces the previous per-app
   * confirmation flow with a single "Delete N apps" path:
   *
   *   `null`       — act step renders the queue as a read-only list +
   *                  a single "Delete N apps" CTA at the bottom.
   *   `'list'`     — Modal 1: lists every app to be deleted and asks
   *                  "Are you sure?". Cancel returns to `null`,
   *                  Continue advances to `'final'`.
   *   `'final'`    — Modal 2: type DELETE to confirm. The copy and
   *                  keyword vary on whether a fresh backup exists —
   *                  the no-backup variant additionally requires the
   *                  user to type the keyword in a "this is at your
   *                  own risk" worded prompt. Cancel returns to `null`.
   *   `'executing'` — Bulk loop in progress. The act-step list shows
   *                  per-app status (idle/running/done/error); the
   *                  modal is dismissed so the user sees progress.
   */
  const [bulkModal, setBulkModal] = useState<
    null | "list" | "final" | "executing"
  >(null);
  const [bulkConfirmText, setBulkConfirmText] = useState("");
  // Modal focus management for the two bulk dialogs — declared here, after
  // `bulkModal`, since the hook's `open` reads it.
  const bulkListCardRef = useModalFocus<HTMLDivElement>({
    open: bulkModal === "list",
    onClose: () => setBulkModal(null),
    closeOnEscape: true,
  });
  const bulkFinalCardRef = useModalFocus<HTMLDivElement>({
    open: bulkModal === "final",
    onClose: () => setBulkModal(null),
    closeOnEscape: true,
  });

  const onVerdictChange = useCallback(
    (rowId: string) => (next: VerdictValue | null) => {
      setRows((prev) =>
        prev.map((r) => {
          if (r.id !== rowId) {
            return r;
          }
          if (!next) {
            return { ...r, userVerdict: null };
          }
          const now = Date.now();
          return {
            ...r,
            userVerdict: r.userVerdict
              ? { ...r.userVerdict, verdict: next, updatedAt: now }
              : {
                  id: "pending",
                  appId: r.id,
                  verdict: next,
                  rationale: null,
                  source: "user",
                  sourceName: null,
                  setAt: now,
                  updatedAt: now,
                },
          };
        })
      );
    },
    []
  );

  // ── Inline rationale editor ────────────────────────────────────────
  // The Review step lets users type a note inline rather than having
  // to navigate to /apps/[id] to use the full VerdictPicker. We
  // mirror VerdictPicker's debounced-save model so each keystroke
  // updates the buffered text immediately (responsive textarea) but
  // only writes to /api/verdicts after the user pauses typing for
  // 600ms. Buffer is keyed by row id; the row's `userVerdict.rationale`
  // is the canonical source — on mount we hydrate from there, and
  // every successful save writes back to it via setRows.
  //
  // Notes only persist when paired with a verdict — POSTing a
  // rationale without a verdict would have no row to attach to.
  // The inline editor renders disabled with a hint when
  // `userVerdict` is null.
  const [rationaleDrafts, setRationaleDrafts] = useState<
    Record<string, string>
  >({});
  const rationaleTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>(
    {}
  );

  /**
   * Read the current draft for a row — falling back to the saved
   * rationale on `userVerdict` when nothing's been typed yet so the
   * textarea hydrates correctly on first render. The dedicated
   * `rationaleDrafts` map only holds buffered edits; saved values
   * live on the row.
   */
  const getRationaleDraft = useCallback(
    (row: Row) => {
      if (Object.hasOwn(rationaleDrafts, row.id)) {
        return rationaleDrafts[row.id];
      }
      return row.userVerdict?.rationale ?? "";
    },
    [rationaleDrafts]
  );

  const onRationaleChange = useCallback((row: Row, next: string) => {
    // Buffer the edit so the textarea stays responsive.
    setRationaleDrafts((prev) => ({ ...prev, [row.id]: next }));
    // Skip the debounced save when there's no verdict to attach
    // the rationale to — the picker shows a hint in that case.
    if (!row.userVerdict) {
      return;
    }
    // Debounce — clear the previous timer so we never end up with
    // overlapping in-flight POSTs for the same row.
    const existing = rationaleTimers.current[row.id];
    if (existing) {
      clearTimeout(existing);
    }
    rationaleTimers.current[row.id] = setTimeout(async () => {
      const verdict = row.userVerdict?.verdict;
      if (!verdict) {
        return;
      }
      const trimmed = next.trim();
      try {
        const res = await fetch("/api/verdicts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            appId: row.id,
            verdict,
            rationale: trimmed || null,
          }),
        });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const { verdict: saved }: { verdict: AppVerdict } = await res.json();
        // Mirror into the row state so the printable PDF + the
        // share payload pick up the new value without a refresh.
        setRows((prev) =>
          prev.map((r) => (r.id === row.id ? { ...r, userVerdict: saved } : r))
        );
      } catch (e) {
        console.warn("[review] inline rationale save failed:", e);
      }
    }, 600);
  }, []);

  // Flush any pending rationale writes on unmount so a "type, navigate
  // away" sequence doesn't drop the last edit on the floor.
  useEffect(() => {
    const timers = rationaleTimers.current;
    return () => {
      for (const id of Object.keys(timers)) {
        clearTimeout(timers[id]);
      }
    };
  }, []);

  // Remove a saved shortlist candidate (×-button on the chip in the
  // Compare step). Updates local row state so the chip vanishes
  // immediately, then fires DELETE /api/shortlist. If the request
  // fails we re-add the chip to keep state honest.
  const removeShortlistCandidate = useCallback(
    async (sourceAppId: string, candidateAppleId: string) => {
      // Optimistic remove.
      setRows((prev) =>
        prev.map((r) =>
          r.id === sourceAppId
            ? {
                ...r,
                shortlistCandidates: r.shortlistCandidates.filter(
                  (c) => c.candidateAppleId !== candidateAppleId
                ),
              }
            : r
        )
      );
      try {
        const qs = new URLSearchParams({ sourceAppId, candidateAppleId });
        const res = await fetch(`/api/shortlist?${qs}`, { method: "DELETE" });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
      } catch (e) {
        console.warn("[review] shortlist remove failed:", e);
        // Best-effort rollback — refetch the page would be cleaner
        // but the inline restore keeps the user's flow intact.
        setRows((prev) =>
          prev.map((r) => {
            if (r.id !== sourceAppId) {
              return r;
            }
            // Don't double-add; only restore if the candidate is
            // genuinely missing from the current list.
            if (
              r.shortlistCandidates.some(
                (c) => c.candidateAppleId === candidateAppleId
              )
            ) {
              return r;
            }
            // We don't have the original entry handy here — punt to a
            // page refresh on next user interaction.
            return r;
          })
        );
      }
    },
    []
  );

  /**
   * Pick a shortlist candidate as the chosen replacement. Fills the
   * "Replacing with…" memo with the candidate's name so the printed
   * checklist + share payload reflect the choice. Doesn't touch the
   * shortlist itself — the entry stays available for re-pick if the
   * user changes their mind.
   */
  const pickShortlistCandidate = useCallback(
    (sourceAppId: string, candidateName: string) => {
      setReplacements((prev) => ({ ...prev, [sourceAppId]: candidateName }));
    },
    []
  );

  // Connected-device polling — only on the Backup step.
  useEffect(() => {
    if (step !== "backup") {
      return;
    }
    if (!desktop) {
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      const result = await listConnectedDevices();
      if (cancelled) {
        return;
      }
      if (!result || result.cfgutilUnavailable) {
        setDevices([]);
        return;
      }
      setDevices(result.devices);
      if (!selectedEcid && result.devices[0]) {
        setSelectedEcid(result.devices[0].ecid);
      }
      if (cancelled) {
        return;
      }
      timer = setTimeout(tick, 5000);
    };
    tick();
    return () => {
      cancelled = true;
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [step, selectedEcid, desktop]);

  const runBackup = useCallback(async () => {
    if (!selectedEcid) {
      return;
    }
    const device = devices.find((d) => d.ecid === selectedEcid) ?? null;
    setBackup({
      status: "running",
      device,
      finishedAt: null,
      path: null,
      error: null,
    });
    const destDir = `~/Documents/privacytracker-Backups/${selectedEcid}`;
    const result = await backupDeviceViaCfgutil(selectedEcid, destDir);
    if (!result.ok) {
      setBackup({
        status: "error",
        device,
        finishedAt: null,
        path: null,
        error: result.error ?? tAct("default_backup_error"),
      });
      return;
    }
    try {
      await fetch("/api/device-actions/backup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ecid: selectedEcid,
          path: result.backupPath ?? destDir,
          finishedAt: result.finishedAt ?? Date.now(),
          deviceName: device?.name ?? null,
        }),
      });
    } catch (e) {
      console.warn("[review] failed to record backup:", e);
    }
    setBackup({
      status: "done",
      device,
      finishedAt: result.finishedAt ?? Date.now(),
      path: result.backupPath,
      error: null,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- t* is a stable next-intl translator; including it forces a re-run on every render
  }, [selectedEcid, devices]);

  const runUninstall = useCallback(
    async (row: Row, acknowledgeNoBackup: boolean) => {
      if (!(selectedEcid && row.bundleId)) {
        return;
      }
      setUninstallStates((prev) => ({
        ...prev,
        [row.id]: { status: "running", error: null },
      }));
      const result = await removeAppViaCfgutil(selectedEcid, row.bundleId);
      try {
        await fetch("/api/device-actions/uninstall", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ecid: selectedEcid,
            bundleId: row.bundleId,
            appId: row.id,
            appName: row.name,
            ok: result.ok,
            error: result.error,
            acknowledgeNoBackup,
          }),
        });
      } catch (e) {
        console.warn("[review] failed to record uninstall outcome:", e);
      }
      setUninstallStates((prev) => ({
        ...prev,
        [row.id]: result.ok
          ? { status: "done", error: null }
          : {
              status: "error",
              error: result.error ?? tAct("default_uninstall_error"),
            },
      }));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- t* is a stable next-intl translator; including it forces a re-run on every render
    [selectedEcid]
  );

  /**
   * Sequential bulk-uninstall runner. Iterates the queue, calling
   * `runUninstall` per row. Errors don't abort the batch — the per-app
   * state surfaces ✓/✕/spinner inline, and the user sees a summary
   * once the loop finishes. Apps that lack a bundle ID are skipped
   * (cfgutil needs one) and surface as `error`.
   *
   * The `acknowledgeNoBackup` flag flows through to every per-app
   * request so the server-side gate can allow the bypass uniformly
   * across the batch.
   */
  const runBulkUninstall = useCallback(
    async (acknowledgeNoBackup: boolean) => {
      if (!selectedEcid) {
        return;
      }
      setBulkModal("executing");
      for (const row of uninstallQueue) {
        if (!row.bundleId) {
          setUninstallStates((prev) => ({
            ...prev,
            [row.id]: {
              status: "error",
              error: tAct("no_bundle_id_title"),
            },
          }));
          continue;
        }
        // Skip apps that already succeeded — re-runs (e.g. retry after
        // a partial failure) shouldn't fire cfgutil again for done rows.
        const currentState = uninstallStates[row.id];
        if (currentState?.status === "done") {
          continue;
        }
        await runUninstall(row, acknowledgeNoBackup);
      }
      setBulkModal(null);
      setBulkConfirmText("");
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runUninstall closes over selectedEcid + t* (stable); uninstallStates is read inside via setState callback
    [selectedEcid, uninstallQueue, runUninstall]
  );

  // Modal 2 (`bulkModal === 'final'`) type-DELETE input. The ref is
  // captured here and attached on render. Focus is handled by
  // useModalFocus (bulkFinalCardRef) above; autoFocus on the input
  // below ensures the input is the first focused element inside the card.
  const confirmInputRef = useRef<HTMLInputElement>(null);

  // ── Save / share / print plumbing ──────────────────────────────────
  // Print toggles a body class; the @media print stylesheet hides
  // every other page chrome element so only `.review-rec-print` is
  // visible. The block contains real <a href> elements for App
  // Store URLs, so the saved PDF carries them as clickable links.
  const triggerPrint = useCallback(() => {
    if (typeof window === "undefined") {
      return;
    }
    document.body.classList.add("review-rec-print-active");
    const cleanup = () => {
      document.body.classList.remove("review-rec-print-active");
      window.removeEventListener("afterprint", cleanup);
    };
    window.addEventListener("afterprint", cleanup);
    window.requestAnimationFrame(() => window.print());
  }, []);

  // Build a plain-text payload suitable for SMS / share / clipboard.
  // The PDF flow is for offline review; this is for "AirDrop my
  // checklist to my iPhone" or "text it to myself". Lines are kept
  // short so the message reads sensibly in iMessage / Mail previews.
  const buildSharePayload = useCallback((): {
    title: string;
    text: string;
    url: string;
  } => {
    const lines: string[] = [tPayload("header")];
    if (uninstallQueue.length > 0) {
      lines.push(
        "",
        tPayload("uninstall_section", { count: uninstallQueue.length })
      );
      for (const r of uninstallQueue) {
        lines.push(`• ${r.name}${r.url ? ` — ${r.url}` : ""}`);
      }
    }
    if (replaceQueue.length > 0) {
      lines.push(
        "",
        tPayload("replace_section", { count: replaceQueue.length })
      );
      for (const r of replaceQueue) {
        const swap = replacements[r.id]?.trim();
        const replaceLine = swap ? ` → ${swap}` : "";
        lines.push(`• ${r.name}${replaceLine}${r.url ? ` — ${r.url}` : ""}`);
      }
    }
    if (safeQueue.length > 0) {
      lines.push("", tPayload("safe_section", { count: safeQueue.length }));
      for (const r of safeQueue) {
        lines.push(`• ${r.name}`);
      }
    }
    const url = typeof window === "undefined" ? "" : window.location.href;
    return { title: tPayload("title"), text: lines.join("\n"), url };
  }, [uninstallQueue, replaceQueue, safeQueue, replacements, tPayload]);

  /**
   * Share trigger with a four-tier fallback so something useful
   * always happens:
   *
   *   1. Web Share API — opens the OS share sheet (iOS Safari,
   *      mac Safari, Chrome on Android, modern Edge). User picks
   *      AirDrop / iMessage / Mail / etc. and the payload arrives
   *      on their phone with tap-open App Store URLs.
   *
   *   2. Clipboard API — `navigator.clipboard.writeText`. Works on
   *      every modern desktop browser over HTTPS / localhost.
   *      Status pill prompts the user to paste it into Messages.
   *
   *   3. `document.execCommand('copy')` — older fallback that
   *      works when the Clipboard API is missing or blocked
   *      (insecure context, older Firefox). We mount a hidden
   *      textarea, select its content, and trigger the copy.
   *
   *   4. Manual copy modal — opens a dialog with the payload
   *      pre-selected. The user hits Cmd-C / Ctrl-C themselves.
   *      This is the last-resort path that always works because
   *      it doesn't touch any privileged browser API.
   *
   * The previous version short-circuited at step 2 with a
   * "doesn't work in this browser" toast for any user whose
   * browser landed past clipboard support — making the share
   * button feel broken even though step 4 would have worked.
   */
  const shareChecklist = useCallback(async () => {
    const payload = buildSharePayload();
    const fullText = `${payload.text}\n\n${payload.url}`;

    // 1. Web Share API.
    if (
      typeof navigator !== "undefined" &&
      typeof navigator.share === "function"
    ) {
      try {
        // canShare() throws / returns false for some payload shapes
        // (e.g. URL-less on iOS Safari < 16). Guard against that
        // before calling share() so we don't trip the AbortError
        // path with a non-recoverable TypeError.
        const canTry =
          typeof navigator.canShare === "function"
            ? navigator.canShare(payload)
            : true;
        if (canTry) {
          await navigator.share(payload);
          setShareStatus(tAction("share_status_shared"));
          window.setTimeout(() => setShareStatus(null), 3000);
          return;
        }
      } catch (e) {
        if (e instanceof Error && e.name === "AbortError") {
          // User dismissed the share sheet — don't fall through
          // to clipboard, since they actively cancelled.
          return;
        }
        // Other errors: fall through to clipboard / fallback.
      }
    }

    // 2. Clipboard API.
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(fullText);
        setShareStatus(tAction("share_status_copied"));
        window.setTimeout(() => setShareStatus(null), 3000);
        return;
      } catch {
        // Permission denied, insecure context, etc. Fall through.
      }
    }

    // 3. execCommand('copy') with a hidden textarea.
    if (typeof document !== "undefined") {
      try {
        const ta = document.createElement("textarea");
        ta.value = fullText;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.top = "-9999px";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        document.body.removeChild(ta);
        if (ok) {
          setShareStatus(tAction("share_status_copied"));
          window.setTimeout(() => setShareStatus(null), 3000);
          return;
        }
      } catch {
        // Some sandboxes throw on execCommand. Fall through.
      }
    }

    // 4. Manual copy modal.
    setShareFallback({ text: payload.text, url: payload.url });
  }, [buildSharePayload, tAction]);

  // When the manual-copy modal opens, select-all the textarea so the
  // user can hit Cmd-C / Ctrl-C immediately. Focus is handled by
  // useModalFocus (shareFallbackCardRef) above.
  useEffect(() => {
    if (!shareFallback) {
      return;
    }
    const handle = window.requestAnimationFrame(() => {
      shareFallbackRef.current?.select();
    });
    return () => window.cancelAnimationFrame(handle);
  }, [shareFallback]);

  // ── Stepper config ─────────────────────────────────────────────────
  // Stepper renders only the steps that are reachable for the user.
  // The desktop addon (backup + act) appears as steps 4 and 5 only
  // when the gate conditions are met — otherwise the wizard is a
  // clean three-step flow with no disabled buttons.
  const visibleSteps: Array<{ id: Step; label: string; enabled: boolean }> = [
    { id: "review", label: tSteps("review"), enabled: true },
    { id: "compare", label: tSteps("compare"), enabled: true },
    { id: "action", label: tSteps("action"), enabled: true },
  ];
  if (showDeviceAddon) {
    visibleSteps.push({ id: "backup", label: tSteps("backup"), enabled: true });
    visibleSteps.push({
      id: "act",
      label: tSteps("act"),
      enabled: backup.status === "done",
    });
  }

  return (
    <main className="review-rec-main">
      <header className="review-rec-hero">
        <Link className="priv-back-link" href="/dashboard/apps">
          {tHero("back_to_apps")}
        </Link>
        <p className="priv-eyebrow">{tHero("eyebrow")}</p>
        <h1 className="legal-page-title">{tHero("title")}</h1>
        <p className="legal-page-sub">{tHero("subtitle")}</p>
      </header>

      {!audienceOk && (
        <div className="review-rec-gate review-rec-gate-soft">
          <p>
            <strong>{tGate("heading")}</strong>
          </p>
          <p>
            {tGate("body_lead")} <em>{tGate("body_em")}</em>{" "}
            {tGate("body_after")} <code>{audience.replace("_", " ")}</code>{" "}
            {tGate("body_after_audience")}
          </p>
          <p>
            <Link href="/dashboard/settings#focus">{tGate("switch_link")}</Link>{" "}
            {tGate("switch_suffix")}
          </p>
        </div>
      )}

      <ol aria-label={t("stepper_aria")} className="review-rec-stepper">
        {visibleSteps.map((s, i) => (
          <li
            aria-current={step === s.id ? "step" : undefined}
            className={step === s.id ? "is-active" : ""}
            key={s.id}
          >
            <button
              disabled={!s.enabled}
              onClick={() => s.enabled && setStep(s.id)}
              type="button"
            >
              <span className="review-rec-stepper-num">{i + 1}</span>
              <span>{s.label}</span>
            </button>
          </li>
        ))}
      </ol>

      {step === "review" && (
        <section className="review-rec-step">
          <h2>{tReview("heading")}</h2>
          <p className="review-rec-step-sub">
            {rows.length === 0
              ? tReview("empty")
              : tReview("summary", {
                  replaceCount: replaceQueue.length,
                  uninstallCount: uninstallQueue.length,
                  safeCount: safeQueue.length,
                })}
          </p>
          <div className="review-rec-list">
            {rows.map((row) => (
              <article
                className="review-rec-row review-rec-row-compact"
                key={row.id}
              >
                <div className="review-rec-row-head">
                  {row.iconUrl ? (
                    /* eslint-disable-next-line @next/next/no-img-element */
                    <img
                      alt=""
                      className="review-rec-row-icon"
                      height={40}
                      src={row.iconUrl}
                      width={40}
                    />
                  ) : (
                    <div className="review-rec-row-icon review-rec-row-icon-placeholder" />
                  )}
                  <div className="review-rec-row-meta">
                    <div className="review-rec-row-name">
                      <Link
                        className="review-rec-row-name-link"
                        href={`/apps/${row.id}`}
                      >
                        {row.name}
                      </Link>
                      {/* Profile-match badge — shows whether the app
                          fits inside the user's privacy profile. The
                          verdict (Safe/Replace/Uninstall) is already
                          visible as the active picker chip on the
                          right, so this slot now communicates "is
                          this still concerning right now?" instead. */}
                      {row.profileBadge && (
                        <ProfileBadge badge={row.profileBadge} />
                      )}
                    </div>
                    {row.developer && (
                      <div className="review-rec-row-dev">{row.developer}</div>
                    )}
                  </div>
                  <div className="review-rec-row-picker">
                    <VerdictPicker
                      appId={row.id}
                      appName={row.name}
                      compact
                      initialVerdicts={[
                        ...(row.userVerdict ? [row.userVerdict] : []),
                        ...row.importedVerdicts,
                      ]}
                      onChange={onVerdictChange(row.id)}
                    />
                  </div>
                </div>

                {/* Notes block — sits below the title row so the
                    row reads as "title row + notes block" rather
                    than cramming everything inside the metadata
                    column. Includes:
                      - inline rationale editor (textarea, debounced
                        save via /api/verdicts) so users can capture
                        WHY they marked an app a certain way without
                        having to navigate to /apps/[id]
                      - imported recommendations from any audit
                        bundle the user accepted, surfaced as muted
                        one-liners below the editor */}
                <div className="review-rec-row-notes">
                  <label
                    className="review-rec-row-notes-label"
                    htmlFor={`review-rec-notes-${row.id}`}
                  >
                    {tReview("notes_label")}
                    {!row.userVerdict && (
                      <span className="review-rec-row-notes-hint">
                        {tReview("notes_hint")}
                      </span>
                    )}
                  </label>
                  <textarea
                    className="review-rec-row-notes-input"
                    disabled={!row.userVerdict}
                    id={`review-rec-notes-${row.id}`}
                    maxLength={400}
                    onChange={(e) => onRationaleChange(row, e.target.value)}
                    placeholder={
                      row.userVerdict
                        ? tReview("notes_placeholder_with_verdict", {
                            appName: row.name,
                            verdict: tVerdict(
                              `${row.userVerdict.verdict}_short`
                            ),
                          })
                        : tReview("notes_placeholder_no_verdict")
                    }
                    rows={2}
                    value={getRationaleDraft(row)}
                  />
                  {row.importedVerdicts.map((rec) => (
                    <p className="review-rec-row-imported" key={rec.id}>
                      {tReview("imported_says", {
                        name:
                          rec.sourceName ?? tReview("imported_says_anon_name"),
                      })}{" "}
                      <em>{tVerdict(`${rec.verdict}_short`)}</em>
                      {rec.rationale ? ` — ${rec.rationale}` : ""}
                    </p>
                  ))}
                </div>
              </article>
            ))}
          </div>
          {rows.length > 0 && (
            <div className="review-rec-step-actions">
              <button
                className="btn btn-primary"
                onClick={() => setStep("compare")}
                type="button"
              >
                {tReview("continue_button", { count: replaceQueue.length })}
              </button>
            </div>
          )}
        </section>
      )}

      {step === "compare" && (
        <section className="review-rec-step">
          <h2>{tCompare("heading")}</h2>
          <p className="review-rec-step-sub">{tCompare("subtitle")}</p>

          {replaceQueue.length === 0 ? (
            <div className="review-rec-empty">
              <p>{tCompare("empty")}</p>
              <div className="review-rec-step-actions">
                <button
                  className="btn btn-ghost"
                  onClick={() => setStep("review")}
                  type="button"
                >
                  {tCompare("back_to_review")}
                </button>
                <button
                  className="btn btn-primary"
                  onClick={() => setStep("action")}
                  type="button"
                >
                  {tCompare("skip_to_action")}
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="review-rec-list">
                {replaceQueue.map((row) => (
                  <article
                    className="review-rec-row review-rec-row-compare"
                    key={row.id}
                  >
                    <div className="review-rec-row-head">
                      {row.iconUrl ? (
                        /* eslint-disable-next-line @next/next/no-img-element */
                        <img
                          alt=""
                          className="review-rec-row-icon"
                          height={40}
                          src={row.iconUrl}
                          width={40}
                        />
                      ) : (
                        <div className="review-rec-row-icon review-rec-row-icon-placeholder" />
                      )}
                      <div className="review-rec-row-meta">
                        <div className="review-rec-row-name">
                          <Link
                            className="review-rec-row-name-link"
                            href={`/apps/${row.id}`}
                          >
                            {row.name}
                          </Link>
                          {row.profileBadge && (
                            <ProfileBadge badge={row.profileBadge} />
                          )}
                        </div>
                        {row.developer && (
                          <div className="review-rec-row-dev">
                            {row.developer}
                          </div>
                        )}
                      </div>
                      <div className="review-rec-row-action">
                        <Link
                          className="btn btn-secondary btn-sm"
                          href={`/dashboard/compare?a=id:${encodeURIComponent(row.id)}&from=review`}
                        >
                          {tCompare("find_alternatives")}
                        </Link>
                      </div>
                    </div>

                    {/* Existing shortlist for this app — appears
                        when the user has previously picked
                        candidates (from this page's Find
                        Alternatives action, the dashboard/compare
                        view, or the shortlist page directly). Each
                        chip shows the candidate icon + name; click
                        to set as the chosen replacement, click ×
                        to remove from the shortlist. The list
                        hides itself when nothing's saved so the
                        row stays compact for first-time users. */}
                    {row.shortlistCandidates.length > 0 && (
                      <div className="review-rec-row-shortlist">
                        <div className="review-rec-row-shortlist-label">
                          {tCompare("shortlist_label")}
                          <span className="review-rec-row-shortlist-count">
                            {row.shortlistCandidates.length}
                          </span>
                        </div>
                        {/* Click-to-autofill hint — without this, users
                            were treating the chip cluster as decorative
                            and missing that clicking populates the
                            "Replacing with" field below. */}
                        <p className="review-rec-row-shortlist-hint">
                          {tCompare("shortlist_hint")}
                        </p>
                        <ul className="review-rec-row-shortlist-list">
                          {row.shortlistCandidates.map((candidate) => {
                            const isPicked =
                              replacements[row.id]?.trim() ===
                              candidate.candidateName;
                            return (
                              <li key={candidate.id}>
                                <button
                                  className={`review-rec-shortlist-chip${isPicked ? " is-picked" : ""}`}
                                  onClick={() =>
                                    pickShortlistCandidate(
                                      row.id,
                                      candidate.candidateName
                                    )
                                  }
                                  title={
                                    isPicked
                                      ? tCompare("shortlist_chip_picked_title")
                                      : tCompare("shortlist_chip_pick_title", {
                                          name: candidate.candidateName,
                                        })
                                  }
                                  type="button"
                                >
                                  {candidate.candidateIconUrl ? (
                                    /* eslint-disable-next-line @next/next/no-img-element */
                                    <img
                                      alt=""
                                      className="review-rec-shortlist-chip-icon"
                                      height={20}
                                      src={candidate.candidateIconUrl}
                                      width={20}
                                    />
                                  ) : (
                                    <span className="review-rec-shortlist-chip-icon review-rec-shortlist-chip-icon-placeholder" />
                                  )}
                                  <span className="review-rec-shortlist-chip-name">
                                    {candidate.candidateName}
                                  </span>
                                  {isPicked && (
                                    <span
                                      aria-hidden="true"
                                      className="review-rec-shortlist-chip-tick"
                                    >
                                      ✓
                                    </span>
                                  )}
                                </button>
                                <button
                                  aria-label={tCompare(
                                    "shortlist_chip_remove_aria",
                                    {
                                      name: candidate.candidateName,
                                    }
                                  )}
                                  className="review-rec-shortlist-chip-remove"
                                  onClick={() =>
                                    removeShortlistCandidate(
                                      row.id,
                                      candidate.candidateAppleId
                                    )
                                  }
                                  title={tCompare(
                                    "shortlist_chip_remove_title"
                                  )}
                                  type="button"
                                >
                                  ✕
                                </button>
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    )}

                    <ReplacingWithCombobox
                      labelText={tCompare("replacing_with")}
                      onChange={(next) =>
                        setReplacements((prev) => ({ ...prev, [row.id]: next }))
                      }
                      onPick={(name) => pickShortlistCandidate(row.id, name)}
                      placeholder={
                        row.shortlistCandidates.length > 0
                          ? tCompare("replacing_with_placeholder_with_chips")
                          : tCompare("replacing_with_placeholder_default")
                      }
                      row={row}
                      value={replacements[row.id] ?? ""}
                    />

                    {row.userVerdict?.rationale && (
                      <div className="review-rec-row-notes">
                        <p className="review-rec-row-reason">
                          &ldquo;{row.userVerdict.rationale}&rdquo;
                        </p>
                      </div>
                    )}

                    {/* Saved notes preview — if the user has written
                        notes about this app on the detail page,
                        surface them here so they have the context
                        in front of them when picking a replacement.
                        Read-only preview; the "Edit" link opens
                        the app detail page with the notes accordion
                        ready to expand. Caps at 3 entries with a
                        "+ N more" indicator past that. */}
                    {row.notes.length > 0 && <SavedNotesPreview row={row} />}
                  </article>
                ))}
              </div>
              {/* Continue gate — count Replace rows where the user
                  hasn't picked / typed a single replacement yet. The
                  "Continue to Action" button stays disabled until
                  every row has one OR the user explicitly checks
                  "I'll decide later" / "I have multiple options".
                  The toggle is the user's escape hatch when they're
                  still narrowing two or three candidates and don't
                  want to be blocked here. */}
              {(() => {
                const missingPickCount = replaceQueue.filter(
                  (r) => (replacements[r.id] ?? "").trim() === ""
                ).length;
                const continueBlocked =
                  missingPickCount > 0 && !proceedDespiteMissingPick;
                return (
                  <>
                    {missingPickCount > 0 && (
                      <div
                        className="review-rec-missing-pick-notice"
                        role="status"
                      >
                        <p className="review-rec-missing-pick-text">
                          {tCompare("missing_pick_notice", {
                            count: missingPickCount,
                          })}
                        </p>
                        <label className="review-rec-missing-pick-toggle">
                          <input
                            aria-label={tCompare("missing_pick_aria")}
                            checked={proceedDespiteMissingPick}
                            onChange={(e) =>
                              setProceedDespiteMissingPick(e.target.checked)
                            }
                            type="checkbox"
                          />
                          <span>{tCompare("missing_pick_acknowledge")}</span>
                        </label>
                      </div>
                    )}
                    <div className="review-rec-step-actions">
                      <button
                        className="btn btn-ghost"
                        onClick={() => setStep("review")}
                        type="button"
                      >
                        {tCompare("back_to_review")}
                      </button>
                      <button
                        aria-disabled={continueBlocked}
                        className="btn btn-primary"
                        disabled={continueBlocked}
                        onClick={() => setStep("action")}
                        type="button"
                      >
                        {tCompare("continue_to_action")}
                      </button>
                    </div>
                  </>
                );
              })()}
            </>
          )}
        </section>
      )}

      {step === "action" && (
        <section className="review-rec-step">
          <h2>{tAction("heading")}</h2>
          <p className="review-rec-step-sub">{tAction("subtitle")}</p>

          <div className="review-rec-summary">
            {replaceQueue.length === 0 &&
              uninstallQueue.length === 0 &&
              safeQueue.length === 0 && (
                <p className="review-rec-step-sub">{tAction("empty")}</p>
              )}
            {uninstallQueue.length > 0 && (
              <SummaryGroup
                appStoreLinkLabel={tAction("share_app_store_link")}
                rows={uninstallQueue}
                title={tAction("group_uninstall", {
                  count: uninstallQueue.length,
                })}
                tone="bad"
              />
            )}
            {replaceQueue.length > 0 && (
              <SummaryGroup
                appStoreLinkLabel={tAction("share_app_store_link")}
                replacementLabel={tAction("replacement_label")}
                replacementLinkAria={(name) =>
                  tAction("replacement_link_label", { name })
                }
                replacements={replacements}
                rows={replaceQueue}
                title={tAction("group_replace", { count: replaceQueue.length })}
                tone="warn"
              />
            )}
            {safeQueue.length > 0 && (
              <SummaryGroup
                appStoreLinkLabel={tAction("share_app_store_link")}
                rows={safeQueue}
                title={tAction("group_safe", { count: safeQueue.length })}
                tone="ok"
              />
            )}
          </div>

          <div className="review-rec-step-actions">
            <button
              className="btn btn-primary"
              disabled={
                replaceQueue.length === 0 &&
                uninstallQueue.length === 0 &&
                safeQueue.length === 0
              }
              onClick={triggerPrint}
              type="button"
            >
              {tAction("save_pdf")}
            </button>
            <button
              className="btn btn-secondary"
              disabled={
                replaceQueue.length === 0 &&
                uninstallQueue.length === 0 &&
                safeQueue.length === 0
              }
              onClick={shareChecklist}
              title={tAction("share_title")}
              type="button"
            >
              {tAction("share")}
            </button>
            {/* Primary end-of-wizard CTA when the user has any apps
             *  flagged for uninstall. Routes into the backup → device-
             *  match → confirm → act flow. Previously the user saw a
             *  "Continue to backup" button alongside a "Re-sync from
             *  device" link — the labels were ambiguous and users
             *  weren't sure which was the destructive path. Now the
             *  intent is in the button name: this is the path that
             *  deletes apps from your phone. */}
            {showDeviceAddon && uninstallQueue.length > 0 && (
              <button
                className="btn btn-danger"
                onClick={() => setStep("backup")}
                type="button"
              >
                {tAction("remove_apps_from_phone", {
                  count: uninstallQueue.length,
                })}
              </button>
            )}
          </div>

          {shareStatus && (
            <p
              aria-live="polite"
              className="review-rec-share-status"
              role="status"
            >
              {shareStatus}
            </p>
          )}

          {/* Desktop-migration info banner — only relevant when the
              user is actually on the web (not the Tauri build) AND
              they have at least one Uninstall row. The banner offers
              the macOS / Apple Configurator path as an alternative
              to the manual long-press-to-delete-on-the-phone flow
              the share-with-iPhone PDF currently provides. We hide
              the banner on the Tauri build since those users are
              already on the desktop app — pointing them at a
              "download the desktop app" CTA would be confusing. */}
          {!desktop && uninstallQueue.length > 0 && (
            <aside
              aria-label={tAction("migrate_banner_title")}
              className="review-rec-migrate-banner"
            >
              <div className="review-rec-migrate-banner-body">
                <strong className="review-rec-migrate-banner-title">
                  {tAction("migrate_banner_title")}
                </strong>
                <p className="review-rec-migrate-banner-copy">
                  {tAction("migrate_banner_body")}
                </p>
              </div>
              <button
                aria-label={tAction("migrate_banner_aria")}
                className="btn btn-secondary review-rec-migrate-banner-cta"
                onClick={() => {
                  setMigrateExport({ status: "idle", error: null });
                  setMigrateOpen(true);
                }}
                type="button"
              >
                {tAction("migrate_banner_cta")}
              </button>
            </aside>
          )}
        </section>
      )}

      {/* Migration wizard modal — opens from the banner above. The
          export hits /api/export/audit-bundle with `migrationFlow:
          true`, which makes the produced bundle carry the
          `migration_flow` marker. When that bundle is imported on
          the macOS desktop build, the dashboard's one-shot redirect
          (consumeMigrationFlowMarker) bounces the user straight back
          into this Review wizard so the workflow continues
          uninterrupted. */}
      {migrateOpen && (
        <MigrateModal
          exportError={migrateExport.error}
          exportStatus={migrateExport.status}
          onClose={() => setMigrateOpen(false)}
          onExport={async () => {
            setMigrateExport({ status: "busy", error: null });
            try {
              const r = await fetch("/api/export/audit-bundle", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  migrationFlow: true,
                  // Same-user migration — the recommender_name field
                  // is meaningless here, leave it null so the receiving
                  // install doesn't render a "from {name}" provenance
                  // banner for what is, conceptually, the user's own data.
                  recommenderName: null,
                  includeRecommenderProfile: true,
                }),
              });
              if (!r.ok) {
                const body = await r.json().catch(() => ({}));
                throw new Error(body?.error || `HTTP ${r.status}`);
              }
              // Convert the response into a downloadable file. Server
              // already sets Content-Disposition with the filename.
              const blob = await r.blob();
              const cd = r.headers.get("Content-Disposition") ?? "";
              const fname =
                /filename="([^"]+)"/.exec(cd)?.[1] ??
                `privacytracker-migration-${Date.now()}.audit.json`;
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = fname;
              document.body.appendChild(a);
              a.click();
              a.remove();
              URL.revokeObjectURL(url);
              setMigrateExport({ status: "done", error: null });
            } catch (e: unknown) {
              const msg =
                e instanceof Error ? e.message : tAct("default_export_error");
              setMigrateExport({ status: "error", error: msg });
            }
          }}
          tMigrate={tMigrate}
        />
      )}

      {step === "backup" && showDeviceAddon && (
        <section className="review-rec-step">
          <h2>{tBackup("heading")}</h2>
          <p className="review-rec-step-sub">{tBackup("subtitle")}</p>

          <div className="review-rec-device-list">
            {devices.length === 0 ? (
              <p className="review-rec-step-sub">
                {tBackup("device_list_empty")}
              </p>
            ) : (
              devices.map((d) => (
                <label
                  className={`review-rec-device-row${selectedEcid === d.ecid ? " is-selected" : ""}`}
                  key={d.ecid}
                >
                  <input
                    checked={selectedEcid === d.ecid}
                    name="device"
                    onChange={() => setSelectedEcid(d.ecid)}
                    type="radio"
                  />
                  <div>
                    <div className="review-rec-device-name">
                      {d.name ??
                        d.deviceClass ??
                        tBackup("ios_device_fallback")}
                    </div>
                    <div className="review-rec-device-meta">
                      {[
                        d.deviceClass,
                        d.iosVersion ? `iOS ${d.iosVersion}` : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </div>
                  </div>
                </label>
              ))
            )}
          </div>

          {/* Device-match warning. Fires when the user has selected a
              connected device whose ECID isn't on file as a source for
              one or more of the queued-for-uninstall apps. Soft warning
              — the user can still proceed (maybe they imported the
              same app on a different device later, or the original
              import was CSV without an ECID), but a "are you sure
              you're on the right phone?" banner here saves a confusing
              cfgutil error message in the next step. */}
          {selectedEcid && deviceMatch.mismatched.length > 0 && (
            <div
              aria-live="polite"
              className="review-rec-device-mismatch"
              role="alert"
            >
              <strong>{tBackup("mismatch_heading")}</strong>
              <p>
                {tBackup("mismatch_body", {
                  count: deviceMatch.mismatched.length,
                })}
              </p>
              <ul>
                {deviceMatch.mismatched.slice(0, 6).map((row) => (
                  <li key={row.id}>
                    {row.name}
                    {row.developer ? ` — ${row.developer}` : ""}
                  </li>
                ))}
                {deviceMatch.mismatched.length > 6 && (
                  <li>
                    {tBackup("mismatch_more", {
                      count: deviceMatch.mismatched.length - 6,
                    })}
                  </li>
                )}
              </ul>
            </div>
          )}

          <div className="review-rec-step-actions">
            <button
              className="btn btn-primary"
              disabled={!selectedEcid || backup.status === "running"}
              onClick={runBackup}
              type="button"
            >
              {backup.status === "running"
                ? tBackup("running")
                : backup.status === "done"
                  ? tBackup("running_again")
                  : tBackup("run_backup")}
            </button>
            {backup.status === "done" && (
              <button
                className="btn btn-secondary"
                onClick={() => setStep("act")}
                type="button"
              >
                {tBackup("continue_to_uninstall")}
              </button>
            )}
            {backup.status !== "done" && backup.status !== "running" && (
              <button
                className="btn btn-ghost btn-sm"
                disabled={!selectedEcid}
                onClick={() => setStep("act")}
                title={tBackup("skip_backup_title")}
                type="button"
              >
                {tBackup("skip_backup")}
              </button>
            )}
          </div>

          {backup.status === "done" && backup.path && (
            <p className="review-rec-step-sub">
              {backup.finishedAt
                ? tBackup.rich("saved_at", {
                    path: backup.path,
                    time: new Date(backup.finishedAt).toLocaleTimeString(),
                    code: (chunks) => <code>{chunks}</code>,
                  })
                : tBackup.rich("saved_no_time", {
                    path: backup.path,
                    code: (chunks) => <code>{chunks}</code>,
                  })}
            </p>
          )}
          {backup.status === "error" && (
            <p className="review-rec-error" role="alert">
              {backup.error}
            </p>
          )}
        </section>
      )}

      {step === "act" && showDeviceAddon && (
        <section className="review-rec-step">
          <h2>{tAct("heading")}</h2>
          <p className="review-rec-step-sub">
            {tAct("subtitle_lead")} <strong>{tAct("subtitle_keyword")}</strong>{" "}
            {tAct("subtitle_after")}
          </p>

          {/* Backup status banner — surfaces whether a recent backup is
              on file so the user understands which Modal 2 variant
              they'll see. Fresh ✓ → reassuring; missing / stale ⚠ →
              warning. Drives no other behaviour here; the actual gate
              decision is made server-side when the bulk loop runs. */}
          {uninstallQueue.length > 0 && (
            <div
              className={`review-rec-backup-status${
                backup.status === "done"
                  ? " review-rec-backup-status-ok"
                  : " review-rec-backup-status-warn"
              }`}
              role="status"
            >
              {backup.status === "done" && backup.finishedAt ? (
                <span>
                  ✓{" "}
                  {tAct("backup_ok", {
                    device: backup.device?.name ?? tAct("default_device_name"),
                    time: new Date(backup.finishedAt).toLocaleTimeString(),
                  })}
                </span>
              ) : (
                <span>
                  ⚠ {tAct("backup_missing_warn")}{" "}
                  <button
                    className="review-rec-inline-link"
                    onClick={() => setStep("backup")}
                    type="button"
                  >
                    {tAct("backup_missing_action")}
                  </button>
                </span>
              )}
            </div>
          )}

          {uninstallQueue.length === 0 ? (
            <p className="review-rec-step-sub">{tAct("empty")}</p>
          ) : (
            <>
              <div className="review-rec-list">
                {uninstallQueue.map((row) => {
                  const state = uninstallStates[row.id] ?? {
                    status: "idle",
                    error: null,
                  };
                  return (
                    <article
                      className="review-rec-row review-rec-row-act"
                      key={row.id}
                    >
                      <div className="review-rec-row-head">
                        {row.iconUrl ? (
                          /* eslint-disable-next-line @next/next/no-img-element */
                          <img
                            alt=""
                            className="review-rec-row-icon"
                            height={40}
                            src={row.iconUrl}
                            width={40}
                          />
                        ) : (
                          <div className="review-rec-row-icon review-rec-row-icon-placeholder" />
                        )}
                        <div className="review-rec-row-meta">
                          <div className="review-rec-row-name">{row.name}</div>
                          {row.developer && (
                            <div className="review-rec-row-dev">
                              {row.developer}
                            </div>
                          )}
                        </div>
                        <div className="review-rec-row-action">
                          {state.status === "done" ? (
                            <span className="review-rec-row-status review-rec-row-status-done">
                              {tAct("removed")}
                            </span>
                          ) : state.status === "running" ? (
                            <span className="review-rec-row-status">
                              {tAct("removing")}
                            </span>
                          ) : state.status === "error" ? (
                            <span
                              className="review-rec-row-status review-rec-row-status-error"
                              title={state.error ?? undefined}
                            >
                              ✕ {tAct("failed")}
                            </span>
                          ) : (
                            <span className="review-rec-row-status review-rec-row-status-pending">
                              {tAct("pending")}
                            </span>
                          )}
                        </div>
                      </div>
                      {row.userVerdict?.rationale && (
                        <div className="review-rec-row-notes">
                          <p className="review-rec-row-reason">
                            &ldquo;{row.userVerdict.rationale}&rdquo;
                          </p>
                        </div>
                      )}
                      {state.status === "error" && state.error && (
                        <p className="review-rec-error" role="alert">
                          {state.error}
                        </p>
                      )}
                    </article>
                  );
                })}
              </div>

              {/* Single bulk-delete CTA. Opens Modal 1 (list + are you
                  sure) which advances to Modal 2 (type DELETE). The
                  button is hidden once the queue is fully done so users
                  don't get a useless control. Disabled while the bulk
                  loop is mid-flight. */}
              {(() => {
                const anyPending = uninstallQueue.some(
                  (row) =>
                    (uninstallStates[row.id]?.status ?? "idle") !== "done"
                );
                if (!anyPending) {
                  return (
                    <p className="review-rec-step-sub review-rec-step-sub-success">
                      ✓ {tAct("all_done")}
                    </p>
                  );
                }
                return (
                  <div className="review-rec-step-actions">
                    <button
                      className="btn btn-danger"
                      disabled={bulkModal === "executing"}
                      onClick={() => {
                        setBulkConfirmText("");
                        setBulkModal("list");
                      }}
                      type="button"
                    >
                      {bulkModal === "executing"
                        ? tAct("deleting_bulk")
                        : tAct("delete_apps_button", {
                            count: uninstallQueue.filter(
                              (row) =>
                                (uninstallStates[row.id]?.status ?? "idle") !==
                                "done"
                            ).length,
                          })}
                    </button>
                  </div>
                );
              })()}
            </>
          )}
        </section>
      )}

      {/* Manual-copy fallback modal — opens when every share path
          (Web Share, clipboard, execCommand) failed. Pre-selects
          the textarea content so the user only needs Cmd-C /
          Ctrl-C to grab it. The URL sits below as a separate
          line so it can be tapped/right-clicked independently. */}
      {shareFallback && (
        <div
          aria-label={tShareModal("title_aria")}
          aria-modal="true"
          className="review-rec-modal-overlay"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) {
              setShareFallback(null);
            }
          }}
          role="dialog"
        >
          <div
            className="review-rec-modal review-rec-share-modal"
            ref={shareFallbackCardRef}
            tabIndex={-1}
          >
            <h3>{tShareModal("heading")}</h3>
            <p>
              {tShareModal("body_lead")}{" "}
              <kbd className="kbd">{tShareModal("kbd_mac")}</kbd> /
              <kbd className="kbd">{tShareModal("kbd_win")}</kbd>
              {tShareModal("body_then")}
            </p>
            <textarea
              className="review-rec-share-fallback-text"
              readOnly
              ref={shareFallbackRef}
              rows={10}
              value={`${shareFallback.text}\n\n${shareFallback.url}`}
            />
            <div className="review-rec-modal-actions">
              <button
                className="btn btn-ghost"
                onClick={() => setShareFallback(null)}
                type="button"
              >
                {tShareModal("done")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal 1 — list of apps + "Are you sure?". First of two
          confirmation gates. Cancel returns the user to the act step
          unchanged; Continue advances to Modal 2. Closes on overlay
          click (we don't allow accidental dismissal while a delete is
          actually in flight; bulkModal === 'executing' suppresses both
          modals). */}
      {bulkModal === "list" && (
        <div
          aria-labelledby="bulk-confirm-title"
          aria-modal="true"
          className="review-rec-modal-overlay"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) {
              setBulkModal(null);
            }
          }}
          role="dialog"
        >
          <div className="review-rec-modal" ref={bulkListCardRef} tabIndex={-1}>
            <h3 id="bulk-confirm-title">
              {tConfirm("list_heading", {
                count: uninstallQueue.filter(
                  (row) =>
                    (uninstallStates[row.id]?.status ?? "idle") !== "done"
                ).length,
              })}
            </h3>
            <p>{tConfirm("list_body")}</p>
            <ul className="review-rec-bulk-list">
              {uninstallQueue
                .filter(
                  (row) =>
                    (uninstallStates[row.id]?.status ?? "idle") !== "done"
                )
                .map((row) => (
                  <li className="review-rec-bulk-list-row" key={row.id}>
                    {row.iconUrl ? (
                      /* eslint-disable-next-line @next/next/no-img-element */
                      <img
                        alt=""
                        className="review-rec-bulk-list-icon"
                        height={28}
                        src={row.iconUrl}
                        width={28}
                      />
                    ) : (
                      <span
                        aria-hidden="true"
                        className="review-rec-bulk-list-icon review-rec-bulk-list-icon-placeholder"
                      />
                    )}
                    <span className="review-rec-bulk-list-text">
                      <strong>{row.name}</strong>
                      {row.developer ? ` — ${row.developer}` : ""}
                      {!row.bundleId && (
                        <span className="review-rec-bulk-list-warn">
                          {" "}
                          {tConfirm("list_no_bundle")}
                        </span>
                      )}
                    </span>
                  </li>
                ))}
            </ul>
            <div className="review-rec-modal-actions">
              <button
                className="btn btn-ghost"
                onClick={() => setBulkModal(null)}
                type="button"
              >
                {tConfirm("cancel")}
              </button>
              <button
                className="btn btn-danger"
                onClick={() => {
                  setBulkConfirmText("");
                  setBulkModal("final");
                }}
                type="button"
              >
                {tConfirm("list_continue")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal 2 — type DELETE final gate. Two copy variants:
            - Fresh backup: reassuring "this is the final step" tone.
            - Missing / stale backup: louder "no recent backup — at
              your own risk" tone. Same keyword (`DELETE`) in both
              variants so the user only has to learn one phrase; the
              `acknowledgeNoBackup` flag flows through to the API
              when no backup is on file. */}
      {bulkModal === "final" && (
        <div
          aria-labelledby="bulk-final-title"
          aria-modal="true"
          className="review-rec-modal-overlay"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) {
              setBulkModal(null);
            }
          }}
          role="dialog"
        >
          <div
            className="review-rec-modal"
            ref={bulkFinalCardRef}
            tabIndex={-1}
          >
            {backup.status === "done" && backup.finishedAt ? (
              <>
                <h3 id="bulk-final-title">{tConfirm("final_heading")}</h3>
                <p>
                  {tConfirm("final_body", {
                    device:
                      backup.device?.name ?? tConfirm("fallback_device_name"),
                    time: new Date(backup.finishedAt).toLocaleTimeString(),
                  })}
                </p>
              </>
            ) : (
              <>
                <h3
                  className="review-rec-modal-title-warn"
                  id="bulk-final-title"
                >
                  ⚠ {tConfirm("final_no_backup_heading")}
                </h3>
                <p className="review-rec-modal-warn">
                  {tConfirm("final_no_backup_body")}
                </p>
              </>
            )}
            <p>
              {tConfirm("type_delete_prompt")}{" "}
              <strong>{tConfirm("type_delete_keyword")}</strong>{" "}
              {tConfirm("type_delete_suffix")}
            </p>
            <input
              autoComplete="off"
              autoFocus
              className="review-rec-confirm-input"
              onChange={(e) => setBulkConfirmText(e.target.value)}
              placeholder={tConfirm("type_placeholder")}
              ref={confirmInputRef}
              spellCheck={false}
              type="text"
              value={bulkConfirmText}
            />
            <div className="review-rec-modal-actions">
              <button
                className="btn btn-ghost"
                onClick={() => setBulkModal(null)}
                type="button"
              >
                {tConfirm("cancel")}
              </button>
              <button
                className="btn btn-danger"
                disabled={bulkConfirmText !== "DELETE"}
                onClick={() => {
                  const acknowledgeNoBackup = backup.status !== "done";
                  void runBulkUninstall(acknowledgeNoBackup);
                }}
                type="button"
              >
                {backup.status === "done"
                  ? tConfirm("final_confirm")
                  : tConfirm("final_confirm_no_backup")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Print-only checklist. Real <a href> elements for App Store
          URLs so the printed PDF carries the links — tap-to-open
          works in the iOS Files app preview. App icons are inline
          <img>s sourced from the same iconUrl the screen view uses;
          most browsers preserve them in the saved PDF. */}
      <div aria-hidden="true" className="review-rec-print">
        <h1>{tPrint("title")}</h1>
        <p className="review-rec-print-meta">
          {tPrint("generated", { date: new Date().toLocaleString() })}
        </p>

        {uninstallQueue.length > 0 && (
          <section>
            <h2>
              {tPrint("uninstall_heading", { count: uninstallQueue.length })}
            </h2>
            <ul>
              {uninstallQueue.map((row) => (
                <PrintRow
                  appStoreLinkLabel={tPrint("app_store_link")}
                  key={row.id}
                  row={row}
                />
              ))}
            </ul>
          </section>
        )}

        {replaceQueue.length > 0 && (
          <section>
            <h2>{tPrint("replace_heading", { count: replaceQueue.length })}</h2>
            <p className="review-rec-print-hint">{tPrint("replace_hint")}</p>
            <ul>
              {replaceQueue.map((row) => (
                <PrintRow
                  appStoreLinkLabel={tPrint("app_store_link")}
                  key={row.id}
                  row={row}
                  swap={replacements[row.id]?.trim()}
                />
              ))}
            </ul>
          </section>
        )}

        {safeQueue.length > 0 && (
          <section>
            <h2>{tPrint("safe_heading", { count: safeQueue.length })}</h2>
            <ul>
              {safeQueue.map((row) => (
                <PrintRow
                  appStoreLinkLabel={tPrint("app_store_link")}
                  key={row.id}
                  row={row}
                />
              ))}
            </ul>
          </section>
        )}

        {uninstallQueue.length === 0 &&
          replaceQueue.length === 0 &&
          safeQueue.length === 0 && <p>{tPrint("empty")}</p>}
      </div>
    </main>
  );
}

/**
 * Single row inside the printable checklist. Renders the app icon
 * next to the name + developer + tap-open App Store link, all on
 * one line. Used by all three sections (uninstall / replace / safe)
 * so the printed groups stay visually consistent.
 *
 * The icon is an inline `<img>` rather than a CSS `background-image`
 * so the saved PDF carries the bitmap. Browsers preserve `<a href>`
 * elements when "Save as PDF" runs; the iOS Files app preview opens
 * App Store links by tap-and-hold → Open in Browser → redirected
 * into the App Store.
 */
function PrintRow({
  row,
  swap,
  appStoreLinkLabel,
}: {
  row: Row;
  swap?: string;
  appStoreLinkLabel: string;
}) {
  return (
    <li className="review-rec-print-row">
      {row.iconUrl ? (
        /* eslint-disable-next-line @next/next/no-img-element */
        <img
          alt=""
          className="review-rec-print-icon"
          height={28}
          src={row.iconUrl}
          width={28}
        />
      ) : (
        <span className="review-rec-print-icon review-rec-print-icon-placeholder" />
      )}
      <span className="review-rec-print-row-body">
        <strong>{row.name}</strong>
        {row.developer ? ` · ${row.developer}` : ""}
        {swap && (
          <>
            {" "}
            → <strong>{swap}</strong>
          </>
        )}
        {isSafeExternalHref(row.url) && (
          <>
            {" · "}
            <a href={row.url!}>{appStoreLinkLabel}</a>
          </>
        )}
        {row.userVerdict?.rationale && (
          <span className="review-rec-print-reason">
            &ldquo;{row.userVerdict.rationale}&rdquo;
          </span>
        )}
      </span>
    </li>
  );
}

/**
 * Profile-match badge inline in the row. Reuses the same data shape
 * the Apps grid renders, but at chip size so it sits next to the
 * app name without taking over the title row. Hides itself when
 * the user has no profile set (`badge` is null on those rows).
 */
function ProfileBadge({ badge }: { badge: AppProfileBadge }) {
  return (
    <span
      aria-label={badge.description}
      className={`review-rec-profile-badge match-${badge.tone}`}
      title={badge.description}
    >
      {badge.label}
    </span>
  );
}

/**
 * One group block in the Save step's on-screen summary. Mirrors the
 * print version but renders interactive App Store links + the
 * "replacing with" memo inline so the user can sanity-check what
 * the saved checklist will contain before they print or share.
 */
function SummaryGroup({
  title,
  tone,
  rows,
  replacements,
  appStoreLinkLabel,
  replacementLabel,
  replacementLinkAria,
}: {
  title: string;
  tone: "ok" | "warn" | "bad";
  rows: Row[];
  replacements?: Record<string, string>;
  /** Localised label for the inline App Store link — comes from
   *  `review_rec.action.share_app_store_link`. Threaded down rather
   *  than re-hooking useTranslations inside the helper to keep the
   *  component pure and avoid double-instantiation of the t-fn. */
  appStoreLinkLabel: string;
  /**
   * Localised "Replacing with" label rendered above the chosen
   * replacement candidate. Threaded as a prop (rather than re-hooking
   * useTranslations inside the helper) for the same reason as the
   * App Store link label.
   */
  replacementLabel?: string;
  /**
   * Builder for the App Store link's aria-label on the replacement
   * candidate. Caller passes `name => tAction('replacement_link_label',
   * { name })` so this helper stays pure.
   */
  replacementLinkAria?: (name: string) => string;
}) {
  return (
    <section
      className={`review-rec-summary-group review-rec-summary-group-${tone}`}
    >
      <h3>{title}</h3>
      <ul>
        {rows.map((row) => {
          const swap = replacements?.[row.id]?.trim();
          // When we have a chosen replacement name, look up the
          // matching shortlist candidate so we can render the
          // candidate's icon + clickable App Store link inline.
          // Falls back to bare-text when the name doesn't match any
          // shortlist entry (the user typed a free-form replacement).
          const swapCandidate = swap
            ? row.shortlistCandidates.find(
                (c) =>
                  c.candidateName.trim().toLowerCase() === swap.toLowerCase()
              )
            : undefined;
          return (
            <li className="review-rec-summary-row" key={row.id}>
              {/* App icon — same 32px thumbnail the AppGrid renders, sized
                  down so the row stays compact. Falls back to a tinted
                  placeholder when the app has no stored iconUrl (sample
                  data, manual entry, etc.). */}
              {row.iconUrl ? (
                /* eslint-disable-next-line @next/next/no-img-element */
                <img
                  alt=""
                  className="review-rec-summary-icon"
                  height={32}
                  src={row.iconUrl}
                  width={32}
                />
              ) : (
                <div className="review-rec-summary-icon review-rec-summary-icon-placeholder" />
              )}
              <div className="review-rec-summary-body">
                <div className="review-rec-summary-line">
                  <Link
                    className="review-rec-summary-name"
                    href={`/apps/${row.id}`}
                  >
                    {row.name}
                  </Link>
                  {row.developer && (
                    <span className="review-rec-summary-dev">
                      {" "}
                      · {row.developer}
                    </span>
                  )}
                  {isSafeExternalHref(row.url) && (
                    <a
                      className="review-rec-summary-link"
                      href={row.url!}
                      rel="noopener"
                      target="_blank"
                    >
                      {appStoreLinkLabel}
                    </a>
                  )}
                </div>
                {/* Replacement row — appears whenever the user has
                    something in `replacements[row.id]`. When we can
                    match it to a shortlist candidate we render the
                    candidate's icon + name + an explicit App Store
                    link to its store page. When we can't (free-form
                    text replacement), we fall back to a plain bold
                    name so the recipient still sees what the user
                    plans to switch to. */}
                {swap && (
                  <div className="review-rec-summary-replacement">
                    {replacementLabel && (
                      <span className="review-rec-summary-replacement-label">
                        {replacementLabel}
                      </span>
                    )}
                    {swapCandidate?.candidateIconUrl ? (
                      /* eslint-disable-next-line @next/next/no-img-element */
                      <img
                        alt=""
                        className="review-rec-summary-replacement-icon"
                        height={20}
                        src={swapCandidate.candidateIconUrl}
                        width={20}
                      />
                    ) : (
                      <span
                        aria-hidden="true"
                        className="review-rec-summary-replacement-icon review-rec-summary-replacement-icon-placeholder"
                      />
                    )}
                    <strong className="review-rec-summary-replacement-name">
                      {swap}
                    </strong>
                    {swapCandidate?.candidateStoreUrl && (
                      <a
                        aria-label={
                          replacementLinkAria
                            ? replacementLinkAria(swap)
                            : undefined
                        }
                        className="review-rec-summary-replacement-link"
                        href={swapCandidate.candidateStoreUrl}
                        rel="noopener"
                        target="_blank"
                      >
                        {appStoreLinkLabel}
                      </a>
                    )}
                  </div>
                )}
                {row.userVerdict?.rationale && (
                  <div className="review-rec-summary-reason">
                    &ldquo;{row.userVerdict.rationale}&rdquo;
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * Modal helper for the desktop-migration wizard. Pure presentational —
 * the parent owns the export-status state and the close handler. Pulled
 * out of the main render so the action step's JSX stays scannable.
 */
function MigrateModal({
  tMigrate,
  exportStatus,
  exportError,
  onClose,
  onExport,
}: {
  tMigrate: ReturnType<typeof useTranslations>;
  exportStatus: "idle" | "busy" | "done" | "error";
  exportError: string | null;
  onClose: () => void;
  onExport: () => void | Promise<void>;
}) {
  // Public macOS-build download page. Hard-coded for v1 — the URL
  // doesn't change per-locale and threading it through i18n would
  // make a future rename harder. Update here if the release page
  // moves; the translation `step_1_link` is the human label only.
  // Source of truth: `GITHUB_REPO` in app/privacy-policy/page.tsx
  // (and AboutModal / GithubIssueLink, which all already point at
  // privacykey/privacytracker). Keep this in sync if the repo is
  // ever renamed.
  const DESKTOP_DOWNLOAD_URL =
    "https://github.com/privacykey/privacytracker/releases/latest";

  const migrateCardRef = useModalFocus<HTMLDivElement>({
    open: true,
    onClose,
    closeOnEscape: true,
  });

  return (
    <div
      aria-label={tMigrate("title_aria")}
      aria-modal="true"
      className="review-rec-modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) {
          onClose();
        }
      }}
      role="dialog"
    >
      <div
        className="review-rec-modal review-rec-modal-wide"
        ref={migrateCardRef}
        tabIndex={-1}
      >
        <header className="review-rec-migrate-modal-head">
          <h3>{tMigrate("heading")}</h3>
          <button
            aria-label={tMigrate("close_aria")}
            className="review-rec-migrate-modal-close"
            onClick={onClose}
            type="button"
          >
            ✕
          </button>
        </header>
        <p className="review-rec-migrate-modal-intro">{tMigrate("intro")}</p>

        <ol className="review-rec-migrate-steps">
          <li>
            <h4>{tMigrate("step_1_title")}</h4>
            <p>{tMigrate("step_1_body")}</p>
            <a
              className="btn btn-secondary"
              href={DESKTOP_DOWNLOAD_URL}
              rel="noopener"
              target="_blank"
            >
              {tMigrate("step_1_link")}
            </a>
          </li>
          <li>
            <h4>{tMigrate("step_2_title")}</h4>
            <p>{tMigrate("step_2_body")}</p>
            <button
              className="btn btn-primary"
              disabled={exportStatus === "busy"}
              onClick={onExport}
              type="button"
            >
              {exportStatus === "busy"
                ? tMigrate("step_2_busy")
                : tMigrate("step_2_button")}
            </button>
            {exportStatus === "done" && (
              <p
                className="review-rec-migrate-export-status review-rec-migrate-export-status-ok"
                role="status"
              >
                {tMigrate("step_2_done")}
              </p>
            )}
            {exportStatus === "error" && (
              <p
                className="review-rec-migrate-export-status review-rec-migrate-export-status-err"
                role="alert"
              >
                {exportError ?? tMigrate("step_2_error")}
              </p>
            )}
          </li>
          <li>
            <h4>{tMigrate("step_3_title")}</h4>
            <p>{tMigrate("step_3_body")}</p>
          </li>
        </ol>

        <div className="review-rec-modal-actions">
          <button className="btn btn-ghost" onClick={onClose} type="button">
            {tMigrate("close")}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * "Replacing with" combobox — text input with a dropdown of matching
 * shortlist candidates. Matches against both the candidate's name AND
 * its developer (case-insensitive substring) so users can type either
 * a brand or a publisher and find their pick. The dropdown opens on
 * focus when there's at least one candidate, and on every keystroke;
 * arrow-key navigation + Enter to select keep keyboard users on par
 * with mouse users.
 *
 * Picking a suggestion calls onPick(name) — same path the chip cluster
 * above uses, which writes through pickShortlistCandidate. Free-form
 * typing falls through to onChange(text) so the text persists in
 * `replacements[row.id]` for the print + share payload.
 */
function ReplacingWithCombobox({
  row,
  value,
  onChange,
  onPick,
  labelText,
  placeholder,
}: {
  row: Row;
  value: string;
  onChange: (next: string) => void;
  onPick: (name: string) => void;
  labelText: string;
  placeholder: string;
}) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const inputId = `replace-${row.id}`;
  const listboxId = `replace-${row.id}-listbox`;
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Match shortlist candidates against the typed value. We split the
  // typed value into tokens so "signal proton" still matches a Proton
  // app published by Signal-Foundation. Empty value → show all
  // candidates so a focused input on a row with shortlist entries
  // already surfaces them.
  const suggestions = useMemo(() => {
    const tokens = value
      .toLowerCase()
      .split(/\s+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
    return row.shortlistCandidates.filter((c) => {
      const haystack =
        `${c.candidateName} ${c.candidateDeveloper}`.toLowerCase();
      return tokens.length === 0 || tokens.every((t) => haystack.includes(t));
    });
  }, [row.shortlistCandidates, value]);

  // Close on outside click. We use a ref-rooted check so a click on
  // any descendant (suggestion item, input, etc.) stays open.
  useEffect(() => {
    if (!open) {
      return;
    }
    // `pointerdown` (not `mousedown`) so iOS Safari's touch input
    // dismisses the suggestion dropdown on outside-tap. See
    // `AppDetailView.tsx` for the canonical comment.
    function onDoc(e: PointerEvent) {
      if (!containerRef.current) {
        return;
      }
      if (!containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("pointerdown", onDoc);
    return () => document.removeEventListener("pointerdown", onDoc);
  }, [open]);

  // Reset highlight whenever suggestions change so the up/down nav
  // never lands on an out-of-range index.
  useEffect(() => {
    setHighlight((h) => (h >= suggestions.length ? 0 : h));
  }, [suggestions.length]);

  // No candidates at all → render as a plain input. This avoids
  // showing an empty dropdown affordance for rows that haven't been
  // through the Compare/shortlist flow yet.
  const hasCandidates = row.shortlistCandidates.length > 0;

  return (
    <div className="review-rec-row-replacement" ref={containerRef}>
      <label className="review-rec-row-replacement-label" htmlFor={inputId}>
        {labelText}
      </label>
      <input
        aria-activedescendant={
          hasCandidates && open && suggestions[highlight]
            ? `${listboxId}-${highlight}`
            : undefined
        }
        aria-autocomplete={hasCandidates ? "list" : undefined}
        aria-controls={hasCandidates ? listboxId : undefined}
        aria-expanded={hasCandidates ? open : undefined}
        autoComplete="off"
        className="review-rec-row-replacement-input"
        id={inputId}
        maxLength={120}
        onChange={(e) => {
          onChange(e.target.value);
          if (hasCandidates) {
            setOpen(true);
          }
        }}
        onFocus={() => hasCandidates && setOpen(true)}
        onKeyDown={(e) => {
          if (!hasCandidates) {
            return;
          }
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setOpen(true);
            setHighlight((h) => Math.min(h + 1, suggestions.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setOpen(true);
            setHighlight((h) => Math.max(h - 1, 0));
          } else if (e.key === "Enter") {
            if (open && suggestions[highlight]) {
              e.preventDefault();
              onPick(suggestions[highlight].candidateName);
              setOpen(false);
            }
          } else if (e.key === "Escape") {
            setOpen(false);
          }
        }}
        placeholder={placeholder}
        role={hasCandidates ? "combobox" : undefined}
        type="text"
        value={value}
      />
      {hasCandidates && open && suggestions.length > 0 && (
        <ul className="review-rec-row-replacement-suggestions" id={listboxId}>
          {suggestions.map((s, i) => {
            const active = i === highlight;
            return (
              <li
                aria-selected={active}
                className={`review-rec-row-replacement-suggestion${
                  active ? " is-active" : ""
                }`}
                id={`${listboxId}-${i}`}
                key={s.id}
                // Use mousedown instead of click so the input's blur
                // handler (which would close the popover before the
                // click lands) can't race us. We also stop default so
                // the input keeps focus through the pick.
                onMouseDown={(e) => {
                  e.preventDefault();
                  onPick(s.candidateName);
                  setOpen(false);
                }}
                onMouseEnter={() => setHighlight(i)}
              >
                {s.candidateIconUrl ? (
                  /* eslint-disable-next-line @next/next/no-img-element */
                  <img
                    alt=""
                    className="review-rec-row-replacement-suggestion-icon"
                    height={22}
                    src={s.candidateIconUrl}
                    width={22}
                  />
                ) : (
                  <span
                    aria-hidden="true"
                    className="review-rec-row-replacement-suggestion-icon review-rec-row-replacement-suggestion-icon-placeholder"
                  />
                )}
                <span className="review-rec-row-replacement-suggestion-body">
                  <span className="review-rec-row-replacement-suggestion-name">
                    {s.candidateName}
                  </span>
                  {s.candidateDeveloper && (
                    <span className="review-rec-row-replacement-suggestion-dev">
                      {s.candidateDeveloper}
                    </span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SavedNotesPreview — read-only preview of a row's existing notes
// ---------------------------------------------------------------------------
//
// Surfaces up to 3 of the user's existing notes for an app inside
// the Compare step, so when they're picking a replacement they can
// see the context they captured earlier (e.g. "kids spend too much
// time here", "asks for too many permissions on launch") without
// having to navigate away. The preview is intentionally read-only —
// the canonical edit affordance lives on /apps/[id], and we link
// there explicitly via the "Edit" link.
//
// Tag chips reuse the same colour tokens as the AnnotationsSidebar
// chip variants so the preview reads as "the same notes" rather
// than a separate concept.

const NOTE_TAG_LABEL_KEYS: Record<string, string> = {
  concern: "tag_concern",
  positive: "tag_positive",
  follow_up: "tag_follow_up",
  other: "tag_other",
};

/** Strip markdown syntax for the preview line — we don't render
 *  rich markup in the inline list, so a plain-text condensed form
 *  reads cleaner than rendered HTML at 12px. Removes wrappers like
 *  `**`, `*`, `__`, `~~`, backticks, and replaces link `[text](url)`
 *  with just the text. Anything else is kept verbatim. */
function condenseMarkdown(input: string): string {
  return input
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "") // images → drop
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links → keep label
    .replace(/`([^`]+)`/g, "$1") // inline code
    .replace(/\*\*([^*]+)\*\*/g, "$1") // bold
    .replace(/__([^_]+)__/g, "$1") // bold (alt)
    .replace(/\*([^*]+)\*/g, "$1") // italic
    .replace(/_([^_]+)_/g, "$1") // italic (alt)
    .replace(/~~([^~]+)~~/g, "$1") // strikethrough
    .replace(/^#+\s+/gm, "") // heading markers
    .replace(/^>\s+/gm, "") // blockquote markers
    .replace(/^[-*]\s+/gm, "") // bullet markers
    .replace(/^\d+\.\s+/gm, "") // ordered list markers
    .replace(/\s+/g, " ") // collapse whitespace
    .trim();
}

function truncate(s: string, n: number): string {
  if (s.length <= n) {
    return s;
  }
  return `${s.slice(0, n).trimEnd()}…`;
}

interface SavedNotesPreviewProps {
  row: { id: string; notes: Annotation[] };
}

function SavedNotesPreview({ row }: SavedNotesPreviewProps) {
  const tNotes = useTranslations("review_rec.saved_notes");
  const MAX_VISIBLE = 3;
  const visible = row.notes.slice(0, MAX_VISIBLE);
  const hidden = row.notes.length - visible.length;

  return (
    <div className="review-rec-row-saved-notes">
      <div className="review-rec-row-saved-notes-label">
        <span>
          {tNotes("heading")}
          <span className="review-rec-row-saved-notes-count">
            {row.notes.length}
          </span>
        </span>
        <Link
          className="review-rec-row-saved-notes-edit"
          href={`/apps/${row.id}#annotations-sidebar-title`}
        >
          {tNotes("edit_link")}
        </Link>
      </div>
      <ul className="review-rec-row-saved-notes-list">
        {visible.map((note) => (
          <li
            className={`review-rec-saved-note review-rec-saved-note--tag-${note.tag ?? "none"}`}
            key={note.id}
          >
            {note.tag && (
              <span className="review-rec-saved-note-tag">
                {NOTE_TAG_LABEL_KEYS[note.tag]
                  ? tNotes(NOTE_TAG_LABEL_KEYS[note.tag])
                  : note.tag}
              </span>
            )}
            <p className="review-rec-saved-note-content">
              {truncate(condenseMarkdown(note.content), 220)}
            </p>
          </li>
        ))}
        {hidden > 0 && (
          <li className="review-rec-saved-note-more">
            {tNotes("more_on_app_page", { count: hidden })}
          </li>
        )}
      </ul>
    </div>
  );
}
