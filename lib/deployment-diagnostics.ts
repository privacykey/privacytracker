import fs from 'node:fs';
import os from 'node:os';
import pkg from '../package.json';
import { getRecentActivity } from './activity';
import db, { dataDir, dbPath } from './db';
import { getSetting } from './scheduler';
import { adminTokenConfigured } from './security';

/**
 * Replace the user's home directory in an absolute path with `~/`.
 * The diagnostics blob is explicitly designed to be pasted into GitHub
 * issues — leaking `/Users/<username>/` in every paste is both an
 * information disclosure and an unnecessary doxing surface. The
 * redacted form is just as useful for triage (`~/Library/Application
 * Support/privacytracker/privacy.db` says everything `/Users/jane/...`
 * does, minus the username).
 */
function redactHomeDir(p: string): string {
  const home = os.homedir();
  if (!home || home === '/' || home === '\\') return p;
  if (p === home) return '~';
  if (p.startsWith(home + '/') || p.startsWith(home + '\\')) {
    return '~' + p.slice(home.length);
  }
  return p;
}

export type DeploymentCheckStatus = 'ok' | 'info' | 'warn' | 'bad';

export interface DeploymentDiagnosticCheck {
  id: string;
  label: string;
  status: DeploymentCheckStatus;
  detail: string;
}

export interface DeploymentDiagnostics {
  generatedAt: string;
  app: {
    name: string;
    version: string;
    nodeEnv: string;
    runtime: 'desktop' | 'web';
    containerLikely: boolean;
    platform: string;
    arch: string;
    node: string;
    uptimeSeconds: number;
  };
  health: {
    status: 'ok' | 'degraded';
    dbPingMs: number | null;
    error: string | null;
  };
  database: {
    path: string;
    dataDir: string;
    dataDirSource: 'env' | 'cwd' | 'memory';
    exists: boolean;
    sizeBytes: number | null;
    writable: boolean;
    journalMode: string | null;
    error: string | null;
  };
  network: DeploymentNetworkDiagnostics;
  security: {
    adminTokenConfigured: boolean;
    adminTokenRequired: boolean;
  };
  checks: DeploymentDiagnosticCheck[];
}

export interface DeploymentNetworkDiagnostics {
  host: string | null;
  forwardedHost: string | null;
  forwardedProto: string | null;
  forwardedForPresent: boolean;
  realIpPresent: boolean;
  proxyDetected: boolean;
  protocol: 'http' | 'https' | 'unknown';
  localOnlyHost: boolean;
  lanOrDomainHost: boolean;
}

export interface DeploymentSupportBundle {
  generatedAt: string;
  diagnostics: DeploymentDiagnostics;
  recentErrors: Array<{
    type: string;
    status: string;
    startedAt: number;
    endedAt: number | null;
    durationMs: number | null;
    errorMessage: string | null;
    fetchDiagnostics: Record<string, unknown> | null;
  }>;
}

function firstHeaderValue(headers: Headers, name: string): string | null {
  const raw = headers.get(name);
  if (!raw) return null;
  const first = raw.split(',')[0]?.trim();
  return first || null;
}

function stripPort(host: string): string {
  const trimmed = host.trim().toLowerCase();
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    return end >= 0 ? trimmed.slice(1, end) : trimmed;
  }
  return trimmed.split(':')[0] ?? trimmed;
}

export function isLocalOnlyHost(host: string | null): boolean {
  if (!host) return false;
  const h = stripPort(host);
  return (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h === '127.0.0.1' ||
    h === '::1' ||
    h === '0.0.0.0'
  );
}

