"use client";

/**
 * FocusFlagMatrix — author the desired flag state across every
 * (audience × goals) combination.
 *
 * Layout
 *   ┌──────────────┬─────────────────────────── 12 combo columns ───────────────────────────┐
 *   │ flag key     │ self·U │ self·D │ self·U+D │ self·M │ loved·U │ … │ guardian·M │
 *   │              ├────────┼────────┼──────────┼────────┼─────────┼───┼────────────┤
 *   │ flag.x.y     │   on   │  off   │    on    │  off   │   on    │…  │     off    │
 *   └──────────────┴─────────────────────────────────────────────────────────────────────────┘
 *
 * Each cell shows two values stacked: the resolver-derived current
 * value (top, faint) and the user's authored desired value (bottom,
 * solid). Clicking a cell cycles desired through `on → off → collapsed
 * → unset`; "unset" means "match the resolver", and the cell renders
 * empty so the table reads as "no opinion here yet".
 *
 * Rows are grouped by surface (`flag.<surface>.…`) inside collapsible
 * sections so the ~204 keys don't collapse into an unreadable wall.
 *
 * Persistence is intentionally **local** for v1: the spec is a
 * draft / documentation artifact that lives in localStorage. Authors
 * iterate freely, then promote a combo into live overrides via the
 * `Apply combo as overrides` button (which posts to the existing
 * `/api/feature-flags/overrides` bulk shape). When the spec stabilises
 * the `Copy as TS patch` button emits a draft AUDIENCE_RULES /
 * GOAL_RULES diff ready to paste into `lib/feature-flag-rules.ts`.
 */

import { useTranslations } from "next-intl";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  ACCESSIBILITY_RULES,
  AUDIENCE_RULES,
  type Audience,
  FLAG_DEPENDENCIES,
  type FlagKey,
  type FlagValue,
  GOAL_RULES,
  HARD_DEFAULTS,
  type Modifier,
  type PrimaryGoal,
} from "@/lib/feature-flag-rules";
import { useModalFocus } from "../../lib/use-modal-focus";

// ── Combo definition ────────────────────────────────────────────────
//
// 3 audiences × 4 primary goal sets = 12 combos. Accessibility is a
// separate column toggle (off by default) since it stacks with any
// primary goal — flipping it on layers ACCESSIBILITY_RULES across
// every column at once.

type GoalSetKey =
  | "understand"
  | "declutter"
  | "understand+declutter"
  | "minimal";

interface ComboDef {
  audience: Audience;
  goalSet: GoalSetKey;
  /** Compact 4-char column header (e.g. "self·U") */
  header: string;
  /** Long form for the tooltip / copy-paste output */
  longHeader: string;
}

const AUDIENCES: readonly Audience[] = ["self", "loved_one", "guardian"];
const GOAL_SETS: readonly GoalSetKey[] = [
  "understand",
  "declutter",
  "understand+declutter",
  "minimal",
];

const AUDIENCE_LABEL: Record<Audience, string> = {
  self: "self",
  loved_one: "loved",
  guardian: "guardian",
};

const GOAL_SHORT: Record<GoalSetKey, string> = {
  understand: "U",
  declutter: "D",
  "understand+declutter": "U+D",
  minimal: "M",
};

const COMBOS: ComboDef[] = AUDIENCES.flatMap((audience) =>
  GOAL_SETS.map<ComboDef>((goalSet) => ({
    audience,
    goalSet,
    header: `${AUDIENCE_LABEL[audience]}·${GOAL_SHORT[goalSet]}`,
    longHeader: `${audience} · ${goalSet}`,
  }))
);

function goalsFor(
  goalSet: GoalSetKey,
  accessibility: boolean
): Set<PrimaryGoal | Modifier> {
  const goals = new Set<PrimaryGoal | Modifier>();
  if (goalSet === "understand") {
    goals.add("understand");
  } else if (goalSet === "declutter") {
    goals.add("declutter");
  } else if (goalSet === "understand+declutter") {
    goals.add("understand");
    goals.add("declutter");
  } else if (goalSet === "minimal") {
    goals.add("minimal");
  }
  if (accessibility) {
    goals.add("accessibility");
  }
  return goals;
}

