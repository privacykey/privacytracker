/**
 * The pairing link a companion QR code carries. The iOS app's parser
 * (privacykey/privacytracker-ios, PairingPayload.swift) is the other half of
 * this format; change both together.
 *
 *   privacytracker://pair?url=<instance URL>&token=ptc_…&name=<instance name>
 *                         [&fp=<SHA-256 of the TLS certificate>]&scope=read
 *
 * Values are percent-encoded with encodeURIComponent, not URLSearchParams:
 * a space becomes %20, which every URL parser decodes, where URLSearchParams
 * would write "+" (the phone decodes that too, but need not).
 */
export function buildPairingLink(input: {
  baseUrl: string;
  fingerprint: string | null;
  instanceName: string;
  token: string;
}): string {
  const pairs: [string, string][] = [
    ["url", input.baseUrl],
    ["token", input.token],
    ["name", input.instanceName],
  ];
  if (input.fingerprint) {
    pairs.push(["fp", input.fingerprint]);
  }
  pairs.push(["scope", "read"]);
  const query = pairs
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");
  return `privacytracker://pair?${query}`;
}
