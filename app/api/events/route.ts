import { NextRequest, NextResponse } from "next/server";

import { getSql } from "@/lib/neon";

export const runtime = "nodejs";

const EVENT_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 32_000;
const MAX_PROPERTIES_BYTES = 16_000;
const ATTRIBUTION_LOOKBACK_DAYS = 30;
const BUILT_IN_ALLOWED_ORIGINS = [
  "https://otavioays.github.io",
  "https://gaiety-6507.myshopify.com",
  "https://analise-de-dados-fbads.vercel.app",
];
const SHOPIFY_HOST_SUFFIXES = [
  ".shopify.com",
  ".myshopify.com",
  ".shopifycloud.com",
  ".shopifycdn.com",
];

interface TrackingEventBody {
  event_id?: unknown;
  event_name?: unknown;
  visitor_id?: unknown;
  session_id?: unknown;
  client_timestamp?: unknown;
  page_url?: unknown;
  page_path?: unknown;
  page_title?: unknown;
  referrer?: unknown;
  utm_source?: unknown;
  utm_medium?: unknown;
  utm_campaign?: unknown;
  utm_content?: unknown;
  utm_term?: unknown;
  fbclid?: unknown;
  device_type?: unknown;
  screen_width?: unknown;
  language?: unknown;
  properties?: unknown;
}

type SqlClient = ReturnType<typeof getSql>;
type AttributionRow = { session_id: string; visitor_id: string };

type AttributionMethod =
  | "explicit_ids"
  | "checkout_id"
  | "order_id"
  | "visitor_latest_attributed_session"
  | "same_session";

function configuredOrigins(): string[] {
  const environmentOrigins = (process.env.TRACKING_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  return Array.from(new Set([...BUILT_IN_ALLOWED_ORIGINS, ...environmentOrigins]));
}

function isTrustedShopifyOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    const hostname = url.hostname.toLowerCase();

    if (url.protocol !== "https:") {
      return false;
    }

    return (
      hostname === "shopify.com" ||
      hostname.includes("shopify-pixel-sandbox") ||
      SHOPIFY_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))
    );
  } catch {
    return false;
  }
}

function isAllowedOrigin(origin: string | null): boolean {
  const allowed = configuredOrigins();

  if (!origin || origin === "null" || allowed.includes("*")) {
    return true;
  }

  return allowed.includes(origin) || isTrustedShopifyOrigin(origin);
}

function corsHeaders(origin: string | null): Record<string, string> {
  const allowOrigin = origin && isAllowedOrigin(origin) ? origin : "*";

  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "no-store",
    Vary: "Origin",
  };
}

function jsonResponse(
  request: NextRequest,
  body: Record<string, unknown>,
  status: number,
): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: corsHeaders(request.headers.get("origin")),
  });
}

function optionalString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizedProperties(value: unknown): Record<string, unknown> {
  const input = isPlainObject(value) ? value : {};
  const internalTraffic =
    input.internal_traffic === true || input.internal_traffic === "true";

  if (!internalTraffic) {
    return { ...input };
  }

  return {
    ...input,
    internal_traffic: true,
    test: true,
  };
}

function findNestedValue(
  value: unknown,
  candidateKeys: Set<string>,
  depth = 0,
): unknown {
  if (depth > 3 || value === null || value === undefined) {
    return null;
  }

  if (Array.isArray(value)) {
    for (const item of value.slice(0, 30)) {
      const found = findNestedValue(item, candidateKeys, depth + 1);
      if (found !== null && found !== undefined && found !== "") {
        return found;
      }
    }
    return null;
  }

  if (!isPlainObject(value)) {
    return null;
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    if (candidateKeys.has(key) && nestedValue !== null && nestedValue !== undefined) {
      return nestedValue;
    }
  }

  for (const nestedValue of Object.values(value)) {
    const found = findNestedValue(nestedValue, candidateKeys, depth + 1);
    if (found !== null && found !== undefined && found !== "") {
      return found;
    }
  }

  return null;
}

function nestedString(
  properties: Record<string, unknown>,
  keys: string[],
  maxLength = 255,
): string | null {
  const value = findNestedValue(properties, new Set(keys));
  return optionalString(value, maxLength);
}

function validUuid(value: string | null): string | null {
  return value && UUID_PATTERN.test(value) ? value : null;
}

function attributionConfidence(method: AttributionMethod): "native" | "high" | "medium" {
  if (method === "same_session") return "native";
  if (method === "visitor_latest_attributed_session") return "medium";
  return "high";
}

