import { NextRequest, NextResponse } from "next/server";

import { getSql } from "@/lib/neon";

export const runtime = "nodejs";

const EVENT_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 32_000;
const MAX_PROPERTIES_BYTES = 16_000;

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

function configuredOrigins(): string[] {
  return (process.env.TRACKING_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function isAllowedOrigin(origin: string | null): boolean {
  const allowed = configuredOrigins();

  if (!origin || allowed.length === 0 || allowed.includes("*")) {
    return true;
  }

  return allowed.includes(origin);
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

  const properties = isPlainObject(body.properties) ? body.properties : {};
  const serializedProperties = JSON.stringify(properties);

  if (serializedProperties.length > MAX_PROPERTIES_BYTES) {
    return jsonResponse(request, { ok: false, error: "Properties are too large." }, 413);
  }

  const screenWidth =
    typeof body.screen_width === "number" &&
    Number.isInteger(body.screen_width) &&
    body.screen_width >= 0 &&
    body.screen_width <= 20_000
      ? body.screen_width
      : null;

  try {
    const sql = getSql();
    const inserted = await sql`
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
        ${body.event_id}::uuid,
        ${body.event_name},
        ${body.visitor_id}::uuid,
        ${body.session_id}::uuid,
        ${timestamp.toISOString()}::timestamptz,
        ${body.page_url},
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
    `;

    if (inserted.length === 0) {
      return jsonResponse(request, { ok: true, duplicate: true }, 202);
    }

    return jsonResponse(request, { ok: true }, 201);
  } catch (error) {
    console.error("Failed to store analytics event", error);
    return jsonResponse(
      request,
      { ok: false, error: "Could not store event. Check DATABASE_URL and the migration." },
      500,
    );
  }
}
