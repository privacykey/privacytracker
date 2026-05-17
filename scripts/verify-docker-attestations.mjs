#!/usr/bin/env node
import { execFileSync } from "node:child_process";

const image = process.argv[2];
if (!image) {
  console.error("Usage: verify-docker-attestations.mjs <image-ref>");
  process.exit(2);
}

let raw;
try {
  raw = execFileSync(
    "docker",
    ["buildx", "imagetools", "inspect", "--raw", image],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }
  );
} catch (error) {
  console.error(`Failed to inspect ${image}:`);
  if (error && typeof error === "object" && "stderr" in error) {
    console.error(String(error.stderr));
  } else {
    console.error(error);
  }
  process.exit(1);
}

let manifest;
try {
  manifest = JSON.parse(raw);
} catch {
  console.error(`docker buildx returned non-JSON manifest data for ${image}`);
  process.exit(1);
}

const manifests = Array.isArray(manifest.manifests) ? manifest.manifests : [];
const attestationManifests = manifests.filter((entry) => {
  const annotations = entry?.annotations ?? {};
  return (
    annotations["vnd.docker.reference.type"] === "attestation-manifest" ||
    annotations["dev.sigstore.bundle.content"] === "dsse-envelope"
  );
});

const rawLower = raw.toLowerCase();
const hasProvenanceSignal =
  rawLower.includes("provenance") ||
  rawLower.includes("slsa") ||
  rawLower.includes("in-toto") ||
  attestationManifests.length > 0;
const hasSbomSignal =
  rawLower.includes("sbom") ||
  rawLower.includes("spdx") ||
  rawLower.includes("cyclonedx") ||
  attestationManifests.length > 1;

if (!(hasProvenanceSignal && hasSbomSignal)) {
  console.error(
    `Missing expected Docker provenance/SBOM attestations for ${image}.`
  );
  console.error(`Attestation manifests found: ${attestationManifests.length}`);
  console.error(`Provenance signal: ${hasProvenanceSignal ? "yes" : "no"}`);
  console.error(`SBOM signal: ${hasSbomSignal ? "yes" : "no"}`);
  process.exit(1);
}

console.log(`Verified Docker attestations for ${image}`);
