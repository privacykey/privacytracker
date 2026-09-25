"use client";

import { useEffect, useState } from "react";
import {
  ERROR_REPORT_FALLBACK_HREF,
  errorReportHref,
} from "@/lib/error-report-link";

/**
 * Last-resort error page: shown when the root layout or the app chrome
 * (AppChrome and its providers) throws, which app/error.tsx cannot catch
 * because it renders inside them.
 *
 * It replaces the whole document, so it brings its own <html>, <body> and
 * styles and depends on nothing the failure may have taken down:
 *
 * - No locale provider. The copy is English on purpose and kept to a few
 *   plain sentences; the translated message files are not loaded here,
 *   because a failed chunk load is one of the ways to end up on this page.
 * - No globals.css and no a11y pre-hydration script, so it follows the
 *   system light/dark setting through its own inline styles. Inline
 *   <style> is allowed by the CSP (style-src 'unsafe-inline'); there is no
 *   inline <script>, so the hash-based script-src is unaffected.
 * - The home link is a plain <a>, a full page load, in case the client
 *   router is what broke.
 */

// English only by design (see above). Kept out of JSX text so the copy is
// in one place.
const COPY = {
  documentTitle: "Something went wrong · privacytracker",
  eyebrow: "privacytracker",
  title: "Something went wrong",
  body: "The app hit a problem it could not recover from. Trying again usually fixes it. If it keeps happening, going back to the home page reloads everything.",
  tryAgain: "Try again",
  home: "Go to the home page",
  report: "Report this problem on GitHub",
};

const STYLES = `
  .global-error-body {
    margin: 0;
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #08080f;
    color: #f5f5f7;
    -webkit-font-smoothing: antialiased;
  }
  .global-error-root {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    padding: 24px 16px;
    box-sizing: border-box;
  }
  .global-error-card {
    width: 100%;
    max-width: 520px;
    box-sizing: border-box;
    padding: 36px 32px;
    text-align: center;
    background: #111118;
    border: 1px solid rgba(255, 255, 255, 0.13);
    border-radius: 20px;
  }
  .global-error-eyebrow {
    margin: 0 0 12px;
    font-size: 12px;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: #a0a0b0;
  }
  .global-error-title {
    margin: 0 0 12px;
    font-size: 26px;
    line-height: 1.2;
  }
  .global-error-text {
    margin: 0 auto 24px;
    max-width: 420px;
    font-size: 15px;
    line-height: 1.55;
    color: #a0a0b0;
  }
  .global-error-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 10px;
    justify-content: center;
    margin-bottom: 20px;
  }
  .global-error-btn {
    display: inline-flex;
    align-items: center;
    padding: 10px 20px;
    font: inherit;
    font-size: 14px;
    font-weight: 600;
    border-radius: 999px;
    border: 1px solid transparent;
    cursor: pointer;
    text-decoration: none;
  }
  .global-error-btn-primary {
    color: #ffffff;
    background: #0a6cd6;
  }
  .global-error-btn-secondary {
    color: #f5f5f7;
    background: rgba(255, 255, 255, 0.04);
    border-color: rgba(255, 255, 255, 0.13);
  }
  .global-error-btn:focus-visible,
  .global-error-report a:focus-visible {
    outline: 2px solid #409cff;
    outline-offset: 3px;
  }
  .global-error-report {
    margin: 0;
    font-size: 13px;
  }
  .global-error-report a {
    color: #409cff;
    font-weight: 600;
  }
  @media (prefers-color-scheme: light) {
    .global-error-body {
      background: #f2f2f7;
      color: #1d1d1f;
    }
    .global-error-card {
      background: #ffffff;
      border-color: rgba(0, 0, 0, 0.1);
    }
    .global-error-eyebrow,
    .global-error-text {
      color: #5b5b63;
    }
    .global-error-btn-secondary {
      color: #1d1d1f;
      background: rgba(0, 0, 0, 0.03);
      border-color: rgba(0, 0, 0, 0.12);
    }
    .global-error-report a {
      color: #0060c0;
    }
  }
`;

export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [reportHref, setReportHref] = useState(ERROR_REPORT_FALLBACK_HREF);
  useEffect(() => {
    setReportHref(errorReportHref(window.location.pathname));
  }, []);

  return (
    <html lang="en">
      <head>
        <title>{COPY.documentTitle}</title>
        <style>{STYLES}</style>
      </head>
      <body className="global-error-body">
        <main className="global-error-root">
          <section
            aria-labelledby="global-error-title"
            className="global-error-card"
            role="alert"
          >
            <p className="global-error-eyebrow">{COPY.eyebrow}</p>
            <h1 className="global-error-title" id="global-error-title">
              {COPY.title}
            </h1>
            <p className="global-error-text">{COPY.body}</p>
            <div className="global-error-actions">
              <button
                className="global-error-btn global-error-btn-primary"
                data-testid="global-error-retry"
                onClick={reset}
                type="button"
              >
                {COPY.tryAgain}
              </button>
              {/* A plain anchor on purpose: a full page load, not a
                  client-router navigation. */}
              <a
                className="global-error-btn global-error-btn-secondary"
                href="/"
              >
                {COPY.home}
              </a>
            </div>
            <p className="global-error-report">
              <a href={reportHref} rel="noopener noreferrer" target="_blank">
                {COPY.report}
              </a>
            </p>
          </section>
        </main>
      </body>
    </html>
  );
}
