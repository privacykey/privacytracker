/**
 * Text alternatives for the ECharts canvases (WCAG 1.1.1).
 *
 * A canvas chart is a picture to assistive technology. Every chart the
 * app draws therefore carries an accessible name (EChart's `ariaLabel`)
 * and, where the data fits in words, a description that restates it
 * (EChart's `ariaDescription`). This module holds the pure data side of
 * those descriptions: it picks out what is worth saying from each
 * chart's payload. The components turn the result into localised
 * sentences with next-intl, so nothing here holds user-facing copy.
 *
 * Pure data in, pure data out: no React, no DOM, so it is unit-tested
 * under node:test (tests/app/chart-text-alternatives.test.ts).
 */

/**
 * An ECharts option with its `aria` feature switched on and the label
 * pinned to ours, so ECharts writes the same name onto the chart root
 * that React does instead of generating its own summary (which it can
 * only word in English or Chinese, from series names and raw values).
 * Merges into any `aria` the caller set, such as the shapes-mode decal
 * flags, rather than replacing it.
 */
export function withAriaLabel<T extends object>(option: T, label: string): T {
  const aria = ((option as { aria?: unknown }).aria ?? {}) as Record<
    string,
    unknown
  >;
  const ariaLabel = (aria.label ?? {}) as Record<string, unknown>;
  return {
    ...option,
    aria: {
      ...aria,
      enabled: true,
      label: { ...ariaLabel, enabled: true, description: label },
    },
  };
}

export interface SeriesInput {
  name: string;
  values: readonly number[];
}

export interface SeriesItem {
  name: string;
  value: number;
}

export interface BucketSummary {
  items: SeriesItem[];
  label: string;
}

/**
 * The non-empty buckets of a category-axis chart (the change timelines),
 * each with only the series that have a value there. Empty buckets and
 * zero values are dropped: read aloud, "0 policy changes" twelve times
 * over hides the three weeks that had any.
 */
export function summariseBuckets(
  labels: readonly string[],
  series: readonly SeriesInput[]
): BucketSummary[] {
  const out: BucketSummary[] = [];
  labels.forEach((label, i) => {
    const items: SeriesItem[] = [];
    for (const s of series) {
      const value = s.values[i] ?? 0;
      if (value > 0) {
        items.push({ name: s.name, value });
      }
    }
    if (items.length > 0) {
      out.push({ label, items });
    }
  });
  return out;
}

export interface MatrixAppInput {
  id: string;
  name: string;
}

export interface LabelledId {
  identifier: string;
  label: string;
}

export interface SeverityGroup {
  categories: string[];
  severity: string;
}

export interface AppSeverityGroups {
  groups: SeverityGroup[];
  name: string;
}

/**
 * For each app, its collected categories grouped by severity, in the
 * order `severities` lists them (the chart legend's order) and, inside a
 * group, in the order `categories` lists them (the chart axis's order).
 * An app with nothing collected has no groups.
 */
export function groupAppsBySeverity(
  apps: readonly MatrixAppInput[],
  categories: readonly LabelledId[],
  cells: Readonly<Record<string, Readonly<Record<string, string>>>>,
  severities: readonly LabelledId[]
): AppSeverityGroups[] {
  return apps.map((app) => {
    const row = cells[app.id] ?? {};
    const groups: SeverityGroup[] = [];
    for (const sev of severities) {
      const cats = categories
        .filter((c) => row[c.identifier] === sev.identifier)
        .map((c) => c.label);
      if (cats.length > 0) {
        groups.push({ severity: sev.label, categories: cats });
      }
    }
    return { name: app.name, groups };
  });
}

export interface SeverityFlow {
  appCount: number;
  categories: string[];
  severity: string;
}

/**
 * The Sankey's middle column in words: for each severity, how many of
 * the plotted apps have at least one category there, and which
 * categories flow out of it. Severities nothing flows through are left
 * out, as the chart leaves out their node.
 */
export function summariseSeverityFlow(
  apps: readonly MatrixAppInput[],
  categories: readonly LabelledId[],
  cells: Readonly<Record<string, Readonly<Record<string, string>>>>,
  severities: readonly LabelledId[]
): SeverityFlow[] {
  const out: SeverityFlow[] = [];
  for (const sev of severities) {
    let appCount = 0;
    const used = new Set<string>();
    for (const app of apps) {
      const row = cells[app.id] ?? {};
      let hit = false;
      for (const [catId, s] of Object.entries(row)) {
        if (s === sev.identifier) {
          hit = true;
          used.add(catId);
        }
      }
      if (hit) {
        appCount++;
      }
    }
    if (appCount > 0) {
      out.push({
        severity: sev.label,
        appCount,
        categories: categories
          .filter((c) => used.has(c.identifier))
          .map((c) => c.label),
      });
    }
  }
  return out;
}
