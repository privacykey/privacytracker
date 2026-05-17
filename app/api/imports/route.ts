export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { withApiTiming } from "../../../lib/api-timing";
import {
  createImport,
  deleteImport,
  getImport,
  IMPORT_SOURCES,
  type ImportSource,
  listImports,
} from "../../../lib/imports";
import { readBoundedJson } from "../../../lib/security";

async function getImports(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");
  if (id) {
    const result = getImport(id);
    if (!result) {
      return NextResponse.json({ error: "Import not found" }, { status: 404 });
    }
    return NextResponse.json(result);
  }
  return NextResponse.json(listImports());
}

async function createImportRoute(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = await readBoundedJson<Record<string, unknown>>(request, 8 * 1024);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Invalid JSON body" },
      { status: 400 }
    );
  }

  try {
    const source = typeof body?.source === "string" ? body.source : "";
    if (!IMPORT_SOURCES.includes(source as ImportSource)) {
      return NextResponse.json(
        { error: `source must be one of ${IMPORT_SOURCES.join(", ")}` },
        { status: 400 }
      );
    }

    const row = createImport({
      source: source as ImportSource,
      sourceLabel:
        typeof body?.sourceLabel === "string" ? body.sourceLabel : undefined,
      total: typeof body?.total === "number" ? body.total : 0,
      // Optional — the new device-naming step in OnboardWizard passes this.
      // Legacy callers omit it; legacy imports stay attached to NULL.
      deviceId:
        typeof body?.deviceId === "string" && body.deviceId.trim()
          ? body.deviceId.trim()
          : null,
    });

    return NextResponse.json(row);
  } catch (error) {
    console.error("Create import error", error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  }
}

export const GET = withApiTiming("/api/imports", getImports);
export const POST = withApiTiming("/api/imports", createImportRoute);

export async function DELETE(request: Request) {
  const { searchParams } = new URL(request.url);
  const id = searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "id is required" }, { status: 400 });
  }

  const removeApps = searchParams.get("removeApps") === "true";
  try {
    const { deletedApps } = deleteImport(id, { removeApps });
    return NextResponse.json({ success: true, deletedApps });
  } catch (error) {
    console.error("Delete import error", error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  }
}
