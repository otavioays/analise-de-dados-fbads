import { NextRequest, NextResponse } from "next/server";

import { buildIntelligenceExport } from "@/lib/intelligence-export";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const payload = await buildIntelligenceExport(request);
    return NextResponse.json(payload, {
      status: 200,
      headers: {
        "Cache-Control": "no-store, max-age=0",
        "Content-Disposition": 'inline; filename="conversion-intelligence-v1-2.json"',
      },
    });
  } catch (error) {
    console.error("Failed to build private intelligence export", error);
    return NextResponse.json(
      {
        ok: false,
        error: "Could not build the private intelligence export.",
      },
      {
        status: 500,
        headers: { "Cache-Control": "no-store, max-age=0" },
      },
    );
  }
}