async function resolveConversionAttribution(
  sql: SqlClient,
  eventName: string,
  visitorId: string,
  sessionId: string,
  timestamp: Date,
  properties: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (eventName !== "checkout_started" && eventName !== "purchase") {
    return properties;
  }

  const checkoutId = nestedString(properties, [
    "checkout_id",
    "checkoutId",
    "ct_checkout_id",
  ]);
  const orderId = nestedString(properties, ["order_id", "orderId", "ct_order_id"]);
  const explicitVisitorId = validUuid(
    nestedString(properties, [
      "ct_visitor_id",
      "source_visitor_id",
      "attributed_visitor_id",
    ]),
  );
  const explicitSessionId = validUuid(
    nestedString(properties, [
      "ct_session_id",
      "source_session_id",
      "attributed_session_id",
    ]),
  );

  let attributedVisitorId = explicitVisitorId ?? visitorId;
  let attributedSessionId = explicitSessionId;
  let method: AttributionMethod | null = explicitSessionId ? "explicit_ids" : null;

  if (!attributedSessionId && checkoutId) {
    const match = (await sql`
      select session_id::text, visitor_id::text
      from public.analytics_events
      where received_at >= now() - (${ATTRIBUTION_LOOKBACK_DAYS} * interval '1 day')
        and client_timestamp <= ${timestamp.toISOString()}::timestamptz
        and event_name in ('checkout_started', 'add_to_cart', 'buy_button_click')
        and coalesce(properties ->> 'test', 'false') <> 'true'
        and coalesce(properties ->> 'internal_traffic', 'false') <> 'true'
        and (
          nullif(properties ->> 'checkout_id', '') = ${checkoutId}
          or nullif(properties ->> 'ct_checkout_id', '') = ${checkoutId}
          or nullif(properties #>> '{conversion_attribution,checkout_id}', '') = ${checkoutId}
        )
      order by client_timestamp desc, received_at desc
      limit 1
    `) as AttributionRow[];

    if (match[0]) {
      attributedSessionId = match[0].session_id;
      attributedVisitorId = explicitVisitorId ?? match[0].visitor_id;
      method = "checkout_id";
    }
  }

  if (!attributedSessionId && orderId) {
    const match = (await sql`
      select session_id::text, visitor_id::text
      from public.analytics_events
      where received_at >= now() - (${ATTRIBUTION_LOOKBACK_DAYS} * interval '1 day')
        and client_timestamp <= ${timestamp.toISOString()}::timestamptz
        and event_name in ('checkout_started', 'add_to_cart')
        and coalesce(properties ->> 'test', 'false') <> 'true'
        and coalesce(properties ->> 'internal_traffic', 'false') <> 'true'
        and (
          nullif(properties ->> 'order_id', '') = ${orderId}
          or nullif(properties ->> 'ct_order_id', '') = ${orderId}
          or nullif(properties #>> '{conversion_attribution,order_id}', '') = ${orderId}
        )
      order by client_timestamp desc, received_at desc
      limit 1
    `) as AttributionRow[];

    if (match[0]) {
      attributedSessionId = match[0].session_id;
      attributedVisitorId = explicitVisitorId ?? match[0].visitor_id;
      method = "order_id";
    }
  }

  if (!attributedSessionId) {
    const match = (await sql`
      select session_id::text, visitor_id::text
      from public.analytics_events
      where visitor_id = ${attributedVisitorId}::uuid
        and event_name = 'page_view'
        and received_at >= now() - (${ATTRIBUTION_LOOKBACK_DAYS} * interval '1 day')
        and client_timestamp <= ${timestamp.toISOString()}::timestamptz
        and coalesce(properties ->> 'test', 'false') <> 'true'
        and coalesce(properties ->> 'internal_traffic', 'false') <> 'true'
        and (
          nullif(utm_campaign, '') is not null
          or nullif(fbclid, '') is not null
          or nullif(properties #>> '{first_touch,utm_campaign}', '') is not null
          or nullif(properties #>> '{first_touch,fbclid}', '') is not null
        )
      order by client_timestamp desc, received_at desc
      limit 1
    `) as AttributionRow[];

    if (match[0]) {
      attributedSessionId = match[0].session_id;
      attributedVisitorId = explicitVisitorId ?? match[0].visitor_id;
      method = "visitor_latest_attributed_session";
    }
  }

  if (!attributedSessionId || !method) {
    attributedSessionId = sessionId;
    attributedVisitorId = explicitVisitorId ?? visitorId;
    method = "same_session";
  }

  return {
    ...properties,
    conversion_attribution: {
      version: 1,
      visitor_id: attributedVisitorId,
      session_id: attributedSessionId,
      method,
      confidence: attributionConfidence(method),
      cross_session: attributedSessionId !== sessionId,
      checkout_id: checkoutId,
      order_id: orderId,
      actual_visitor_id: visitorId,
      actual_session_id: sessionId,
      lookback_days: ATTRIBUTION_LOOKBACK_DAYS,
      resolved_at: new Date().toISOString(),
    },
  };
}

