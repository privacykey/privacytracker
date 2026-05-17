/**
 * /api/annotations
 *
 *   GET    ?appId=…   — list active annotations for the app
 *   POST              — create a new annotation
 *
 * Mutations require same-origin per proxy.ts. Per-id operations (PATCH,
 * DELETE, restore) live under [id]/route.ts.
 */

import { type NextRequest, NextResponse } from "next/server";
import {
  type AnnotationSource,
  type AnnotationTag,
  type AnnotationVisibility,
  createAnnotation,
  listAnnotations,
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

export async function GET(request: NextRequest) {
  const appId = request.nextUrl.searchParams.get("appId");
  if (!appId) {
    return NextResponse.json({ error: "appId is required" }, { status: 400 });
  }

  try {
    const annotations = listAnnotations(appId);
    return NextResponse.json({ annotations });
  } catch (e) {
    console.error("[/api/annotations GET] failed:", e);
    return NextResponse.json(
      { error: "Failed to list annotations" },
      { status: 500 }
    );
  }
}

interface CreateBody {
  appId?: string;
  content?: string;
  /** Set when an audit-bundle import calls this endpoint with attribution. */
  source?: AnnotationSource;
  sourceName?: string | null;
  tag?: AnnotationTag | null;
  visibility?: AnnotationVisibility;
}

export async function POST(request: NextRequest) {
  let body: CreateBody;
  try {
    body = await readBoundedJson<CreateBody>(request, 8 * 1024);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (!body.appId || typeof body.appId !== "string") {
    return NextResponse.json({ error: "appId is required" }, { status: 400 });
  }
  if (typeof body.content !== "string" || body.content.trim().length === 0) {
    return NextResponse.json({ error: "content is required" }, { status: 400 });
  }
  if (body.content.length > MAX_ANNOTATION_CONTENT_CHARS) {
    return NextResponse.json(
      {
        error: `content must be ${MAX_ANNOTATION_CONTENT_CHARS} characters or fewer`,
      },
      { status: 413 }
    );
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
  if (
    body.source !== undefined &&
    body.source !== "user" &&
    body.source !== "imported"
  ) {
    return NextResponse.json(
      { error: "source must be user or imported" },
      { status: 400 }
    );
  }

  try {
    const annotation = createAnnotation({
      appId: body.appId,
      content: body.content,
      tag: body.tag ?? null,
      visibility: body.visibility ?? "export",
      source: body.source ?? "user",
      sourceName: body.sourceName ?? null,
    });
    return NextResponse.json({ annotation }, { status: 201 });
  } catch (e) {
    console.error("[/api/annotations POST] failed:", e);
    return NextResponse.json(
      { error: "Failed to create annotation" },
      { status: 500 }
    );
  }
}
