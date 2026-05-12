'use client';

/**
 * Developer Options → Feature flags panel (round 3 PR 5).
 *
 * Pulls the flag list from /api/feature-flags on mount, lets the user
 * toggle individual overrides, reset per-surface defaults, or wipe all
 * overrides. Search filters flag keys + descriptions in-place.
 *
 * Renders a kill-switch banner when `flag.devopts.feature_flag_system.enabled`
 * is overridden off — re-enable button restores normal flag behaviour.
 *
 * See https://privacytracker-docs.privacykey.org/develop/feature-flags.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import type { FlagValue } from '@/lib/feature-flag-rules';
import { useFlag } from '../../lib/feature-flags-hooks';
import { DEV_MENU_STORAGE_KEY } from './DevMenu';
import { getFlagUsage } from '../../lib/feature-flag-usage';

interface FlagRow {
  key: string;
  surface: string;
  hardDefault: FlagValue;
  currentValue: FlagValue;
  override: FlagValue | null;
  /** True when at least one component / route reads this flag today. */
  wired: boolean;
}

interface ApiList {
  flags: FlagRow[];
}

const VALUE_OPTIONS: FlagValue[] = ['on', 'off', 'collapsed'];

const SURFACE_LABELS: Record<string, string> = {
  about: 'About',
  appgrid: 'App grid',
  dashboard: 'Dashboard',
  desktop: 'Desktop (Tauri)',
  detail: 'App detail',
  devopts: 'Developer options',
  global: 'Global',
  help: 'Help',
  legal: 'Legal',
  nav: 'Navigation',
  notifications: 'Notifications',
  onboarding: 'Onboarding',
  page: 'Secondary pages',
  settings: 'Settings',
  shortlist: 'Shortlist',
  stats: 'Stats',
  taskcenter: 'Task center',
};

/**
 * Single user-driven mutation, captured for the Cmd/Ctrl+Z stack.
 *
 *   - `single`   — one row's override flipped (or cleared); undo restores the
 *                  previous override (or clears it back to the inherited
 *                  default).
 *   - `category` — bulk on/off/collapsed/reset across a whole surface; undo
 *                  replays the per-row before-snapshot.
 *
 * The "before" snapshot is keyed by flag id so undo can rebuild the exact
 * pre-change state via the existing single-row API. We deliberately don't
 * keep multiple steps — only the most recent action is undoable, matching
 * the toast hint ("Cmd-Z to undo") and avoiding a confusing multi-step
 * stack inside a panel users mostly visit briefly.
 */
type UndoEntry =
  | {
      kind: 'single';
      key: string;
      label: string;
      previous: FlagValue | null;
      next: FlagValue | null;
    }
  | {
      kind: 'category';
      surface: string;
      label: string;
      /** Pre-bulk overrides per row (`null` = no override). */
      before: Map<string, FlagValue | null>;
    };

/**
 * Tiny ephemeral toast surfaced after every flag mutation. Drives the
 * "Undone — flag.foo restored to on" hint at the bottom of the panel
 * and the "Nothing to undo" feedback when Cmd-Z fires with an empty
 * stack. Plain string + nonce so consecutive identical messages still
 * re-trigger the auto-dismiss timer.
 */
interface PanelToast {
  message: string;
  nonce: number;
}