// ── Mini-resolver ────────────────────────────────────────────────────
//
// Faithfully reproduces `computeFlag` from `lib/feature-flags.ts`
// minus the user-override + kill-switch + Tauri layers, which aren't
// meaningful in a "what should the rule tables say" view. The tour /
// dependency / accessibility logic is preserved so the matrix matches
// what users will actually see.

function resolveFor(
  key: FlagKey,
  audience: Audience,
  goals: Set<PrimaryGoal | Modifier>
): FlagValue {
  let value: FlagValue = HARD_DEFAULTS[key];

  const audienceRule = AUDIENCE_RULES[audience][key];
  if (audienceRule !== undefined) {
    value = audienceRule;
  }

  for (const goal of ["understand", "declutter", "minimal"] as const) {
    if (goals.has(goal)) {
      const r = GOAL_RULES[goal][key];
      if (r !== undefined) {
        value = r;
      }
    }
  }

  if (goals.has("accessibility")) {
    const r = ACCESSIBILITY_RULES[key];
    if (r !== undefined) {
      value = r;
    }
  }

  const parent = FLAG_DEPENDENCIES[key];
  if (parent) {
    const parentValue = resolveFor(parent, audience, goals);
    if (parentValue !== "on") {
      value = "off";
    }
  }

  return value;
}

// ── Spec storage ─────────────────────────────────────────────────────
//
// localStorage shape:
//   {
//     accessibility: boolean,
//     desired: {
//       [comboId]: { [flagKey]: 'on' | 'off' | 'collapsed' }
//     }
//   }
//
// Combo id matches `${audience}/${goalSet}` so it's stable across
// renders and easy to grep for in exports.

const STORAGE_KEY = "focus-flag-matrix-spec-v1";

interface SpecBlob {
  accessibility: boolean;
  desired: Record<string, Partial<Record<FlagKey, FlagValue>>>;
}

function comboId(combo: ComboDef): string {
  return `${combo.audience}/${combo.goalSet}`;
}

function readSpec(): SpecBlob {
  if (typeof window === "undefined") {
    return { accessibility: false, desired: {} };
  }
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return { accessibility: false, desired: {} };
    }
    const parsed = JSON.parse(raw) as SpecBlob;
    if (!parsed || typeof parsed !== "object") {
      return { accessibility: false, desired: {} };
    }
    return {
      accessibility: !!parsed.accessibility,
      desired:
        parsed.desired && typeof parsed.desired === "object"
          ? parsed.desired
          : {},
    };
  } catch {
    return { accessibility: false, desired: {} };
  }
}

function writeSpec(spec: SpecBlob) {
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(spec));
  } catch {
    // localStorage quota / disabled — drop silently. The in-memory
    // spec keeps working until the page reloads.
  }
}

const VALUE_CYCLE: Array<FlagValue | null> = ["on", "off", "collapsed", null];

function nextValue(current: FlagValue | null | undefined): FlagValue | null {
  const idx = VALUE_CYCLE.indexOf((current ?? null) as FlagValue | null);
  return VALUE_CYCLE[(idx + 1) % VALUE_CYCLE.length];
}

// Surface labels mirror DevMenu's SURFACE_LABELS — kept in sync by
// hand because importing it would pull in the whole popover.
const SURFACE_LABELS: Record<string, string> = {
  about: "About",
  appgrid: "App grid",
  dashboard: "Dashboard",
  desktop: "Desktop (Tauri)",
  detail: "App detail",
  devopts: "Developer options",
  global: "Global",
  help: "Help",
  legal: "Legal",
  nav: "Navigation",
  notifications: "Notifications",
  onboarding: "Onboarding",
  page: "Secondary pages",
  settings: "Settings",
  shortlist: "Shortlist",
  stats: "Stats",
  taskcenter: "Task center",
};

// ── Component ────────────────────────────────────────────────────────