export function inferDeploymentNetwork(headers: Headers): DeploymentNetworkDiagnostics {
  const directHost = firstHeaderValue(headers, 'host');
  const forwardedHost = firstHeaderValue(headers, 'x-forwarded-host');
  const forwardedProto = firstHeaderValue(headers, 'x-forwarded-proto');
  const forwardedFor = firstHeaderValue(headers, 'x-forwarded-for');
  const realIp = firstHeaderValue(headers, 'x-real-ip');
  const forwardedPort = firstHeaderValue(headers, 'x-forwarded-port');
  const forwardedSsl = firstHeaderValue(headers, 'x-forwarded-ssl');
  const effectiveHost = forwardedHost ?? directHost;
  const proxyDetected = Boolean(
    forwardedHost ||
    forwardedProto ||
    forwardedFor ||
    realIp ||
    forwardedPort ||
    forwardedSsl,
  );
  const protocol =
    forwardedProto === 'https' || forwardedSsl === 'on'
      ? 'https'
      : forwardedProto === 'http'
        ? 'http'
        : 'unknown';
  const localOnlyHost = isLocalOnlyHost(effectiveHost);

  return {
    host: effectiveHost,
    forwardedHost,
    forwardedProto,
    forwardedForPresent: Boolean(forwardedFor),
    realIpPresent: Boolean(realIp),
    proxyDetected,
    protocol,
    localOnlyHost,
    lanOrDomainHost: Boolean(effectiveHost && !localOnlyHost),
  };
}

function likelyContainer(): boolean {
  return fs.existsSync('/.dockerenv') || fs.existsSync('/run/.containerenv');
}

