"use client";

import ErrorContent from "./components/content/ErrorContent";

/**
 * Route error boundary for every page under the root layout. Without it a
 * render-time exception in any client component showed Next's default
 * "Application error: a client-side exception has occurred" with no way
 * back.
 *
 * It renders inside AppChrome, so it is translated and styled like the
 * rest of the app. An error in the root layout or the chrome itself is
 * caught by app/global-error.tsx instead.
 *
 * "Try again" calls `reset`, which re-renders the page. Every page is a
 * static client shell that fetches its data on mount, so a remount is a
 * fresh load; there is no server-rendered data for `retry` to refresh.
 */
export default function ErrorBoundaryPage({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return <ErrorContent onRetry={reset} />;
}
