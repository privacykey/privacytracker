/**
 * "Report this problem" link for the error pages (app/error.tsx and
 * app/global-error.tsx).
 *
 * Same bug-report template and repo as GithubIssueLink and SiteInfoHint;
 * keep all three in sync if the repo is ever renamed. The field ids
 * (`report-type`, `current-url`) must match `.github/ISSUE_TEMPLATE/
 * bug_report.yml`, or GitHub ignores the prefill silently.
 *
 * The prefill carries the PATH only: no host (a LAN install's own name),
 * no query string, and never the error message, which can quote app names
 * or other data from the page. The reporter sees the form before sending
 * and can add detail themselves.
 *
 * No React and no DOM access, so global-error can use it even when the
 * failure that brought it up was in the providers.
 */

const REPO = "privacykey/privacytracker";
const TEMPLATE = "bug_report.yml";

/** The plain template, for before hydration or an unusable path. */
export const ERROR_REPORT_FALLBACK_HREF = `https://github.com/${REPO}/issues/new?template=${TEMPLATE}`;

const MAX_PATH_LENGTH = 200;

export function errorReportHref(pathname: string | null | undefined): string {
  if (
    !pathname?.startsWith("/") ||
    pathname.startsWith("//") ||
    pathname.length > MAX_PATH_LENGTH
  ) {
    return ERROR_REPORT_FALLBACK_HREF;
  }
  const params = new URLSearchParams({
    template: TEMPLATE,
    "report-type": "Feature bug",
    title: `Error on ${pathname}`,
    "current-url": pathname,
  });
  return `https://github.com/${REPO}/issues/new?${params.toString()}`;
}
