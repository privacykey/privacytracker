'use client';

import { useEffect, useState } from 'react';

/**
 * "Raise an issue on GitHub" link for the 404 page (and anywhere else we
 * want a one-click bug-report affordance).
 *
 * The issue URL is built in a `useEffect` so it can read `window.location.href`
 * and `document.referrer` at click time — those tell the maintainer exactly
 * which path 404'd and where the user came from. Before hydration (or with
 * JS disabled), the link still works: it falls back to the generic "new
 * issue from template" URL, which opens the same bug-report form without
 * the prefill.
 *
 * The field IDs (`current-url`, `previous-url`, `browser`) must match the
 * `id:` values in `.github/ISSUE_TEMPLATE/bug_report.yml`, or GitHub will
 * ignore the prefill params silently.
 */

const REPO = 'privacykey/privacytracker';
const TEMPLATE = 'bug_report.yml';
const FALLBACK_HREF = `https://github.com/${REPO}/issues/new?template=${TEMPLATE}`;

/** GitHub caps the querystring — keep prefilled values reasonable. */
const MAX_URL_LENGTH = 500;
const MAX_UA_LENGTH = 240;

function clamp(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, max - 1) + '…';
}

export default function GithubIssueLink({ className }: { className?: string }) {
  const [href, setHref] = useState<string>(FALLBACK_HREF);

  useEffect(() => {
    try {
      const current = clamp(window.location.href, MAX_URL_LENGTH);
      const previous = document.referrer
        ? clamp(document.referrer, MAX_URL_LENGTH)
        : '(direct link — no referrer)';
      const ua = clamp(navigator.userAgent ?? '', MAX_UA_LENGTH);
      const title = `404 on ${window.location.pathname}`;

      // URLSearchParams handles the encoding for us. GitHub issue forms
      // accept field-id keys and map them onto the form fields.
      const params = new URLSearchParams({
        template: TEMPLATE,
        title,
        'current-url': current,
        'previous-url': previous,
        browser: ua,
      });

      setHref(`https://github.com/${REPO}/issues/new?${params.toString()}`);
    } catch {
      // If window/navigator look weird (ancient browser, extension shim),
      // keep the fallback URL. The user can still file a blank report.
    }
  }, []);

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={className}
    >
      Not what you&apos;re expecting? <span>Raise an issue on GitHub →</span>
    </a>
  );
}
