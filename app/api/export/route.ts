import { NextRequest, NextResponse } from "next/server";

import { getSql } from "@/lib/neon";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_DAYS = new Set([1, 7, 14, 30, 90, 180, 365]);
const DEFAULT_DAYS = 90;
const DEFAULT_RAW_LIMIT = 10_000;
const MAX_RAW_LIMIT = 20_000;
const CONTROL_SURFACE_PATTERN =
  "^https?://analise-de-dados-fbads[^/]*\\.vercel\\.app(?:/|$)";

const NUMERIC_FIELDS = new Set([
  "events",
  "total_events",
  "sessions",
  "unique_visitors",
  "visitors",
  "page_views",
  "summaries",
  "summary_sessions",
  "session_v2_sessions",
  "v2_page_views",
  "attributed_sessions",
  "attributed_visitors",
  "distinct_fbclid",
  "max_sessions_per_visitor",
  "visitors_with_multiple_sessions",
  "event_count",
  "javascript_errors",
  "cta_impression_visitors",
  "buy_click_visitors",
  "add_to_cart_visitors",
  "checkout_visitors",
  "purchase_visitors",
  "missing_visitor_id",
  "missing_session_id",
  "missing_page_url",
  "missing_device_type",
  "missing_campaign",
  "facebook_without_fbclid",
  "occurrences",
  "quantity",
  "total_quantity",
  "test_events",
  "internal_traffic_events",
  "control_surface_events",
  "valid_external_events",
  "total_rows_in_period",
  "resolved_events",
  "unresolved_events",
  "cross_session_events",
]);

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
  return Array.isArray(rows) ? (rows as Row[]).map(normalizeRow) : [];
}