export interface FocusFlagMatrixProps {
  rows: Array<{ key: FlagKey; surface: string; hardDefault: FlagValue }>;
}

// Modal-staged destructive actions. Mirrors the `.modal-overlay` /
// `.modal-card` pattern used in SettingsView's wayback-remove + reset
// dialogs so the dev-options matrix doesn't fall back to native
// `window.confirm()` boxes that don't match the rest of the app.
type PendingConfirm =
  | { kind: "clear" }
  | { kind: "seed" }
  | { kind: "apply"; combo: ComboDef; cellCount: number };

export default function FocusFlagMatrix({ rows }: FocusFlagMatrixProps) {
  const tMatrix = useTranslations("dev_options.focus_matrix");
  // Hydrate-once snapshot of the local spec. We deliberately don't
  // sync across tabs — this is a single-author drafting tool.
  const [spec, setSpec] = useState<SpecBlob>(() => readSpec());
  const [filter, setFilter] = useState("");
  const [showOnlyDeltas, setShowOnlyDeltas] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(
    null
  );
  const [applying, setApplying] = useState(false);

  const flashToast = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(
      () => setToast((prev) => (prev === message ? null : prev)),
      2400
    );
  }, []);

  const setAccessibility = useCallback((next: boolean) => {
    setSpec((prev) => {
      const updated = { ...prev, accessibility: next };
      writeSpec(updated);
      return updated;
    });
  }, []);

  const setCell = useCallback(
    (combo: ComboDef, key: FlagKey, value: FlagValue | null) => {
      setSpec((prev) => {
        const id = comboId(combo);
        const desiredForCombo = { ...(prev.desired[id] ?? {}) };
        if (value === null) {
          delete desiredForCombo[key];
        } else {
          desiredForCombo[key] = value;
        }
        const next: SpecBlob = {
          ...prev,
          desired: { ...prev.desired, [id]: desiredForCombo },
        };
        writeSpec(next);
        return next;
      });
    },
    []
  );

  // Stage-1: open the confirm modal. The actual mutation happens in
  // `runPendingConfirm` once the user clicks the Confirm button.
  const clearAll = useCallback(() => {
    setPendingConfirm({ kind: "clear" });
  }, []);

  const seedFromCurrentRules = useCallback(() => {
    setPendingConfirm({ kind: "seed" });
  }, []);

  // Filter + only-deltas. We compute resolver values lazily inside the
  // memoised list because changing accessibility changes every row.
  const visibleRows = useMemo(() => {
    const fLower = filter.trim().toLowerCase();
    return rows.filter((r) => {
      if (
        fLower &&
        !r.key.toLowerCase().includes(fLower) &&
        !r.surface.includes(fLower)
      ) {
        return false;
      }
      if (!showOnlyDeltas) {
        return true;
      }
      // "Delta" rows are ones where any combo's desired value differs
      // from the resolver-derived value. Useful for finding "what
      // have I actually authored".
      for (const combo of COMBOS) {
        const desired = spec.desired[comboId(combo)]?.[r.key];
        if (desired === undefined) {
          continue;
        }
        const goals = goalsFor(combo.goalSet, spec.accessibility);
        const current = resolveFor(r.key, combo.audience, goals);
        if (desired !== current) {
          return true;
        }
      }
      return false;
    });
  }, [rows, filter, showOnlyDeltas, spec]);

  const grouped = useMemo(() => {
    const byPlatform: Record<string, typeof visibleRows> = {};
    for (const r of visibleRows) {
      (byPlatform[r.surface] ||= []).push(r);
    }
    return Object.entries(byPlatform).sort(([a], [b]) => a.localeCompare(b));
  }, [visibleRows]);

  // ── Exports ───────────────────────────────────────────────────────

  const copyToClipboard = useCallback(
    async (text: string, label: string) => {
      try {
        await navigator.clipboard.writeText(text);
        flashToast(tMatrix("toast_copied", { label }));
      } catch {
        // Older browsers / iframes without clipboard permission. Fall
        // back to a textarea-select trick so the user can still copy.
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        try {
          document.execCommand("copy");
          flashToast(tMatrix("toast_copied", { label }));
        } catch {
          flashToast(tMatrix("toast_copy_failed"));
        } finally {
          document.body.removeChild(ta);
        }
      }
    },
    [flashToast]
  );

  const exportFullSpec = useCallback(() => {
    const blob = {
      generatedAt: new Date().toISOString(),
      accessibility: spec.accessibility,
      combos: COMBOS.map((c) => ({
        audience: c.audience,
        goalSet: c.goalSet,
        cells: spec.desired[comboId(c)] ?? {},
      })),
    };
    void copyToClipboard(
      JSON.stringify(blob, null, 2),
      tMatrix("copy_label_spec_json")
    );
  }, [spec, copyToClipboard, tMatrix]);

  const exportTsPatch = useCallback(() => {
    // Build a draft AUDIENCE_RULES + GOAL_RULES patch from the spec.
    // Strategy: per audience, keep the cells whose desired value
    // differs from HARD_DEFAULTS *and* are consistent across every
    // goal set under that audience. Cells whose value differs by goal
    // get emitted under GOAL_RULES instead.
    const lines: string[] = [];
    lines.push("// Draft from Focus × Flags matrix — review before pasting");
    lines.push("// into lib/feature-flag-rules.ts.");
    lines.push("");

    // Audience-only overrides: same value under every goal set for
    // that audience, and that value differs from HARD_DEFAULTS.
    for (const audience of AUDIENCES) {
      lines.push(`// AUDIENCE_RULES.${audience}`);
      const audienceCombos = COMBOS.filter((c) => c.audience === audience);
      const flagToValues: Map<FlagKey, Set<FlagValue>> = new Map();
      for (const combo of audienceCombos) {
        const cells = spec.desired[comboId(combo)] ?? {};
        for (const [flagKey, value] of Object.entries(cells) as [
          FlagKey,
          FlagValue,
        ][]) {
          if (!flagToValues.has(flagKey)) {
            flagToValues.set(flagKey, new Set());
          }
          flagToValues.get(flagKey)!.add(value);
        }
      }
      const audienceLines: string[] = [];
      for (const [flagKey, values] of flagToValues.entries()) {
        if (values.size !== 1) {
          continue; // varies by goal — let GOAL_RULES handle it
        }
        const [only] = [...values];
        if (only === HARD_DEFAULTS[flagKey]) {
          continue; // matches default — skip
        }
        audienceLines.push(`  '${flagKey}': '${only}',`);
      }
      if (audienceLines.length === 0) {
        lines.push("// (no overrides)");
      } else {
        lines.push(...audienceLines);
      }
      lines.push("");
    }

    // Goal-only overrides: same value across every audience for a
    // given goal, differing from HARD_DEFAULTS.
    const PRIMARY_GOALS: PrimaryGoal[] = ["understand", "declutter", "minimal"];
    for (const goal of PRIMARY_GOALS) {
      lines.push(`// GOAL_RULES.${goal}`);
      // Combos that include this goal:
      const goalCombos = COMBOS.filter((c) =>
        goal === "understand"
          ? c.goalSet === "understand" || c.goalSet === "understand+declutter"
          : goal === "declutter"
            ? c.goalSet === "declutter" || c.goalSet === "understand+declutter"
            : c.goalSet === "minimal"
      );
      const flagToValues: Map<FlagKey, Set<FlagValue>> = new Map();
      for (const combo of goalCombos) {
        const cells = spec.desired[comboId(combo)] ?? {};
        for (const [flagKey, value] of Object.entries(cells) as [
          FlagKey,
          FlagValue,
        ][]) {
          if (!flagToValues.has(flagKey)) {
            flagToValues.set(flagKey, new Set());
          }
          flagToValues.get(flagKey)!.add(value);
        }
      }
      const goalLines: string[] = [];
      for (const [flagKey, values] of flagToValues.entries()) {
        if (values.size !== 1) {
          continue;
        }
        const [only] = [...values];
        if (only === HARD_DEFAULTS[flagKey]) {
          continue;
        }
        goalLines.push(`  '${flagKey}': '${only}',`);
      }
      if (goalLines.length === 0) {
        lines.push("// (no overrides)");
      } else {
        lines.push(...goalLines);
      }
      lines.push("");
    }

    void copyToClipboard(lines.join("\n"), tMatrix("copy_label_ts_patch"));
  }, [spec, copyToClipboard, tMatrix]);

  const applyComboAsOverrides = useCallback(
    (combo: ComboDef) => {
      const cells = spec.desired[comboId(combo)] ?? {};
      const cellCount = Object.keys(cells).length;
      if (cellCount === 0) {
        flashToast(tMatrix("toast_no_cells"));
        return;
      }
      setPendingConfirm({ kind: "apply", combo, cellCount });
    },
    [spec, flashToast, tMatrix]
  );

  // Stage-2: dispatched by the modal's Confirm button.
  const runPendingConfirm = useCallback(async () => {
    if (!pendingConfirm) {
      return;
    }
    if (pendingConfirm.kind === "clear") {
      const fresh: SpecBlob = { accessibility: false, desired: {} };
      setSpec(fresh);
      writeSpec(fresh);
      flashToast(tMatrix("toast_cleared"));
      setPendingConfirm(null);
      return;
    }
    if (pendingConfirm.kind === "seed") {
      const desired: SpecBlob["desired"] = {};
      for (const combo of COMBOS) {
        const id = comboId(combo);
        const goals = goalsFor(combo.goalSet, spec.accessibility);
        const cells: Partial<Record<FlagKey, FlagValue>> = {};
        for (const r of rows) {
          cells[r.key] = resolveFor(r.key, combo.audience, goals);
        }
        desired[id] = cells;
      }
      const next: SpecBlob = { ...spec, desired };
      setSpec(next);
      writeSpec(next);
      flashToast(tMatrix("toast_seeded"));
      setPendingConfirm(null);
      return;
    }
    // kind === 'apply' — network call, so guard against double-submit.
    const { combo } = pendingConfirm;
    const cells = spec.desired[comboId(combo)] ?? {};
    const flags = Object.entries(cells).map(([key, override]) => ({
      key,
      override,
    }));
    setApplying(true);
    try {
      const res = await fetch("/api/feature-flags/overrides", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flags }),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const body = (await res.json()) as { applied?: number; skipped?: number };
      flashToast(
        tMatrix("toast_applied", {
          applied: body.applied ?? 0,
          skipped: body.skipped ?? 0,
        })
      );
      setPendingConfirm(null);
    } catch (e) {
      flashToast(
        tMatrix("toast_failed", {
          message: e instanceof Error ? e.message : tMatrix("unknown_error"),
        })
      );
    } finally {
      setApplying(false);
    }
  }, [pendingConfirm, spec, rows, flashToast, tMatrix]);

  // ── Render ────────────────────────────────────────────────────────

  const cancelRef = useRef<(() => void) | null>(null);
  const confirmCardRef = useModalFocus<HTMLDivElement>({
    open: pendingConfirm !== null,
    onClose: () => cancelRef.current?.(),
  });

  return (
    <div className="focus-matrix">
      <div className="focus-matrix-toolbar">
        <input
          aria-label={tMatrix("filter_aria")}
          className="focus-matrix-filter"
          onChange={(e) => setFilter(e.target.value)}
          placeholder={tMatrix("filter_placeholder")}
          type="search"
          value={filter}
        />
        <label className="focus-matrix-toolbar-check">
          <input
            checked={showOnlyDeltas}
            onChange={(e) => setShowOnlyDeltas(e.target.checked)}
            type="checkbox"
          />
          {tMatrix("only_authored_rows")}
        </label>
        <label className="focus-matrix-toolbar-check">
          <input
            checked={spec.accessibility}
            onChange={(e) => setAccessibility(e.target.checked)}
            type="checkbox"
          />
          {tMatrix("apply_accessibility_modifier")}
        </label>
        <span className="focus-matrix-toolbar-spacer" />
        <button
          className="btn btn-secondary btn-sm"
          onClick={seedFromCurrentRules}
          type="button"
        >
          {tMatrix("seed_button")}
        </button>
        <button
          className="btn btn-secondary btn-sm"
          onClick={exportFullSpec}
          type="button"
        >
          {tMatrix("copy_spec_button")}
        </button>
        <button
          className="btn btn-secondary btn-sm"
          onClick={exportTsPatch}
          type="button"
        >
          {tMatrix("copy_ts_patch_button")}
        </button>
        <button
          className="btn btn-danger btn-sm"
          onClick={clearAll}
          type="button"
        >
          {tMatrix("clear_draft_button")}
        </button>
      </div>

      <p className="focus-matrix-hint">
        {tMatrix.rich("hint", {
          code: (chunks) => <code>{chunks}</code>,
        })}
      </p>

      <section
        aria-label={tMatrix("matrix_aria")}
        className="focus-matrix-table-wrap"
      >
        <table className="focus-matrix-table">
          <thead>
            <tr>
              <th className="focus-matrix-th-key">
                {tMatrix("flag_column_header")}
              </th>
              {COMBOS.map((combo) => (
                <th
                  className="focus-matrix-th-combo"
                  key={comboId(combo)}
                  title={combo.longHeader}
                >
                  <div className="focus-matrix-th-label">{combo.header}</div>
                  <button
                    className="focus-matrix-th-apply"
                    onClick={() => applyComboAsOverrides(combo)}
                    title={tMatrix("apply_combo_title", {
                      combo: combo.longHeader,
                    })}
                    type="button"
                  >
                    ↗
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {grouped.map(([surface, surfaceRows]) => (
              <FocusMatrixSurface
                key={surface}
                onSetCell={setCell}
                rows={surfaceRows}
                spec={spec}
                surface={surface}
              />
            ))}
            {grouped.length === 0 && (
              <tr>
                <td className="focus-matrix-empty" colSpan={1 + COMBOS.length}>
                  {tMatrix("no_flags_match")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      {toast && (
        <div aria-live="polite" className="focus-matrix-toast" role="status">
          {toast}
        </div>
      )}

      {pendingConfirm &&
        (() => {
          const closing = applying;
          const cancel = () => {
            if (!closing) {
              setPendingConfirm(null);
            }
          };
          cancelRef.current = cancel;
          const titleId = "focus-matrix-confirm-title";
          const copyId = "focus-matrix-confirm-copy";
          const { title, body, confirmLabel } = (() => {
            if (pendingConfirm.kind === "clear") {
              return {
                title: tMatrix("confirm_clear_title"),
                body: tMatrix("confirm_clear_body"),
                confirmLabel: tMatrix("clear_draft_button"),
              };
            }
            if (pendingConfirm.kind === "seed") {
              return {
                title: tMatrix("confirm_seed_title"),
                body: tMatrix("confirm_seed_body"),
                confirmLabel: tMatrix("confirm_seed_confirm"),
              };
            }
            return {
              title: tMatrix("confirm_apply_title", {
                count: pendingConfirm.cellCount,
              }),
              body: tMatrix("confirm_apply_body", {
                count: pendingConfirm.cellCount,
                combo: pendingConfirm.combo.longHeader,
              }),
              confirmLabel: tMatrix("confirm_apply_confirm"),
            };
          })();
          return (
            <div className="modal-overlay" onClick={cancel}>
              <div
                aria-describedby={copyId}
                aria-labelledby={titleId}
                aria-modal="true"
                className="modal-card"
                onClick={(event) => event.stopPropagation()}
                ref={confirmCardRef}
                role="dialog"
                tabIndex={-1}
              >
                <h2 className="modal-title" id={titleId}>
                  {title}
                </h2>
                <p className="modal-copy" id={copyId}>
                  {body}
                </p>
                <div className="modal-actions">
                  <button
                    className="btn btn-secondary"
                    disabled={closing}
                    onClick={cancel}
                    type="button"
                  >
                    {tMatrix("cancel")}
                  </button>
                  <button
                    className="btn btn-danger"
                    disabled={closing}
                    onClick={() => void runPendingConfirm()}
                    type="button"
                  >
                    {closing ? (
                      <>
                        <span aria-hidden="true" className="spinner-sm" />{" "}
                        {tMatrix("applying")}
                      </>
                    ) : (
                      confirmLabel
                    )}
                  </button>
                </div>
              </div>
            </div>
          );
        })()}
    </div>
  );
}

function FocusMatrixSurface({
  surface,
  rows,
  spec,
  onSetCell,
}: {
  surface: string;
  rows: Array<{ key: FlagKey; surface: string; hardDefault: FlagValue }>;
  spec: SpecBlob;
  onSetCell: (combo: ComboDef, key: FlagKey, value: FlagValue | null) => void;
}) {
  const [open, setOpen] = useState(true);
  const tSurfaces = useTranslations("dev_options.feature_flags.surfaces");
  const label = SURFACE_LABELS[surface] ? tSurfaces(surface) : surface;
  return (
    <>
      <tr className="focus-matrix-surface-row">
        <th className="focus-matrix-surface-th" colSpan={1 + COMBOS.length}>
          <button
            aria-expanded={open}
            className="focus-matrix-surface-toggle"
            onClick={() => setOpen((o) => !o)}
            type="button"
          >
            <span className="focus-matrix-surface-caret">
              {open ? "▾" : "▸"}
            </span>
            <span>{label}</span>
            <span className="focus-matrix-surface-count">{rows.length}</span>
          </button>
        </th>
      </tr>
      {open &&
        rows.map((r) => (
          <FocusMatrixRow
            key={r.key}
            onSetCell={onSetCell}
            row={r}
            spec={spec}
          />
        ))}
    </>
  );
}

function FocusMatrixRow({
  row,
  spec,
  onSetCell,
}: {
  row: { key: FlagKey; surface: string; hardDefault: FlagValue };
  spec: SpecBlob;
  onSetCell: (combo: ComboDef, key: FlagKey, value: FlagValue | null) => void;
}) {
  const tMatrix = useTranslations("dev_options.focus_matrix");
  return (
    <tr className="focus-matrix-row">
      <th className="focus-matrix-row-key" scope="row" title={row.key}>
        <code>{row.key}</code>
        <span
          className="focus-matrix-row-default"
          title={tMatrix("hard_default_title", { value: row.hardDefault })}
        >
          {tMatrix("hard_default_label", { value: row.hardDefault })}
        </span>
      </th>
      {COMBOS.map((combo) => {
        const goals = goalsFor(combo.goalSet, spec.accessibility);
        const current = resolveFor(row.key, combo.audience, goals);
        const desired = spec.desired[comboId(combo)]?.[row.key];
        const drift = desired !== undefined && desired !== current;
        return (
          <td
            className={`focus-matrix-cell focus-matrix-cell-${desired ?? current}${
              drift ? "is-drift" : ""
            }${desired === undefined ? "" : "is-authored"}`}
            key={comboId(combo)}
          >
            <button
              className="focus-matrix-cell-btn"
              onClick={() => onSetCell(combo, row.key, nextValue(desired))}
              title={tMatrix("cell_title", {
                combo: combo.longHeader,
                current,
                authored: desired ?? tMatrix("cell_unset"),
              })}
              type="button"
            >
              <span className="focus-matrix-cell-current">{current}</span>
              <span className="focus-matrix-cell-desired">
                {desired === undefined ? (
                  "·"
                ) : (
                  <>
                    {/* Glyph prefix reinforces the colour cue (green / red /
                        orange) so on/off/collapsed are distinguishable in
                        monochrome and for users with red-green colour
                        blindness. The glyph is aria-hidden because the
                        textual value next to it is what screen readers
                        should announce. */}
                    <span
                      aria-hidden="true"
                      className="focus-matrix-cell-glyph"
                    >
                      {desired === "on" ? "✓" : desired === "off" ? "✕" : "▾"}
                    </span>{" "}
                    {desired}
                  </>
                )}
              </span>
            </button>
          </td>
        );
      })}
    </tr>
  );
}
