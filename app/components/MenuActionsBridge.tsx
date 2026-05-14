'use client';

/**
 * Bridge for menu-driven window events that the Rust side dispatches
 * via `window.eval`. Each handler is intentionally tiny — the menu
 * lives in Rust (src-tauri/src/app_menu.rs), and the actual UI side
 * effect (focusing the search bar, writing to clipboard) is owned here.
 *
 * Listens for:
 *   - `search:focus` — Edit → Find (Cmd+F). Focuses the first element
 *     in the DOM with `data-search-focus`. Pages that have a search
 *     input add the attribute; pages without one no-op silently.
 *   - `diagnostics:copy-report` — Help → Copy Diagnostics Report.
 *     Invokes the existing `get_diagnostics_report` Tauri command and
 *     writes the result to the clipboard. Renders a brief inline
 *     status pill so the user gets visible confirmation without
 *     needing a global toast system.
 *
 * No-op outside the Tauri webview. Rendered once in app/layout.tsx
 * so the handlers are alive on every page.
 */

import { useEffect, useState } from 'react';
import { getDiagnosticsReport } from '../../lib/desktop';

export default function MenuActionsBridge() {
  const [status, setStatus] = useState<{ message: string; tone: 'ok' | 'error' } | null>(null);

  useEffect(() => {
    function onFocusSearch() {
      const target = document.querySelector<HTMLElement>('[data-search-focus]');
      if (!target) return;
      if (typeof (target as HTMLInputElement).select === 'function') {
        (target as HTMLInputElement).select();
      } else {
        target.focus();
      }
    }

    async function onCopyDiagnostics() {
      try {
        const report = await getDiagnosticsReport();
        if (!report) {
          setStatus({ message: 'Diagnostics unavailable.', tone: 'error' });
          return;
        }
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(report);
        } else {
          const textarea = document.createElement('textarea');
          textarea.value = report;
          textarea.setAttribute('readonly', 'true');
          textarea.style.position = 'fixed';
          textarea.style.left = '-9999px';
          document.body.appendChild(textarea);
          textarea.select();
          document.execCommand('copy');
          textarea.remove();
        }
        setStatus({ message: 'Diagnostics report copied to clipboard.', tone: 'ok' });
      } catch (err) {
        console.warn('[MenuActionsBridge] copy-diagnostics failed:', err);
        setStatus({ message: 'Failed to copy diagnostics report.', tone: 'error' });
      }
    }

    window.addEventListener('search:focus', onFocusSearch);
    window.addEventListener('diagnostics:copy-report', onCopyDiagnostics);
    return () => {
      window.removeEventListener('search:focus', onFocusSearch);
      window.removeEventListener('diagnostics:copy-report', onCopyDiagnostics);
    };
  }, []);

  // Auto-dismiss the status pill after 3 s so it doesn't linger.
  useEffect(() => {
    if (!status) return;
    const id = setTimeout(() => setStatus(null), 3000);
    return () => clearTimeout(id);
  }, [status]);

  if (!status) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed',
        bottom: 24,
        right: 24,
        zIndex: 9999,
        padding: '10px 14px',
        background: 'var(--bg-2)',
        color: status.tone === 'error' ? 'var(--danger)' : 'var(--text)',
        border: `1px solid ${status.tone === 'error' ? 'var(--danger)' : 'var(--border-strong)'}`,
        borderRadius: 'var(--r-md)',
        boxShadow: 'var(--shadow-lg)',
        fontSize: 13,
        maxWidth: 320,
      }}
    >
      {status.message}
    </div>
  );
}
