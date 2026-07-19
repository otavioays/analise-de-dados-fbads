import { createHash } from "node:crypto";

import { NextRequest } from "next/server";

import { buildIntelligenceExport } from "@/lib/intelligence-export";
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
  "email",
  "phone",
  "phone_number",
  "customer_email",
]);

type Row = Record<string, unknown>;

function integerParam(value: string | null, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : fallback;
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

function sanitize(value: unknown, key = "", depth = 0): unknown {
  if (depth > 8) return "[depth-limited]";
  if (value === null || value === undefined) return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) {
      return value ? `sha256:${stableHash(value)}` : value;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitize(item, key, depth + 1));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([nestedKey, nestedValue]) => [
        nestedKey,
        sanitize(nestedValue, nestedKey, depth + 1),
      ]),
    );
  }
  return value;
}

function errorSummary(error: unknown): Row {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message.slice(0, 1_000),
    };
  }
  return {
    name: "UnknownError",
    message: String(error).slice(0, 1_000),
  };
}

async function buildFallbackExport(request: NextRequest, richError: unknown): Promise<Row> {
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

  const [overviewResult, eventCatalogResult, rawEventsResult] = await Promise.all([
    sql`
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
        count(*) filter (where event_name = 'purchase') as purchases
      from public.analytics_events
      where received_at >= now() - (${days} * interval '1 day')
        and coalesce(properties ->> 'test', 'false') <> 'true'
        and coalesce(properties ->> 'internal_traffic', 'false') <> 'true'
        and page_url !~* ${CONTROL_SURFACE_PATTERN}
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

  const rawEvents = normalizeRows(rawEventsResult).map((row) => sanitize(row) as Row);

  return {
    schema: "private_conversion_intelligence_export_v1_2_fallback",
    generated_at: new Date().toISOString(),
    analysis_request:
      "Analise os dados disponíveis, comece pelas limitações de tracking e não trate correlação como causalidade. Este dossiê está em modo de contingência porque uma consulta avançada falhou.",
    export_health: {
      mode: "fallback",
      core_export_available: true,
      advanced_export_available: false,
      advanced_export_error: errorSummary(richError),
      instruction:
        "Use overview, event_catalog e raw_events normalmente. Não presuma que blocos avançados ausentes equivalem a zero.",
    },
    export_scope: {
      days,
      raw_event_limit: rawLimit,
      raw_events_included: rawEvents.length,
      raw_event_limit_reached: rawEvents.length >= rawLimit,
      excludes_test_events: true,
      excludes_internal_traffic: true,
      excludes_historical_control_surface_by_url: true,
    },
    overview: sanitize(firstRow(overviewResult)),
    event_catalog: sanitize(normalizeRows(eventCatalogResult)),
    raw_events: rawEvents,
    interpretation_guardrails: [
      "Não trate sessões como pessoas.",
      "Não interprete blocos avançados ausentes como métricas zeradas.",
      "Não declare criativo vencedor com amostra pequena.",
      "Verifique integridade e atribuição antes de culpar anúncio, página ou oferta.",
      "Use os eventos brutos para reconstruir a jornada quando necessário.",
    ],
  };
}

export async function buildSafeIntelligenceExport(request: NextRequest): Promise<Row> {
  try {
    return await buildIntelligenceExport(request);
  } catch (error) {
    console.error("Advanced intelligence export failed; using fallback export", error);
    return buildFallbackExport(request, error);
  }
}
