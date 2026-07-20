import { NextRequest } from "next/server";

import { getSql } from "@/lib/neon";

const ALLOWED_DAYS = new Set([1, 7, 14, 30, 90, 180, 365]);
const DEFAULT_DAYS = 90;
const CONTROL_SURFACE_PATTERN =
  "^https?://analise-de-dados-fbads[^/]*\\.vercel\\.app(?:/|$)";

type Row = Record<string, unknown>;

function daysFromRequest(request: NextRequest): number {
  const parsed = Number(request.nextUrl.searchParams.get("days") || DEFAULT_DAYS);
  return ALLOWED_DAYS.has(parsed) ? parsed : DEFAULT_DAYS;
}

function rows(value: unknown): Row[] {
  return Array.isArray(value) ? (value as Row[]) : [];
}

function numberValue(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeRows(value: unknown): Row[] {
  return rows(value).map((row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, item]) => {
        if (
          typeof item === "string" &&
          /^-?\d+(?:\.\d+)?$/.test(item) &&
          /(?:events|visitors|sessions|views|clicks|checkouts|purchases|count|rate|percent)$/.test(key)
        ) {
          return [key, numberValue(item)];
        }
        return [key, item];
      }),
    ),
  );
}

export async function buildJourneyBreakdown(request: NextRequest): Promise<Row> {
  const days = daysFromRequest(request);
  const sql = getSql();

  const [pageTypesRaw, journeysRaw, overlapRaw, stageFlowRaw] = await Promise.all([
    sql`
      with classified as (
        select
          visitor_id,
          session_id,
          event_name,
          coalesce(
            nullif(properties ->> 'page_type', ''),
            case
              when event_name in ('checkout_started', 'purchase') then 'checkout'
              when page_path like '/editorial/%' or event_name like 'funnel_%' then 'funnel'
              when page_path in ('/', '') or event_name in ('sales_page_view', 'product_view', 'buy_button_click', 'checkout_redirect') then 'sales_page'
              else 'other'
            end
          ) as page_type
        from public.analytics_events
        where received_at >= now() - (${days} * interval '1 day')
          and coalesce(properties ->> 'test', 'false') <> 'true'
          and coalesce(properties ->> 'internal_traffic', 'false') <> 'true'
          and page_url !~* ${CONTROL_SURFACE_PATTERN}
      )
      select
        page_type,
        count(*) as events,
        count(distinct visitor_id) as unique_visitors,
        count(distinct session_id) as sessions,
        count(distinct visitor_id) filter (where event_name = 'funnel_view') as funnel_view_visitors,
        count(distinct visitor_id) filter (where event_name = 'sales_page_view') as sales_page_view_visitors,
        count(distinct visitor_id) filter (where event_name = 'checkout_started') as checkout_visitors,
        count(distinct visitor_id) filter (where event_name = 'purchase') as purchase_visitors
      from classified
      group by page_type
      order by unique_visitors desc, events desc
    `,
    sql`
      with classified as (
        select
          visitor_id,
          session_id,
          event_name,
          coalesce(
            nullif(properties ->> 'journey_type', ''),
            nullif(properties #>> '{checkout_attributes,ct_journey_type}', ''),
            case
              when page_path like '/editorial/%' or event_name like 'funnel_%' then 'funnel'
              else 'unclassified'
            end
          ) as journey_type
        from public.analytics_events
        where received_at >= now() - (${days} * interval '1 day')
          and coalesce(properties ->> 'test', 'false') <> 'true'
          and coalesce(properties ->> 'internal_traffic', 'false') <> 'true'
          and page_url !~* ${CONTROL_SURFACE_PATTERN}
      )
      select
        journey_type,
        count(*) as events,
        count(distinct visitor_id) as unique_visitors,
        count(distinct session_id) as sessions,
        count(distinct visitor_id) filter (where event_name = 'checkout_started') as checkout_visitors,
        count(distinct visitor_id) filter (where event_name = 'purchase') as purchase_visitors
      from classified
      group by journey_type
      order by purchase_visitors desc, checkout_visitors desc, unique_visitors desc
    `,
    sql`
      with valid as (
        select
          visitor_id,
          bool_or(
            properties ->> 'page_type' = 'funnel'
            or page_path like '/editorial/%'
            or event_name = 'funnel_view'
          ) as saw_funnel,
          bool_or(
            properties ->> 'page_type' = 'sales_page'
            or event_name = 'sales_page_view'
            or event_name in ('product_view', 'buy_button_click', 'checkout_redirect')
          ) as saw_sales_page,
          bool_or(event_name = 'checkout_started') as reached_checkout,
          bool_or(event_name = 'purchase') as purchased
        from public.analytics_events
        where received_at >= now() - (${days} * interval '1 day')
          and coalesce(properties ->> 'test', 'false') <> 'true'
          and coalesce(properties ->> 'internal_traffic', 'false') <> 'true'
          and page_url !~* ${CONTROL_SURFACE_PATTERN}
        group by visitor_id
      )
      select
        count(*) filter (where saw_funnel and not saw_sales_page) as funnel_only_visitors,
        count(*) filter (where saw_sales_page and not saw_funnel) as sales_page_only_visitors,
        count(*) filter (where saw_funnel and saw_sales_page) as funnel_and_sales_page_visitors,
        count(*) filter (where not saw_funnel and not saw_sales_page) as unclassified_visitors,
        count(*) filter (where saw_funnel and reached_checkout) as funnel_touched_checkout_visitors,
        count(*) filter (where saw_funnel and purchased) as funnel_touched_purchase_visitors,
        count(*) filter (where saw_sales_page and reached_checkout) as sales_page_checkout_visitors,
        count(*) filter (where saw_sales_page and purchased) as sales_page_purchase_visitors
      from valid
    `,
    sql`
      select
        count(distinct visitor_id) filter (where event_name = 'funnel_view') as funnel_visitors,
        count(distinct visitor_id) filter (where event_name = 'funnel_cta_impression') as funnel_cta_impression_visitors,
        count(distinct visitor_id) filter (where event_name = 'funnel_cta_click') as funnel_cta_click_visitors,
        count(distinct visitor_id) filter (where event_name = 'sales_page_view') as sales_page_visitors,
        count(distinct visitor_id) filter (
          where event_name = 'sales_page_view' and properties ->> 'journey_type' = 'funnel_to_sales'
        ) as funnel_to_sales_visitors,
        count(distinct visitor_id) filter (
          where event_name = 'sales_page_view' and properties ->> 'journey_type' = 'funnel_assisted_sales'
        ) as funnel_assisted_sales_visitors,
        count(distinct visitor_id) filter (
          where event_name = 'sales_page_view' and properties ->> 'journey_type' = 'direct_to_sales'
        ) as direct_to_sales_visitors,
        count(distinct visitor_id) filter (where event_name = 'buy_button_click') as buy_click_visitors,
        count(distinct visitor_id) filter (where event_name = 'checkout_started') as checkout_visitors,
        count(distinct visitor_id) filter (where event_name = 'purchase') as purchase_visitors
      from public.analytics_events
      where received_at >= now() - (${days} * interval '1 day')
        and coalesce(properties ->> 'test', 'false') <> 'true'
        and coalesce(properties ->> 'internal_traffic', 'false') <> 'true'
        and page_url !~* ${CONTROL_SURFACE_PATTERN}
    `,
  ]);

  const overlap = normalizeRows(overlapRaw)[0] || {};
  const stageFlow = normalizeRows(stageFlowRaw)[0] || {};

  return {
    period_days: days,
    definitions: {
      funnel: "Visitou o advertorial em /editorial/ ou disparou funnel_view.",
      sales_page: "Visitou a página de vendas raiz ou disparou sales_page_view.",
      funnel_to_sales: "Saiu do editorial para a sales page na jornada atual.",
      funnel_assisted_sales: "Visitou o editorial antes e voltou à sales page em outra entrada.",
      direct_to_sales: "Chegou à sales page sem passagem detectada pelo editorial.",
    },
    page_types: normalizeRows(pageTypesRaw),
    journey_types: normalizeRows(journeysRaw),
    visitor_overlap: overlap,
    stage_flow_unique_visitors: stageFlow,
    interpretation: {
      primary_people_unit: "unique visitor_id",
      funnel_and_sales_overlap_is_expected: true,
      warning:
        "Um visitante pode aparecer no funil e na sales page; use visitor_overlap e journey_type para interpretar a sequência, não some grupos sobrepostos como pessoas diferentes.",
    },
  };
}
