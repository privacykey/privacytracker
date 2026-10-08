/**
 * App Store version strings, as the iTunes Lookup `version` field reports
 * them, are the developer's marketing version and are stored verbatim. Most
 * are bare ("1.181"), but some developers write their own prefix: Obscura
 * VPN ships "v1.181". Every sentence that names a version adds its own "v"
 * ("Updated to v{version}"), so the raw value printed "vv1.181".
 *
 * `bareVersion` drops a leading "v" or "V" when a digit follows, so a
 * caller's "v" is the only one. It is for display only: the stored value
 * and the version-change comparison keep Apple's string unchanged.
 * Client-safe. Mirrored by `bare_version` in core/src/scrape/notify.rs.
 */
export function bareVersion(version: string): string {
  return /^[vV]\d/.test(version) ? version.slice(1) : version;
}
