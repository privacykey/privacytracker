/**
 * Client-safe semver comparison. Extracted from `lib/update-check.ts`
 * (which is server-only via its transitive `feature-flags-server`
 * dependency) so client modules — `lib/tauri-updater.ts`, the update
 * banner — can call it without dragging the server tree into the
 * browser bundle.
 *
 * Permissive: accepts `MAJOR.MINOR.PATCH[-prerelease][+build]`.
 * Pre-release tags rank lower than no tag (so 0.1.0 > 0.1.0-beta.1).
 * Build metadata is ignored. Zero-deps so importing this from a client
 * component is safe.
 */

function stripBuild(v: string): string {
  const i = v.indexOf('+');
  return i === -1 ? v : v.slice(0, i);
}

/**
 * Compare two semver strings. Returns >0/0/<0 (a vs b).
 */
export function compareVersions(a: string, b: string): number {
  const [aCore, aPre] = stripBuild(a).split('-', 2) as [string, string | undefined];
  const [bCore, bPre] = stripBuild(b).split('-', 2) as [string, string | undefined];

  const aParts = aCore.split('.').map(n => parseInt(n, 10) || 0);
  const bParts = bCore.split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const diff = (aParts[i] ?? 0) - (bParts[i] ?? 0);
    if (diff !== 0) return diff;
  }

  if (!aPre && !bPre) return 0;
  if (!aPre) return 1;
  if (!bPre) return -1;

  const aIds = aPre.split('.');
  const bIds = bPre.split('.');
  const len = Math.max(aIds.length, bIds.length);
  for (let i = 0; i < len; i++) {
    const x = aIds[i];
    const y = bIds[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x) ? parseInt(x, 10) : NaN;
    const yn = /^\d+$/.test(y) ? parseInt(y, 10) : NaN;
    if (!Number.isNaN(xn) && !Number.isNaN(yn)) {
      if (xn !== yn) return xn - yn;
    } else if (!Number.isNaN(xn)) {
      return -1;
    } else if (!Number.isNaN(yn)) {
      return 1;
    } else {
      const cmp = x < y ? -1 : x > y ? 1 : 0;
      if (cmp !== 0) return cmp;
    }
  }
  return 0;
}