export default function DevOptionsFeatureFlagPanel() {
  // i18n — title + chrome (search field, two visibility toggles, plus
  // the reset-all confirmation modal copy). Per-flag descriptions in
  // FLAG_REGISTRY remain English in v1; tracked separately because
  // the registry has 200+ entries and warrants its own pass.
  const tDev = useTranslations('dev_options.feature_flags');
  const tDevReset = useTranslations('dev_options.feature_flags.reset_all_modal');
  const tDevCat = useTranslations('dev_options.feature_flags.category');
  const tDevUndo = useTranslations('dev_options.feature_flags.undo');

  // Live-apply support. Every successful override write triggers a
  // `router.refresh()` so server-rendered surfaces (the dashboard,
  // Settings sections gated by `flag.page.*`, etc.) re-render with the
  // new resolution. Without this, users would have to hit reload to
  // see a flag change anywhere outside the panel.
  const router = useRouter();

  // Wave I: gate the whole panel behind `flag.devopts.feature_flag_panel`.
  // The panel is the chief surface for inspecting + overriding flags;
  // hiding it is what guardian/loved_one focus uses to keep developer
  // tooling out of curated configurations.
  const panelOn = useFlag('flag.devopts.feature_flag_panel') === 'on';

  const [rows, setRows] = useState<FlagRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [showOverriddenOnly, setShowOverriddenOnly] = useState(false);
  const [showWiredOnly, setShowWiredOnly] = useState(false);
  const [openSurfaces, setOpenSurfaces] = useState<Set<string>>(new Set());
  const [busyKey, setBusyKey] = useState<string | null>(null);
  /**
   * Status line for the import flow — populated after a successful import
   * (`{tone: 'success', applied, skipped}`) or failure (`tone: 'error'`).
   * Cleared on next import attempt or after a soft delay (handled below).
   * Lives in a `role="status"` aria-live region so screen-reader users
   * hear "Imported N overrides" without focusing the panel.
   */
  const [importStatus, setImportStatus] = useState<
    | null
    | { tone: 'success'; message: string }
    | { tone: 'error'; message: string }
  >(null);
  const importFileRef = useRef<HTMLInputElement | null>(null);
  /**
   * Pending file the user picked. The confirm modal owns the gate
   * between "user chose a file" and "we actually wipe + replay
   * overrides on the server"; ack closes the modal AND fires the
   * import, cancel just clears the file. Storing the File rather than
   * its parsed contents keeps the modal lightweight — parsing happens
   * inside the import handler so a malformed JSON surfaces an error
   * with the same path as a server failure.
   */
  const [pendingImport, setPendingImport] = useState<File | null>(null);
  /**
   * Two-state confirm modal for the destructive "Reset all to
   * defaults" footer button. Mirrors the pattern used in SettingsView
   * (waybackRemoveOpen, resetStep) so the dialog UX matches the rest
   * of the Settings page.
   */
  const [resetAllOpen, setResetAllOpen] = useState(false);

  /**
   * Single-step undo stack — captures the most recent flag mutation so
   * Cmd/Ctrl+Z can restore the prior state. We keep one entry rather
   * than a deeper history because the Dev Options panel is a
   * lightweight inspector (not an editor) and an unbounded stack would
   * make the toast hint at the bottom misleading.
   */
  const [undoEntry, setUndoEntry] = useState<UndoEntry | null>(null);
  const [toast, setToast] = useState<PanelToast | null>(null);

  /**
   * The flag the user has clicked on most recently. Drives the purple
   * "selected" border on the matching row + the scroll-into-view
   * effect. `null` = no selection (the panel renders normally with no
   * row picked out). The selection is intentionally sticky — it stays
   * highlighted until the user clicks another row or clears it
   * explicitly — so the row stays easy to find when it's been
   * scrolled to.
   */
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const selectedRowRef = useRef<HTMLLIElement | null>(null);

  // When the selection changes, scroll the row into the centre of the
  // viewport. `block: 'center'` keeps the row stable rather than
  // wedged against the top edge — easier to grab the toggle
  // immediately. Behaviour is `smooth`; users with reduced-motion
  // preferences get the browser's default jump, which is what we
  // want.
  useEffect(() => {
    if (!selectedKey) return;
    selectedRowRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [selectedKey]);

  // Selecting a row inside a collapsed surface is a dead end — the
  // accordion body is hidden, so nothing to scroll to. Auto-open the
  // surface that contains the selected key so the row's actually
  // visible to scroll into.
  useEffect(() => {
    if (!selectedKey) return;
    const surfaceMatch = selectedKey.match(/^flag\.([^.]+)\./);
    if (!surfaceMatch) return;
    const surface = surfaceMatch[1];
    setOpenSurfaces(prev => {
      if (prev.has(surface)) return prev;
      const next = new Set(prev);
      next.add(surface);
      return next;
    });
  }, [selectedKey]);

  // Dev-menu opt-in. The actual rendering lives in <DevMenu /> mounted
  // in the global footer landmark (app/layout.tsx → bottom-right cluster
  // next to AccessibilityQuickToggles). This toggle is the dev-facing
  // on/off switch persisted in localStorage AND in the
  // /api/dev-menu-state SQLite-backed endpoint — the API store is what
  // makes the flag survive a Tauri quit/relaunch (each launch's sidecar
  // origin has fresh empty localStorage). Synced lazily on mount and
  // on cross-tab storage events so flipping it elsewhere keeps both
  // surfaces aligned.
  const [floatingOverlayOn, setFloatingOverlayOn] = useState(false);
  useEffect(() => {
    try {
      setFloatingOverlayOn(localStorage.getItem(DEV_MENU_STORAGE_KEY) === 'true');
    } catch {
      /* localStorage may be unavailable in private mode */
    }
  }, []);
  // Server-side merge. If the API reports `enabled: true` and our
  // local cache disagreed (typical on a fresh Tauri origin), flip the
  // toggle on and broadcast so DevMenu sees the change too.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch('/api/dev-menu-state');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { enabled?: boolean };
        if (cancelled || data.enabled !== true) return;
        try {
          localStorage.setItem(DEV_MENU_STORAGE_KEY, 'true');
        } catch {
          /* private mode */
        }
        setFloatingOverlayOn(true);
        window.dispatchEvent(new CustomEvent('dev-menu:changed'));
      } catch (err) {
        console.warn('[dev-menu] failed to read state from API:', err);
      }
    })();
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== DEV_MENU_STORAGE_KEY) return;
      setFloatingOverlayOn(e.newValue === 'true');
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  const toggleFloatingOverlay = useCallback(() => {
    setFloatingOverlayOn(prev => {
      const next = !prev;
      try {
        if (next) localStorage.setItem(DEV_MENU_STORAGE_KEY, 'true');
        else localStorage.removeItem(DEV_MENU_STORAGE_KEY);
      } catch {
        /* localStorage may be unavailable */
      }
      // Same-tab broadcast — DevMenu listens for this so toggling here
      // updates the footer trigger immediately without a reload.
      window.dispatchEvent(new CustomEvent('dev-menu:changed'));
      // Persist server-side too so the next Tauri launch picks the
      // flag back up — localStorage alone is per-origin and the
      // sidecar port (and thus the origin) changes on every quit.
      // Fire-and-forget; failures are logged but don't block the UI.
      fetch('/api/dev-menu-state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: next }),
      }).catch(err => {
        console.warn('[dev-menu] failed to persist toggle:', err);
      });
      return next;
    });
  }, []);

  // Auto-dismiss toast after 4s. Cleared if a new toast lands first.
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(id);
  }, [toast]);

  function showToast(message: string) {
    setToast({ message, nonce: Date.now() });
  }

  // Initial load + reload helper.
  async function load() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/feature-flags');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as ApiList;
      setRows(data.flags ?? []);
    } catch (e) {
      console.error('[DevOpts] load failed:', e);
      setError(e instanceof Error ? e.message : 'Failed to load flags');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  const overrideCount = rows.filter((r) => r.override !== null).length;

  const killSwitchOff = useMemo(() => {
    const killSwitch = rows.find((r) => r.key === 'flag.devopts.feature_flag_system.enabled');
    return killSwitch?.currentValue === 'off';
  }, [rows]);

  const wiredCount = useMemo(() => rows.filter((r) => r.wired).length, [rows]);

  // Group rows by surface, applying search + overridden + wired filters.
  const grouped = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const groups = new Map<string, FlagRow[]>();
    for (const row of rows) {
      if (showOverriddenOnly && row.override === null) continue;
      if (showWiredOnly && !row.wired) continue;
      if (needle && !row.key.toLowerCase().includes(needle)) continue;
      if (!groups.has(row.surface)) groups.set(row.surface, []);
      groups.get(row.surface)!.push(row);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [rows, search, showOverriddenOnly, showWiredOnly]);

  function toggleSurface(prefix: string) {
    setOpenSurfaces((prev) => {
      const next = new Set(prev);
      if (next.has(prefix)) next.delete(prefix);
      else next.add(prefix);
      return next;
    });
  }

  /**
   * Low-level POST. Writes a single override to the server but doesn't
   * touch local state — `setOverride` / `applyCategory` / undo all
   * compose this with their own bookkeeping.
   */
  async function writeOverride(key: string, value: FlagValue): Promise<boolean> {
    const res = await fetch('/api/feature-flags/overrides', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, value }),
    });
    return res.ok;
  }

  /** Low-level DELETE for a single key. */
  async function deleteOverride(key: string): Promise<boolean> {
    const res = await fetch(`/api/feature-flags/overrides/${encodeURIComponent(key)}`, {
      method: 'DELETE',
    });
    return res.ok;
  }

  /**
   * Live-apply post-write hook. Re-fetches the flag list to refresh the
   * panel itself and `router.refresh()` to re-render server components
   * that read flags via `resolveFlagFromDb` so the dashboard / settings
   * surfaces gated on the changed flag update without a full reload.
   */
  async function refreshAfterChange() {
    await load();
    router.refresh();
  }

  async function setOverride(key: string, value: FlagValue, recordUndo = true) {
    setBusyKey(key);
    const prev = rows.find((r) => r.key === key)?.override ?? null;
    try {
      const ok = await writeOverride(key, value);
      if (!ok) throw new Error('write failed');
      if (recordUndo) {
        setUndoEntry({
          kind: 'single',
          key,
          label: key,
          previous: prev,
          next: value,
        });
      }
      await refreshAfterChange();
    } catch (e) {
      console.error('[DevOpts] setOverride failed:', e);
    } finally {
      setBusyKey(null);
    }
  }

  async function clearOverride(key: string, recordUndo = true) {
    setBusyKey(key);
    const prev = rows.find((r) => r.key === key)?.override ?? null;
    try {
      const ok = await deleteOverride(key);
      if (!ok) throw new Error('delete failed');
      if (recordUndo) {
        setUndoEntry({
          kind: 'single',
          key,
          label: key,
          previous: prev,
          next: null,
        });
      }
      await refreshAfterChange();
    } catch (e) {
      console.error('[DevOpts] clearOverride failed:', e);
    } finally {
      setBusyKey(null);
    }
  }

  async function resetSurface(surface: string) {
    setBusyKey(`__surface:${surface}`);
    // Snapshot before so undo can replay.
    const surfaceRows = rows.filter((r) => r.surface === surface);
    const before = new Map<string, FlagValue | null>();
    for (const r of surfaceRows) before.set(r.key, r.override);
    try {
      const res = await fetch(`/api/feature-flags/overrides?surface=${encodeURIComponent(surface)}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setUndoEntry({
        kind: 'category',
        surface,
        label: SURFACE_LABELS[surface] ?? surface,
        before,
      });
      await refreshAfterChange();
    } catch (e) {
      console.error('[DevOpts] resetSurface failed:', e);
    } finally {
      setBusyKey(null);
    }
  }

  /**
   * Bulk-set every flag in a surface to the same value (`on`/`off`/
   * `collapsed`). Captures a per-row snapshot for undo so Cmd-Z can
   * walk the surface back to where the user started — including rows
   * that were already overridden.
   *
   * Implementation: small N (≈20 flags per surface) so we just await a
   * sequential write loop. A bulk endpoint would be tidier but this
   * keeps the API surface (and its bulk-import edge cases) untouched.
   */
  async function applyCategory(surface: string, value: FlagValue) {
    setBusyKey(`__surface:${surface}`);
    const surfaceRows = rows.filter((r) => r.surface === surface);
    const before = new Map<string, FlagValue | null>();
    for (const r of surfaceRows) before.set(r.key, r.override);
    try {
      for (const r of surfaceRows) {
        if (r.override === value) continue; // already there, skip the round-trip
        const ok = await writeOverride(r.key, value);
        if (!ok) throw new Error(`write failed for ${r.key}`);
      }
      setUndoEntry({
        kind: 'category',
        surface,
        label: SURFACE_LABELS[surface] ?? surface,
        before,
      });
      await refreshAfterChange();
    } catch (e) {
      console.error('[DevOpts] applyCategory failed:', e);
    } finally {
      setBusyKey(null);
    }
  }

  /**
   * Undo handler — restores the previous state of whatever the most
   * recent action mutated, then clears the stack so a second Cmd-Z
   * doesn't re-apply the original change. The toast surfaces what was
   * undone so users have visual confirmation outside the panel.
   */
  const undoLastChange = useCallback(async () => {
    if (!undoEntry) {
      showToast(tDevUndo('toast_nothing'));
      return;
    }
    const entry = undoEntry;
    setUndoEntry(null);
    try {
      if (entry.kind === 'single') {
        if (entry.previous === null) {
          await deleteOverride(entry.key);
        } else {
          await writeOverride(entry.key, entry.previous);
        }
        showToast(
          entry.previous === null
            ? tDevUndo('toast_undone_cleared', { key: entry.label })
            : tDevUndo('toast_undone', { key: entry.label, value: entry.previous }),
        );
      } else {
        // Category: replay each row's pre-bulk override (or clear when
        // it was unset before).
        for (const [key, prev] of entry.before) {
          if (prev === null) {
            await deleteOverride(key);
          } else {
            await writeOverride(key, prev);
          }
        }
        showToast(
          tDevUndo('toast_undone', {
            key: entry.label,
            value: tDevCat('reset'),
          }),
        );
      }
      await refreshAfterChange();
    } catch (e) {
      console.error('[DevOpts] undo failed:', e);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- refreshAfterChange is stable from parent
  }, [undoEntry, tDevUndo, tDevCat]);

  // Cmd/Ctrl+Z shortcut. Bound to the document so users can hit it
  // from anywhere inside the panel without focusing a specific
  // element. Skips when a modal is open or when an editable element
  // (input/textarea/contenteditable) currently holds focus, so we
  // don't fight the browser's own undo for the search field.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'z' && event.key !== 'Z') return;
      if (!(event.metaKey || event.ctrlKey)) return;
      // Shift+Cmd/Ctrl+Z is left to the browser / OS — we return before
      // calling preventDefault so an editable element that holds focus
      // can run its native redo. There is no panel-level redo stack to
      // pair with this handler's single-step undo, by design.
      if (event.shiftKey) return;
      const target = event.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) return;
      }
      if (resetAllOpen || pendingImport) return;
      event.preventDefault();
      void undoLastChange();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [undoLastChange, resetAllOpen, pendingImport]);

  /**
   * Wipe every override. Called from the confirm modal's Confirm
   * button — the button itself is what gates the destructive action,
   * so this function no longer pops a `window.confirm`. Captures a
   * before-snapshot keyed by every row's surface so an immediate
   * Cmd-Z restores the entire pre-wipe state (rendered as multiple
   * category-undo entries collapsed into one, since the snapshot
   * spans every surface).
   */
  async function resetAllConfirmed() {
    setBusyKey('__all');
    const before = new Map<string, FlagValue | null>();
    for (const r of rows) before.set(r.key, r.override);
    try {
      const res = await fetch('/api/feature-flags/overrides', { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setResetAllOpen(false);
      // Stamp the undo as a synthetic "all surfaces" category so the
      // existing replay path applies — replaying every row at once is
      // exactly what reverting "reset all" needs.
      setUndoEntry({
        kind: 'category',
        surface: '__all__',
        label: tDevReset('title').replace(/\?$/, ''),
        before,
      });
      await refreshAfterChange();
    } catch (e) {
      console.error('[DevOpts] resetAll failed:', e);
    } finally {
      setBusyKey(null);
    }
  }

  function exportJson() {
    const blob = new Blob([JSON.stringify({ flags: rows }, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `feature-flag-state-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  /**
   * Trigger the hidden file picker. The visible "Import flag state"
   * button delegates to this so its keyboard / focus story stays the
   * standard <button> one rather than the bespoke <input type="file">.
   * Reset `value=''` first so picking the same file twice in a row still
   * fires onChange (browsers swallow a no-change pick otherwise).
   */
  function triggerImportPicker() {
    setImportStatus(null);
    if (importFileRef.current) {
      importFileRef.current.value = '';
      importFileRef.current.click();
    }
  }

  /**
   * Stage 1 of the import flow: the user picked a file via the hidden
   * input. Stash it on `pendingImport` so the confirm modal can render
   * the filename in its copy. The actual wipe + replay only happens
   * once the user clicks Confirm in the modal.
   */
  function handleImportFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Always reset the input so picking the same file again later
    // re-triggers onChange. Without this, a user who imports → re-edits
    // the file → re-imports gets nothing on the second click.
    event.target.value = '';
    if (!file) return;
    setImportStatus(null);
    setPendingImport(file);
  }

  /**
   * Stage 2 of the import flow: confirmed the destructive overwrite,
   * parse the file and POST to the bulk endpoint. The modal stays open
   * with the spinner while the request is in flight; closes on either
   * outcome (success → load() refreshes the rows, error → status banner).
   */
  async function importConfirmed() {
    const file = pendingImport;
    if (!file) return;

    setBusyKey('__import');
    setImportStatus(null);
    try {
      const text = await file.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error('File is not valid JSON.');
      }
      if (!parsed || typeof parsed !== 'object' || !Array.isArray((parsed as { flags?: unknown }).flags)) {
        throw new Error('File is missing a top-level `flags` array. Use a file produced by "Export current flag state as JSON".');
      }
      const res = await fetch('/api/feature-flags/overrides', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ flags: (parsed as { flags: unknown[] }).flags }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as { applied?: number; skipped?: number };
      const applied = data.applied ?? 0;
      const skipped = data.skipped ?? 0;
      setImportStatus({
        tone: 'success',
        message:
          `Imported ${applied} override${applied === 1 ? '' : 's'}` +
          (skipped > 0 ? ` · skipped ${skipped} unknown row${skipped === 1 ? '' : 's'}` : ''),
      });
      setPendingImport(null);
      await load();
    } catch (e) {
      console.error('[DevOpts] import failed:', e);
      setImportStatus({
        tone: 'error',
        message: e instanceof Error ? e.message : 'Import failed.',
      });
      setPendingImport(null);
    } finally {
      setBusyKey(null);
    }
  }

  if (!panelOn) return null;

  return (
    <section
      className="dev-options-flag-panel"
      id="feature-flags"
      aria-labelledby="feature-flags-title"
      aria-busy={loading || busyKey !== null}
    >
      <header className="dev-options-flag-panel__header">
        <h3 className="dev-options-flag-panel__title" id="feature-flags-title">{tDev('title')}</h3>
        <p className="dev-options-flag-panel__subtitle" aria-live="polite">
          {loading
            ? 'Loading…'
            : overrideCount === 0
            ? 'No overrides — every flag is using its computed default.'
            : `${overrideCount} flag${overrideCount === 1 ? '' : 's'} overridden`}
        </p>
      </header>

      {/* Dev menu opt-in. The menu itself is mounted in the global
          footer landmark (app/layout.tsx) and self-gates on this
          localStorage key + the devmode flag. Keeping the toggle
          inside this panel means devs flip it from the same surface
          where they manage every other flag — no scattering of dev
          settings. */}
      <div className="dev-options-flag-panel__floating-toggle">
        <div className="dev-options-flag-panel__floating-toggle-text">
          <strong>Dev menu trigger</strong>
          <span className="dev-options-flag-panel__floating-toggle-hint">
            Pin a 🛠 button to the bottom-right of every page (next to
            the accessibility quick-toggle) so you can inspect +
            override the flags relevant to the current page, run quick
            admin actions (sync, wipe apps, reset changelog, seed test
            data), switch language, audience, and goals without leaving
            the page. Press <kbd className="kbd">g</kbd> then{' '}
            <kbd className="kbd">f</kbd> anywhere to jump back here.
          </span>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={floatingOverlayOn}
          className={`switch-toggle${floatingOverlayOn ? ' is-on' : ''}`}
          onClick={toggleFloatingOverlay}
        >
          <span className="switch-toggle-thumb" aria-hidden="true" />
        </button>
      </div>

      {killSwitchOff && (
        <div role="alert" className="dev-options-flag-panel__kill-switch-banner">
          <span className="dev-options-flag-panel__banner-icon" aria-hidden="true">⚠</span>
          <div className="dev-options-flag-panel__banner-copy">
            <strong>Feature flag system is disabled.</strong>{' '}
            <span>Hard defaults are active. Your overrides aren&rsquo;t being applied.</span>
          </div>
          <button
            type="button"
            onClick={() => setOverride('flag.devopts.feature_flag_system.enabled', 'on')}
            disabled={busyKey !== null}
            className="btn btn-primary btn-sm"
          >
            Re-enable
          </button>
        </div>
      )}

      {error && (
        <div role="alert" className="dev-options-flag-panel__error">
          <span aria-hidden="true">⚠</span>
          <span>Couldn&rsquo;t load flags: {error}</span>
          <button type="button" onClick={() => void load()} className="btn btn-secondary btn-sm">
            Retry
          </button>
        </div>
      )}

      <div className="dev-options-flag-panel__controls">
        <input
          type="search"
          value={search}
          onChange={(e: ChangeEvent<HTMLInputElement>) => setSearch(e.target.value)}
          placeholder={tDev('search_placeholder')}
          className="dev-options-flag-panel__search"
          aria-label={tDev('search_aria')}
        />
        <label className="dev-options-flag-panel__filter">
          <input
            type="checkbox"
            checked={showOverriddenOnly}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setShowOverriddenOnly(e.target.checked)}
          />
          <span>{tDev('show_only_overridden')}</span>
        </label>
        <label
          className="dev-options-flag-panel__filter"
          title={`${wiredCount} of ${rows.length} flags are currently consumed by component code; the rest are placeholder.`}
        >
          <input
            type="checkbox"
            checked={showWiredOnly}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setShowWiredOnly(e.target.checked)}
          />
          <span>{tDev('show_wired_only', { count: wiredCount })}</span>
        </label>
      </div>

      {!loading && rows.length > 0 && wiredCount < rows.length && !showWiredOnly && (
        <p className="dev-options-flag-panel__note" style={{ fontSize: 12, color: 'var(--text-3)' }}>
          {wiredCount} of {rows.length} flags currently produce a visible change when toggled.
          Unwired flags are marked &ldquo;<em>no effect yet</em>&rdquo; — they exist in the
          registry but their consuming components ship in subsequent PRs.
        </p>
      )}

      <div className="dev-options-flag-panel__surfaces" role="list">
        {grouped.map(([surface, surfaceRows]) => {
          const isOpen = openSurfaces.has(surface);
          const overriddenInGroup = surfaceRows.filter((r) => r.override !== null).length;
          return (
            <details
              key={surface}
              role="listitem"
              open={isOpen}
              className="dev-options-flag-panel__accordion"
            >
              <summary
                className="dev-options-flag-panel__accordion-summary"
                onClick={(e) => {
                  e.preventDefault();
                  toggleSurface(surface);
                }}
              >
                <span className="dev-options-flag-panel__accordion-label">
                  {SURFACE_LABELS[surface] ?? surface}
                </span>
                <span className="dev-options-flag-panel__accordion-count">
                  {surfaceRows.length} flag{surfaceRows.length === 1 ? '' : 's'}
                  {overriddenInGroup > 0 && ` · ${overriddenInGroup} overridden`}
                </span>
              </summary>

              <div className="dev-options-flag-panel__accordion-body">
                {/*
                  Per-category head toggles. Three "set every flag in
                  this surface to <value>" buttons followed by a reset.
                  Each button captures a per-row before-snapshot so
                  Cmd/Ctrl+Z can replay the pre-bulk state for the
                  whole surface in one undo step. `disabled` while
                  any surface action is in flight to avoid stomping
                  on the snapshot mid-write.
                */}
                <div
                  className="dev-options-flag-panel__category-actions"
                  role="group"
                  aria-label={SURFACE_LABELS[surface] ?? surface}
                >
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={busyKey !== null}
                    onClick={() => void applyCategory(surface, 'on')}
                    title={tDevCat('all_on_title')}
                  >
                    {tDevCat('all_on')}
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={busyKey !== null}
                    onClick={() => void applyCategory(surface, 'off')}
                    title={tDevCat('all_off_title')}
                  >
                    {tDevCat('all_off')}
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    disabled={busyKey !== null}
                    onClick={() => void applyCategory(surface, 'collapsed')}
                    title={tDevCat('all_collapsed_title')}
                  >
                    {tDevCat('all_collapsed')}
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    disabled={busyKey !== null || overriddenInGroup === 0}
                    onClick={() => void resetSurface(surface)}
                    title={tDevCat('reset_title')}
                  >
                    {tDevCat('reset')}
                  </button>
                </div>

                <ul className="dev-options-flag-panel__flag-list">
                  {surfaceRows.map((row) => (
                    <FlagListItem
                      key={row.key}
                      row={row}
                      busy={busyKey === row.key}
                      isSelected={selectedKey === row.key}
                      onSelect={() => setSelectedKey(row.key)}
                      selectedRowRef={selectedKey === row.key ? selectedRowRef : null}
                      onChange={(next) => void setOverride(row.key, next)}
                      onClear={() => void clearOverride(row.key)}
                    />
                  ))}
                </ul>
              </div>
            </details>
          );
        })}

        {!loading && grouped.length === 0 && (
          <p className="dev-options-flag-panel__empty">
            {search.trim()
              ? `No flags match "${search}".`
              : 'No flags to show.'}
          </p>
        )}
      </div>

      {/* Import status — sits above the footer so it shows up next to
          the Import button that produced it. role="status" + aria-live
          ensures SR users hear "Imported N overrides" after a click
          even if focus has moved off the button. */}
      {importStatus && (
        <div
          role="status"
          aria-live="polite"
          className={`dev-options-flag-panel__import-status dev-options-flag-panel__import-status--${importStatus.tone}`}
        >
          <span aria-hidden="true">{importStatus.tone === 'success' ? '✓' : '⚠'}</span>
          <span>{importStatus.message}</span>
          <button
            type="button"
            className="dev-options-flag-panel__import-status-dismiss"
            onClick={() => setImportStatus(null)}
            aria-label={tDev('dismiss_import_aria')}
          >
            <span aria-hidden="true">✕</span>
          </button>
        </div>
      )}

      {/* Undo + status toast strip. Always rendered (even with no
          undo entry yet) so the keyboard-shortcut hint is visible
          and discoverable. The toast itself sits in an aria-live
          region so screen readers hear "Undone — flag.foo restored
          to on" without needing to refocus the panel. */}
      <div className="dev-options-flag-panel__undo-strip" role="status" aria-live="polite">
        <span className="dev-options-flag-panel__undo-hint">
          {/* Mac vs non-Mac shortcut hint — checked at render so it
              flips correctly when the user moves their cursor across
              the OS. `navigator.platform` is deprecated but still the
              most reliable cross-browser signal for "is this a Mac
              keyboard layout"; userAgentData isn't widely shipped. */}
          {typeof navigator !== 'undefined' && /Mac|iPad|iPhone/.test(navigator.platform)
            ? tDevUndo('shortcut_hint')
            : tDevUndo('shortcut_hint_ctrl')}
        </span>
        {toast && (
          <span
            className="dev-options-flag-panel__undo-toast"
            key={toast.nonce}
          >
            {toast.message}
          </span>
        )}
      </div>

      <footer className="dev-options-flag-panel__footer">
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          disabled={busyKey !== null || overrideCount === 0}
          onClick={() => setResetAllOpen(true)}
        >
          Reset all to defaults
        </button>
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={exportJson}
        >
          Export current flag state as JSON
        </button>
        {/*
          Import button — opens a hidden <input type="file"> via the
          ref. We use a real <button> so keyboard / aria semantics match
          the rest of the footer; the file picker is just an
          implementation detail. Confirm dialog inside `handleImportFile`
          warns that the import overwrites every existing override.
        */}
        <button
          type="button"
          className="btn btn-secondary btn-sm"
          onClick={triggerImportPicker}
          disabled={busyKey !== null}
        >
          {busyKey === '__import'
            ? <><span className="spinner-sm" aria-hidden="true" /> Importing…</>
            : 'Import flag state from JSON'}
        </button>
        <input
          ref={importFileRef}
          type="file"
          accept="application/json,.json"
          className="sr-only"
          // Tabbable input would let keyboard users land on a hidden
          // control, which is confusing — we control the focus story
          // entirely through the visible button above.
          tabIndex={-1}
          aria-hidden="true"
          onChange={handleImportFile}
        />
      </footer>

      {/*
        Confirm modal — Reset all overrides. Mirrors the wayback-remove
        and reset-app dialogs in SettingsView (`.modal-overlay` +
        `.modal-card` + `role="dialog"` + Escape-to-close +
        click-outside-to-close). Confirm button stays in the danger
        palette so users see the destructive intent immediately.
      */}
      {resetAllOpen && (
        <div
          className="modal-overlay"
          onClick={() => { if (busyKey === null) setResetAllOpen(false); }}
        >
          <div
            className="modal-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="dev-flag-reset-title"
            aria-describedby="dev-flag-reset-copy"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && busyKey === null) setResetAllOpen(false);
            }}
          >
            <div className="modal-badge">{tDevReset('badge')}</div>
            <h2 id="dev-flag-reset-title" className="modal-title">
              {tDevReset('title')}
            </h2>
            <p id="dev-flag-reset-copy" className="modal-copy">
              {tDevReset('copy', { count: overrideCount })}
            </p>
            <div className="modal-actions">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setResetAllOpen(false)}
                disabled={busyKey !== null}
              >
                {tDevReset('cancel')}
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => void resetAllConfirmed()}
                disabled={busyKey !== null}
                autoFocus
              >
                {busyKey === '__all'
                  ? <><span className="spinner-sm" aria-hidden="true" /> {tDevReset('resetting')}</>
                  : tDevReset('confirm', { count: overrideCount })}
              </button>
            </div>
          </div>
        </div>
      )}

      {/*
        Confirm modal — Import flag state from JSON. Same `.modal-card`
        chrome as the reset modal; copy spells out that the import
        WIPES every existing override before replaying the file's
        contents. Filename is shown in the body so users can
        cross-check they picked the right file before committing.
      */}
      {pendingImport && (
        <div
          className="modal-overlay"
          onClick={() => { if (busyKey === null) setPendingImport(null); }}
        >
          <div
            className="modal-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="dev-flag-import-title"
            aria-describedby="dev-flag-import-copy"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (event.key === 'Escape' && busyKey === null) setPendingImport(null);
            }}
          >
            <div className="modal-badge">Destructive action</div>
            <h2 id="dev-flag-import-title" className="modal-title">
              Import flag state?
            </h2>
            <p id="dev-flag-import-copy" className="modal-copy">
              Importing <code>{pendingImport.name}</code> will <strong>overwrite every existing
              flag override</strong> with the contents of the file. Flags whose entry has{' '}
              <code>override: null</code> revert to their computed default. The quarantine table
              and your focus + audience are preserved; only per-flag overrides change.
            </p>
            <div className="modal-actions">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setPendingImport(null)}
                disabled={busyKey !== null}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void importConfirmed()}
                disabled={busyKey !== null}
                autoFocus
              >
                {busyKey === '__import'
                  ? <><span className="spinner-sm" aria-hidden="true" /> Importing…</>
                  : 'Import & overwrite'}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Flag row
