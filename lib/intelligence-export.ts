import { createHash } from "node:crypto";

import { NextRequest } from "next/server";

import { ensureMetaAdsTable } from "@/lib/meta-ads";
import { getSql } from "@/lib/neon";

const ALLOWED_DAYS = new Set([1, 7, 14, 30, 90, 180, 365]);
const DEFAULT_DAYS = 90;
const DEFAULT_RAW_LIMIT = 10_000;
const MAX_RAW_LIMIT = 20_000;
const CONTROL_SURFACE_PATTERN =
  "^https?://analise-de-dados-fbads[^/]*\\.vercel\\.app(?:/|$)";

const SENSITIVE_KEYS = new Set([
  "checkout_token",
  "checkout_id",
  "order_id",
  "shopify_event_id",
  "fbclid",
  "gclid",
  "ttclid",
  "email",
  "phone",
  "phone_number",
  "customer_email",
]);

const NON_NUMERIC_KEY_PATTERN =
  /(?:^|_)(?:id|date|day|time|timestamp|at|url|path|title|name|source|medium|campaign|creative|term|currency|language|device|method|confidence|reason|type|key|hash|token|pattern|status|schema|version|warning|note|request)$/i;

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

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function sanitizeUrl(value: string): string {
  try {
    const url = new URL(value);
    const pathname = url.pathname.startsWith("/checkouts/")
      ? `/checkouts/hash-${stableHash(url.pathname)}`
      : url.pathname.startsWith("/cart/")
        ? `/cart/hash-${stableHash(url.pathname)}`
        : url.pathname;
    const output = new URL(`${url.protocol}//${url.host}${pathname}`);
    const allowed = new Set([
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_content",
      "utm_term",
      "ref",
    ]);
    for (const [key, raw] of url.searchParams.entries()) {
      if (allowed.has(key)) output.searchParams.set(key, raw.slice(0, 255));
      if (["fbclid", "gclid", "ttclid"].includes(key)) {
        output.searchParams.set(`${key}_hash`, stableHash(raw));
      }
    }
    return output.toString();
  } catch {
    return value.slice(0, 2_048);
  }
}

function sanitizeValue(value: unknown, key = "", depth = 0): unknown {
  if (depth > 8) return "[depth-limited]";
  if (value === null || value === undefined) return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) {
      return value ? `sha256:${stableHash(value)}` : value;
    }
    if (
      /(?:url|referrer|landing_page|destination)$/i.test(key) &&
      /^https?:\/\//i.test(value)
    ) {
      return sanitizeUrl(value);
    }
    if (
      /^[-+]?\d+(?:\.\d+)?$/.test(value) &&
      !NON_NUMERIC_KEY_PATTERN.test(key) &&
      value.length < 18
    ) {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : value;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 20_000).map((item) => sanitizeValue(item, key, depth + 1));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([nestedKey, nestedValue]) => [
        nestedKey,
        sanitizeValue(nestedValue, nestedKey, depth + 1),
      ]),
    );
  }
  return value;
}

function sanitizedRows(rows: unknown): Row[] {
  return normalizeRows(rows).map((row) => sanitizeValue(row) as Row);
}

function wilsonInterval(successes: number, total: number): Row {
  if (total <= 0 || successes < 0 || successes > total) {
    return {
      successes,
      total,
      rate: null,
      lower_95: null,
      upper_95: null,
      valid: false,
      warning:
        successes > total
          ? "Numerator exceeds denominator, usually indicating cross-domain identity fragmentation."
          : "No valid denominator.",
    };
  }
  const z = 1.959963984540054;
  const p = successes / total;
  const denominator = 1 + (z * z) / total;
  const center = (p + (z * z) / (2 * total)) / denominator;
  const margin =
    (z / denominator) *
    Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total));
  return {
    successes,
    total,
    rate: Number(p.toFixed(6)),
    lower_95: Number(Math.max(0, center - margin).toFixed(6)),
    upper_95: Number(Math.min(1, center + margin).toFixed(6)),
    valid: true,
  };
}

function safeDivide(numerator: number, denominator: number): number | null {
  return denominator > 0 ? Number((numerator / denominator).toFixed(6)) : null;
}

function scoreFromRatio(ratio: number): number {
  return Math.max(0, Math.min(100, Math.round(ratio * 100)));
}

function metaMetrics(row: Row): Row {
  const spend = numberValue(row.spend);
  const impressions = numberValue(row.impressions);
  const clicks = numberValue(row.clicks);
  const landingPageViews = numberValue(row.landing_page_views);
  const purchases = numberValue(row.purchases);
  const purchaseValue = numberValue(row.purchase_value);
  return {
    ...row,
    ctr: safeDivide(clicks, impressions),
    cpc: safeDivide(spend, clicks),
    cpm: impressions > 0 ? Number(((spend / impressions) * 1_000).toFixed(4)) : null,
    landing_page_view_rate: safeDivide(landingPageViews, clicks),
    cost_per_landing_page_view: safeDivide(spend, landingPageViews),
    cpa: safeDivide(spend, purchases),
    roas: safeDivide(purchaseValue, spend),
  };
}