function readHealth(): DeploymentDiagnostics['health'] {
  const started = Date.now();
  try {
    const row = db.prepare('SELECT 1 AS ok').get() as { ok: number } | undefined;
    const dbPingMs = Math.max(0, Date.now() - started);
    if (!row || row.ok !== 1) {
      return { status: 'degraded', dbPingMs, error: 'Database ping returned an unexpected result.' };
    }
    return { status: 'ok', dbPingMs, error: null };
  } catch (error) {
    return {
      status: 'degraded',
      dbPingMs: Math.max(0, Date.now() - started),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function readDatabase(): DeploymentDiagnostics['database'] {
  const memory = dbPath === ':memory:';
  try {
    const exists = !memory && fs.existsSync(dbPath);
    const writableTarget = exists ? dbPath : dataDir;
    let writable = false;
    let accessError: string | null = null;
    try {
      if (!memory) fs.accessSync(writableTarget, fs.constants.R_OK | fs.constants.W_OK);
      writable = !memory;
    } catch (error) {
      accessError = error instanceof Error ? error.message : String(error);
    }

    let journalMode: string | null = null;
    try {
      const value = db.pragma('journal_mode', { simple: true });
      journalMode = typeof value === 'string' ? value : String(value);
    } catch {
      journalMode = null;
    }

    return {
      path: redactHomeDir(dbPath),
      dataDir: redactHomeDir(dataDir),
      dataDirSource: memory ? 'memory' : process.env.PRIVACYTRACKER_DATA_DIR ? 'env' : 'cwd',
      exists,
      sizeBytes: exists ? fs.statSync(dbPath).size : null,
      writable,
      journalMode,
      error: accessError,
    };
  } catch (error) {
    return {
      path: redactHomeDir(dbPath),
      dataDir: redactHomeDir(dataDir),
      dataDirSource: memory ? 'memory' : process.env.PRIVACYTRACKER_DATA_DIR ? 'env' : 'cwd',
      exists: false,
      sizeBytes: null,
      writable: false,
      journalMode: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function buildChecks(
  health: DeploymentDiagnostics['health'],
  database: DeploymentDiagnostics['database'],
  network: DeploymentNetworkDiagnostics,
  security: DeploymentDiagnostics['security'],
): DeploymentDiagnosticCheck[] {
  const checks: DeploymentDiagnosticCheck[] = [
    {
      id: 'health',
      label: 'App health',
      status: health.status === 'ok' ? 'ok' : 'bad',
      detail:
        health.status === 'ok'
          ? `Health probe is passing (${health.dbPingMs ?? 0}ms DB ping).`
          : health.error ?? 'Health probe failed.',
    },
    {
      id: 'database',
      label: 'Database storage',
      status: database.writable ? 'ok' : 'bad',
      // database.path has already been home-dir-redacted above.
      detail: database.writable
        ? `SQLite is writable at ${database.path}.`
        : database.error ?? `SQLite is not writable at ${database.path}.`,
    },
    {
      id: 'proxy',
      label: 'Proxy detection',
      status: network.proxyDetected ? 'ok' : network.lanOrDomainHost ? 'warn' : 'info',
      detail: network.proxyDetected
        ? 'Forwarded proxy headers are present.'
        : network.lanOrDomainHost
          ? 'This looks LAN/domain reachable, but no forwarded proxy headers were seen.'
          : 'No proxy headers seen on this local-only request.',
    },
    {
      id: 'transport',
      label: 'Transport',
      status: network.protocol === 'https' || network.localOnlyHost ? 'ok' : 'warn',
      detail:
        network.protocol === 'https'
          ? 'The request arrived through HTTPS.'
          : network.localOnlyHost
            ? 'Localhost access is fine over HTTP.'
            : 'Plain HTTP is acceptable only on a trusted LAN; use HTTPS before exposing this more widely.',
    },
    {
      id: 'admin-token',
      label: 'Destructive API guard',
      status: security.adminTokenConfigured
        ? 'ok'
        : security.adminTokenRequired
        ? 'bad'
        : 'info',
      detail: security.adminTokenConfigured
        ? 'AUDITOR_ADMIN_TOKEN is configured for guarded API calls.'
        : security.adminTokenRequired
        ? 'This request looks LAN/domain reachable, so set AUDITOR_ADMIN_TOKEN before using guarded API actions.'
        : 'AUDITOR_ADMIN_TOKEN is optional for localhost-only access.',
    },
  ];

  return checks;
}

export function buildDeploymentDiagnostics(headers: Headers): DeploymentDiagnostics {
  const runtimeEnvironment = getSetting('runtime_environment', '') === 'desktop' ? 'desktop' : 'web';
  const health = readHealth();
  const database = readDatabase();
  const network = inferDeploymentNetwork(headers);
  const security = {
    adminTokenConfigured: adminTokenConfigured(),
    adminTokenRequired: network.lanOrDomainHost,
  };

  return {
    generatedAt: new Date().toISOString(),
    app: {
      name: pkg.name,
      version: pkg.version,
      nodeEnv: process.env.NODE_ENV ?? 'development',
      runtime: runtimeEnvironment,
      containerLikely: likelyContainer(),
      platform: `${os.type()} ${os.release()}`,
      arch: process.arch,
      node: process.version,
      uptimeSeconds: Math.round(process.uptime()),
    },
    health,
    database,
    network,
    security,
    checks: buildChecks(health, database, network, security),
  };
}

function redactFetchDiagnostics(detail: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!detail || typeof detail !== 'object') return null;
  const raw = detail.fetchDiagnostics;
  if (!raw || typeof raw !== 'object') return null;
  const diag = raw as Record<string, unknown>;
  const allowedKeys = [
    'httpStatus',
    'contentType',
    'origin',
    'networkHint',
    'troubleshoot',
    'retryAfterMs',
  ];
  const safe: Record<string, unknown> = {};
  for (const key of allowedKeys) {
    if (diag[key] !== undefined) safe[key] = diag[key];
  }
  return Object.keys(safe).length > 0 ? safe : null;
}

function readRecentSafeErrors(): DeploymentSupportBundle['recentErrors'] {
  try {
    return getRecentActivity({ status: 'error', limit: 8 }).map(row => {
      const errorMessage =
        typeof row.detail?.errorMessage === 'string'
          ? row.detail.errorMessage
          : typeof row.detail?.error === 'string'
            ? row.detail.error
            : null;
      return {
        type: row.type,
        status: row.status,
        startedAt: row.startedAt,
        endedAt: row.endedAt,
        durationMs: row.durationMs,
        errorMessage,
        fetchDiagnostics: redactFetchDiagnostics(row.detail),
      };
    });
  } catch {
    return [];
  }
}

export function buildDeploymentSupportBundle(headers: Headers): DeploymentSupportBundle {
  const diagnostics = buildDeploymentDiagnostics(headers);
  return {
    generatedAt: new Date().toISOString(),
    diagnostics,
    recentErrors: readRecentSafeErrors(),
  };
}