function normalizeRow(row: Row): Row {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      NUMERIC_FIELDS.has(key) && value !== null ? numberValue(value) : value,
    ]),
  );
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
    exclusionResult,
    overviewResult,
    funnelResult,
    eventCountsResult,
    campaignResult,
    sessionsResult,
    conversionsResult,
    qualityResult,
    propertyKeysResult,
    pagesResult,
    referrersResult,
    devicesResult,
    dailyResult,
    productsResult,
    errorsResult,
    rawEventsResult,
  ] = await Promise.all([
    sql`
      select
        count(*) as total_rows_in_period,
        count(*) filter (where coalesce(properties ->> 'test', 'false') = 'true') as test_events,
        count(*) filter (where coalesce(properties ->> 'internal_traffic', 'false') = 'true') as internal_traffic_events,
        count(*) filter (where page_url ~* ${CONTROL_SURFACE_PATTERN}) as control_surface_events,
        count(*) filter (
          where coalesce(properties ->> 'test', 'false') <> 'true'
            and coalesce(properties ->> 'internal_traffic', 'false') <> 'true'
            and page_url !~* ${CONTROL_SURFACE_PATTERN}
        ) as valid_external_events
      from public.analytics_events
      where received_at >= now() - (${days} * interval '1 day')
    `,
    sql`
      with base as (
        select *
        from public.analytics_events
        where received_at >= now() - (${days} * interval '1 day')
          and coalesce(properties ->> 'test', 'false') <> 'true'
          and coalesce(properties ->> 'internal_traffic', 'false') <> 'true'
          and page_url !~* ${CONTROL_SURFACE_PATTERN}
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
      with base as (
        select *
        from public.analytics_events
        where received_at >= now() - (${days} * interval '1 day')
          and coalesce(properties ->> 'test', 'false') <> 'true'
          and coalesce(properties ->> 'internal_traffic', 'false') <> 'true'
          and page_url !~* ${CONTROL_SURFACE_PATTERN}
      ), visitor_funnel as (
        select
          visitor_id,
          bool_or(event_name = 'page_view') as viewed,
          bool_or(event_name = 'cta_impression') as saw_cta,
          bool_or(event_name = 'buy_button_click') as clicked,
          bool_or(event_name = 'add_to_cart') as added,
          bool_or(event_name = 'checkout_started') as checkout,
          bool_or(event_name = 'purchase') as purchase
        from base
        group by visitor_id
      )
      select
        count(*) as visitors,
        count(*) filter (where viewed) as page_view_visitors,
        count(*) filter (where saw_cta) as cta_impression_visitors,
        count(*) filter (where clicked) as buy_click_visitors,
        count(*) filter (where added) as add_to_cart_visitors,
        count(*) filter (where checkout) as checkout_visitors,
        count(*) filter (where purchase) as purchase_visitors
      from visitor_funnel
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
        and page_url !~* ${CONTROL_SURFACE_PATTERN}
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
          and page_url !~* ${CONTROL_SURFACE_PATTERN}
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
          and page_url !~* ${CONTROL_SURFACE_PATTERN}
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
          count(*) filter (where event_name = 'javascript_error') as javascript_errors,
          count(*) filter (where event_name = 'session_summary') as summaries,
          count(distinct nullif(properties ->> 'page_instance_id', '')) as page_instances
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
        coalesce(properties ->> 'checkout_id', properties ->> 'checkout_token') as checkout_id,
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
        and page_url !~* ${CONTROL_SURFACE_PATTERN}
      order by client_timestamp desc, received_at desc
    `,
    sql`
      with base as (
        select *
        from public.analytics_events
        where received_at >= now() - (${days} * interval '1 day')
          and coalesce(properties ->> 'test', 'false') <> 'true'
          and coalesce(properties ->> 'internal_traffic', 'false') <> 'true'
          and page_url !~* ${CONTROL_SURFACE_PATTERN}
      )
      select
        count(*) filter (where event_name = 'page_view') as page_views,
        count(*) filter (where event_name = 'page_view' and visitor_id is null) as missing_visitor_id,
        count(*) filter (where event_name = 'page_view' and session_id is null) as missing_session_id,
        count(*) filter (where event_name = 'page_view' and nullif(page_url, '') is null) as missing_page_url,
        count(*) filter (where event_name = 'page_view' and nullif(device_type, '') is null) as missing_device_type,
        count(*) filter (
          where event_name = 'page_view'
            and nullif(utm_campaign, '') is null
            and nullif(properties #>> '{first_touch,utm_campaign}', '') is null
        ) as missing_campaign,
        count(*) filter (
          where event_name = 'page_view'
            and lower(coalesce(utm_source, properties #>> '{first_touch,utm_source}', '')) in ('facebook', 'fb', 'meta')
            and nullif(coalesce(fbclid, properties #>> '{first_touch,fbclid}'), '') is null
        ) as facebook_without_fbclid,
        count(*) filter (
          where event_name = 'page_view'
            and coalesce(nullif(properties ->> 'session_storage_version', '')::integer, 1) >= 2
        ) as v2_page_views,
        count(*) filter (where event_name = 'session_summary') as summaries,
        count(distinct session_id) filter (where event_name = 'session_summary') as summary_sessions
      from base
    `,
    sql`
      select key, count(*) as occurrences
      from public.analytics_events e
      cross join lateral jsonb_object_keys(e.properties) as key
      where e.received_at >= now() - (${days} * interval '1 day')
        and coalesce(e.properties ->> 'test', 'false') <> 'true'
        and coalesce(e.properties ->> 'internal_traffic', 'false') <> 'true'
        and e.page_url !~* ${CONTROL_SURFACE_PATTERN}
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
        and page_url !~* ${CONTROL_SURFACE_PATTERN}
      group by page_path, page_title
      order by events desc
      limit 500
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
        and page_url !~* ${CONTROL_SURFACE_PATTERN}
      group by referrer
      order by sessions desc
      limit 500
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
        and page_url !~* ${CONTROL_SURFACE_PATTERN}
      group by device_type, screen_width, language
      order by sessions desc, events desc
    `,
    sql`
      select
        date_trunc('day', client_timestamp) as day,
        count(*) as events,
        count(distinct visitor_id) as unique_visitors,
        count(distinct session_id) as sessions,
        count(*) filter (where event_name = 'page_view') as page_views,
        count(*) filter (where event_name = 'checkout_started') as checkouts,
        count(*) filter (where event_name = 'purchase') as purchases
      from public.analytics_events
      where received_at >= now() - (${days} * interval '1 day')
        and coalesce(properties ->> 'test', 'false') <> 'true'
        and coalesce(properties ->> 'internal_traffic', 'false') <> 'true'
        and page_url !~* ${CONTROL_SURFACE_PATTERN}
      group by date_trunc('day', client_timestamp)
      order by day asc
    `,
    sql`
      with line_items as (
        select
          e.event_name,
          e.visitor_id,
          e.session_id,
          item
        from public.analytics_events e
        cross join lateral jsonb_array_elements(
          case
            when jsonb_typeof(e.properties -> 'line_items') = 'array'
              then e.properties -> 'line_items'
            else '[]'::jsonb
          end
        ) as item
        where e.received_at >= now() - (${days} * interval '1 day')
          and coalesce(e.properties ->> 'test', 'false') <> 'true'
          and coalesce(e.properties ->> 'internal_traffic', 'false') <> 'true'
          and e.page_url !~* ${CONTROL_SURFACE_PATTERN}
      )
      select
        item ->> 'product_id' as product_id,
        item ->> 'variant_id' as variant_id,
        item ->> 'product_title' as product_title,
        item ->> 'variant_title' as variant_title,
        count(*) as events,
        count(distinct visitor_id) as unique_visitors,
        count(distinct session_id) as sessions,
        coalesce(sum(nullif(item ->> 'quantity', '')::numeric), 0) as total_quantity,
        min(nullif(item ->> 'price', '')::numeric) as minimum_price,
        max(nullif(item ->> 'price', '')::numeric) as maximum_price
      from line_items
      group by product_id, variant_id, product_title, variant_title
      order by events desc, product_title asc
    `,
    sql`
      select
        event_id,
        visitor_id,
        session_id,
        client_timestamp,
        received_at,
        page_url,
        page_path,
        properties
      from public.analytics_events
      where received_at >= now() - (${days} * interval '1 day')
        and event_name = 'javascript_error'
        and coalesce(properties ->> 'test', 'false') <> 'true'
        and coalesce(properties ->> 'internal_traffic', 'false') <> 'true'
        and page_url !~* ${CONTROL_SURFACE_PATTERN}
      order by client_timestamp desc
      limit 500
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
        and page_url !~* ${CONTROL_SURFACE_PATTERN}
      order by client_timestamp asc, received_at asc
      limit ${rawLimit}
    `,
  ]);

  const exclusions = firstRow(exclusionResult);
  const overview = firstRow(overviewResult);
  const quality = firstRow(qualityResult);
  const rawEvents = normalizeRows(rawEventsResult);
  const conversions = normalizeRows(conversionsResult);
  const totalEvents = numberValue(overview.total_events);
  const sessions = numberValue(overview.sessions);
  const uniqueVisitors = numberValue(overview.unique_visitors);
  const v2Sessions = numberValue(overview.session_v2_sessions);
  const pageViews = numberValue(quality.page_views);
  const v2PageViews = numberValue(quality.v2_page_views);
  const summarySessions = numberValue(quality.summary_sessions);

  const resolvedConversions = conversions.filter(
    (event) => typeof event.attribution_method === "string" && event.attribution_method,
  );
  const crossSessionConversions = resolvedConversions.filter(
    (event) => event.cross_session === "true" || event.cross_session === true,
  );

  const payload = {
    schema: "private_conversion_intelligence_export_v1_1",
    generated_at: new Date().toISOString(),
    analysis_request:
      "Analise este dossiê como um cientista de dados e estrategista de direct response. Use visitantes únicos como unidade principal, sessões como contexto, conteste conclusões frágeis, diferencie correlação de causalidade, identifique falhas de tracking antes de culpar anúncio ou página e recomende apenas o próximo teste incremental de maior valor.",
    export_scope: {
      days,
      raw_event_limit: rawLimit,
      raw_events_included: rawEvents.length,
      total_valid_external_events_in_period: totalEvents,
      raw_event_limit_reached: totalEvents > rawEvents.length,
      excludes_test_events: true,
      excludes_internal_traffic: true,
      excludes_historical_control_surface_by_url: true,
      control_surface_url_pattern: CONTROL_SURFACE_PATTERN,
      timezone: "timestamps_preserved_as_stored",
      exclusion_audit: exclusions,
      exclusion_counts_can_overlap: true,
    },
    definitions: {
      visitor: "visitor_id anônimo persistido no navegador",
      session: "session_id persistido por 30 minutos de inatividade na versão v2",
      attributed_session:
        "sessão comercial recuperada para checkout ou compra sem sobrescrever a sessão real do evento",
      raw_events:
        "eventos externos válidos completos, incluindo properties, em ordem cronológica e sujeitos ao limite explícito",
      control_surface:
        "eventos históricos gerados dentro da própria central de análise; são excluídos mesmo quando não possuíam a flag internal_traffic",
    },
    overview: {
      ...overview,
      session_v2_coverage_percent:
        sessions > 0 ? Number(((v2Sessions / sessions) * 100).toFixed(2)) : 0,
      sessions_per_visitor:
        uniqueVisitors > 0 ? Number((sessions / uniqueVisitors).toFixed(4)) : 0,
    },
    funnel_by_unique_visitor: firstRow(funnelResult),
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
      resolved_events: resolvedConversions.length,
      unresolved_events: conversions.length - resolvedConversions.length,
      cross_session_events: crossSessionConversions.length,
      historical_note:
        "Eventos anteriores à implantação da camada conversion_attribution podem permanecer nulos; isso não significa falha do exportador.",
      events: conversions,
      warning:
        "Fallback por último acesso atribuído é evidência de confiança média. Checkout ID ou IDs explícitos são preferíveis.",
    },
    data_quality: {
      ...quality,
      summary_session_coverage_percent:
        sessions > 0 ? Number(((summarySessions / sessions) * 100).toFixed(2)) : 0,
      session_v2_page_view_coverage_percent:
        pageViews > 0 ? Number(((v2PageViews / pageViews) * 100).toFixed(2)) : 0,
    },
    observed_property_keys: normalizeRows(propertyKeysResult),
    daily_time_series: normalizeRows(dailyResult),
    pages: normalizeRows(pagesResult),
    referrers: normalizeRows(referrersResult),
    devices_and_languages: normalizeRows(devicesResult),
    products_and_variants: normalizeRows(productsResult),
    javascript_errors: normalizeRows(errorsResult),
    raw_events: rawEvents,
    interpretation_guardrails: [
      "Não trate sessões como pessoas.",
      "Não declare criativo vencedor com amostra pequena ou concentrada.",
      "Não estime custo pago usando sessões; use identificadores de clique ou dados da plataforma.",
      "Ausência de purchase pode ser falha de integração entre domínio, checkout e webhook.",
      "Scroll e tempo não comprovam intenção ou causalidade.",
      "Eventos históricos da central foram removidos pelo domínio antes de qualquer agregado.",
      "Campos de atribuição nulos em eventos antigos não devem ser reinterpretados retroativamente.",
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
