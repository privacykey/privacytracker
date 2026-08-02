/**
 * Formatting helpers shared by settings sections.
 *
 * Small enough to have lived inline in SettingsView, but two sections
 * now need them (Deployment Diagnostics for the DB size, Backup for
 * snapshot sizes), and duplicating a formatter is how two surfaces
 * quietly start disagreeing about what "1.5 MB" means.
 *
 * The date/duration helpers below landed here for the same reason when
 * the Developer Options panels moved out: SettingsView still formats
 * sync timestamps and import durations, and the activity log formats
 * the same things in its own component.
 */

export function fmtBytes(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes)) {
    return "—";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let i = 1; i < units.length && value >= 1024; i += 1) {
    value /= 1024;
    unit = units[i];
  }
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${unit}`;
}

/**
 * `t` is the translator namespaced at `settings.time`. Module-level so the
 * function signature stays stable for callers, but the strings now route
 * through the locale bundle. Numerals stay numeric — Intl.PluralRules
 * isn't useful for these compact countdowns since neither English nor
 * Mandarin distinguish them.
 */
export type TimeT = (
  key: string,
  values?: Record<string, string | number>
) => string;

export type DateT = (
  key: string,
  values?: Record<string, string | number>
) => string;

/**
 * Format an epoch-ms as a localised "5 Apr 2025, 14:30" string. Translator
 * arg supplies the localised "Never" placeholder for unset (0) values; the
 * surrounding numeric formatting is handed to Intl.DateTimeFormat with the
 * `en-AU` locale so the date string keeps its day/month/year ordering
 * regardless of UI locale (zh users still see "5 Apr 2025" etc.).
 */
export function fmtDate(t: DateT, ts: number) {
  if (!ts) {
    return t("fmt_never");
  }
  return new Intl.DateTimeFormat("en-AU", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(ts));
}

/** Rough "N minutes ago" formatter — coarse enough for a log view. */
export function fmtRelativeTime(t: TimeT, tDate: DateT, ts: number): string {
  const now = Date.now();
  const diff = now - ts;
  if (diff < 0) {
    return fmtDate(tDate, ts);
  }
  if (diff < 45_000) {
    return t("rel_just_now");
  }
  if (diff < 90_000) {
    return t("rel_one_min");
  }
  if (diff < 60 * 60_000) {
    return t("rel_mins_ago", { count: Math.round(diff / 60_000) });
  }
  if (diff < 2 * 60 * 60_000) {
    return t("rel_one_hr");
  }
  if (diff < 24 * 60 * 60_000) {
    return t("rel_hrs_ago", { count: Math.round(diff / (60 * 60_000)) });
  }
  if (diff < 2 * 24 * 60 * 60_000) {
    return t("rel_yesterday");
  }
  if (diff < 7 * 24 * 60 * 60_000) {
    return t("rel_days_ago", { count: Math.round(diff / (24 * 60 * 60_000)) });
  }
  return fmtDate(tDate, ts);
}

/** Duration in a compact form: 430ms / 3.2s / 1m 20s. */
export function fmtDuration(ms: number): string {
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  }
  const mins = Math.floor(ms / 60_000);
  const secs = Math.round((ms % 60_000) / 1000);
  return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
}
