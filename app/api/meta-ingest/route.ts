import { NextRequest, NextResponse } from "next/server";

import { getSql } from "@/lib/neon";
import {
  ensureMetaAdsTable,
  MetaAdsDailyInput,
  normalizeMetaAdsDaily,
  upsertMetaAdsDaily,
} from "@/lib/meta-ads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_ROWS = 5_000;

function authorized(request: NextRequest): boolean {
  const expected = process.env.META_INGEST_SECRET?.trim();
  if (!expected) return false;
  const authorization = request.headers.get("authorization") ?? "";
  return authorization === `Bearer ${expected}`;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  if (!process.env.META_INGEST_SECRET?.trim()) {
    return NextResponse.json(
      {
        ok: false,
        error: "META_INGEST_SECRET is not configured.",
      },
      { status: 503 },
    );
  }

  if (!authorized(request)) {
    return NextResponse.json({ ok: false, error: "Unauthorized." }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON." }, { status: 400 });
  }

  const rows =
    body && typeof body === "object" && Array.isArray((body as { rows?: unknown }).rows)
      ? ((body as { rows: MetaAdsDailyInput[] }).rows ?? [])
      : [];

  if (rows.length === 0 || rows.length > MAX_ROWS) {
    return NextResponse.json(
      {
        ok: false,
        error: `Provide between 1 and ${MAX_ROWS} rows.`,
      },
      { status: 400 },
    );
  }

  const normalized = rows.map(normalizeMetaAdsDaily);
  const valid = normalized.filter((row) => row !== null);
  const rejected = rows.length - valid.length;

  if (valid.length === 0) {
    return NextResponse.json(
      {
        ok: false,
        error: "No valid rows. date_start, campaign_id and ad_id are required.",
        rejected,
      },
      { status: 400 },
    );
  }

  try {
    const sql = getSql();
    await ensureMetaAdsTable(sql);

    const batchSize = 25;
    for (let index = 0; index < valid.length; index += batchSize) {
      const batch = valid.slice(index, index + batchSize);
      await Promise.all(batch.map((row) => upsertMetaAdsDaily(sql, row)));
    }

    return NextResponse.json(
      {
        ok: true,
        accepted: valid.length,
        rejected,
        integration: "meta_ads_daily_v1",
      },
      {
        status: 201,
        headers: { "Cache-Control": "no-store" },
      },
    );
  } catch (error) {
    console.error("Failed to ingest Meta Ads rows", error);
    return NextResponse.json(
      { ok: false, error: "Could not store Meta Ads rows." },
      { status: 500 },
    );
  }
}
