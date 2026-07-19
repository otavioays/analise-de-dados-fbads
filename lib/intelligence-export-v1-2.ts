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
type SqlClient = ReturnType<typeof getSql>;
type QueryHealth = {
  name: string;
  ok: boolean;
  rows: number;
  error: null | { name: string; message: string };
};
type QueryResult = { rows: Row[]; health: QueryHealth };

function integerParam(value: string | null, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : fallback;
}

function numberValue(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeRows(value: unknown): Row[] {
  return Array.isArray(value) ? (value as Row[]) : [];
}

function firstRow(value: unknown): Row {
  return normalizeRows(value)[0] ?? {};
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
    const preserved = new Set([
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_content",
      "utm_term",
      "ref",
    ]);

    for (const [key, raw] of url.searchParams.entries()) {
      if (preserved.has(key)) output.searchParams.set(key, raw.slice(0, 255));
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
  if (depth > 10) return "[depth-limited]";
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return value.toISOString();
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

function sanitizedRows(value: unknown): Row[] {
  return normalizeRows(value).map((row) => sanitizeValue(row) as Row);
}

function errorSummary(error: unknown): { name: string; message: string } {
  if (error instanceof Error) {
    return { name: error.name, message: error.message.slice(0, 1_000) };
  }
  return { name: "UnknownError", message: String(error).slice(0, 1_000) };
}

async function safeQuery(name: string, query: Promise<unknown>): Promise<QueryResult> {
  try {
    const rows = normalizeRows(await query);
    return { rows, health: { name, ok: true, rows: rows.length, error: null } };
  } catch (error) {
    return {
      rows: [],
      health: { name, ok: false, rows: 0, error: errorSummary(error) },
    };
  }
}

function safeDivide(numerator: number, denominator: number): number | null {
  return denominator > 0 ? Number((numerator / denominator).toFixed(6)) : null;
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
          ? "Numerator exceeds denominator, indicating identity fragmentation or incompatible units."
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

function numericJsonExpression(key: string): string {
  return `case when nullif(properties ->> '${key}', '') ~ '^-?[0-9]+(?:\\.[0-9]+)?$' then (properties ->> '${key}')::numeric end`;
}

export async function buildPrivateIntelligenceExport(request: NextRequest): Promise<Row> {
  const requestedDays = integerParam(request.nextUrl.searchParams.get("days"), DEFAULT_DAYS);
  const days = ALLOWED_DAYS.has(requestedDays) ? requestedDays : DEFAULT_DAYS;
  const requestedLimit = integerParam(
    request.nextUrl.searchParams.get("raw_limit"),
    DEFAULT_RAW_LIMIT,
  );
  const rawLimit = Math.max(100, Math.min(MAX_RAW_LIMIT, requestedLimit));
  const sql = getSql();
  const queryHealth: QueryHealth[] = [];

  try {
    await ensureMetaAdsTable(sql);
    queryHealth.push({ name: "ensure_meta_ads_table", ok: true, rows: 0, error: null });
  } catch (error) {
    queryHealth.push({
      name: "ensure_meta_ads_table",
      ok: false,
      rows: 0,
      error: errorSummary(error),
    });
  }

  const results = await Promise.all([
    safeQuery(
      "exclusion_audit",
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
    ),
    safeQuery(
      "overview",
      sql`
        with base as (
          select * from public.analytics_events
          where received_at >= now() - (${days} * interval '1 day')
            and coalesce(properties ->> 'test', 'false') <> 'true'
            and coalesce(properties ->> 'internal_traffic', 'false') <> 'true'
            and page_url !~* ${CONTROL_SURFACE_PATTERN}
        ), session_versions as (
          select session_id,
            max(coalesce(nullif(properties ->> 'session_storage_version', '')::integer, 1)) as version
          from base group by session_id
        )
        select
          count(*) as total_events,
          count(distinct session_id) as sessions,
          count(distinct visitor_id) as unique_visitors,
          min(client_timestamp) as first_event_at,
          max(client_timestamp) as latest_event_at,
          count(*) filter (where event_name = 'page_view') as page_views,
          count(*) filter (where event_name = 'cta_impression') as cta_impressions,
          count(*) filter (where event_name = 'buy_button_click') as buy_clicks,
          count(*) filter (where event_name = 'add_to_cart') as add_to_cart,
          count(*) filter (where event_name = 'checkout_started') as checkouts,
          count(*) filter (where event_name = 'purchase') as purchases,
          (select count(*) from session_versions where version >= 2) as session_v2_sessions,
          (select count(*) from session_versions where version >= 3) as session_v3_sessions
        from base
      `,
    ),
    safeQuery(
      "funnel_unique_visitors",
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
    ),
    safeQuery(
      "event_catalog",
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
        group by event_name order by events desc, event_name asc
      `,
    ),
    safeQuery(
      "campaigns",
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
            coalesce(nullif(utm_term, ''), nullif(properties #>> '{first_touch,utm_term}', '')) as term
          from base order by session_id, client_timestamp asc
        ), rollup as (
          select session_id,
            bool_or(event_name = 'cta_impression') as cta_impression,
            bool_or(event_name = 'buy_button_click') as buy_click,
            bool_or(event_name = 'checkout_started') as checkout,
            bool_or(event_name = 'purchase') as purchase,
            count(*) as events
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
          count(distinct visitor_id) filter (where coalesce(r.cta_impression, false)) as cta_impression_visitors,
          count(distinct visitor_id) filter (where coalesce(r.buy_click, false)) as buy_click_visitors,
          count(distinct visitor_id) filter (where coalesce(r.checkout, false)) as checkout_visitors,
          count(distinct visitor_id) filter (where coalesce(r.purchase, false)) as purchase_visitors,
          coalesce(sum(r.events), 0) as total_events
        from entries e left join rollup r on r.session_id = e.session_id
        group by source, medium, campaign, creative, term
        order by purchase_visitors desc, checkout_visitors desc, unique_visitors desc
      `,
    ),
    safeQuery(
      "sessions",
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
            coalesce(nullif(properties ->> 'session_storage_version', '')::integer, 1) as session_storage_version
          from base order by session_id, client_timestamp asc
        ), rollup as (
          select session_id,
            min(client_timestamp) as first_event_at,
            max(client_timestamp) as last_event_at,
            count(*) as event_count,
            array_agg(distinct event_name order by event_name) as event_names,
            bool_or(event_name = 'cta_impression') as cta_impression,
            bool_or(event_name = 'buy_button_click') as buy_click,
            bool_or(event_name = 'checkout_started') as checkout,
            bool_or(event_name = 'purchase') as purchase,
            count(*) filter (where event_name = 'javascript_error') as javascript_errors,
            count(*) filter (where event_name = 'session_summary') as summaries,
            max(case when event_name = 'session_summary' then nullif(properties ->> 'visible_seconds', '')::numeric end) as visible_seconds,
            max(case when event_name = 'session_summary' then nullif(properties ->> 'max_scroll_depth', '')::numeric end) as max_scroll_depth,
            max(case when event_name = 'session_summary' then nullif(properties ->> 'sections_viewed', '')::numeric end) as sections_viewed
          from base group by session_id
        )
        select e.*, r.* from entries e
        left join rollup r on r.session_id = e.session_id
        order by e.started_at desc limit 5_000
      `,
    ),
    safeQuery(
      "conversion_attribution",
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
          properties
        from public.analytics_events
        where received_at >= now() - (${days} * interval '1 day')
          and event_name in ('checkout_started', 'purchase')
          and coalesce(properties ->> 'test', 'false') <> 'true'
          and coalesce(properties ->> 'internal_traffic', 'false') <> 'true'
          and page_url !~* ${CONTROL_SURFACE_PATTERN}
        order by client_timestamp desc, received_at desc limit 5_000
      `,
    ),
    safeQuery(
      "daily_series",
      sql`
        select date_trunc('day', client_timestamp) as day,
          count(*) as events,
          count(distinct visitor_id) as unique_visitors,
          count(distinct session_id) as sessions,
          count(*) filter (where event_name = 'page_view') as page_views,
          count(*) filter (where event_name = 'cta_impression') as cta_impressions,
          count(*) filter (where event_name = 'buy_button_click') as buy_clicks,
          count(*) filter (where event_name = 'checkout_started') as checkouts,
          count(*) filter (where event_name = 'purchase') as purchases
        from public.analytics_events
        where received_at >= now() - (${days} * interval '1 day')
          and coalesce(properties ->> 'test', 'false') <> 'true'
          and coalesce(properties ->> 'internal_traffic', 'false') <> 'true'
          and page_url !~* ${CONTROL_SURFACE_PATTERN}
        group by day order by day asc
      `,
    ),
    safeQuery(
      "pages",
      sql`
        select page_url, page_path, page_title,
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
        group by page_url, page_path, page_title
        order by unique_visitors desc, events desc limit 2_000
      `,
    ),
    safeQuery(
      "devices",
      sql`
        select coalesce(device_type, 'unknown') as device_type,
          screen_width, language,
          count(*) as events,
          count(distinct visitor_id) as unique_visitors,
          count(distinct session_id) as sessions,
          count(*) filter (where event_name = 'checkout_started') as checkouts,
          count(*) filter (where event_name = 'purchase') as purchases
        from public.analytics_events
        where received_at >= now() - (${days} * interval '1 day')
          and coalesce(properties ->> 'test', 'false') <> 'true'
          and coalesce(properties ->> 'internal_traffic', 'false') <> 'true'
          and page_url !~* ${CONTROL_SURFACE_PATTERN}
        group by device_type, screen_width, language
        order by unique_visitors desc, events desc limit 2_000
      `,
    ),
    safeQuery(
      "products",
      sql`
        select
          coalesce(properties ->> 'product_id', properties #>> '{line_items,0,product_id}', 'unknown') as product_id,
          coalesce(properties ->> 'variant_id', properties #>> '{line_items,0,variant_id}', 'unknown') as variant_id,
          coalesce(properties ->> 'product_name', properties #>> '{line_items,0,product_title}', 'unknown') as product_name,
          coalesce(properties ->> 'currency', 'unknown') as currency,
          count(*) as events,
          count(distinct visitor_id) as unique_visitors,
          count(*) filter (where event_name = 'checkout_started') as checkouts,
          count(*) filter (where event_name = 'purchase') as purchases,
          avg(case when nullif(properties ->> 'value', '') ~ '^-?[0-9]+(?:\\.[0-9]+)?$' then (properties ->> 'value')::numeric end) as avg_value
        from public.analytics_events
        where received_at >= now() - (${days} * interval '1 day')
          and event_name in ('cta_impression', 'buy_button_click', 'add_to_cart', 'checkout_started', 'purchase')
          and coalesce(properties ->> 'test', 'false') <> 'true'
          and coalesce(properties ->> 'internal_traffic', 'false') <> 'true'
          and page_url !~* ${CONTROL_SURFACE_PATTERN}
        group by product_id, variant_id, product_name, currency
        order by purchases desc, checkouts desc, unique_visitors desc
      `,
    ),
    safeQuery(
      "cta_performance",
      sql`
        select coalesce(properties ->> 'placement', 'unknown') as placement,
          coalesce(properties ->> 'element_text', 'unknown') as element_text,
          count(*) filter (where event_name = 'cta_impression') as impressions,
          count(distinct visitor_id) filter (where event_name = 'cta_impression') as impression_visitors,
          count(*) filter (where event_name in ('buy_button_click', 'cta_click_context')) as clicks,
          count(distinct visitor_id) filter (where event_name in ('buy_button_click', 'cta_click_context')) as click_visitors,
          avg(case when nullif(properties ->> 'visible_ms_before_impression', '') ~ '^-?[0-9]+(?:\\.[0-9]+)?$' then (properties ->> 'visible_ms_before_impression')::numeric end) as avg_visible_ms_before_impression
        from public.analytics_events
        where received_at >= now() - (${days} * interval '1 day')
          and event_name in ('cta_impression', 'buy_button_click', 'cta_click_context')
          and coalesce(properties ->> 'test', 'false') <> 'true'
          and coalesce(properties ->> 'internal_traffic', 'false') <> 'true'
          and page_url !~* ${CONTROL_SURFACE_PATTERN}
        group by placement, element_text
        order by click_visitors desc, impression_visitors desc
      `,
    ),
    safeQuery(
      "sections",
      sql`
        select
          coalesce(properties ->> 'section_key', properties ->> 'chapter', properties ->> 'section_id', 'unknown') as section_key,
          count(*) filter (where event_name = 'section_view') as views,
          count(distinct visitor_id) filter (where event_name = 'section_view') as view_visitors,
          count(*) filter (where event_name = 'section_engagement') as engagement_events,
          count(distinct visitor_id) filter (where event_name = 'section_engagement') as engaged_visitors,
          avg(case when nullif(properties ->> 'visible_ms', '') ~ '^-?[0-9]+(?:\\.[0-9]+)?$' then (properties ->> 'visible_ms')::numeric end) as avg_visible_ms,
          sum(case when nullif(properties ->> 'visible_ms', '') ~ '^-?[0-9]+(?:\\.[0-9]+)?$' then (properties ->> 'visible_ms')::numeric end) as total_visible_ms
        from public.analytics_events
        where received_at >= now() - (${days} * interval '1 day')
          and event_name in ('section_view', 'section_engagement')
          and coalesce(properties ->> 'test', 'false') <> 'true'
          and coalesce(properties ->> 'internal_traffic', 'false') <> 'true'
          and page_url !~* ${CONTROL_SURFACE_PATTERN}
        group by section_key order by view_visitors desc, total_visible_ms desc nulls last
      `,
    ),
    safeQuery(
      "performance",
      sql`
        select
          count(*) as samples,
          count(distinct visitor_id) as unique_visitors,
          avg(case when nullif(properties ->> 'ttfb_ms', '') ~ '^-?[0-9]+(?:\\.[0-9]+)?$' then (properties ->> 'ttfb_ms')::numeric end) as avg_ttfb_ms,
          percentile_cont(0.75) within group (order by case when nullif(properties ->> 'lcp_ms', '') ~ '^-?[0-9]+(?:\\.[0-9]+)?$' then (properties ->> 'lcp_ms')::numeric end) as p75_lcp_ms,
          percentile_cont(0.75) within group (order by case when nullif(properties ->> 'inp_ms', '') ~ '^-?[0-9]+(?:\\.[0-9]+)?$' then (properties ->> 'inp_ms')::numeric end) as p75_inp_ms,
          percentile_cont(0.75) within group (order by case when nullif(properties ->> 'cls', '') ~ '^-?[0-9]+(?:\\.[0-9]+)?$' then (properties ->> 'cls')::numeric end) as p75_cls,
          avg(case when nullif(properties ->> 'load_ms', '') ~ '^-?[0-9]+(?:\\.[0-9]+)?$' then (properties ->> 'load_ms')::numeric end) as avg_load_ms
        from public.analytics_events
        where received_at >= now() - (${days} * interval '1 day')
          and event_name in ('page_performance', 'session_summary')
          and coalesce(properties ->> 'test', 'false') <> 'true'
          and coalesce(properties ->> 'internal_traffic', 'false') <> 'true'
          and page_url !~* ${CONTROL_SURFACE_PATTERN}
      `,
    ),
    safeQuery(
      "identity_integrity",
      sql`
        with base as (
          select * from public.analytics_events
          where received_at >= now() - (${days} * interval '1 day')
            and coalesce(properties ->> 'test', 'false') <> 'true'
            and coalesce(properties ->> 'internal_traffic', 'false') <> 'true'
            and page_url !~* ${CONTROL_SURFACE_PATTERN}
        ), page_visitors as (
          select distinct visitor_id from base where event_name = 'page_view'
        ), conversion_visitors as (
          select distinct visitor_id from base where event_name in ('checkout_started', 'purchase')
        )
        select
          (select count(*) from page_visitors) as page_view_visitors,
          (select count(*) from conversion_visitors) as conversion_visitors,
          count(*) filter (where p.visitor_id is not null) as conversion_visitors_with_page_view,
          count(*) filter (where p.visitor_id is null) as orphan_conversion_visitors,
          (select count(*) from base where event_name in ('checkout_started', 'purchase')
            and nullif(properties #>> '{conversion_attribution,session_id}', '') is not null) as conversions_with_resolved_attribution,
          (select count(*) from base where event_name in ('checkout_started', 'purchase')) as conversion_events
        from conversion_visitors c left join page_visitors p on p.visitor_id = c.visitor_id
      `,
    ),
    safeQuery(
      "time_to_conversion",
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
          avg(extract(epoch from (first_cta_impression - first_page_view))) filter (where first_cta_impression >= first_page_view) as avg_seconds_page_to_cta,
          avg(extract(epoch from (first_buy_click - first_cta_impression))) filter (where first_buy_click >= first_cta_impression) as avg_seconds_cta_to_click,
          avg(extract(epoch from (first_checkout - first_page_view))) filter (where first_checkout >= first_page_view) as avg_seconds_page_to_checkout,
          avg(extract(epoch from (first_purchase - first_checkout))) filter (where first_purchase >= first_checkout) as avg_seconds_checkout_to_purchase
        from visitor_times
      `,
    ),
    safeQuery(
      "creative_taxonomy",
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
    ),
    safeQuery(
      "meta_overview",
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
        where date_start >= (current_date - (${days}::integer))
      `,
    ),
    safeQuery(
      "meta_campaigns",
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
        where date_start >= (current_date - (${days}::integer))
        group by campaign_id, campaign_name
        order by spend desc, impressions desc
      `,
    ),
    safeQuery(
      "meta_daily",
      sql`
        select date_start, account_id, campaign_id, campaign_name,
          adset_id, adset_name, ad_id, ad_name, creative_id,
          spend, impressions, reach, frequency, clicks, unique_clicks,
          landing_page_views, add_to_cart, initiate_checkout,
          purchases, purchase_value, currency, actions, ingested_at
        from public.meta_ads_daily
        where date_start >= (current_date - (${days}::integer))
        order by date_start asc, spend desc limit 20_000
      `,
    ),
    safeQuery(
      "raw_events",
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
        order by client_timestamp asc, received_at asc limit ${rawLimit}
      `,
    ),
  ]);

  for (const result of results) queryHealth.push(result.health);

  const [
    exclusionAuditResult,
    overviewResult,
    funnelResult,
    eventCatalogResult,
    campaignsResult,
    sessionsResult,
    conversionsResult,
    dailyResult,
    pagesResult,
    devicesResult,
    productsResult,
    ctaResult,
    sectionsResult,
    performanceResult,
    identityResult,
    timeToConversionResult,
    creativeTaxonomyResult,
    metaOverviewResult,
    metaCampaignResult,
    metaDailyResult,
    rawEventsResult,
  ] = results.map((result) => result.rows);

  const overview = sanitizeValue(firstRow(overviewResult)) as Row;
  const funnel = sanitizeValue(firstRow(funnelResult)) as Row;
  const identity = sanitizeValue(firstRow(identityResult)) as Row;
  const metaOverview = sanitizeValue(firstRow(metaOverviewResult)) as Row;
  const rawEvents = sanitizedRows(rawEventsResult);

  const sessions = numberValue(overview.sessions);
  const uniqueVisitors = numberValue(overview.unique_visitors);
  const v2Sessions = numberValue(overview.session_v2_sessions);
  const v3Sessions = numberValue(overview.session_v3_sessions);
  const pageViewVisitors = numberValue(funnel.page_view_visitors);
  const ctaVisitors = numberValue(funnel.cta_impression_visitors);
  const clickVisitors = numberValue(funnel.buy_click_visitors);
  const checkoutVisitors = numberValue(funnel.checkout_visitors);
  const purchaseVisitors = numberValue(funnel.purchase_visitors);
  const metaRows = numberValue(metaOverview.rows);
  const failedQueries = queryHealth.filter((item) => !item.ok);

  return sanitizeValue({
    schema: "private_conversion_intelligence_export_v1_2",
    generated_at: new Date().toISOString(),
    analysis_request:
      "Analise este dossiê como cientista de dados, especialista em mensuração e estrategista de direct response. Audite o tracking antes do marketing, use visitantes únicos como unidade principal, preserve a distinção entre sessão real e sessão atribuída, não trate correlação como causalidade, reporte incerteza estatística e recomende somente o próximo teste incremental de maior valor.",
    export_health: {
      mode: failedQueries.length === 0 ? "full" : "partial_with_isolated_failures",
      complete_query_blocks: queryHealth.filter((item) => item.ok).length,
      failed_query_blocks: failedQueries.length,
      query_health: queryHealth,
      instruction:
        "Blocos com erro estão ausentes, não zerados. Os demais blocos permanecem válidos e independentes.",
    },
    export_scope: {
      days,
      raw_event_limit: rawLimit,
      raw_events_included: rawEvents.length,
      raw_event_limit_reached: numberValue(overview.total_events) > rawEvents.length,
      excludes_test_events: true,
      excludes_internal_traffic: true,
      excludes_historical_control_surface_by_url: true,
      control_surface_url_pattern: CONTROL_SURFACE_PATTERN,
      exclusion_audit: sanitizeValue(firstRow(exclusionAuditResult)),
      sensitive_fields_hashed: Array.from(SENSITIVE_KEYS),
      checkout_and_cart_paths_hashed: true,
    },
    definitions: {
      visitor: "visitor_id anônimo persistido no navegador",
      session: "session_id delimitado por inatividade e compartilhado entre abas no tracker v3",
      attributed_session:
        "sessão comercial recuperada para checkout ou compra sem sobrescrever a sessão real",
      cac_target:
        "CAC máximo para preservar o lucro desejado, diferente do CAC de equilíbrio",
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
    funnel_by_unique_visitor: funnel,
    funnel_confidence_95: {
      page_view_to_cta_impression: wilsonInterval(ctaVisitors, pageViewVisitors),
      cta_impression_to_buy_click: wilsonInterval(clickVisitors, ctaVisitors),
      buy_click_to_checkout: wilsonInterval(checkoutVisitors, clickVisitors),
      checkout_to_purchase: wilsonInterval(purchaseVisitors, checkoutVisitors),
      page_view_to_purchase: wilsonInterval(purchaseVisitors, pageViewVisitors),
    },
    data_readiness: {
      unique_visitors: uniqueVisitors,
      sample_label:
        uniqueVisitors < 20
          ? "exploratory_only"
          : uniqueVisitors < 100
            ? "directional"
            : "stronger_directional",
      tracker_v3_ready: sessions > 0 && v3Sessions === sessions,
      meta_ads_available: metaRows > 0,
      identity_integrity: identity,
      blockers: [
        ...(uniqueVisitors < 20 ? ["Amostra menor que 20 visitantes únicos."] : []),
        ...(sessions > 0 && v3Sessions < sessions ? ["Nem todas as sessões usam tracker v3."] : []),
        ...(numberValue(identity.orphan_conversion_visitors) > 0
          ? ["Existem conversões órfãs sem page_view do mesmo visitante."]
          : []),
        ...(metaRows === 0 ? ["Custos e impressões do Meta Ads ainda não foram ingeridos."] : []),
        ...(purchaseVisitors === 0 ? ["Nenhuma purchase externa foi registrada."] : []),
        ...(failedQueries.length > 0
          ? ["Alguns blocos analíticos falharam isoladamente; consulte export_health.query_health."]
          : []),
      ],
    },
    campaigns_and_creatives: sanitizedRows(campaignsResult),
    session_journeys: sanitizedRows(sessionsResult),
    conversion_attribution: sanitizedRows(conversionsResult),
    event_catalog: sanitizedRows(eventCatalogResult),
    daily_series: sanitizedRows(dailyResult),
    pages: sanitizedRows(pagesResult),
    devices: sanitizedRows(devicesResult),
    products: sanitizedRows(productsResult),
    cta_performance: sanitizedRows(ctaResult),
    section_performance: sanitizedRows(sectionsResult),
    web_performance: sanitizeValue(firstRow(performanceResult)),
    identity_integrity: identity,
    time_to_conversion: sanitizeValue(firstRow(timeToConversionResult)),
    creative_taxonomy: sanitizedRows(creativeTaxonomyResult),
    meta_ads: {
      overview: metaMetrics(metaOverview),
      campaigns: sanitizedRows(metaCampaignResult).map(metaMetrics),
      daily_ads: sanitizedRows(metaDailyResult).map(metaMetrics),
    },
    raw_events: rawEvents,
    interpretation_guardrails: [
      "Não trate sessões como pessoas.",
      "Não interprete blocos ausentes como métricas zeradas.",
      "Não declare criativo vencedor com amostra pequena.",
      "Verifique integridade e atribuição antes de culpar anúncio, página ou oferta.",
      "Use intervalos de confiança e eventos brutos para sustentar conclusões.",
    ],
  }) as Row;
}
