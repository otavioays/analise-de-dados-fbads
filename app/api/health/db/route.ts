import { NextResponse } from "next/server";

import { getSql } from "@/lib/neon";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  if (!process.env.DATABASE_URL) {
    return NextResponse.json(
      {
        ok: false,
        status: "database_url_missing",
        environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "unknown",
        action:
          "Enable DATABASE_URL for this Vercel environment and redeploy. Preview deployments need Preview scope.",
      },
      { status: 503 },
    );
  }

  try {
    const sql = getSql();
    await sql`select 1`;

    return NextResponse.json({
      ok: true,
      status: "database_ok",
      environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "unknown",
    });
  } catch (error) {
    console.error("Database health check failed", error);

    return NextResponse.json(
      {
        ok: false,
        status: "database_connection_failed",
        environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "unknown",
        error_type: error instanceof Error ? error.name : "UnknownError",
        message:
          error instanceof Error
            ? error.message.replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[redacted]")
            : "Unknown database error",
      },
      { status: 503 },
    );
  }
}
