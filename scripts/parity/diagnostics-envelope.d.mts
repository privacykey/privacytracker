// Types for the plain-JS validator so TypeScript importers (the contract
// test) see it typed. The implementation stays JavaScript on purpose: the
// parity harness runs under plain `node` with no loader.
export const RUNTIME_DIAGNOSTICS_SCHEMA_VERSION: 2;
export function validateRuntimeDiagnostics(value: unknown): string[];
