import { type NextRequest, NextResponse } from "next/server";
import { requireMutationGuard } from "@/lib/api-guards";
import { readBoundedJson, recordAudit, requestActorIp } from "@/lib/security";
import { TASK_DEFS, type UserTaskId } from "@/lib/tasks";
import {
  clearAllTasks,
  dismissTask,
  optInTask,
  resetTask,
  resolveAllTasks,
  resolveOptInCandidates,
  startTask,
} from "@/lib/tasks-server";

/**
 * User-facing task list — the inline panel and persistent nav icon read
 * from `GET` and mutate via `POST`. Distinct namespace from
 * `/api/tasks/active` (which surfaces background-job state).
 *
 * GET  → { tasks: ResolvedTask[] }
 * POST { id: UserTaskId, action: 'start' | 'dismiss' | 'reset' }
 *  or  { action: 'clear_all' }
 */
export const dynamic = "force-dynamic";

const TASK_IDS = new Set<UserTaskId>(TASK_DEFS.map((d) => d.id));
const ACTIONS = new Set(["start", "dismiss", "reset", "clear_all", "opt_in"]);

export async function GET() {
  try {
    // Server-side resolve always passes isDesktop=false; the client
    // provider re-resolves with the real runtime flag. This keeps the
    // bottom-sheet/dropdown showing the right list on web builds.
    const tasks = resolveAllTasks(undefined, false);
    const candidates = resolveOptInCandidates(undefined, false);
    return NextResponse.json({ tasks, candidates });
  } catch (error) {
    console.error("[user-tasks] GET failed:", error);
    return NextResponse.json({ tasks: [], candidates: [] });
  }
}

export async function POST(req: NextRequest) {
  const guard = requireMutationGuard(req, {
    action: "user-tasks.write",
    rateLimit: { keyPrefix: "user-tasks.write", limit: 60, windowMs: 60_000 },
    requireAdminToken: false,
  });
  if (!guard.ok) {
    return guard.response;
  }

  let body: unknown = null;
  try {
    body = await readBoundedJson<unknown>(req, 4 * 1024);
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json(
      { error: "expected object body" },
      { status: 400 }
    );
  }

  const { id, action, missingPrerequisite } = body as {
    id?: unknown;
    action?: unknown;
    missingPrerequisite?: unknown;
  };

  if (typeof action !== "string" || !ACTIONS.has(action)) {
    return NextResponse.json(
      {
        error:
          "action must be one of 'start', 'dismiss', 'reset', 'opt_in', 'clear_all'",
      },
      { status: 400 }
    );
  }

  if (action === "clear_all") {
    clearAllTasks();
    return NextResponse.json({
      tasks: resolveAllTasks(undefined, false),
      candidates: resolveOptInCandidates(undefined, false),
    });
  }

  if (typeof id !== "string" || !TASK_IDS.has(id as UserTaskId)) {
    return NextResponse.json({ error: "unknown task id" }, { status: 400 });
  }
  const taskId = id as UserTaskId;

  if (action === "start") {
    startTask(taskId);
    // Audit gate-bypass events so we can later answer "how often do users
    // skip past the recommended prerequisite step?" without retrofitting.
    if (
      typeof missingPrerequisite === "string" &&
      TASK_IDS.has(missingPrerequisite as UserTaskId)
    ) {
      recordAudit({
        action: "task_gate_bypassed",
        actorIp: requestActorIp(req),
        userAgent: req.headers.get("user-agent"),
        detail: JSON.stringify({ taskId, missingPrerequisite }),
        success: true,
      });
    }
  } else if (action === "dismiss") {
    dismissTask(taskId);
  } else if (action === "opt_in") {
    optInTask(taskId);
  } else {
    resetTask(taskId);
  }

  return NextResponse.json({
    tasks: resolveAllTasks(undefined, false),
    candidates: resolveOptInCandidates(undefined, false),
  });
}
