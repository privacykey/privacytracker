/** Client-safe backup and uninstall-gate response types. */

export interface BackupStamp {
  /** Verified artifact timestamp, capped by the server recording time. */
  finishedAt: number;
  /** Non-zero size of Manifest.db when the artifact was verified. */
  manifestBytes?: number;
  /** Canonical Apple MobileSync backup directory. */
  path: string;
}

export type UninstallGateReason =
  | "audience"
  | "backup_missing"
  | "backup_stale"
  | "backup_unverified"
  | "flag";

export interface UninstallGateResponse {
  activeAudience?: string;
  agedMs?: number;
  allowed?: boolean;
  lastBackup?: BackupStamp | null;
  reason?: UninstallGateReason;
}

export type ServerBackupState =
  | { backup: BackupStamp; kind: "fresh" }
  | {
      kind: "not_fresh";
      reason: "missing" | "stale" | "unreachable" | "unverified";
    };

function isBackupStamp(value: unknown): value is BackupStamp {
  if (!(value && typeof value === "object")) {
    return false;
  }
  const candidate = value as Partial<BackupStamp>;
  return (
    typeof candidate.finishedAt === "number" &&
    Number.isFinite(candidate.finishedAt) &&
    candidate.finishedAt > 0 &&
    candidate.finishedAt <= Date.now() &&
    typeof candidate.path === "string" &&
    candidate.path.length > 0
  );
}

/**
 * Convert the additive GET gate payload into conservative display state.
 * Only an allowed gate paired with a well-formed backup stamp may reassure
 * the user. Missing, stale, malformed, or unreachable responses never do.
 */
export function deriveServerBackupState(
  gate: UninstallGateResponse | null
): ServerBackupState {
  if (gate?.allowed === true && isBackupStamp(gate.lastBackup)) {
    return { backup: gate.lastBackup, kind: "fresh" };
  }
  if (gate?.reason === "backup_stale") {
    return { kind: "not_fresh", reason: "stale" };
  }
  if (gate?.reason === "backup_unverified") {
    return { kind: "not_fresh", reason: "unverified" };
  }
  if (gate === null) {
    return { kind: "not_fresh", reason: "unreachable" };
  }
  return { kind: "not_fresh", reason: "missing" };
}
