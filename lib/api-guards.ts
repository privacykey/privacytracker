import { NextResponse } from 'next/server';
import {
  adminTokenConfigured,
  checkRateLimit,
  rateLimitKeyForRequest,
  recordAudit,
  requestActorIp,
  requestHasValidAdminToken,
} from './security';

interface MutationGuardRateLimit {
  keyPrefix: string;
  limit: number;
  windowMs: number;
  message?: string;
}

export interface MutationGuardOptions {
  action: string;
  rateLimit: MutationGuardRateLimit;
  /**
   * Destructive/admin routes should leave this true. Set false for costly but
   * ordinary same-origin actions such as "sync now".
   */
  requireAdminToken?: boolean;
}

export interface MutationGuardContext {
  actorIp: string;
  userAgent: string | null;
}

export type MutationGuardResult =
  | ({ ok: true } & MutationGuardContext)
  | ({ ok: false; response: NextResponse } & MutationGuardContext);

export function requireMutationGuard(
  request: Request,
  options: MutationGuardOptions,
): MutationGuardResult {
  const actorIp = requestActorIp(request);
  const userAgent = request.headers.get('user-agent');
  const requireAdminToken = options.requireAdminToken ?? true;

  const rate = checkRateLimit({
    key: rateLimitKeyForRequest(request, options.rateLimit.keyPrefix),
    limit: options.rateLimit.limit,
    windowMs: options.rateLimit.windowMs,
  });

  if (!rate.allowed) {
    recordAudit({
      action: `${options.action}.rate_limited`,
      actorIp,
      userAgent,
      success: false,
      detail: `retryAfterMs=${rate.retryAfterMs}`,
    });
    return {
      ok: false,
      actorIp,
      userAgent,
      response: NextResponse.json(
        { error: options.rateLimit.message ?? 'Rate limit exceeded. Try again shortly.' },
        {
          status: 429,
          headers: { 'Retry-After': String(Math.ceil(rate.retryAfterMs / 1000)) },
        },
      ),
    };
  }

  if (requireAdminToken && adminTokenConfigured() && !requestHasValidAdminToken(request)) {
    recordAudit({
      action: `${options.action}.unauthorised`,
      actorIp,
      userAgent,
      success: false,
      detail: 'admin token required but missing or invalid',
    });
    return {
      ok: false,
      actorIp,
      userAgent,
      response: NextResponse.json({ error: 'Admin token required' }, { status: 401 }),
    };
  }

  return { ok: true, actorIp, userAgent };
}
