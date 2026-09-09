export const UPDATE_PLATFORMS = {
  "darwin-aarch64": {
    triple: "aarch64-apple-darwin",
    name: "privacytracker_aarch64.app.tar.gz",
  },
  "darwin-x86_64": {
    triple: "x86_64-apple-darwin",
    name: "privacytracker_x64.app.tar.gz",
  },
};
export function validateManifest(manifest, version, repo) {
  if (manifest.version !== version) {
    throw new Error("Manifest version does not match the release");
  }
  const expected = Object.keys(UPDATE_PLATFORMS).sort();
  if (
    JSON.stringify(Object.keys(manifest.platforms ?? {}).sort()) !==
    JSON.stringify(expected)
  ) {
    throw new Error("Both macOS platforms are required");
  }
  for (const [key, { name }] of Object.entries(UPDATE_PLATFORMS)) {
    const entry = manifest.platforms[key];
    if (
      entry.url !==
      `https://github.com/${repo}/releases/download/v${version}/${name}`
    ) {
      throw new Error(`Wrong release URL for ${key}`);
    }
    if (typeof entry.signature !== "string" || !entry.signature.trim()) {
      throw new Error(`Missing signature for ${key}`);
    }
  }
}
