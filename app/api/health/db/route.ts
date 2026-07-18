import { NextResponse } from "next/server";

import { getDatabaseConfig, getSql } from "@/lib/neon";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  const config = getDatabaseConfig();

  if (!config.isConfigured) {
    return NextResponse.json(
      {
        ok: false,
        status: "database_connection_variable_missing",
        environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "unknown",
        accepted_variables: config.acceptedVariables,
        action:
          "Add a Neon connection string to this Vercel environment and redeploy. Preview deployments need Preview scope enabled.",
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
      variable_name: config.variableName,
    });
  } catch (error) {
    console.error("Database health check failed", error);

    return NextResponse.json(
      {
        ok: false,
        status: "database_connection_failed",
        environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "unknown",
        variable_name: config.variableName,
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
