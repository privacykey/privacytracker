/**
 * Server-side verification for Apple MobileSync backups.
 *
 * The native cfgutil bridge verifies the artifact immediately after the
 * command finishes. The sidecar repeats the check before it records a fresh
 * backup stamp and whenever the uninstall gate is evaluated. That second
 * check matters because the webview transports the native result to the
 * sidecar, and because a user can move or delete a backup after it was made.
 */

import "server-only";

import { lstatSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export type BackupVerificationFailure =
  | "backup_not_absolute"
  | "backup_not_directory"
  | "backup_outside_mobile_sync"
  | "backup_path_missing"
  | "backup_symlink"
  | "manifest_symlink"
  | "manifest_time_invalid"
  | "manifest_empty"
  | "manifest_missing"
  | "manifest_not_file"
  | "manifest_outside_backup"
  | "mobile_sync_root_missing";

export type BackupVerificationResult =
  | {
      ok: true;
      manifestBytes: number;
      manifestModifiedAt: number;
      path: string;
    }
  | { ok: false; reason: BackupVerificationFailure };

export function getMobileSyncBackupRoot(): string {
  // Tests need a writable MobileSync-shaped root. Never honour this override
  // in an actual app process, where the Apple-owned location is fixed.
  if (
    process.env.NEXT_PHASE === "phase-test" &&
    process.env.PRIVACYTRACKER_TEST_MOBILESYNC_ROOT
  ) {
    return resolve(process.env.PRIVACYTRACKER_TEST_MOBILESYNC_ROOT);
  }
  return join(
    homedir(),
    "Library",
    "Application Support",
    "MobileSync",
    "Backup"
  );
}

function isDirectChild(parent: string, candidate: string): boolean {
  const rel = relative(parent, candidate);
  return rel.length > 0 && !rel.includes("/") && !rel.includes("\\");
}

/**
 * Verify a backup against an explicit root. Exported to make the filesystem
 * rules independently testable; production callers use
 * `verifyBackupArtifact`, which supplies Apple's fixed MobileSync root.
 */
export function verifyBackupArtifactAtRoot(
  backupPath: string,
  mobileSyncRoot: string
): BackupVerificationResult {
  if (!isAbsolute(backupPath)) {
    return { ok: false, reason: "backup_not_absolute" };
  }

  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(mobileSyncRoot);
  } catch {
    return { ok: false, reason: "mobile_sync_root_missing" };
  }

  let canonicalBackup: string;
  try {
    if (lstatSync(backupPath).isSymbolicLink()) {
      return { ok: false, reason: "backup_symlink" };
    }
    canonicalBackup = realpathSync(backupPath);
  } catch {
    return { ok: false, reason: "backup_path_missing" };
  }
  if (!isDirectChild(canonicalRoot, canonicalBackup)) {
    return { ok: false, reason: "backup_outside_mobile_sync" };
  }

  try {
    if (!statSync(canonicalBackup).isDirectory()) {
      return { ok: false, reason: "backup_not_directory" };
    }
  } catch {
    return { ok: false, reason: "backup_path_missing" };
  }

  const manifestPath = join(canonicalBackup, "Manifest.db");
  let canonicalManifest: string;
  try {
    if (lstatSync(manifestPath).isSymbolicLink()) {
      return { ok: false, reason: "manifest_symlink" };
    }
    canonicalManifest = realpathSync(manifestPath);
  } catch {
    return { ok: false, reason: "manifest_missing" };
  }
  if (dirname(canonicalManifest) !== canonicalBackup) {
    return { ok: false, reason: "manifest_outside_backup" };
  }

  try {
    const manifest = statSync(canonicalManifest);
    if (!manifest.isFile()) {
      return { ok: false, reason: "manifest_not_file" };
    }
    if (manifest.size === 0) {
      return { ok: false, reason: "manifest_empty" };
    }
    const modifiedAt = Math.floor(manifest.mtimeMs);
    if (
      !Number.isFinite(modifiedAt) ||
      modifiedAt <= 0 ||
      modifiedAt > Date.now()
    ) {
      return { ok: false, reason: "manifest_time_invalid" };
    }
    return {
      ok: true,
      manifestBytes: manifest.size,
      manifestModifiedAt: modifiedAt,
      path: canonicalBackup,
    };
  } catch {
    return { ok: false, reason: "manifest_missing" };
  }
}

export function verifyBackupArtifact(
  backupPath: string
): BackupVerificationResult {
  return verifyBackupArtifactAtRoot(backupPath, getMobileSyncBackupRoot());
}
