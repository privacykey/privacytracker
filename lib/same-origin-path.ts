/**
 * Whether a stored or received path can only ever navigate within this
 * app. Shared by the server (which decides what it hands out) and the
 * client (which checks again before it navigates), so neither trusts the
 * other alone.
 *
 * The rule is stricter than "starts with a slash", because a URL parser
 * turns several path-looking strings into another host: `//host` and
 * `/\host` are network-path references (browsers read `\` as `/`), and
 * tabs and newlines are dropped before parsing, so `/<TAB>/host` becomes
 * `//host`. A path passes only when it
 *
 * - starts with exactly one `/`,
 * - contains no backslash, no ASCII control character and no space, and
 * - resolves against a placeholder origin to that same origin.
 *
 * The last check is redundant after the first two; it stays as the
 * definition the first two implement. `core/src/server/writes.rs` has
 * the same rule for the Rust server.
 */
const PLACEHOLDER_ORIGIN = "http://same-origin.invalid";

export function isSameOriginPath(value: unknown): value is string {
  if (typeof value !== "string" || !value.startsWith("/")) {
    return false;
  }
  if (value.startsWith("//")) {
    return false;
  }
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f || code === 0x5c) {
      return false;
    }
  }
  try {
    return new URL(value, PLACEHOLDER_ORIGIN).origin === PLACEHOLDER_ORIGIN;
  } catch {
    return false;
  }
}
