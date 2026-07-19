import { NextRequest, NextResponse } from "next/server";

import { getSql } from "@/lib/neon";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAINTENANCE_TOKEN = "legacy-gaiety-20260719-b8f174e0";
const CURRENT_SITE_CUTOVER = "2026-07-19T03:00:00.000Z";

type Row = Record<string, unknown>;

function rows(value: unknown): Row[] {
  return Array.isArray(value) ? (value as Row[]) : [];
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (request.nextUrl.searchParams.get("token") !== MAINTENANCE_TOKEN) {
    return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });
  }

  const sql = getSql();

  await sql`
    create table if not exists public.analytics_events_archive_legacy_gaiety
    (like public.analytics_events including all)
  `;

  const matchingBeforeResult = await sql`
    select count(*)::integer as count
    from public.analytics_events e
    where
      e.client_timestamp < ${CURRENT_SITE_CUTOVER}::timestamptz
      or coalesce(e.page_title, '') ilike 'GAIETY Classic%'
      or coalesce(e.page_url, '') ilike '%/products/relogio-masculino-gaiety-classic%'
      or coalesce(e.referrer, '') ilike '%/products/relogio-masculino-gaiety-classic%'
      or coalesce(e.properties ->> 'product_id', '') = 'gaiety-classic'
      or coalesce(e.properties ->> 'product_name', '') ilike '%GAIETY Classic%'
      or e.properties @> '{"line_items":[{"product_id":"15913500705137"}]}'::jsonb
  `;

  const archivedResult = await sql`
    insert into public.analytics_events_archive_legacy_gaiety
    select e.*
    from public.analytics_events e
    where
      e.client_timestamp < ${CURRENT_SITE_CUTOVER}::timestamptz
      or coalesce(e.page_title, '') ilike 'GAIETY Classic%'
      or coalesce(e.page_url, '') ilike '%/products/relogio-masculino-gaiety-classic%'
      or coalesce(e.referrer, '') ilike '%/products/relogio-masculino-gaiety-classic%'
      or coalesce(e.properties ->> 'product_id', '') = 'gaiety-classic'
      or coalesce(e.properties ->> 'product_name', '') ilike '%GAIETY Classic%'
      or e.properties @> '{"line_items":[{"product_id":"15913500705137"}]}'::jsonb
    on conflict do nothing
    returning event_id
  `;

  const deletedResult = await sql`
    delete from public.analytics_events e
    where
      e.client_timestamp < ${CURRENT_SITE_CUTOVER}::timestamptz
      or coalesce(e.page_title, '') ilike 'GAIETY Classic%'
      or coalesce(e.page_url, '') ilike '%/products/relogio-masculino-gaiety-classic%'
      or coalesce(e.referrer, '') ilike '%/products/relogio-masculino-gaiety-classic%'
      or coalesce(e.properties ->> 'product_id', '') = 'gaiety-classic'
      or coalesce(e.properties ->> 'product_name', '') ilike '%GAIETY Classic%'
      or e.properties @> '{"line_items":[{"product_id":"15913500705137"}]}'::jsonb
    returning event_id
  `;

  const remainingLegacyResult = await sql`
    select count(*)::integer as count
    from public.analytics_events e
    where
      e.client_timestamp < ${CURRENT_SITE_CUTOVER}::timestamptz
      or coalesce(e.page_title, '') ilike 'GAIETY Classic%'
      or coalesce(e.page_url, '') ilike '%/products/relogio-masculino-gaiety-classic%'
      or coalesce(e.referrer, '') ilike '%/products/relogio-masculino-gaiety-classic%'
      or coalesce(e.properties ->> 'product_id', '') = 'gaiety-classic'
      or coalesce(e.properties ->> 'product_name', '') ilike '%GAIETY Classic%'
      or e.properties @> '{"line_items":[{"product_id":"15913500705137"}]}'::jsonb
  `;

  const matchingBefore = rows(matchingBeforeResult);
  const archived = rows(archivedResult);
  const deleted = rows(deletedResult);
  const remainingLegacy = rows(remainingLegacyResult);

  return NextResponse.json(
    {
      ok: true,
      mode: "archive_then_delete",
      cutover: CURRENT_SITE_CUTOVER,
      matching_before: Number(matchingBefore[0]?.count ?? 0),
      archived_now: archived.length,
      deleted_now: deleted.length,
      remaining_legacy: Number(remainingLegacy[0]?.count ?? 0),
      archive_table: "public.analytics_events_archive_legacy_gaiety",
    },
    { headers: { "Cache-Control": "no-store, max-age=0" } },
  );
}