export function OPTIONS(request: NextRequest): NextResponse {
  const origin = request.headers.get("origin");

  if (!isAllowedOrigin(origin)) {
    return jsonResponse(request, { ok: false, error: "Origin not allowed." }, 403);
  }

  return new NextResponse(null, {
    status: 204,
    headers: corsHeaders(origin),
  });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const origin = request.headers.get("origin");

  if (!isAllowedOrigin(origin)) {
    return jsonResponse(request, { ok: false, error: "Origin not allowed." }, 403);
  }

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_BODY_BYTES) {
    return jsonResponse(request, { ok: false, error: "Payload too large." }, 413);
  }

  let body: TrackingEventBody;

  try {
    body = (await request.json()) as TrackingEventBody;
  } catch {
    return jsonResponse(request, { ok: false, error: "Invalid JSON." }, 400);
  }

  if (
    typeof body.event_id !== "string" ||
    !UUID_PATTERN.test(body.event_id) ||
    typeof body.visitor_id !== "string" ||
    !UUID_PATTERN.test(body.visitor_id) ||
    typeof body.session_id !== "string" ||
    !UUID_PATTERN.test(body.session_id)
  ) {
    return jsonResponse(request, { ok: false, error: "Invalid identifiers." }, 400);
  }

  if (
    typeof body.event_name !== "string" ||
    !EVENT_NAME_PATTERN.test(body.event_name)
  ) {
    return jsonResponse(request, { ok: false, error: "Invalid event name." }, 400);
  }

  if (typeof body.page_url !== "string" || body.page_url.length > 2_048) {
    return jsonResponse(request, { ok: false, error: "Invalid page URL." }, 400);
  }

  try {
    new URL(body.page_url);
  } catch {
    return jsonResponse(request, { ok: false, error: "Invalid page URL." }, 400);
  }

  const timestamp =
    typeof body.client_timestamp === "string"
      ? new Date(body.client_timestamp)
      : new Date();

  if (Number.isNaN(timestamp.getTime())) {
    return jsonResponse(request, { ok: false, error: "Invalid timestamp." }, 400);
  }

  const eventId = body.event_id;
  const eventName = body.event_name;
  const visitorId = body.visitor_id;
  const sessionId = body.session_id;
  const pageUrl = body.page_url;
  const screenWidth =
    typeof body.screen_width === "number" &&
    Number.isInteger(body.screen_width) &&
    body.screen_width >= 0 &&
    body.screen_width <= 20_000
      ? body.screen_width
      : null;

  try {
    const sql = getSql();
    const properties = await resolveConversionAttribution(
      sql,
      eventName,
      visitorId,
      sessionId,
      timestamp,
      normalizedProperties(body.properties),
    );
    const serializedProperties = JSON.stringify(properties);

    if (serializedProperties.length > MAX_PROPERTIES_BYTES) {
      return jsonResponse(request, { ok: false, error: "Properties are too large." }, 413);
    }

    const inserted = (await sql`
      insert into public.analytics_events (
        event_id,
        event_name,
        visitor_id,
        session_id,
        client_timestamp,
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
      ) values (
        ${eventId}::uuid,
        ${eventName},
        ${visitorId}::uuid,
        ${sessionId}::uuid,
        ${timestamp.toISOString()}::timestamptz,
        ${pageUrl},
        ${optionalString(body.page_path, 1_024)},
        ${optionalString(body.page_title, 512)},
        ${optionalString(body.referrer, 2_048)},
        ${optionalString(body.utm_source, 255)},
        ${optionalString(body.utm_medium, 255)},
        ${optionalString(body.utm_campaign, 255)},
        ${optionalString(body.utm_content, 255)},
        ${optionalString(body.utm_term, 255)},
        ${optionalString(body.fbclid, 1_024)},
        ${optionalString(body.device_type, 32)},
        ${screenWidth},
        ${optionalString(body.language, 64)},
        ${serializedProperties}::jsonb
      )
      on conflict (event_id) do nothing
      returning event_id
    `) as Array<{ event_id: string }>;

    if (inserted.length === 0) {
      return jsonResponse(request, { ok: true, duplicate: true }, 202);
    }

    return jsonResponse(
      request,
      {
        ok: true,
        conversion_attribution:
          isPlainObject(properties.conversion_attribution)
            ? properties.conversion_attribution
            : null,
      },
      201,
    );
  } catch (error) {
    console.error("Failed to store analytics event", error);
    return jsonResponse(
      request,
      { ok: false, error: "Could not store event. Check DATABASE_URL and the migration." },
      500,
    );
  }
}
