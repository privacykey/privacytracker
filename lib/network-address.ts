/** Canonical address policy shared by URL checks and the actual socket lookup. */
function normalizeAddress(host: string): string {
  const bare = host
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (!bare.includes(":")) {
    return bare;
  }
  try {
    return new URL(`http://[${bare}]/`).hostname.slice(1, -1);
  } catch {
    return bare;
  }
}

function mappedIpv4(address: string): string | null {
  // WHATWG URLs normalize ::ffff:127.0.0.1 to ::ffff:7f00:1.
  const parts = /^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/.exec(address);
  if (!parts) {
    return null;
  }
  const high = Number.parseInt(parts[1], 16);
  const low = Number.parseInt(parts[2], 16);
  return `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
}

const METADATA_HOSTNAMES = new Set<string>([
  "metadata.google.internal",
  "metadata",
  "instance-data",
  "instance-data.ec2.internal",
]);

export function isMetadataHost(host: string): boolean {
  const h = normalizeAddress(host);
  const mapped = mappedIpv4(h);
  if (mapped) {
    return isMetadataHost(mapped);
  }
  if (METADATA_HOSTNAMES.has(h)) {
    return true;
  }
  // IPv4 literals: anything in 169.254.0.0/16 counts as metadata-adjacent
  // (IMDS lives at 169.254.169.254; ECS task metadata at 169.254.170.2).
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 169 && b === 254) {
      return true;
    }
  }
  // IPv6 metadata: AWS uses fd00:ec2::254 and GCP/Azure use fe80::a9fe:a9fe-ish
  // link-local. Blocking anything in fe80::/10 here is conservative but cheap.
  if (h.includes(":")) {
    const stripped = h.replace(/^\[|\]$/g, "");
    if (stripped.startsWith("fd00:ec2")) {
      return true;
    }
    if (/^fe[89ab]/.test(stripped)) {
      return true;
    }
  }
  return false;
}

export function isPrivateIpv4(hostname: string): boolean {
  // Plain dotted quad check; doesn't cover integer/octal/mixed forms which we
  // reject up front by requiring strict dotted-quad shape.
  const match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) {
    return false;
  }
  const octets = match.slice(1, 5).map(Number);
  if (octets.some((o) => o < 0 || o > 255)) {
    return true; // reject malformed
  }

  const [a, b] = octets;
  // 0.0.0.0/8, 10.0.0.0/8, 127.0.0.0/8, 169.254.0.0/16 (link-local incl. 169.254.169.254),
  // 172.16.0.0/12, 192.168.0.0/16, 100.64.0.0/10 (CGNAT), 224.0.0.0/4 (multicast)
  if (a === 0) {
    return true;
  }
  if (a === 10) {
    return true;
  }
  if (a === 127) {
    return true;
  }
  if (a === 169 && b === 254) {
    return true;
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  }
  if (a === 192 && b === 168) {
    return true;
  }
  if (a === 100 && b >= 64 && b <= 127) {
    return true;
  }
  if (a >= 224) {
    return true;
  }
  return false;
}

export function isPrivateIpv6(hostname: string): boolean {
  if (!hostname.includes(":")) {
    return false;
  }
  const address = normalizeAddress(hostname);
  const mapped = mappedIpv4(address);
  if (mapped) {
    return isPrivateIpv4(mapped);
  }
  // Permit global unicast only. This also excludes deprecated IPv4-compatible
  // and translation prefixes whose embedded IPv4 address could reach the LAN.
  if (!/^[23][0-9a-f]{3}:/.test(address)) {
    return true;
  }
  return (
    address.startsWith("2002:") ||
    address.startsWith("2001:0:") ||
    address.startsWith("2001::")
  );
}
