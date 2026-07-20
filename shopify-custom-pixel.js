// GAIETY Private Conversion Tracker — Shopify Custom Pixel
// Paste this entire file into Shopify Admin > Settings > Customer events > Add custom pixel.
// This pixel intentionally excludes customer PII such as email, phone, name and address.

const TRACKING_ENDPOINT = "https://analise-de-dados-fbads.vercel.app/api/events";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function uuid() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (char) {
    const random = Math.floor(Math.random() * 16);
    const value = char === "x" ? random : (random & 3) | 8;
    return value.toString(16);
  });
}

function validUuid(value) {
  return typeof value === "string" && UUID_PATTERN.test(value) ? value : null;
}

function compact(object) {
  return Object.fromEntries(
    Object.entries(object || {}).filter(([, value]) => value !== null && value !== undefined && value !== ""),
  );
}

function attributesToObject(attributes) {
  const output = {};
  (Array.isArray(attributes) ? attributes : []).forEach((attribute) => {
    if (!attribute || typeof attribute.key !== "string") return;
    if (!attribute.key.startsWith("ct_")) return;
    output[attribute.key] = attribute.value == null ? null : String(attribute.value);
  });
  return output;
}

function contextUrl(event) {
  return (
    event?.context?.document?.location?.href ||
    event?.context?.window?.location?.href ||
    "https://gaiety-6507.myshopify.com/"
  );
}

function urlData(pageUrl, attributes) {
  try {
    const url = new URL(pageUrl);
    return {
      page_path: `${url.pathname}${url.search}`,
      utm_source: url.searchParams.get("utm_source") || attributes.ct_utm_source || null,
      utm_medium: url.searchParams.get("utm_medium") || attributes.ct_utm_medium || null,
      utm_campaign: url.searchParams.get("utm_campaign") || attributes.ct_utm_campaign || null,
      utm_content: url.searchParams.get("utm_content") || attributes.ct_utm_content || null,
      utm_term: url.searchParams.get("utm_term") || attributes.ct_utm_term || null,
      fbclid: url.searchParams.get("fbclid") || attributes.ct_fbclid || null,
    };
  } catch (_error) {
    return {
      page_path: null,
      utm_source: attributes.ct_utm_source || null,
      utm_medium: attributes.ct_utm_medium || null,
      utm_campaign: attributes.ct_utm_campaign || null,
      utm_content: attributes.ct_utm_content || null,
      utm_term: attributes.ct_utm_term || null,
      fbclid: attributes.ct_fbclid || null,
    };
  }
}

function moneyValue(money) {
  const amount = Number(money?.amount);
  return Number.isFinite(amount) ? amount : null;
}

function checkoutItems(checkout) {
  return (Array.isArray(checkout?.lineItems) ? checkout.lineItems : []).slice(0, 50).map((item) => ({
    line_item_id: item?.id || null,
    title: item?.title || null,
    quantity: Number(item?.quantity || 0),
    variant_id: item?.variant?.id || null,
    variant_title: item?.variant?.title || null,
    product_id: item?.variant?.product?.id || null,
    product_title: item?.variant?.product?.title || null,
    line_value: moneyValue(item?.finalLinePrice),
  }));
}

function deviceType(event) {
  const width = Number(event?.context?.window?.innerWidth || 0);
  if (width > 0 && width < 768) return "mobile";
  if (width >= 768 && width < 1024) return "tablet";
  return "desktop";
}

async function send(eventName, event) {
  const checkout = event?.data?.checkout || {};
  const attributes = attributesToObject(checkout.attributes);
  const pageUrl = contextUrl(event);
  const attribution = urlData(pageUrl, attributes);
  const visitorId = validUuid(attributes.ct_visitor_id) || uuid();
  const sessionId = validUuid(attributes.ct_session_id) || uuid();
  const checkoutId = checkout.token || attributes.ct_checkout_id || null;
  const orderId = checkout?.order?.id || checkout?.order?.name || null;
  const value = moneyValue(checkout.totalPrice) ?? moneyValue(checkout.subtotalPrice);
  const currency = checkout.currencyCode || checkout.totalPrice?.currencyCode || null;
  const items = checkoutItems(checkout);

  const payload = compact({
    event_id: uuid(),
    event_name: eventName,
    visitor_id: visitorId,
    session_id: sessionId,
    client_timestamp: event?.timestamp || new Date().toISOString(),
    page_url: pageUrl,
    page_path: attribution.page_path,
    page_title: event?.context?.document?.title || null,
    referrer: event?.context?.document?.referrer || null,
    utm_source: attribution.utm_source,
    utm_medium: attribution.utm_medium,
    utm_campaign: attribution.utm_campaign,
    utm_content: attribution.utm_content,
    utm_term: attribution.utm_term,
    fbclid: attribution.fbclid,
    device_type: deviceType(event),
    screen_width: event?.context?.window?.screen?.width || null,
    language: event?.context?.navigator?.language || null,
    properties: compact({
      source: "shopify_custom_pixel",
      tracker_version: 1,
      shopify_event_id: event?.id || null,
      shopify_event_name: event?.name || null,
      shopify_event_sequence: event?.seq ?? null,
      shopify_client_id: event?.clientId || null,
      checkout_id: checkoutId,
      ct_checkout_id: attributes.ct_checkout_id || checkoutId,
      order_id: orderId,
      value,
      revenue: value,
      currency,
      item_count: items.reduce((total, item) => total + Math.max(0, item.quantity || 0), 0),
      line_items: items,
      ct_visitor_id: attributes.ct_visitor_id || null,
      ct_session_id: attributes.ct_session_id || null,
      ct_page_instance_id: attributes.ct_page_instance_id || null,
      ct_origin: attributes.ct_origin || "shopify",
      ct_product_id: attributes.ct_product_id || null,
      ct_variant_id: attributes.ct_variant_id || null,
      ct_offer_units: attributes.ct_offer_units || null,
      checkout_attributes: attributes,
      pii_included: false,
    }),
  });

  try {
    await fetch(TRACKING_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      keepalive: true,
    });
  } catch (_error) {
    // Shopify can retry or emit the event again; the ingestion endpoint also deduplicates by event_id.
  }
}

analytics.subscribe("checkout_started", async (event) => {
  await send("checkout_started", event);
});

analytics.subscribe("checkout_completed", async (event) => {
  await send("purchase", event);
});
