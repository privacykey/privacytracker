/**
 * Live runtime-diagnostics dashboard.
 *
 * Server shell — hands off to a client component that polls
 * /api/diagnostics/runtime every 2s. Kept dynamic so the SSR pass
 * doesn't pre-render stale numbers; the client takes over instantly
 * after hydration.
 *
 * No `redirect('/onboard')` guard like settings/page.tsx — diagnostics
 * is meant to be reachable even when the DB is in a weird state, since
 * "weird state" is exactly when the user wants to look at it.
 */
import type { Metadata } from 'next';
import Nav from '../../components/Nav';
import DiagnosticsView from '../../components/DiagnosticsView';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = {
  title: 'Diagnostics · privacytracker',
  description: 'Live runtime metrics for the Node sidecar — memory, event-loop lag, slow queries.',
};

export default function DiagnosticsPage() {
  return (
    <>
      <Nav />
      <DiagnosticsView />
    </>
  );
}
