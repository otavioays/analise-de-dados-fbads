import { NextRequest, NextResponse } from "next/server";

import { getSql } from "@/lib/neon";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_DAYS = new Set([1, 7, 14, 30, 90, 180, 365]);
const DEFAULT_DAYS = 90;
const DEFAULT_RAW_LIMIT = 10_000;
const MAX_RAW_LIMIT = 20_000;

type Row = Record<string, unknown>;

function integerParam(value: string | null, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function numberValue(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeRows(rows: unknown): Row[] {
  return Array.isArray(rows) ? (rows as Row[]) : [];
}

function firstRow(rows: unknown): Row {
  return normalizeRows(rows)[0] ?? {};
}

function jsonSafe(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, current) =>
      typeof current === "bigint" ? current.toString() : current,
    ),
  );
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const requestedDays = integerParam(request.nextUrl.searchParams.get("days"), DEFAULT_DAYS);
  const days = ALLOWED_DAYS.has(requestedDays) ? requestedDays : DEFAULT_DAYS;
  const requestedLimit = integerParam(
    request.nextUrl.searchParams.get("raw_limit"),
    DEFAULT_RAW_LIMIT,
  );
  const rawLimit = Math.max(100, Math.min(MAX_RAW_LIMIT, requestedLimit));
  const sql = getSql();

  const [
    overviewResult,
    eventCountsResult,
    campaignResult,
    sessionsResult,
    conversionsResult,
    qualityResult,
    propertyKeysResult,
    pagesResult,
    referrersResult,
    devicesResult,
    rawEventsResult,
  ] = await Promise.all([
    sql`
      with base as (
        select *
        from public.analytics_events
        where received_at >= now() - (${days} * interval '1 day')
          and coalesce(properties ->> 'test', 'false') <> 'true'
          and coalesce(properties ->> 'internal_traffic', 'false') <> 'true'
      ), entries as (
        select distinct on (session_id)
          session_id,
          visitor_id,
          client_timestamp as session_first_event_at,
          coalesce(nullif(properties ->> 'session_storage_version', '')::integer, 1) as session_storage_version,
          coalesce(nullif(utm_source, ''), nullif(properties #>> '{first_touch,utm_source}', '')) as source,
          coalesce(nullif(utm_campaign, ''), nullif(properties #>> '{first_touch,utm_campaign}', '')) as campaign,
          coalesce(nullif(utm_content, ''), nullif(properties #>> '{first_touch,utm_content}', '')) as creative,
          coalesce(nullif(fbclid, ''), nullif(properties #>> '{first_touch,fbclid}', '')) as fbclid
        from base
        order by session_id, client_timestamp asc
      ), visitors as (
        select visitor_id, count(*) as sessions
        from entries
        group by visitor_id
      )
      select
        (select count(*) from base) as total_events,
        count(*) as sessions,
        count(distinct visitor_id) as unique_visitors,
        min(session_first_event_at) as first_session_at,
        max(session_first_event_at) as latest_session_at,
        count(*) filter (where session_storage_version >= 2) as session_v2_sessions,
        count(*) filter (where campaign is not null) as attributed_sessions,
        count(distinct visitor_id) filter (where campaign is not null) as attributed_visitors,
        count(distinct fbclid) filter (where fbclid is not null) as distinct_fbclid,
        (select coalesce(max(sessions), 0) from visitors) as max_sessions_per_visitor,
        (select count(*) from visitors where sessions > 1) as visitors_with_multiple_sessions,
        (select coalesce(avg(sessions), 0) from visitors) as avg_sessions_per_visitor
      from entries
    `,
    sql`
      select
        event_name,
        count(*) as events,
        count(distinct visitor_id) as unique_visitors,
        count(distinct session_id) as sessions,
        min(client_timestamp) as first_seen_at,
        max(client_timestamp) as last_seen_at
      from public.analytics_events
      where received_at >= now() - (${days} * interval '1 day')
        and coalesce(properties ->> 'test', 'false') <> 'true'
        and coalesce(properties ->> 'internal_traffic', 'false') <> 'true'
      group by event_name
      order by events desc, event_name asc
    `,
    sql`
      with base as (
        select *
        from public.analytics_events
        where received_at >= now() - (${days} * interval '1 day')
          and coalesce(properties ->> 'test', 'false') <> 'true'
          and coalesce(properties ->> 'internal_traffic', 'false') <> 'true'
      ), entries as (
        select distinct on (session_id)
          session_id,
          visitor_id,
          coalesce(nullif(utm_source, ''), nullif(properties #>> '{first_touch,utm_source}', '')) as source,
          coalesce(nullif(utm_medium, ''), nullif(properties #>> '{first_touch,utm_medium}', '')) as medium,
          coalesce(nullif(utm_campaign, ''), nullif(properties #>> '{first_touch,utm_campaign}', '')) as campaign,
          coalesce(nullif(utm_content, ''), nullif(properties #>> '{first_touch,utm_content}', '')) as creative,
          coalesce(nullif(utm_term, ''), nullif(properties #>> '{first_touch,utm_term}', '')) as term,
          coalesce(nullif(fbclid, ''), nullif(properties #>> '{first_touch,fbclid}', '')) as fbclid
        from base
        order by session_id, client_timestamp asc
      ), rollup as (
        select
          session_id,
          bool_or(event_name = 'cta_impression') as cta_impression,
          bool_or(event_name = 'buy_button_click') as buy_click,
          bool_or(event_name = 'add_to_cart') as add_to_cart,
          bool_or(event_name = 'checkout_started') as checkout,
          bool_or(event_name = 'purchase') as purchase,
          count(*) as event_count
        from base
        group by session_id
      )
      select
        coalesce(source, 'Direto / não informado') as source,
        medium,
        coalesce(campaign, 'Direto / não atribuído') as campaign,
        coalesce(creative, 'Não informado') as creative,
        term,
        count(*) as sessions,
        count(distinct visitor_id) as unique_visitors,
        count(distinct fbclid) filter (where fbclid is not null) as distinct_fbclid,
        count(distinct visitor_id) filter (where coalesce(r.cta_impression, false)) as cta_impression_visitors,
        count(distinct visitor_id) filter (where coalesce(r.buy_click, false)) as buy_click_visitors,
        count(distinct visitor_id) filter (where coalesce(r.add_to_cart, false)) as add_to_cart_visitors,
        count(distinct visitor_id) filter (where coalesce(r.checkout, false)) as checkout_visitors,
        count(distinct visitor_id) filter (where coalesce(r.purchase, false)) as purchase_visitors,
        coalesce(sum(r.event_count), 0) as total_events
      from entries e
      left join rollup r on r.session_id = e.session_id
      group by source, medium, campaign, creative, term
      order by purchase_visitors desc, checkout_visitors desc, buy_click_visitors desc, unique_visitors desc
    `,
    sql`
      with base as (
        select *
        from public.analytics_events
        where received_at >= now() - (${days} * interval '1 day')
          and coalesce(properties ->> 'test', 'false') <> 'true'
          and coalesce(properties ->> 'internal_traffic', 'false') <> 'true'
      ), entries as (
        select distinct on (session_id)
          session_id,
          visitor_id,
          client_timestamp as started_at,
          page_url as landing_page,
          referrer,
          device_type,
          screen_width,
          language,
          coalesce(nullif(utm_source, ''), nullif(properties #>> '{first_touch,utm_source}', '')) as source,
          coalesce(nullif(utm_medium, ''), nullif(properties #>> '{first_touch,utm_medium}', '')) as medium,
          coalesce(nullif(utm_campaign, ''), nullif(properties #>> '{first_touch,utm_campaign}', '')) as campaign,
          coalesce(nullif(utm_content, ''), nullif(properties #>> '{first_touch,utm_content}', '')) as creative,
          coalesce(nullif(fbclid, ''), nullif(properties #>> '{first_touch,fbclid}', '')) as fbclid,
          coalesce(nullif(properties ->> 'session_storage_version', '')::integer, 1) as session_storage_version,
          properties ->> 'session_started_at' as session_started_at
        from base
        order by session_id, client_timestamp asc
      ), rollup as (
        select
          session_id,
          min(client_timestamp) as first_event_at,
          max(client_timestamp) as last_event_at,
          count(*) as event_count,
          array_agg(distinct event_name order by event_name) as event_names,
          bool_or(event_name = 'cta_impression') as cta_impression,
          bool_or(event_name = 'buy_button_click') as buy_click,
          bool_or(event_name = 'add_to_cart') as add_to_cart,
          bool_or(event_name = 'checkout_started') as checkout,
          bool_or(event_name = 'purchase') as purchase,
          count(*) filter (where event_name = 'javascript_error') as javascript_errors
        from base
        group by session_id
      ), latest_summary as (
        select distinct on (session_id)
          session_id,
          properties ->> 'visible_seconds' as visible_seconds,
          properties ->> 'duration_seconds' as duration_seconds,
          properties ->> 'max_scroll_depth' as max_scroll_depth,
          properties ->> 'sections_viewed' as sections_viewed,
          properties ->> 'quick_exit' as quick_exit,
          properties ->> 'page_instance_id' as page_instance_id
        from base
        where event_name = 'session_summary'
        order by session_id, client_timestamp desc
      )
      select e.*, r.*, s.visible_seconds, s.duration_seconds, s.max_scroll_depth,
        s.sections_viewed, s.quick_exit, s.page_instance_id
      from entries e
      left join rollup r on r.session_id = e.session_id
      left join latest_summary s on s.session_id = e.session_id
      order by e.started_at desc
    `,
    sql`
      select
        event_id,
        event_name,
        visitor_id,
        session_id as actual_session_id,
        client_timestamp,
        received_at,
        utm_source,
        utm_medium,
        utm_campaign,
        utm_content,
        fbclid,
        properties ->> 'checkout_id' as checkout_id,
        properties ->> 'order_id' as order_id,
        properties #>> '{conversion_attribution,visitor_id}' as attributed_visitor_id,
        properties #>> '{conversion_attribution,session_id}' as attributed_session_id,
        properties #>> '{conversion_attribution,method}' as attribution_method,
        properties #>> '{conversion_attribution,confidence}' as attribution_confidence,
        properties #>> '{conversion_attribution,cross_session}' as cross_session,
        properties #>> '{conversion_attribution,lookback_days}' as attribution_lookback_days,
        properties
      from public.analytics_events
      where received_at >= now() - (${days} * interval '1 day')
        and event_name in ('checkout_started', 'purchase')
        and coalesce(properties ->> 'test', 'false') <> 'true'
        and coalesce(properties ->> 'internal_traffic', 'false') <> 'true'
      order by client_timestamp desc, received_at desc
    `,
    sql`
      with base as (
        select *
        from public.analytics_events
        where received_at >= now() - (${days} * interval '1 day')
          and coalesce(properties ->> 'test', 'false') <> 'true'
          and coalesce(properties ->> 'internal_traffic', 'false') <> 'true'
      ), page_views as (
        select * from base where event_name = 'page_view'
      )
      select
        count(*) as page_views,
        count(*) filter (where visitor_id is null) as missing_visitor_id,
        count(*) filter (where session_id is null) as missing_session_id,
        count(*) filter (where nullif(page_url, '') is null) as missing_page_url,
        count(*) filter (where nullif(device_type, '') is null) as missing_device_type,
        count(*) filter (where nullif(utm_campaign, '') is null and nullif(properties #>> '{first_touch,utm_campaign}', '') is null) as missing_campaign,
        count(*) filter (where lower(coalesce(utm_source, properties #>> '{first_touch,utm_source}', '')) in ('facebook', 'fb', 'meta') and nullif(coalesce(fbclid, properties #>> '{first_touch,fbclid}'), '') is null) as facebook_without_fbclid,
        count(*) filter (where coalesce(nullif(properties ->> 'session_storage_version', '')::integer, 1) >= 2) as v2_page_views,
        count(*) filter (where event_name = 'session_summary') as summaries
      from page_views
    `,
    sql`
      select key, count(*) as occurrences
      from public.analytics_events e
      cross join lateral jsonb_object_keys(e.properties) as key
      where e.received_at >= now() - (${days} * interval '1 day')
        and coalesce(e.properties ->> 'test', 'false') <> 'true'
        and coalesce(e.properties ->> 'internal_traffic', 'false') <> 'true'
      group by key
      order by occurrences desc, key asc
    `,
    sql`
      select
        page_path,
        page_title,
        count(*) as events,
        count(distinct visitor_id) as unique_visitors,
        count(distinct session_id) as sessions
      from public.analytics_events
      where received_at >= now() - (${days} * interval '1 day')
        and coalesce(properties ->> 'test', 'false') <> 'true'
        and coalesce(properties ->> 'internal_traffic', 'false') <> 'true'
      group by page_path, page_title
      order by events desc
      limit 250
    `,
    sql`
      select
        coalesce(nullif(referrer, ''), 'Sem referrer') as referrer,
        count(*) as events,
        count(distinct visitor_id) as unique_visitors,
        count(distinct session_id) as sessions
      from public.analytics_events
      where received_at >= now() - (${days} * interval '1 day')
        and event_name = 'page_view'
        and coalesce(properties ->> 'test', 'false') <> 'true'
        and coalesce(properties ->> 'internal_traffic', 'false') <> 'true'
      group by referrer
      order by sessions desc
      limit 250
    `,
    sql`
      select
        coalesce(device_type, 'unknown') as device_type,
        screen_width,
        language,
        count(*) as events,
        count(distinct visitor_id) as unique_visitors,
        count(distinct session_id) as sessions
      from public.analytics_events
      where received_at >= now() - (${days} * interval '1 day')
        and coalesce(properties ->> 'test', 'false') <> 'true'
        and coalesce(properties ->> 'internal_traffic', 'false') <> 'true'
      group by device_type, screen_width, language
      order by sessions desc, events desc
    `,
    sql`
      select
        event_id,
        event_name,
        visitor_id,
        session_id,
        client_timestamp,
        received_at,
        page_url,
        page_path,
        page_title,
        referrer,
        utm_source,
        utm_medium,
        utm_campaign,
        utm_content,
        utm_term,
        fbclid,
        device_type,
        screen_width,
        language,
        properties
      from public.analytics_events
      where received_at >= now() - (${days} * interval '1 day')
        and coalesce(properties ->> 'test', 'false') <> 'true'
        and coalesce(properties ->> 'internal_traffic', 'false') <> 'true'
      order by client_timestamp asc, received_at asc
      limit ${rawLimit}
    `,
  ]);

  const overview = firstRow(overviewResult);
  const rawEvents = normalizeRows(rawEventsResult);
  const totalEvents = numberValue(overview.total_events);
  const sessions = numberValue(overview.sessions);
  const uniqueVisitors = numberValue(overview.unique_visitors);
  const v2Sessions = numberValue(overview.session_v2_sessions);

  const payload = {
    schema: "private_conversion_intelligence_export_v1",
    generated_at: new Date().toISOString(),
    analysis_request:
      "Analise este dossiê como um cientista de dados e estrategista de direct response. Use visitantes únicos como unidade principal, sessões como contexto, conteste conclusões frágeis, diferencie correlação de causalidade, identifique falhas de tracking antes de culpar anúncio ou página e recomende apenas o próximo teste incremental de maior valor.",
    export_scope: {
      days,
      raw_event_limit: rawLimit,
      raw_events_included: rawEvents.length,
      total_valid_events_in_period: totalEvents,
      raw_event_limit_reached: totalEvents > rawEvents.length,
      excludes_test_events: true,
      excludes_internal_traffic: true,
      timezone: "timestamps_preserved_as_stored",
    },
    definitions: {
      visitor: "visitor_id anônimo persistido no navegador",
      session: "session_id persistido por 30 minutos de inatividade na versão v2",
      attributed_session:
        "sessão comercial recuperada para checkout ou compra sem sobrescrever a sessão real do evento",
      raw_events:
        "eventos válidos completos, incluindo properties, em ordem cronológica e sujeitos ao limite explícito",
    },
    overview: {
      ...overview,
      session_v2_coverage_percent:
        sessions > 0 ? Number(((v2Sessions / sessions) * 100).toFixed(2)) : 0,
      sessions_per_visitor:
        uniqueVisitors > 0 ? Number((sessions / uniqueVisitors).toFixed(4)) : 0,
    },
    event_catalog: normalizeRows(eventCountsResult),
    campaigns_and_creatives: normalizeRows(campaignResult),
    session_journeys: normalizeRows(sessionsResult),
    conversion_attribution: {
      resolution_order: [
        "explicit_ct_session_id",
        "checkout_id",
        "order_id",
        "visitor_latest_attributed_session_within_30_days",
        "same_session",
      ],
      events: normalizeRows(conversionsResult),
      warning:
        "Fallback por último acesso atribuído é evidência de confiança média. Checkout ID ou IDs explícitos são preferíveis.",
    },
    data_quality: firstRow(qualityResult),
    observed_property_keys: normalizeRows(propertyKeysResult),
    pages: normalizeRows(pagesResult),
    referrers: normalizeRows(referrersResult),
    devices_and_languages: normalizeRows(devicesResult),
    raw_events: rawEvents,
    interpretation_guardrails: [
      "Não trate sessões como pessoas.",
      "Não declare criativo vencedor com amostra pequena ou concentrada.",
      "Não estime custo pago usando sessões; use identificadores de clique ou dados da plataforma.",
      "Ausência de purchase pode ser falha de integração entre domínio, checkout e webhook.",
      "Scroll e tempo não comprovam intenção ou causalidade.",
      "Priorize corrigir integridade e atribuição antes de otimizar copy ou oferta.",
      "Ao recomendar ação, escolha apenas uma variável para o próximo teste.",
    ],
  };

  return NextResponse.json(jsonSafe(payload), {
    status: 200,
    headers: {
      "Cache-Control": "no-store, max-age=0",
      "Content-Disposition": 'inline; filename="conversion-intelligence.json"',
    },
  });
}
