import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";

/**
 * Shared axe-core harness for the E2E accessibility gate
 * (`tests/e2e/a11y.spec.ts`).
 *
 * Policy: violations with `serious` or
 * `critical` impact FAIL the suite; `minor`/`moderate` findings are
 * logged to the Playwright report but don't block. Scans run against
 * the WCAG 2.x A/AA rule tags only — best-practice rules stay
 * advisory in the Storybook a11y addon.
 *
 * Known-issue allowlist: defects that are already tracked for fixing
 * are filtered per rule + selector so the gate stays green while
 * blocking NEW regressions. Every entry names the pending fix that
 * removes it — when that fix lands, the run prints a
 * "no longer detected" notice and the entry must be deleted in the
 * same PR.
 */

const WCAG_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];

const BLOCKING_IMPACTS = new Set(["serious", "critical"]);

export interface KnownIssue {
  /**
   * Substring matched against each violating node's CSS target AND its
   * outer HTML (axe often picks attribute selectors like
   * `a[href$="privacy-policy"]` over class names, so the class usually
   * only appears in the HTML). An entry only suppresses nodes that
   * contain this string — the same rule firing elsewhere on the page
   * still fails the gate.
   */
  match: string;
  /** Roadmap anchor + PR that deletes this entry. */
  reason: string;
  /** axe rule id, e.g. "label" or "nested-interactive". */
  rule: string;
}

interface ViolationNode {
  html: string;
  target: string[];
}

interface Violation {
  help: string;
  helpUrl: string;
  id: string;
  impact: string | null;
  nodes: ViolationNode[];
}

function nodeIsKnown(
  rule: string,
  node: ViolationNode,
  knownIssues: KnownIssue[]
): boolean {
  const haystack = `${node.target.join(" ")} ${node.html}`;
  return knownIssues.some((k) => k.rule === rule && haystack.includes(k.match));
}

function formatViolations(label: string, violations: Violation[]): string {
  const lines = violations.map((v) => {
    const nodes = v.nodes
      .map(
        (n) => `      ${n.target.join(" ")}\n        ${n.html.slice(0, 200)}`
      )
      .join("\n");
    return `  [${v.impact}] ${v.id}: ${v.help}\n    ${v.helpUrl}\n${nodes}`;
  });
  return `axe (${label}) found ${violations.length} blocking violation(s):\n${lines.join("\n")}`;
}

/**
 * Run an axe scan and throw on serious/critical WCAG A/AA violations
 * that aren't covered by `knownIssues`.
 *
 * @param label surface name used in failure output, e.g. "welcome".
 * @param options.include restrict the scan to a CSS selector (e.g. an
 *   open dialog) instead of the whole document.
 */
export async function expectNoBlockingViolations(
  page: Page,
  label: string,
  options: {
    knownIssues?: KnownIssue[];
    include?: string;
  } = {}
): Promise<void> {
  const knownIssues = options.knownIssues ?? [];

  let builder = new AxeBuilder({ page }).withTags(WCAG_TAGS);
  if (options.include) {
    builder = builder.include(options.include);
  }
  const results = await builder.analyze();

  const blocking: Violation[] = [];
  const advisory: Violation[] = [];
  const suppressedRules = new Set<string>();

  for (const violation of results.violations as Violation[]) {
    const unknownNodes = violation.nodes.filter(
      (node) => !nodeIsKnown(violation.id, node, knownIssues)
    );
    if (unknownNodes.length < violation.nodes.length) {
      suppressedRules.add(violation.id);
    }
    if (unknownNodes.length === 0) {
      continue;
    }
    const remaining = { ...violation, nodes: unknownNodes };
    if (BLOCKING_IMPACTS.has(violation.impact ?? "")) {
      blocking.push(remaining);
    } else {
      advisory.push(remaining);
    }
  }

  // Surface allowlist entries whose defect no longer reproduces so the
  // fixing PR remembers to delete them (stale entries would mask a
  // future regression on the same selector).
  for (const known of knownIssues) {
    const stillPresent = (results.violations as Violation[]).some(
      (v) =>
        v.id === known.rule &&
        v.nodes.some((n) => nodeIsKnown(v.id, n, [known]))
    );
    if (!stillPresent) {
      console.log(
        `[a11y:${label}] known issue no longer detected — remove its allowlist entry: ` +
          `${known.rule} @ ${known.match} (${known.reason})`
      );
    }
  }
  if (suppressedRules.size > 0) {
    console.log(
      `[a11y:${label}] suppressed known tracked issues: ${[...suppressedRules].join(", ")}`
    );
  }
  if (advisory.length > 0) {
    console.log(
      `[a11y:${label}] non-blocking findings (minor/moderate): ${advisory
        .map((v) => `${v.id}×${v.nodes.length}`)
        .join(", ")}`
    );
  }

  if (blocking.length > 0) {
    throw new Error(formatViolations(label, blocking));
  }
}
