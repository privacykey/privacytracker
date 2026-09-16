// Types for the plain-JS coverage check so TypeScript importers (the
// tests/app contract test) see it typed. The implementation stays
// JavaScript on purpose: the parity harness runs under plain `node` with
// no loader.
export type ManifestGroup = ReadonlyArray<{ route: string }>;

export const API_DIR: string;
export const MANIFEST_GROUPS: readonly ManifestGroup[];

export interface CoverageReport {
  disk: Set<string>;
  listed: Set<string>;
  missing: string[];
  ok: boolean;
  phantom: string[];
}

export function diskRoutes(apiDir?: string): Set<string>;
export function manifestRoutes(groups?: readonly ManifestGroup[]): Set<string>;
export function coverageReport(options?: {
  apiDir?: string;
  groups?: readonly ManifestGroup[];
}): CoverageReport;
export function formatCoverageFailure(
  report: Pick<CoverageReport, "missing" | "phantom">
): string;
