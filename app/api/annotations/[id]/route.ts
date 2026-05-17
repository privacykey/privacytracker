/**
 * /api/annotations/[id]
 *
 *   PATCH  — partial update (content, tag, visibility)
 *   DELETE — soft-delete (sets deleted_at; 30s undo window)
 *   PUT    — restore a soft-deleted annotation within the undo window
 *
 * Per-id operations on the annotations table. The list/create endpoint
 * lives at ../route.ts.
 */

import { type NextRequest, NextResponse } from "next/server";
import {
  type AnnotationTag,
  type AnnotationVisibility,
  getAnnotation,
  restoreAnnotation,
  softDeleteAnnotation,
  updateAnnotation,
} from "@/lib/annotations";
import { readBoundedJson } from "@/lib/security";

export const dynamic = "force-dynamic";

const VALID_TAGS = new Set<AnnotationTag>([
  "concern",
  "positive",
  "follow_up",
  "other",
]);
const VALID_VISIBILITIES = new Set<AnnotationVisibility>(["export", "private"]);
const MAX_ANNOTATION_CONTENT_CHARS = 8000;

interface PatchBody {
  content?: string;
  tag?: AnnotationTag | null;
  visibility?: AnnotationVisibility;
}

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  const { id } = await context.params;

  let body: PatchBody;
  try {
    body = await readBoundedJson<PatchBody>(request, 8 * 1024);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (
    body.tag !== undefined &&
    body.tag !== null &&
    !VALID_TAGS.has(body.tag)
  ) {
    return NextResponse.json(
      { error: `tag must be one of: ${[...VALID_TAGS].join(", ")}` },
      { status: 400 }
    );
  }
  if (body.content !== undefined) {
    if (typeof body.content !== "string") {
      return NextResponse.json(
        { error: "content must be a string" },
        { status: 400 }
      );
    }
    if (body.content.length > MAX_ANNOTATION_CONTENT_CHARS) {
      return NextResponse.json(
        {
          error: `content must be ${MAX_ANNOTATION_CONTENT_CHARS} characters or fewer`,
        },
        { status: 413 }
      );
    }
  }
  if (
    body.visibility !== undefined &&
    !VALID_VISIBILITIES.has(body.visibility)
  ) {
    return NextResponse.json(
      {
        error: `visibility must be one of: ${[...VALID_VISIBILITIES].join(", ")}`,
      },
      { status: 400 }
    );
  }

  try {
    const updated = updateAnnotation(id, body);
    if (!updated) {
      return NextResponse.json(
        { error: "Annotation not found or already deleted" },
        { status: 404 }
      );
    }
    return NextResponse.json({ annotation: updated });
  } catch (e) {
    console.error("[/api/annotations PATCH] failed:", e);
    return NextResponse.json(
      { error: "Failed to update annotation" },
      { status: 500 }
    );
  }
}

export async function DELETE(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params;

  try {
    const result = softDeleteAnnotation(id);
    if (!result) {
      return NextResponse.json(
        { error: "Annotation not found" },
        { status: 404 }
      );
    }
    return NextResponse.json({ annotation: result });
  } catch (e) {
    console.error("[/api/annotations DELETE] failed:", e);
    return NextResponse.json(
      { error: "Failed to delete annotation" },
      { status: 500 }
    );
  }
}

export async function PUT(_request: NextRequest, context: RouteContext) {
  const { id } = await context.params;

  try {
    // Refuse if the row no longer exists or the undo window has elapsed.
    const existing = getAnnotation(id);
    if (!existing) {
      return NextResponse.json(
        { error: "Annotation not found or already purged" },
        { status: 404 }
      );
    }
    const restored = restoreAnnotation(id);
    if (!restored) {
      return NextResponse.json(
        { error: "Undo window has elapsed" },
        { status: 410 }
      );
    }
    return NextResponse.json({ annotation: restored });
  } catch (e) {
    console.error("[/api/annotations PUT] failed:", e);
    return NextResponse.json(
      { error: "Failed to restore annotation" },
      { status: 500 }
    );
  }
}
