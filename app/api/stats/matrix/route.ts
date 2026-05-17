export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getMatrixData } from "../../../../lib/stats-views";

export async function GET() {
  try {
    const data = getMatrixData();
    return NextResponse.json(data);
  } catch (error) {
    console.error("/api/stats/matrix error", error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  }
}