// ---------------------------------------------------------------------------

interface FlagListItemProps {
  row: FlagRow;
  busy: boolean;
  /** True when this row is the currently-selected one (drives purple ring). */
  isSelected: boolean;
  /** Click handler for the row chrome (anywhere outside the toggle controls). */
  onSelect: () => void;
  /**
   * Ref handed back to the parent for scroll-into-view. Only populated
   * when `isSelected` is true so the parent doesn't end up holding stale
   * refs to every row in the list.
   */
  selectedRowRef: React.RefObject<HTMLLIElement | null> | null;
  onChange: (next: FlagValue) => void;
  onClear: () => void;
}

// Per-value labels for the segmented toggle. Spelled out so screen
// readers announce "On selected" rather than the bare token "on".
const VALUE_LABEL: Record<FlagValue, string> = {
  on: 'On',
  off: 'Off',
  collapsed: 'Collapsed',
};

function FlagListItem({
  row,
  busy,
  isSelected,
  onSelect,
  selectedRowRef,
  onChange,
  onClear,
}: FlagListItemProps) {
  // i18n — for the per-row reset button's screen-reader-only label.
  const tDev = useTranslations('dev_options.feature_flags');
  const isOverridden = row.override !== null;
  const selectedValue = row.override ?? row.currentValue;
  // Where-used metadata for the hover popover + the "Show me where"
  // navigate button. `null` when the flag isn't in the curated
  // registry — we still render the row, just without the preview.
  const usage = getFlagUsage(row.key);
  const [hoverPreviewOpen, setHoverPreviewOpen] = useState(false);

  return (
    <li
      ref={selectedRowRef}
      className={
        `dev-options-flag-panel__flag-row` +
        (isOverridden ? ' is-overridden' : '') +
        (row.wired ? '' : ' is-unwired') +
        (isSelected ? ' is-selected' : '')
      }
      onMouseEnter={() => usage && setHoverPreviewOpen(true)}
      onMouseLeave={() => setHoverPreviewOpen(false)}
      onFocusCapture={() => usage && setHoverPreviewOpen(true)}
      onBlurCapture={(e) => {
        // Keep the popover open while focus moves between children
        // inside the row (e.g. tabbing from the row click target into
        // the toggle buttons). Only close when focus actually leaves
        // the row entirely.
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setHoverPreviewOpen(false);
        }
      }}
    >
      {/*
        Click target for "select this row". Clicking the key string or
        the status copy applies the purple ring + scroll-into-view via
        the parent's `selectedKey` state. The toggle buttons + reset
        button below are kept outside this clickable region (their own
        events) so they can be activated without selecting first.
      */}
      <button
        type="button"
        className="dev-options-flag-panel__flag-meta dev-options-flag-panel__flag-select"
        onClick={onSelect}
        aria-pressed={isSelected}
        aria-label={`Select ${row.key} for highlight`}
      >
        <code className="dev-options-flag-panel__flag-key">{row.key}</code>
        <span className="dev-options-flag-panel__flag-status">
          {isOverridden ? (
            <>
              <strong>{VALUE_LABEL[row.currentValue]}</strong>
              <span className="dev-options-flag-panel__flag-status-tag dev-options-flag-panel__flag-status-tag--custom">
                custom
              </span>
              <span className="dev-options-flag-panel__flag-default">
                would be {VALUE_LABEL[row.hardDefault]}
              </span>
            </>
          ) : (
            <>
              <strong>{VALUE_LABEL[row.currentValue]}</strong>
              <span className="dev-options-flag-panel__flag-default">default</span>
            </>
          )}
          {!row.wired && (
            <span
              className="dev-options-flag-panel__flag-unwired"
              title="This flag is in the registry but no component reads it yet — toggling it has no observable effect today. Wiring lands in a future PR."
            >
              no effect yet
            </span>
          )}
        </span>
      </button>

      {/*
        Hover preview popover. Anchored to the right of the row, fades
        in on hover/focus. Carries a one-line hint, the file paths the
        flag is wired into, and (when applicable) a "Show me where"
        link that navigates to the surface with `?flag-highlight=<key>`
        — the global FlagHighlightHandler picks that up and rings the
        gated element with the same purple border.
      */}
      {hoverPreviewOpen && usage && (
        <div className="dev-options-flag-preview" role="tooltip">
          <p className="dev-options-flag-preview-hint">{usage.hint}</p>
          {usage.files.length > 0 && (
            <ul className="dev-options-flag-preview-files">
              {usage.files.map((path) => (
                <li key={path}>
                  <code>{path}</code>
                </li>
              ))}
            </ul>
          )}
          {usage.route && (
            <Link
              href={{
                pathname: usage.route,
                query: { 'flag-highlight': usage.target ?? row.key },
              }}
              className="dev-options-flag-preview-link"
            >
              Show me where →
            </Link>
          )}
        </div>
      )}

      <div className="dev-options-flag-panel__flag-actions">
        {/*
          Segmented toggle modelled on the Recent Changes / Risk filter
          rows used elsewhere in the app — `role="radiogroup"` + per-
          button `role="radio"` + `aria-checked` so screen readers
          announce the three-way choice the way they would for native
          radios. Buttons keep `type="button"` so the implicit form
          submit doesn't fire from inside the Settings page.
        */}
        <div
          className="segmented-toggle dev-options-flag-panel__flag-toggle"
          role="radiogroup"
          aria-label={`Override value for ${row.key}`}
        >
          {VALUE_OPTIONS.map((v) => {
            const checked = selectedValue === v;
            return (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={checked}
                className={`segmented-toggle-btn${checked ? ' is-active' : ''}`}
                disabled={busy}
                onClick={() => onChange(v)}
              >
                {VALUE_LABEL[v]}
              </button>
            );
          })}
        </div>

        {isOverridden && (
          <button
            type="button"
            className="dev-options-flag-panel__flag-reset"
            onClick={onClear}
            disabled={busy}
            title="Clear override (revert to computed default)"
            aria-label={`Clear override for ${row.key}`}
          >
            <span aria-hidden="true">↺</span>
            <span className="sr-only">{tDev('row_reset_sr')}</span>
          </button>
        )}
      </div>
    </li>
  );
}
