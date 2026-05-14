'use client';

/**
 * "Simple" editable dashboard layout — preset pills + drag-to-reorder rows
 * + per-card show/hide toggles. The list-view counterpart to the
 * edit-in-place mode on /dashboard itself. Each row carries a small
 * thumbnail sketch so users can identify what each card looks like
 * without leaving the page.
 *
 * State + persist semantics live in `useDashboardLayoutSaver`; this file
 * is purely the list-view UI.
 */

import { useCallback } from 'react';
import { useTranslations } from 'next-intl';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  CALLOUT_CARDS,
  DASHBOARD_PRESET_KEYS,
  DASHBOARD_PRESET_META,
  type DashboardCardId,
  type DashboardLayout,
} from '../../lib/dashboard-layout';
import { useDashboardLayoutSaver } from '../../lib/use-dashboard-layout-saver';
import { CardThumbnail } from './DashboardCardThumbnail';

interface Props {
  initialLayout: DashboardLayout;
}

export default function DashboardLayoutEditor({ initialLayout }: Props) {
  const t = useTranslations('dashboard.layout_editor');
  const tPresetLabel = useTranslations('dashboard.layout_editor.presets.labels');
  const tPresetDesc = useTranslations('dashboard.layout_editor.presets.descriptions');
  const tCardLabel = useTranslations('dashboard.layout_editor.cards.labels');
  const tCardDesc = useTranslations('dashboard.layout_editor.cards.descriptions');

  const saver = useDashboardLayoutSaver(initialLayout);
  const {
    layout,
    activePreset,
    hiddenSet,
    savingState,
    errorMsg,
    liveMessage,
    pendingPreset,
    applyPreset,
    cancelPendingPreset,
    resetLayout,
    toggleVisibility,
    reorder,
  } = saver;

  // dnd-kit sensors. PointerSensor handles mouse + touch; KeyboardSensor
  // gives Space/Arrow reordering. `activationConstraint.distance` keeps
  // a 5-px tap from triggering a drag when the user just wants to tick
  // the checkbox.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!over || active.id === over.id) return;
      reorder(active.id as DashboardCardId, over.id as DashboardCardId);
    },
    [reorder],
  );

  return (
    <div className="layout-editor">
      {/* Preset row — opinionated whole-layout shortcuts. */}
      <div className="layout-editor-presets">
        <div className="layout-editor-presets-header">
          <span className="layout-editor-presets-label">
            {t('preset_section_label')}
          </span>
          <span className="layout-editor-presets-hint">
            {t('preset_section_hint')}
          </span>
        </div>
        <div
          className="layout-editor-presets-row"
          role="radiogroup"
          aria-label={t('preset_aria_group')}
        >
          {DASHBOARD_PRESET_KEYS.map(presetKey => {
            const meta = DASHBOARD_PRESET_META[presetKey];
            const isActive = activePreset === presetKey;
            const isPending = pendingPreset === presetKey;
            return (
              <div
                key={presetKey}
                className={`layout-editor-preset-cell${
                  isPending ? ' has-pending-confirm' : ''
                }`}
              >
                <button
                  type="button"
                  role="radio"
                  aria-checked={isActive}
                  className={`layout-editor-preset-pill${
                    isActive ? ' is-active' : ''
                  }`}
                  data-preset={presetKey}
                  data-severity={meta.severityCls}
                  onClick={() => applyPreset(presetKey)}
                  title={tPresetDesc(presetKey)}
                >
                  <span className="layout-editor-preset-icon" aria-hidden="true">
                    {meta.icon}
                  </span>
                  <span className="layout-editor-preset-text">
                    <span className="layout-editor-preset-title">
                      {tPresetLabel(presetKey)}
                    </span>
                    <span className="layout-editor-preset-desc">
                      {tPresetDesc(presetKey)}
                    </span>
                  </span>
                </button>
                {isPending && (
                  <div
                    className="layout-editor-preset-confirm"
                    role="dialog"
                    aria-label={t('confirm_aria')}
                  >
                    <p className="layout-editor-preset-confirm-text">
                      {t('confirm_text', { preset: tPresetLabel(presetKey) })}
                    </p>
                    <div className="layout-editor-preset-confirm-actions">
                      <button
                        type="button"
                        className="btn btn-primary btn-sm"
                        onClick={() => applyPreset(presetKey, true)}
                      >
                        {t('confirm_apply')}
                      </button>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={cancelPendingPreset}
                      >
                        {t('confirm_cancel')}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Sortable card list. */}
      <div className="layout-editor-list-wrap">
        <div className="layout-editor-list-header">
          <span className="layout-editor-list-title">{t('list_title')}</span>
          <div className="layout-editor-list-status">
            {savingState === 'saving' && (
              <span className="layout-editor-saving" aria-hidden="true">
                {t('saving')}
              </span>
            )}
            {savingState === 'saved' && (
              <span className="layout-editor-saved" aria-hidden="true">
                {t('saved')}
              </span>
            )}
            {savingState === 'error' && errorMsg && (
              <span className="layout-editor-error" role="alert">
                {t('save_error', { message: errorMsg })}
              </span>
            )}
            <button
              type="button"
              className="btn btn-ghost btn-sm layout-editor-reset"
              onClick={resetLayout}
              disabled={savingState === 'saving'}
            >
              {t('reset_button')}
            </button>
          </div>
        </div>

        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext
            items={layout.order as string[]}
            strategy={verticalListSortingStrategy}
          >
            <ol className="layout-editor-list" aria-label={t('list_aria')}>
              {layout.order.map(id => (
                <SortableRow
                  key={id}
                  id={id}
                  hidden={hiddenSet.has(id)}
                  label={tCardLabel(id)}
                  description={tCardDesc(id)}
                  showHideLabel={t('show_hide_label')}
                  autoManagedLabel={t('auto_managed_label')}
                  autoManagedTitle={t('auto_managed_title')}
                  dragHandleAria={t('drag_handle_aria', { name: tCardLabel(id) })}
                  onToggleVisibility={() => toggleVisibility(id)}
                />
              ))}
            </ol>
          </SortableContext>
        </DndContext>
      </div>

      {/* Live region for keyboard drag + post-save announcements. */}
      <div
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {liveMessage}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────
// Sortable row
// ─────────────────────────────────────────────

interface SortableRowProps {
  id: DashboardCardId;
  hidden: boolean;
  label: string;
  description: string;
  showHideLabel: string;
  autoManagedLabel: string;
  autoManagedTitle: string;
  dragHandleAria: string;
  onToggleVisibility: () => void;
}

function SortableRow({
  id,
  hidden,
  label,
  description,
  showHideLabel,
  autoManagedLabel,
  autoManagedTitle,
  dragHandleAria,
  onToggleVisibility,
}: SortableRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id });

  const isCallout = CALLOUT_CARDS.has(id);
  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.7 : 1,
  };

  return (
    <li
      ref={setNodeRef}
      style={style}
      className={`layout-editor-row${isDragging ? ' is-dragging' : ''}${
        hidden ? ' is-hidden' : ''
      }${isCallout ? ' is-callout' : ''}`}
      data-card-id={id}
    >
      <button
        type="button"
        className="layout-editor-drag-handle"
        aria-label={dragHandleAria}
        {...attributes}
        {...listeners}
      >
        <span aria-hidden="true">⋮⋮</span>
      </button>

      <div className="layout-editor-row-thumb" aria-hidden="true">
        <CardThumbnail id={id} />
      </div>

      <div className="layout-editor-row-body">
        <div className="layout-editor-row-title">{label}</div>
        <div className="layout-editor-row-desc">{description}</div>
      </div>

      <div className="layout-editor-row-controls">
        {isCallout ? (
          <span
            className="layout-editor-auto-managed"
            title={autoManagedTitle}
            aria-label={autoManagedTitle}
          >
            {autoManagedLabel}
          </span>
        ) : (
          <label className="layout-editor-visibility-toggle">
            <input
              type="checkbox"
              checked={!hidden}
              onChange={onToggleVisibility}
              aria-label={`${showHideLabel} — ${label}`}
            />
            <span className="layout-editor-visibility-text">{showHideLabel}</span>
          </label>
        )}
      </div>
    </li>
  );
}
