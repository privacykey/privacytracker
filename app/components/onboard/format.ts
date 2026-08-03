/**
 * Formatting helpers shared by the onboarding pieces.
 */

export function formatMs(ms: number): string {
  if (ms < 0) {
    ms = 0;
  }
  const secs = Math.round(ms / 1000);
  if (secs < 60) {
    return `${secs}s`;
  }
  const mins = Math.floor(secs / 60);
  const remSec = secs % 60;
  return remSec === 0 ? `${mins}m` : `${mins}m ${remSec}s`;
}