export async function buildIntelligenceExport(request: NextRequest): Promise<Row> {
  const requestedDays = integerParam(
    request.nextUrl.searchParams.get("days"),
    DEFAULT_DAYS,
  );
  const days = ALLOWED_DAYS.has(requestedDays) ? requestedDays : DEFAULT_DAYS;
  const requestedLimit = integerParam(
    request.nextUrl.searchParams.get("raw_limit"),
    DEFAULT_RAW_LIMIT,
  );
  const rawLimit = Math.max(100, Math.min(MAX_RAW_LIMIT, requestedLimit));
  const sql = getSql();

  await ensureMetaAdsTable(sql);

  const [
    exclusionAuditResult,
    overviewResult,
    funnelResult,
    eventCatalogResult,
    campaignsResult,
    sessionsResult,
    conversionsResult,
    qualityResult,
    propertyKeysResult,
    dailyResult,
    pagesResult,
    referrersResult,
    devicesResult,
    productsResult,
    javascriptErrorsResult,
    ctaResult,
    sectionsResult,
    performanceResult,
    anomaliesResult,
    identityResult,
    timeToConversionResult,
    cohortsResult,
    creativeTaxonomyResult,
    metaOverviewResult,
    metaCampaignResult,
    metaDailyResult,
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
        select * from public.analytics_events
        where received_at >= now() - (${days} * interval '1 day')
          and coalesce(properties ->> 'test', 'false') <> 'true'
          and coalesce(properties ->> 'internal_traffic', 'false') <> 'true'
          and page_url !~* ${CONTROL_SURFACE_PATTERN}
      ), entries as (
        select distinct on (session_id)
          session_id, visitor_id, client_timestamp as session_first_event_at,
          coalesce(nullif(properties ->> 'session_storage_version', '')::integer, 1) as session_storage_version,
          coalesce(nullif(utm_campaign, ''), nullif(properties #>> '{first_touch,utm_campaign}', '')) as campaign,
          coalesce(nullif(fbclid, ''), nullif(properties #>> '{first_touch,fbclid}', '')) as fbclid
        from base
        order by session_id, client_timestamp asc
      ), visitors as (
        select visitor_id, count(*) as sessions from entries group by visitor_id
      )
      select
        (select count(*) from base) as total_events,
        count(*) as sessions,
        count(distinct visitor_id) as unique_visitors,
        min(session_first_event_at) as first_session_at,
        max(session_first_event_at) as latest_session_at,
        count(*) filter (where session_storage_version >= 2) as session_v2_sessions,
        count(*) filter (where session_storage_version >= 3) as session_v3_sessions,
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
        select * from public.analytics_events
        where received_at >= now() - (${days} * interval '1 day')
          and coalesce(properties ->> 'test', 'false') <> 'true'
          and coalesce(properties ->> 'internal_traffic', 'false') <> 'true'
          and page_url !~* ${CONTROL_SURFACE_PATTERN}
      )
      select
        count(distinct visitor_id) as visitors,
        count(distinct visitor_id) filter (where event_name = 'page_view') as page_view_visitors,
        count(distinct visitor_id) filter (where event_name = 'cta_impression') as cta_impression_visitors,
        count(distinct visitor_id) filter (where event_name = 'buy_button_click') as buy_click_visitors,
        count(distinct visitor_id) filter (where event_name = 'add_to_cart') as add_to_cart_visitors,
        count(distinct visitor_id) filter (where event_name = 'checkout_started') as checkout_visitors,
        count(distinct visitor_id) filter (where event_name = 'purchase') as purchase_visitors
      from base
    `,
    sql`
      select event_name, count(*) as events,
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
        select * from public.analytics_events
        where received_at >= now() - (${days} * interval '1 day')
          and coalesce(properties ->> 'test', 'false') <> 'true'
          and coalesce(properties ->> 'internal_traffic', 'false') <> 'true'
          and page_url !~* ${CONTROL_SURFACE_PATTERN}
      ), entries as (
        select distinct on (session_id)
          session_id, visitor_id,
          coalesce(nullif(utm_source, ''), nullif(properties #>> '{first_touch,utm_source}', '')) as source,
          coalesce(nullif(utm_medium, ''), nullif(properties #>> '{first_touch,utm_medium}', '')) as medium,
          coalesce(nullif(utm_campaign, ''), nullif(properties #>> '{first_touch,utm_campaign}', '')) as campaign,
          coalesce(nullif(utm_content, ''), nullif(properties #>> '{first_touch,utm_content}', '')) as creative,
          coalesce(nullif(utm_term, ''), nullif(properties #>> '{first_touch,utm_term}', '')) as term,
          coalesce(nullif(fbclid, ''), nullif(properties #>> '{first_touch,fbclid}', '')) as fbclid
        from base order by session_id, client_timestamp asc
      ), rollup as (
        select session_id,
          bool_or(event_name = 'cta_impression') as cta_impression,
          bool_or(event_name = 'buy_button_click') as buy_click,
          bool_or(event_name = 'add_to_cart') as add_to_cart,
          bool_or(event_name = 'checkout_started') as checkout,
          bool_or(event_name = 'purchase') as purchase,
          count(*) as event_count
        from base group by session_id
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
      from entries e left join rollup r on r.session_id = e.session_id
      group by source, medium, campaign, creative, term
      order by purchase_visitors desc, checkout_visitors desc, unique_visitors desc
    `,
    sql`
      with base as (
        select * from public.analytics_events
        where received_at >= now() - (${days} * interval '1 day')
          and coalesce(properties ->> 'test', 'false') <> 'true'
          and coalesce(properties ->> 'internal_traffic', 'false') <> 'true'
          and page_url !~* ${CONTROL_SURFACE_PATTERN}
      ), entries as (
        select distinct on (session_id)
          session_id, visitor_id, client_timestamp as started_at,
          page_url as landing_page, referrer, device_type, screen_width, language,
          coalesce(nullif(utm_source, ''), nullif(properties #>> '{first_touch,utm_source}', '')) as source,
          coalesce(nullif(utm_medium, ''), nullif(properties #>> '{first_touch,utm_medium}', '')) as medium,
          coalesce(nullif(utm_campaign, ''), nullif(properties #>> '{first_touch,utm_campaign}', '')) as campaign,
          coalesce(nullif(utm_content, ''), nullif(properties #>> '{first_touch,utm_content}', '')) as creative,
          coalesce(nullif(fbclid, ''), nullif(properties #>> '{first_touch,fbclid}', '')) as fbclid,
          coalesce(nullif(properties ->> 'session_storage_version', '')::integer, 1) as session_storage_version,
          properties ->> 'session_started_at' as session_started_at
        from base order by session_id, client_timestamp asc
      ), rollup as (
        select session_id,
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
        from base group by session_id
      ), latest_page_summary as (
        select distinct on (
          session_id,
          coalesce(nullif(properties ->> 'page_instance_id', ''), session_id::text)
        )
          session_id,
          coalesce(nullif(properties ->> 'page_instance_id', ''), session_id::text) as page_instance_id,
          coalesce(nullif(properties ->> 'visible_seconds', '')::numeric, 0) as visible_seconds,
          coalesce(nullif(properties ->> 'duration_seconds', '')::numeric, 0) as duration_seconds,
          coalesce(nullif(properties ->> 'max_scroll_depth', '')::numeric, 0) as max_scroll_depth,
          coalesce(nullif(properties ->> 'sections_viewed', '')::numeric, 0) as sections_viewed,
          coalesce(nullif(properties ->> 'rage_click_count', '')::numeric, 0) as rage_click_count,
          coalesce(nullif(properties ->> 'dead_click_count', '')::numeric, 0) as dead_click_count,
          properties ->> 'quick_exit' as quick_exit
        from base where event_name = 'session_summary'
        order by session_id,
          coalesce(nullif(properties ->> 'page_instance_id', ''), session_id::text),
          client_timestamp desc
      ), summary_rollup as (
        select session_id,
          sum(visible_seconds) as visible_seconds,
          sum(duration_seconds) as duration_seconds,
          max(max_scroll_depth) as max_scroll_depth,
          sum(sections_viewed) as sections_viewed,
          sum(rage_click_count) as rage_click_count,
          sum(dead_click_count) as dead_click_count,
          bool_and(quick_exit = 'true') as all_pages_quick_exit
        from latest_page_summary group by session_id
      )
      select e.*, r.*, s.visible_seconds, s.duration_seconds, s.max_scroll_depth,
        s.sections_viewed, s.rage_click_count, s.dead_click_count, s.all_pages_quick_exit
      from entries e
      left join rollup r on r.session_id = e.session_id
      left join summary_rollup s on s.session_id = e.session_id
      order by e.started_at desc
      limit 5_000
    `,
    sql`
      select event_id, event_name, visitor_id, session_id as actual_session_id,
        client_timestamp, received_at, utm_source, utm_medium, utm_campaign,
        utm_content, fbclid,
        coalesce(properties ->> 'checkout_id', properties ->> 'checkout_token', properties #>> '{conversion_attribution,checkout_id}') as checkout_id,
        coalesce(properties ->> 'order_id', properties #>> '{conversion_attribution,order_id}') as order_id,
        properties #>> '{conversion_attribution,visitor_id}' as attributed_visitor_id,
        properties #>> '{conversion_attribution,session_id}' as attributed_session_id,
        properties #>> '{conversion_attribution,method}' as attribution_method,
        properties #>> '{conversion_attribution,confidence}' as attribution_confidence,
        properties #>> '{conversion_attribution,cross_session}' as cross_session,
        properties #>> '{conversion_attribution,identifier_source}' as identifier_source,
        properties #>> '{conversion_attribution,lookback_days}' as attribution_lookback_days,
        properties
      from public.analytics_events
      where received_at >= now() - (${days} * interval '1 day')
        and event_name in ('checkout_started', 'purchase')
        and coalesce(properties ->> 'test', 'false') <> 'true'
        and coalesce(properties ->> 'internal_traffic', 'false') <> 'true'
        and page_url !~* ${CONTROL_SURFACE_PATTERN}
      order by client_timestamp desc, received_at desc
      limit 5_000
    `,
    sql`
      with base as (
        select * from public.analytics_events
        where received_at >= now() - (${days} * interval '1 day')
          and coalesce(properties ->> 'test', 'false') <> 'true'
          and coalesce(properties ->> 'internal_traffic', 'false') <> 'true'
          and page_url !~* ${CONTROL_SURFACE_PATTERN}
      ), page_views as (select * from base where event_name = 'page_view'),
      summary_sessions as (
        select count(distinct session_id) as count from base where event_name = 'session_summary'
      )
      select
        count(*) as page_views,
        count(*) filter (where visitor_id is null) as missing_visitor_id,
        count(*) filter (where session_id is null) as missing_session_id,
        count(*) filter (where nullif(page_url, '') is null) as missing_page_url,
        count(*) filter (where nullif(device_type, '') is null) as missing_device_type,
        count(*) filter (
          where nullif(utm_campaign, '') is null
            and nullif(properties #>> '{first_touch,utm_campaign}', '') is null
        ) as missing_campaign,
        count(*) filter (
          where lower(coalesce(utm_source, properties #>> '{first_touch,utm_source}', '')) in ('facebook', 'fb', 'meta')
            and nullif(coalesce(fbclid, properties #>> '{first_touch,fbclid}'), '') is null
        ) as facebook_without_fbclid,
        count(*) filter (
          where coalesce(nullif(properties ->> 'session_storage_version', '')::integer, 1) >= 2
        ) as v2_page_views,
        count(*) filter (
          where coalesce(nullif(properties ->> 'session_storage_version', '')::integer, 1) >= 3
        ) as v3_page_views,
        (select count(*) from base where event_name = 'session_summary') as summaries,
        (select count from summary_sessions) as summary_sessions
      from page_views
    `,
    sql`
      select key, count(*) as occurrences
      from public.analytics_events e
      cross join lateral jsonb_object_keys(e.properties) as key
      where e.received_at >= now() - (${days} * interval '1 day')
        and coalesce(e.properties ->> 'test', 'false') <> 'true'
        and coalesce(e.properties ->> 'internal_traffic', 'false') <> 'true'
        and e.page_url !~* ${CONTROL_SURFACE_PATTERN}
      group by key order by occurrences desc, key asc
    `,
    sql`
      select date_trunc('day', client_timestamp) as day,
        count(*) as events,
        count(distinct visitor_id) as unique_visitors,
        count(distinct session_id) as sessions,
        count(*) filter (where event_name = 'page_view') as page_views,
        count(*) filter (where event_name = 'cta_impression') as cta_impressions,
        count(*) filter (where event_name = 'buy_button_click') as buy_clicks,
        count(*) filter (where event_name = 'checkout_started') as checkouts,
        count(*) filter (where event_name = 'purchase') as purchases,
        coalesce(sum(nullif(properties ->> 'value', '')::numeric) filter (where event_name = 'purchase'), 0) as revenue
      from public.analytics_events
      where received_at >= now() - (${days} * interval '1 day')
        and coalesce(properties ->> 'test', 'false') <> 'true'
        and coalesce(properties ->> 'internal_traffic', 'false') <> 'true'
        and page_url !~* ${CONTROL_SURFACE_PATTERN}
      group by date_trunc('day', client_timestamp) order by day asc
    `,
    sql`
      select page_path, page_title, count(*) as events,
        count(distinct visitor_id) as unique_visitors,
        count(distinct session_id) as sessions
      from public.analytics_events
      where received_at >= now() - (${days} * interval '1 day')
        and coalesce(properties ->> 'test', 'false') <> 'true'
        and coalesce(properties ->> 'internal_traffic', 'false') <> 'true'
        and page_url !~* ${CONTROL_SURFACE_PATTERN}
      group by page_path, page_title order by events desc limit 500
    `,
    sql`
      select coalesce(nullif(referrer, ''), 'Sem referrer') as referrer,
        count(*) as events,
        count(distinct visitor_id) as unique_visitors,
        count(distinct session_id) as sessions
      from public.analytics_events
      where received_at >= now() - (${days} * interval '1 day')
        and event_name = 'page_view'
        and coalesce(properties ->> 'test', 'false') <> 'true'
        and coalesce(properties ->> 'internal_traffic', 'false') <> 'true'
        and page_url !~* ${CONTROL_SURFACE_PATTERN}
      group by referrer order by sessions desc limit 500
    `,
    sql`
      select coalesce(device_type, 'unknown') as device_type, screen_width, language,
        properties ->> 'viewport_width' as viewport_width,
        properties ->> 'viewport_height' as viewport_height,
        properties ->> 'effective_connection_type' as effective_connection_type,
        properties ->> 'country' as country,
        count(*) as events,
        count(distinct visitor_id) as unique_visitors,
        count(distinct session_id) as sessions
      from public.analytics_events
      where received_at >= now() - (${days} * interval '1 day')
        and coalesce(properties ->> 'test', 'false') <> 'true'
        and coalesce(properties ->> 'internal_traffic', 'false') <> 'true'
        and page_url !~* ${CONTROL_SURFACE_PATTERN}
      group by device_type, screen_width, language,
        properties ->> 'viewport_width', properties ->> 'viewport_height',
        properties ->> 'effective_connection_type', properties ->> 'country'
      order by sessions desc, events desc
    `,
    sql`
      select item ->> 'product_id' as product_id,
        item ->> 'variant_id' as variant_id,
        item ->> 'product_title' as product_title,
        item ->> 'variant_title' as variant_title,
        count(*) as events,
        count(distinct e.visitor_id) as unique_visitors,
        count(distinct e.session_id) as sessions,
        coalesce(sum(nullif(item ->> 'quantity', '')::numeric), 0) as total_quantity,
        min(nullif(item ->> 'price', '')::numeric) as minimum_price,
        max(nullif(item ->> 'price', '')::numeric) as maximum_price
      from public.analytics_events e
      cross join lateral jsonb_array_elements(
        case when jsonb_typeof(e.properties -> 'line_items') = 'array'
          then e.properties -> 'line_items' else '[]'::jsonb end
      ) item
      where e.received_at >= now() - (${days} * interval '1 day')
        and coalesce(e.properties ->> 'test', 'false') <> 'true'
        and coalesce(e.properties ->> 'internal_traffic', 'false') <> 'true'
        and e.page_url !~* ${CONTROL_SURFACE_PATTERN}
      group by item ->> 'product_id', item ->> 'variant_id',
        item ->> 'product_title', item ->> 'variant_title'
      order by events desc
    `,
    sql`
      select properties ->> 'message' as message,
        properties ->> 'filename' as filename,
        properties ->> 'kind' as kind,
        count(*) as events,
        count(distinct visitor_id) as unique_visitors,
        count(distinct session_id) as sessions,
        min(client_timestamp) as first_seen_at,
        max(client_timestamp) as last_seen_at
      from public.analytics_events
      where received_at >= now() - (${days} * interval '1 day')
        and event_name = 'javascript_error'
        and coalesce(properties ->> 'test', 'false') <> 'true'
        and coalesce(properties ->> 'internal_traffic', 'false') <> 'true'
        and page_url !~* ${CONTROL_SURFACE_PATTERN}
      group by properties ->> 'message', properties ->> 'filename', properties ->> 'kind'
      order by events desc limit 500
    `,
    sql`
      select
        coalesce(properties ->> 'placement', 'unknown') as placement,
        coalesce(properties ->> 'product_id', 'unknown') as product_id,
        coalesce(utm_content, properties #>> '{first_touch,utm_content}', 'Não informado') as creative,
        count(*) filter (where event_name = 'cta_impression') as impressions,
        count(distinct visitor_id) filter (where event_name = 'cta_impression') as impression_visitors,
        count(*) filter (where event_name = 'buy_button_click') as clicks,
        count(distinct visitor_id) filter (where event_name = 'buy_button_click') as click_visitors,
        avg(nullif(properties ->> 'seconds_to_click', '')::numeric) filter (where event_name = 'buy_button_click') as avg_seconds_to_click,
        avg(nullif(properties ->> 'seconds_visible', '')::numeric) filter (where event_name = 'buy_button_click') as avg_visible_seconds_before_click
      from public.analytics_events
      where received_at >= now() - (${days} * interval '1 day')
        and event_name in ('cta_impression', 'buy_button_click')
        and coalesce(properties ->> 'test', 'false') <> 'true'
        and coalesce(properties ->> 'internal_traffic', 'false') <> 'true'
        and page_url !~* ${CONTROL_SURFACE_PATTERN}
      group by placement, product_id, creative
      order by click_visitors desc, impression_visitors desc
    `,
    sql`
      select
        coalesce(properties ->> 'section_key', properties ->> 'chapter', properties ->> 'section_id', 'unknown') as section_key,
        count(*) filter (where event_name = 'section_view') as views,
        count(distinct visitor_id) filter (where event_name = 'section_view') as view_visitors,
        count(*) filter (where event_name = 'section_engagement') as engagement_events,
        count(distinct visitor_id) filter (where event_name = 'section_engagement') as engaged_visitors,
        avg(nullif(properties ->> 'visible_ms', '')::numeric) filter (where event_name = 'section_engagement') as avg_visible_ms,
        sum(nullif(properties ->> 'visible_ms', '')::numeric) filter (where event_name = 'section_engagement') as total_visible_ms
      from public.analytics_events
      where received_at >= now() - (${days} * interval '1 day')
        and event_name in ('section_view', 'section_engagement')
        and coalesce(properties ->> 'test', 'false') <> 'true'
        and coalesce(properties ->> 'internal_traffic', 'false') <> 'true'
        and page_url !~* ${CONTROL_SURFACE_PATTERN}
      group by section_key order by view_visitors desc, total_visible_ms desc nulls last
    `,
    sql`
      select
        count(*) as samples,
        count(distinct visitor_id) as unique_visitors,
        avg(nullif(properties ->> 'ttfb_ms', '')::numeric) as avg_ttfb_ms,
        percentile_cont(0.5) within group (order by nullif(properties ->> 'ttfb_ms', '')::numeric) as p50_ttfb_ms,
        percentile_cont(0.75) within group (order by nullif(properties ->> 'lcp_ms', '')::numeric) as p75_lcp_ms,
        percentile_cont(0.75) within group (order by nullif(properties ->> 'inp_ms', '')::numeric) as p75_inp_ms,
        percentile_cont(0.75) within group (order by nullif(properties ->> 'cls', '')::numeric) as p75_cls,
        avg(nullif(properties ->> 'load_ms', '')::numeric) as avg_load_ms
      from public.analytics_events
      where received_at >= now() - (${days} * interval '1 day')
        and event_name in ('page_performance', 'session_summary')
        and coalesce(properties ->> 'test', 'false') <> 'true'
        and coalesce(properties ->> 'internal_traffic', 'false') <> 'true'
        and page_url !~* ${CONTROL_SURFACE_PATTERN}
    `,
    sql`
      select coalesce(properties ->> 'anomaly_type', 'unknown') as anomaly_type,
        properties ->> 'element_tag' as element_tag,
        properties ->> 'element_text' as element_text,
        count(*) as events,
        count(distinct visitor_id) as unique_visitors,
        count(distinct session_id) as sessions
      from public.analytics_events
      where received_at >= now() - (${days} * interval '1 day')
        and event_name = 'interaction_anomaly'
        and coalesce(properties ->> 'test', 'false') <> 'true'
        and coalesce(properties ->> 'internal_traffic', 'false') <> 'true'
        and page_url !~* ${CONTROL_SURFACE_PATTERN}
      group by anomaly_type, element_tag, element_text
      order by events desc limit 500
    `,
    sql`
      with base as (
        select * from public.analytics_events
        where received_at >= now() - (${days} * interval '1 day')
          and coalesce(properties ->> 'test', 'false') <> 'true'
          and coalesce(properties ->> 'internal_traffic', 'false') <> 'true'
          and page_url !~* ${CONTROL_SURFACE_PATTERN}
      ), page_visitors as (
        select distinct visitor_id from base where event_name = 'page_view'
      ), checkout_visitors as (
        select distinct visitor_id from base where event_name = 'checkout_started'
      )
      select
        (select count(*) from page_visitors) as page_view_visitors,
        (select count(*) from checkout_visitors) as checkout_visitors,
        count(*) filter (where p.visitor_id is not null) as checkout_visitors_with_page_view,
        count(*) filter (where p.visitor_id is null) as orphan_checkout_visitors,
        (select count(*) from base where event_name in ('checkout_started', 'purchase')
          and nullif(properties #>> '{conversion_attribution,session_id}', '') is not null) as conversions_with_resolved_attribution,
        (select count(*) from base where event_name in ('checkout_started', 'purchase')) as conversion_events
      from checkout_visitors c left join page_visitors p on p.visitor_id = c.visitor_id
    `,
    sql`
      with base as (
        select * from public.analytics_events
        where received_at >= now() - (${days} * interval '1 day')
          and coalesce(properties ->> 'test', 'false') <> 'true'
          and coalesce(properties ->> 'internal_traffic', 'false') <> 'true'
          and page_url !~* ${CONTROL_SURFACE_PATTERN}
      ), visitor_times as (
        select visitor_id,
          min(client_timestamp) filter (where event_name = 'page_view') as first_page_view,
          min(client_timestamp) filter (where event_name = 'cta_impression') as first_cta_impression,
          min(client_timestamp) filter (where event_name = 'buy_button_click') as first_buy_click,
          min(client_timestamp) filter (where event_name = 'checkout_started') as first_checkout,
          min(client_timestamp) filter (where event_name = 'purchase') as first_purchase
        from base group by visitor_id
      )
      select
        count(*) filter (where first_page_view is not null) as visitors_with_page_view,
        count(*) filter (where first_checkout is not null) as visitors_with_checkout,
        count(*) filter (where first_purchase is not null) as visitors_with_purchase,
        avg(extract(epoch from (first_cta_impression - first_page_view))) filter (
          where first_cta_impression >= first_page_view
        ) as avg_seconds_page_to_cta,
        avg(extract(epoch from (first_buy_click - first_cta_impression))) filter (
          where first_buy_click >= first_cta_impression
        ) as avg_seconds_cta_to_click,
        avg(extract(epoch from (first_checkout - first_page_view))) filter (
          where first_checkout >= first_page_view
        ) as avg_seconds_page_to_checkout,
        avg(extract(epoch from (first_purchase - first_checkout))) filter (
          where first_purchase >= first_checkout
        ) as avg_seconds_checkout_to_purchase
      from visitor_times
    `,
    sql`
      with base as (
        select * from public.analytics_events
        where received_at >= now() - (${days} * interval '1 day')
          and coalesce(properties ->> 'test', 'false') <> 'true'
          and coalesce(properties ->> 'internal_traffic', 'false') <> 'true'
          and page_url !~* ${CONTROL_SURFACE_PATTERN}
      ), first_touch as (
        select visitor_id, min(client_timestamp) as first_page_view
        from base where event_name = 'page_view' group by visitor_id
      )
      select date_trunc('day', f.first_page_view) as cohort_day,
        count(*) as visitors,
        count(*) filter (where exists (
          select 1 from base b where b.visitor_id = f.visitor_id
            and b.event_name = 'checkout_started'
            and b.client_timestamp between f.first_page_view and f.first_page_view + interval '1 day'
        )) as checkout_within_1d,
        count(*) filter (where exists (
          select 1 from base b where b.visitor_id = f.visitor_id
            and b.event_name = 'checkout_started'
            and b.client_timestamp between f.first_page_view and f.first_page_view + interval '7 day'
        )) as checkout_within_7d,
        count(*) filter (where exists (
          select 1 from base b where b.visitor_id = f.visitor_id
            and b.event_name = 'purchase'
            and b.client_timestamp between f.first_page_view and f.first_page_view + interval '7 day'
        )) as purchase_within_7d,
        count(*) filter (where exists (
          select 1 from base b where b.visitor_id = f.visitor_id
            and b.event_name = 'purchase'
            and b.client_timestamp between f.first_page_view and f.first_page_view + interval '30 day'
        )) as purchase_within_30d
      from first_touch f group by cohort_day order by cohort_day asc
    `,
    sql`
      select
        coalesce(properties ->> 'concept', 'Não informado') as concept,
        coalesce(properties ->> 'hook', 'Não informado') as hook,
        coalesce(properties ->> 'sales_message', 'Não informado') as sales_message,
        coalesce(properties ->> 'format', 'Não informado') as format,
        coalesce(properties ->> 'angle', 'Não informado') as angle,
        coalesce(properties ->> 'awareness_level', 'Não informado') as awareness_level,
        coalesce(properties ->> 'landing_version', 'Não informado') as landing_version,
        coalesce(properties ->> 'offer_version', 'Não informado') as offer_version,
        count(*) as events,
        count(distinct visitor_id) as unique_visitors,
        count(distinct session_id) as sessions,
        count(distinct visitor_id) filter (where event_name = 'checkout_started') as checkout_visitors,
        count(distinct visitor_id) filter (where event_name = 'purchase') as purchase_visitors
      from public.analytics_events
      where received_at >= now() - (${days} * interval '1 day')
        and coalesce(properties ->> 'test', 'false') <> 'true'
        and coalesce(properties ->> 'internal_traffic', 'false') <> 'true'
        and page_url !~* ${CONTROL_SURFACE_PATTERN}
        and (
          properties ? 'concept' or properties ? 'hook' or properties ? 'sales_message'
          or properties ? 'format' or properties ? 'angle' or properties ? 'awareness_level'
          or properties ? 'landing_version' or properties ? 'offer_version'
        )
      group by concept, hook, sales_message, format, angle, awareness_level,
        landing_version, offer_version
      order by purchase_visitors desc, checkout_visitors desc, unique_visitors desc
    `,
    sql`
      select count(*) as rows,
        min(date_start) as first_date,
        max(date_start) as latest_date,
        count(distinct account_id) as accounts,
        count(distinct campaign_id) as campaigns,
        count(distinct adset_id) as adsets,
        count(distinct ad_id) as ads,
        coalesce(sum(spend), 0) as spend,
        coalesce(sum(impressions), 0) as impressions,
        coalesce(sum(reach), 0) as reach,
        coalesce(sum(clicks), 0) as clicks,
        coalesce(sum(landing_page_views), 0) as landing_page_views,
        coalesce(sum(purchases), 0) as purchases,
        coalesce(sum(purchase_value), 0) as purchase_value
      from public.meta_ads_daily
      where date_start >= current_date - ${days}
    `,
    sql`
      select campaign_id, campaign_name,
        count(distinct adset_id) as adsets,
        count(distinct ad_id) as ads,
        coalesce(sum(spend), 0) as spend,
        coalesce(sum(impressions), 0) as impressions,
        coalesce(sum(reach), 0) as reach,
        coalesce(sum(clicks), 0) as clicks,
        coalesce(sum(unique_clicks), 0) as unique_clicks,
        coalesce(sum(landing_page_views), 0) as landing_page_views,
        coalesce(sum(add_to_cart), 0) as add_to_cart,
        coalesce(sum(initiate_checkout), 0) as initiate_checkout,
        coalesce(sum(purchases), 0) as purchases,
        coalesce(sum(purchase_value), 0) as purchase_value,
        max(currency) as currency,
        max(ingested_at) as latest_ingested_at
      from public.meta_ads_daily
      where date_start >= current_date - ${days}
      group by campaign_id, campaign_name
      order by spend desc, impressions desc
    `,
    sql`
      select date_start, account_id, campaign_id, campaign_name,
        adset_id, adset_name, ad_id, ad_name, creative_id,
        spend, impressions, reach, frequency, clicks, unique_clicks,
        landing_page_views, add_to_cart, initiate_checkout,
        purchases, purchase_value, currency, actions, ingested_at
      from public.meta_ads_daily
      where date_start >= current_date - ${days}
      order by date_start asc, spend desc
      limit 20_000
    `,
    sql`
      select event_id, event_name, visitor_id, session_id,
        client_timestamp, received_at, page_url, page_path, page_title,
        referrer, utm_source, utm_medium, utm_campaign, utm_content,
        utm_term, fbclid, device_type, screen_width, language, properties
      from public.analytics_events
      where received_at >= now() - (${days} * interval '1 day')
        and coalesce(properties ->> 'test', 'false') <> 'true'
        and coalesce(properties ->> 'internal_traffic', 'false') <> 'true'
        and page_url !~* ${CONTROL_SURFACE_PATTERN}
      order by client_timestamp asc, received_at asc
      limit ${rawLimit}
    `,
  ]);

  const exclusionAudit = sanitizeValue(firstRow(exclusionAuditResult)) as Row;
  const overview = sanitizeValue(firstRow(overviewResult)) as Row;
  const funnel = sanitizeValue(firstRow(funnelResult)) as Row;
  const quality = sanitizeValue(firstRow(qualityResult)) as Row;
  const identity = sanitizeValue(firstRow(identityResult)) as Row;
  const conversions = sanitizedRows(conversionsResult);
  const rawEvents = sanitizedRows(rawEventsResult);
  const metaOverview = sanitizeValue(firstRow(metaOverviewResult)) as Row;
  const metaCampaigns = sanitizedRows(metaCampaignResult).map(metaMetrics);
  const metaDaily = sanitizedRows(metaDailyResult).map(metaMetrics);

  const totalEvents = numberValue(overview.total_events);
  const sessions = numberValue(overview.sessions);
  const uniqueVisitors = numberValue(overview.unique_visitors);
  const v2Sessions = numberValue(overview.session_v2_sessions);
  const v3Sessions = numberValue(overview.session_v3_sessions);
  const pageViews = numberValue(funnel.page_view_visitors);
  const ctaVisitors = numberValue(funnel.cta_impression_visitors);
  const clickVisitors = numberValue(funnel.buy_click_visitors);
  const checkoutVisitors = numberValue(funnel.checkout_visitors);
  const purchaseVisitors = numberValue(funnel.purchase_visitors);
  const summarySessions = numberValue(quality.summary_sessions);
  const conversionEvents = numberValue(identity.conversion_events);
  const resolvedConversions = numberValue(
    identity.conversions_with_resolved_attribution,
  );
  const metaRows = numberValue(metaOverview.rows);

  const resolvedEvents = conversions.filter(
    (event) => event.attributed_session_id !== null && event.attributed_session_id !== undefined,
  ).length;
  const crossSessionEvents = conversions.filter(
    (event) => event.cross_session === true || event.cross_session === "true",
  ).length;

  const sampleScore = scoreFromRatio(Math.min(1, uniqueVisitors / 100));
  const v3Score = scoreFromRatio(safeDivide(v3Sessions, sessions) ?? 0);
  const summaryScore = scoreFromRatio(safeDivide(summarySessions, sessions) ?? 0);
  const attributionScore = scoreFromRatio(
    safeDivide(resolvedConversions, conversionEvents) ?? 0,
  );
  const behaviorCoverage = scoreFromRatio(
    Math.max(
      safeDivide(ctaVisitors, pageViews) ?? 0,
      safeDivide(summarySessions, sessions) ?? 0,
    ),
  );
  const metaScore = metaRows > 0 ? 100 : 0;
  const overallReadiness = Math.round(
    sampleScore * 0.15 +
      v3Score * 0.2 +
      summaryScore * 0.2 +
      attributionScore * 0.25 +
      behaviorCoverage * 0.1 +
      metaScore * 0.1,
  );

  return sanitizeValue({
    schema: "private_conversion_intelligence_export_v1_2",
    generated_at: new Date().toISOString(),
    analysis_request:
      "Analise este dossiê como cientista de dados, especialista em mensuração e estrategista de direct response. Audite o tracking antes do marketing, use visitantes únicos como unidade principal, preserve a distinção entre sessão real e sessão atribuída, não trate correlação como causalidade, reporte incerteza estatística e recomende somente o próximo teste incremental de maior valor.",
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
      exclusion_audit: exclusionAudit,
      exclusion_counts_can_overlap: true,
      sensitive_fields_hashed: Array.from(SENSITIVE_KEYS),
      checkout_and_cart_paths_hashed: true,
      timezone: "timestamps_preserved_as_stored",
    },
    definitions: {
      visitor: "visitor_id anônimo persistido no navegador",
      session: "session_id persistido por inatividade; tracker v3 mantém contexto entre abas",
      page_instance: "carregamento individual de uma página dentro de uma sessão",
      attributed_session:
        "sessão comercial recuperada para checkout ou compra sem sobrescrever a sessão real",
      meta_ads_daily:
        "snapshot diário opcional de mídia paga, armazenado separadamente de eventos comportamentais",
      raw_events:
        "eventos externos completos com URLs e identificadores sensíveis sanitizados",
    },
    overview: {
      ...overview,
      session_v2_coverage_percent:
        sessions > 0 ? Number(((v2Sessions / sessions) * 100).toFixed(2)) : 0,
      session_v3_coverage_percent:
        sessions > 0 ? Number(((v3Sessions / sessions) * 100).toFixed(2)) : 0,
      sessions_per_visitor:
        uniqueVisitors > 0 ? Number((sessions / uniqueVisitors).toFixed(4)) : 0,
    },
    data_readiness: {
      overall_score: overallReadiness,
      sample_score: sampleScore,
      session_v3_score: v3Score,
      summary_coverage_score: summaryScore,
      attribution_score: attributionScore,
      behavior_coverage_score: behaviorCoverage,
      meta_ads_score: metaScore,
      sample_label:
        uniqueVisitors < 20
          ? "exploratory_only"
          : uniqueVisitors < 100
            ? "directional"
            : "stronger_directional",
      blockers: [
        ...(uniqueVisitors < 20 ? ["Amostra menor que 20 visitantes únicos."] : []),
        ...(v3Sessions < sessions ? ["Nem todas as sessões usam tracker v3."] : []),
        ...(summarySessions < sessions ? ["Cobertura incompleta de session_summary."] : []),
        ...(resolvedConversions < conversionEvents
          ? ["Existem conversões sem sessão comercial resolvida."]
          : []),
        ...(metaRows === 0 ? ["Custos e impressões do Meta Ads ainda não foram ingeridos."] : []),
        ...(purchaseVisitors === 0 ? ["Nenhuma purchase externa foi registrada."] : []),
      ],
    },
    funnel_by_unique_visitor: funnel,
    funnel_confidence_95: {
      page_view_to_cta_impression: wilsonInterval(ctaVisitors, pageViews),
      cta_impression_to_buy_click: wilsonInterval(clickVisitors, ctaVisitors),
      buy_click_to_checkout: wilsonInterval(checkoutVisitors, clickVisitors),
      checkout_to_purchase: wilsonInterval(purchaseVisitors, checkoutVisitors),
      page_view_to_checkout: wilsonInterval(checkoutVisitors, pageViews),
      page_view_to_purchase: wilsonInterval(purchaseVisitors, pageViews),
    },
    identity_continuity: {
      ...identity,
      checkout_identity_match_rate: safeDivide(
        numberValue(identity.checkout_visitors_with_page_view),
        numberValue(identity.checkout_visitors),
      ),
      attribution_resolution_rate: safeDivide(resolvedConversions, conversionEvents),
      warning:
        numberValue(identity.orphan_checkout_visitors) > 0
          ? "Há checkouts cujo visitor_id não aparece em page_view; não calcule conversão landing→checkout sem corrigir continuidade de identidade."
          : null,
    },
    time_to_conversion: sanitizeValue(firstRow(timeToConversionResult)),
    visitor_cohorts: sanitizedRows(cohortsResult),
    event_catalog: sanitizedRows(eventCatalogResult),
    campaigns_and_creatives: sanitizedRows(campaignsResult),
    creative_taxonomy: sanitizedRows(creativeTaxonomyResult),
    cta_placement_performance: sanitizedRows(ctaResult).map((row) => ({
      ...row,
      impression_to_click_rate: safeDivide(
        numberValue(row.click_visitors),
        numberValue(row.impression_visitors),
      ),
    })),
    section_engagement: sanitizedRows(sectionsResult),
    page_performance: sanitizeValue(firstRow(performanceResult)),
    interaction_anomalies: sanitizedRows(anomaliesResult),
    session_journeys: sanitizedRows(sessionsResult),
    conversion_attribution: {
      resolution_order: [
        "explicit_ct_session_id",
        "page_url_ct_session_id",
        "checkout_id",
        "order_id",
        "visitor_latest_attributed_session_within_30_days",
        "same_session",
      ],
      resolved_events: resolvedEvents,
      unresolved_events: Math.max(0, conversions.length - resolvedEvents),
      cross_session_events: crossSessionEvents,
      events: conversions,
      warning:
        "Fallback por último acesso atribuído é evidência de confiança média; IDs explícitos ou checkout_id são preferíveis.",
    },
    data_quality: {
      ...quality,
      summary_session_coverage_percent:
        sessions > 0 ? Number(((summarySessions / sessions) * 100).toFixed(2)) : 0,
      session_v2_page_view_coverage_percent:
        numberValue(quality.page_views) > 0
          ? Number(
              ((numberValue(quality.v2_page_views) / numberValue(quality.page_views)) * 100).toFixed(2),
            )
          : 0,
      session_v3_page_view_coverage_percent:
        numberValue(quality.page_views) > 0
          ? Number(
              ((numberValue(quality.v3_page_views) / numberValue(quality.page_views)) * 100).toFixed(2),
            )
          : 0,
    },
    observed_property_keys: sanitizedRows(propertyKeysResult),
    daily_time_series: sanitizedRows(dailyResult),
    pages: sanitizedRows(pagesResult),
    referrers: sanitizedRows(referrersResult),
    devices_network_and_geography: sanitizedRows(devicesResult),
    products_and_variants: sanitizedRows(productsResult),
    javascript_errors: sanitizedRows(javascriptErrorsResult),
    meta_ads: {
      configured_for_ingestion: Boolean(process.env.META_INGEST_SECRET?.trim()),
      has_data: metaRows > 0,
      overview: metaMetrics(metaOverview),
      campaigns: metaCampaigns,
      daily_ad_rows: metaDaily,
      ingestion_contract: {
        endpoint: "/api/meta-ingest",
        authentication: "Bearer META_INGEST_SECRET",
        required_fields: ["date_start", "campaign_id", "ad_id"],
      },
    },
    business_context: {
      currency: process.env.BUSINESS_CURRENCY ?? "BRL",
      average_order_value: numberValue(process.env.BUSINESS_AOV) || null,
      product_cost: numberValue(process.env.BUSINESS_PRODUCT_COST) || null,
      target_cac: numberValue(process.env.BUSINESS_TARGET_CAC) || null,
      note:
        "Configure BUSINESS_AOV, BUSINESS_PRODUCT_COST e BUSINESS_TARGET_CAC na Vercel para análises econômicas completas.",
    },
    raw_events: rawEvents,
    interpretation_guardrails: [
      "Não trate sessões como pessoas.",
      "Não calcule taxa entre etapas quando o numerador excede o denominador; isso indica quebra de identidade.",
      "Não declare criativo vencedor com amostra pequena, concentrada ou sem custo da plataforma.",
      "Intervalos de confiança largos significam que o resultado é inconclusivo.",
      "Scroll, tempo e seção visualizada são sinais comportamentais, não prova de intenção causal.",
      "Core Web Vitals exigem amostra suficiente e devem ser segmentados por dispositivo e rede.",
      "Eventos históricos anteriores ao tracker v3 não devem ser comparados diretamente sem controlar cobertura.",
      "Dados do Meta Ads e eventos first-party possuem modelos de atribuição diferentes.",
      "Escolha uma única variável para o próximo teste incremental.",
    ],
  }) as Row;
}
