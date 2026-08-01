/**
 * Formatting helpers shared by settings sections.
 *
 * Small enough to have lived inline in SettingsView, but two sections
 * now need them (Deployment Diagnostics for the DB size, Backup for
 * snapshot sizes), and duplicating a formatter is how two surfaces
 * quietly start disagreeing about what "1.5 MB" means.
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
