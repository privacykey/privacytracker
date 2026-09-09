import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function createVerifiedTestBackup(label = "device"): string {
  const root = process.env.PRIVACYTRACKER_TEST_MOBILESYNC_ROOT;
  if (!root) {
    throw new Error("PRIVACYTRACKER_TEST_MOBILESYNC_ROOT is not configured");
  }
  mkdirSync(root, { recursive: true });
  const backup = join(root, `${label}-${randomUUID()}`);
  mkdirSync(backup);
  writeFileSync(join(backup, "Manifest.db"), "sqlite backup fixture");
  return backup;
}
