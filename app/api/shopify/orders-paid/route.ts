import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { getSql } from "@/lib/neon";

export const runtime = "nodejs";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_BODY_BYTES = 2_000_000;
const MAX_PROPERTIES_BYTES = 16_000;
const EXPECTED_TOPIC = "orders/paid";

type JsonObject = Record<string, unknown>;
type IdentityResolution =
  | "original_session_verified"
  | "original_session_unverified"
  | "session_only_unverified"
  | "visitor_only_unresolved"
  | "anonymous_unresolved";

function isPlainObject(value: unknown): value is JsonObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function optionalString(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const normalized = String(value).trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function optionalNumber(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function validUuid(value: unknown): string | null {
  const normalized = optionalString(value, 64);
  return normalized && UUID_PATTERN.test(normalized) ? normalized.toLowerCase() : null;
}

function deterministicUuid(seed: string): string {
  const bytes = Buffer.from(createHash("sha256").update(seed).digest().subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function verifyShopifyHmac(rawBody: string, suppliedHmac: string, secret: string): boolean {
  try {
    const supplied = Buffer.from(suppliedHmac, "base64");
    const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest();
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  } catch {
    return false;
  }
}

function noteAttributes(payload: JsonObject): Record<string, string> {
  const result: Record<string, string> = {};
  const input = payload.note_attributes;

  if (Array.isArray(input)) {
    for (const item of input) {
      if (!isPlainObject(item)) continue;
      const key = optionalString(item.name ?? item.key, 128)?.toLowerCase();
      const value = optionalString(item.value, 2_048);
      if (key && value !== null) result[key] = value;
    }
  }

  if (isPlainObject(payload.attributes)) {
    for (const [rawKey, rawValue] of Object.entries(payload.attributes)) {
      const key = rawKey.trim().toLowerCase().slice(0, 128);
      const value = optionalString(rawValue, 2_048);
      if (key && value !== null) result[key] = value;
    }
  }

  return result;
}

function firstAttribute(attributes: Record<string, string>, names: string[]): string | null {
  for (const name of names) {
    const value = attributes[name];
    if (value) return value;
  }
  return null;
}

function validUrl(value: unknown): string | null {
  const normalized = optionalString(value, 2_048);
  if (!normalized) return null;
  try {
    return new URL(normalized).toString();
  } catch {
    return null;
  }
}

function eventTimestamp(payload: JsonObject): string {
  const candidates = [payload.processed_at, payload.updated_at, payload.created_at];
  for (const candidate of candidates) {
    const value = optionalString(candidate, 128);
    if (!value) continue;
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return new Date().toISOString();
}

function summarizedLineItems(payload: JsonObject): JsonObject[] {
  if (!Array.isArray(payload.line_items)) return [];
  return payload.line_items.slice(0, 12).flatMap((item) => {
    if (!isPlainObject(item)) return [];
    return [
      {
        product_id: optionalString(item.product_id, 128),
        variant_id: optionalString(item.variant_id, 128),
        sku: optionalString(item.sku, 128),
        title: optionalString(item.title, 256),
        quantity: optionalNumber(item.quantity),
        price: optionalNumber(item.price),
      },
    ];
  });
}

function webhookStatus(configured: boolean): NextResponse {
  return NextResponse.json(
    {
      ok: true,
      configured,
      topic: EXPECTED_TOPIC,
      endpoint: "/api/shopify/orders-paid",
      required_cart_attributes: [
        "ct_visitor_id",
        "ct_session_id",
        "ct_utm_source",
        "ct_utm_medium",
        "ct_utm_campaign",
        "ct_utm_content",
        "ct_utm_term",
        "ct_fbclid",
      ],
      attribution_rule:
        "A compra só é atribuída à sessão original quando ct_session_id é um UUID válido. Quando a sessão já existe no banco, o visitor_id é recuperado dela.",
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export function GET(): NextResponse {
  return webhookStatus(Boolean(process.env.SHOPIFY_WEBHOOK_SECRET?.trim()));
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET?.trim();
  if (!secret) {
    return NextResponse.json(
      { ok: false, error: "SHOPIFY_WEBHOOK_SECRET is not configured." },
      { status: 503 },
    );
  }

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > MAX_BODY_BYTES) {
    return NextResponse.json({ ok: false, error: "Payload too large." }, { status: 413 });
  }

  const rawBody = await request.text();
  if (Buffer.byteLength(rawBody, "utf8") > MAX_BODY_BYTES) {
    return NextResponse.json({ ok: false, error: "Payload too large." }, { status: 413 });
  }

  const suppliedHmac = request.headers.get("x-shopify-hmac-sha256") ?? "";
  if (!verifyShopifyHmac(rawBody, suppliedHmac, secret)) {
    return NextResponse.json({ ok: false, error: "Invalid Shopify signature." }, { status: 401 });
  }

  const topic = (request.headers.get("x-shopify-topic") ?? "").toLowerCase();
  if (topic && topic !== EXPECTED_TOPIC) {
    return NextResponse.json(
      { ok: true, ignored: true, reason: `Unexpected topic: ${topic}` },
      { status: 202 },
    );
  }

  let payload: JsonObject;
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    if (!isPlainObject(parsed)) throw new Error("Payload is not an object");
    payload = parsed;
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid JSON payload." }, { status: 400 });
  }

  const shopDomain = optionalString(request.headers.get("x-shopify-shop-domain"), 255);
  const orderId = optionalString(
    payload.id ?? payload.admin_graphql_api_id ?? payload.order_number ?? payload.name,
    255,
  );
  if (!orderId) {
    return NextResponse.json({ ok: false, error: "Order identifier is missing." }, { status: 400 });
  }

  const attributes = noteAttributes(payload);
  const explicitVisitorId = validUuid(
    firstAttribute(attributes, ["ct_visitor_id", "_ct_visitor_id", "visitor_id"]),
  );
  const explicitSessionId = validUuid(
    firstAttribute(attributes, ["ct_session_id", "_ct_session_id", "session_id"]),
  );

  const fallbackSeed = `${shopDomain ?? "shopify"}:${orderId}`;
  let visitorId = explicitVisitorId ?? deterministicUuid(`visitor:${fallbackSeed}`);
  let sessionId = explicitSessionId ?? deterministicUuid(`session:${fallbackSeed}`);
  let resolution: IdentityResolution;
  let identityMismatch = false;

  const sql = getSql();

  if (explicitSessionId) {
    const matches = (await sql`
      select visitor_id::text as visitor_id
      from public.analytics_events
      where session_id = ${explicitSessionId}::uuid
      order by client_timestamp asc, received_at asc
      limit 1
    `) as Array<{ visitor_id: string }>;

    const storedVisitorId = validUuid(matches[0]?.visitor_id);
    if (storedVisitorId) {
      identityMismatch = Boolean(explicitVisitorId && explicitVisitorId !== storedVisitorId);
      visitorId = storedVisitorId;
      sessionId = explicitSessionId;
      resolution = "original_session_verified";
    } else if (explicitVisitorId) {
      resolution = "original_session_unverified";
    } else {
      resolution = "session_only_unverified";
    }
  } else if (explicitVisitorId) {
    resolution = "visitor_only_unresolved";
  } else {
    resolution = "anonymous_unresolved";
  }

  const checkoutId = optionalString(
    payload.checkout_id ?? payload.checkout_token ?? payload.cart_token,
    255,
  );
  const currency = optionalString(payload.currency ?? payload.presentment_currency, 16);
  const orderStatusUrl = validUrl(payload.order_status_url);
  const pageUrl =
    orderStatusUrl ??
    (shopDomain ? `https://${shopDomain}/orders/${encodeURIComponent(orderId)}` : "https://shopify.com");
  const eventId = deterministicUuid(`shopify-order-paid:${fallbackSeed}`);
  const timestamp = eventTimestamp(payload);
  const webhookId = optionalString(request.headers.get("x-shopify-webhook-id"), 255);

  const properties: JsonObject = {
    purchase_source: "shopify_orders_paid_webhook",
    server_side: true,
    webhook_topic: topic || EXPECTED_TOPIC,
    webhook_id: webhookId,
    shop_domain: shopDomain,
    order_id: orderId,
    order_name: optionalString(payload.name, 255),
    order_number: optionalString(payload.order_number, 255),
    checkout_id: checkoutId,
    checkout_token: optionalString(payload.checkout_token, 255),
    financial_status: optionalString(payload.financial_status, 64),
    fulfillment_status: optionalString(payload.fulfillment_status, 64),
    value: optionalNumber(payload.current_total_price ?? payload.total_price),
    subtotal: optionalNumber(payload.current_subtotal_price ?? payload.subtotal_price),
    total_tax: optionalNumber(payload.current_total_tax ?? payload.total_tax),
    total_discounts: optionalNumber(payload.current_total_discounts ?? payload.total_discounts),
    currency,
    attribution_resolution: resolution,
    attribution_eligible: resolution === "original_session_verified",
    identity_mismatch: identityMismatch,
    supplied_visitor_id: explicitVisitorId,
    supplied_session_id: explicitSessionId,
    note_attribute_keys: Object.keys(attributes).slice(0, 40),
    line_items: summarizedLineItems(payload),
  };

  let serializedProperties = JSON.stringify(properties);
  if (serializedProperties.length > MAX_PROPERTIES_BYTES) {
    delete properties.line_items;
    properties.line_items_omitted = true;
    serializedProperties = JSON.stringify(properties);
  }

  try {
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
        'purchase',
        ${visitorId}::uuid,
        ${sessionId}::uuid,
        ${timestamp}::timestamptz,
        ${pageUrl},
        '/checkout/thank_you',
        ${optionalString(payload.name, 255) ?? `Shopify order ${orderId}`},
        null,
        ${firstAttribute(attributes, ["ct_utm_source", "utm_source"])},
        ${firstAttribute(attributes, ["ct_utm_medium", "utm_medium"])},
        ${firstAttribute(attributes, ["ct_utm_campaign", "utm_campaign"])},
        ${firstAttribute(attributes, ["ct_utm_content", "utm_content"])},
        ${firstAttribute(attributes, ["ct_utm_term", "utm_term"])},
        ${firstAttribute(attributes, ["ct_fbclid", "fbclid"])},
        null,
        null,
        null,
        ${serializedProperties}::jsonb
      )
      on conflict (event_id) do nothing
      returning event_id
    `) as Array<{ event_id: string }>;

    return NextResponse.json(
      {
        ok: true,
        duplicate: inserted.length === 0,
        event_id: eventId,
        order_id: orderId,
        attribution_resolution: resolution,
        attribution_eligible: resolution === "original_session_verified",
      },
      { status: inserted.length === 0 ? 202 : 201 },
    );
  } catch (error) {
    console.error("Failed to store Shopify paid order", error);
    return NextResponse.json(
      { ok: false, error: "Could not store the paid order." },
      { status: 500 },
    );
  }
}
