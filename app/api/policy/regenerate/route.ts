export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import db from "../../../../lib/db";
import type { PolicyRunPhase } from "../../../../lib/policy-summary-meta";
import {
  type PolicyPhase,
  type PolicyPhaseStream,
  syncPrivacyPolicyAnalysis,
} from "../../../../lib/privacy-policy";
import { getSetting } from "../../../../lib/scheduler";
import {
  checkRateLimit,
  rateLimitKeyForRequest,
  readBoundedJson,
  recordAudit,
  requestActorIp,
} from "../../../../lib/security";

const VALID_PHASES: PolicyPhase[] = ["fetch", "summarise", "all"];

export async function POST(request: Request) {
  const actorIp = requestActorIp(request);
  const userAgent = request.headers.get("user-agent");

  // Regeneration fires outbound HTTP + (usually paid) LLM calls. Rate-limit
  // hard so a same-origin loop can't burn through a user's AI budget.
  const rate = checkRateLimit({
    key: rateLimitKeyForRequest(request, "policy.regenerate"),
    limit: 10,
    windowMs: 60_000,
  });
  if (!rate.allowed) {
    return NextResponse.json(
      {
        error: "Rate limit exceeded for policy regenerate. Try again shortly.",
      },
      {
        status: 429,
        headers: { "Retry-After": String(Math.ceil(rate.retryAfterMs / 1000)) },
      }
    );
  }

  try {
    const body = await readBoundedJson<{
      appId?: unknown;
      phase?: unknown;
      stream?: unknown;
    }>(request, 8 * 1024);
    const appId = typeof body?.appId === "string" ? body.appId.trim() : "";
    if (!appId) {
      return NextResponse.json({ error: "appId is required" }, { status: 400 });
    }
    if (!/^\d{1,20}$/.test(appId)) {
      return NextResponse.json({ error: "Invalid appId" }, { status: 400 });
    }

    const rawPhase =
      typeof body?.phase === "string" ? body.phase.trim() : "all";
    const phase = (
      VALID_PHASES.includes(rawPhase as PolicyPhase) ? rawPhase : "all"
    ) as PolicyPhase;
    const wantStream = body?.stream === true;

    // Global kill-switch — refuse any phase that includes a fetch. The deep
    // gate in `fetchAndStorePolicySource` would also short-circuit, but
    // returning 409 here lets the AI Policy tab surface the reason inline
    // instead of polling for a delayed "disabled" log entry. `summarise`
    // (cache-only) is allowed through so users can still refresh the AI
    // summary on their existing cached policy text.
    if (phase !== "summarise") {
      const scrapeDisabled =
        getSetting("policy_scrape_disabled", "false") === "true";
      if (scrapeDisabled) {
        return NextResponse.json(
          {
            error:
              "Policy scraping is disabled in Settings. Re-enable to fetch, or use the Summarise-only action.",
            code: "policy_scrape_disabled",
          },
          { status: 409 }
        );
      }
    }

    const app = db
      .prepare(
        "SELECT id, name, developer, privacyPolicyUrl FROM apps WHERE id = ?"
      )
      .get(appId) as
      | {
          id: string;
          name: string;
          developer: string | null;
          privacyPolicyUrl: string | null;
        }
      | undefined;

    if (!app) {
      return NextResponse.json({ error: "App not found" }, { status: 404 });
    }

    if (!app.privacyPolicyUrl) {
      return NextResponse.json(
        {
          error:
            "This app does not expose a developer privacy-policy link on its App Store page.",
        },
        { status: 409 }
      );
    }

    // Explicit user-initiated regenerate always wants fresh network work AND
    // a fresh AI summary — even if the text hash hasn't changed. We signal
    // that via `forceResummarise` rather than nulling the hash on the row,
    // because nulling the hash destroys our ability to detect "scraped, same
    // text as last time" (isSameAsPrevious compares against the stored hash).
    // Without this, every manual rescrape gets misreported as a change event.
    const forceResummarise =
      phase === "fetch" || phase === "all" || phase === "summarise";

    if (wantStream) {
      // NDJSON stream: emit one line per phase event, then a final line
      // containing the full analysis result. The client reads this
      // progressively so the "Thinking" indicator stays fresh.
      const encoder = new TextEncoder();

      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          const write = (obj: unknown) => {
            try {
              controller.enqueue(encoder.encode(`${JSON.stringify(obj)}\n`));
            } catch {
              // Controller may already be closed on client disconnect — ignore.
            }
          };

          const phaseStream: PolicyPhaseStream = {
            emit: (phaseEvent: PolicyRunPhase) =>
              write({ type: "phase", phase: phaseEvent }),
          };

          try {
            const analysis = await syncPrivacyPolicyAnalysis(
              {
                appId: app.id,
                appName: app.name,
                developer: app.developer ?? undefined,
                policyUrl: app.privacyPolicyUrl!,
              },
              { phase, phaseStream, forceResummarise }
            );

            write({ type: "done", analysis });

            recordAudit({
              action: "policy.regenerate.success",
              actorIp,
              userAgent,
              success: true,
              detail: `appId=${appId} phase=${phase} stream=1`,
            });
          } catch (error) {
            const message =
              error instanceof Error ? error.message : "Regeneration failed";
            write({ type: "error", error: message });
            recordAudit({
              action: "policy.regenerate.failed",
              actorIp,
              userAgent,
              success: false,
              detail: `appId=${appId} phase=${phase} stream=1 ${message.slice(0, 200)}`,
            });
          } finally {
            try {
              controller.close();
            } catch {
              /* ignore */
            }
          }
        },
      });

      return new Response(stream, {
        status: 200,
        headers: {
          "Content-Type": "application/x-ndjson; charset=utf-8",
          "Cache-Control": "no-store, no-transform",
        },
      });
    }

    const analysis = await syncPrivacyPolicyAnalysis(
      {
        appId: app.id,
        appName: app.name,
        developer: app.developer ?? undefined,
        policyUrl: app.privacyPolicyUrl,
      },
      { phase, forceResummarise }
    );

    recordAudit({
      action: "policy.regenerate.success",
      actorIp,
      userAgent,
      success: true,
      detail: `appId=${appId} phase=${phase}`,
    });

    return NextResponse.json({ analysis });
  } catch (error) {
    console.error("Policy regenerate API error", error);
    recordAudit({
      action: "policy.regenerate.failed",
      actorIp,
      userAgent,
      success: false,
      detail: error instanceof Error ? error.message.slice(0, 200) : "unknown",
    });
    const message =
      error instanceof Error ? error.message : "Internal Server Error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
