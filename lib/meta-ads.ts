import { getSql } from "@/lib/neon";

export type SqlClient = ReturnType<typeof getSql>;

export type MetaAdsDailyInput = {
  account_id?: unknown;
  date_start?: unknown;
  campaign_id?: unknown;
  campaign_name?: unknown;
  adset_id?: unknown;
  adset_name?: unknown;
  ad_id?: unknown;
  ad_name?: unknown;
  creative_id?: unknown;
  spend?: unknown;
  impressions?: unknown;
  reach?: unknown;
  frequency?: unknown;
  clicks?: unknown;
  unique_clicks?: unknown;
  landing_page_views?: unknown;
  add_to_cart?: unknown;
  initiate_checkout?: unknown;
  purchases?: unknown;
  purchase_value?: unknown;
  currency?: unknown;
  actions?: unknown;
  raw?: unknown;
};

export type NormalizedMetaAdsDaily = {
  accountId: string;
  dateStart: string;
  campaignId: string;
  campaignName: string | null;
  adsetId: string;
  adsetName: string | null;
  adId: string;
  adName: string | null;
  creativeId: string | null;
  spend: number;
  impressions: number;
  reach: number;
  frequency: number;
  clicks: number;
  uniqueClicks: number;
  landingPageViews: number;
  addToCart: number;
  initiateCheckout: number;
  purchases: number;
  purchaseValue: number;
  currency: string | null;
  actions: unknown;
  raw: unknown;
};

function text(value: unknown, maxLength = 512): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const normalized = String(value).trim();
  return normalized ? normalized.slice(0, maxLength) : null;
}

function number(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function integer(value: unknown): number {
  return Math.max(0, Math.round(number(value)));
}

function actionValue(actions: unknown, candidates: string[]): number {
  if (!Array.isArray(actions)) return 0;
  for (const item of actions) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const actionType = text(record.action_type, 255);
    if (actionType && candidates.includes(actionType)) return number(record.value);
  }
  return 0;
}

function validDate(value: string | null): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? null : value;
}

export function normalizeMetaAdsDaily(input: MetaAdsDailyInput): NormalizedMetaAdsDaily | null {
  const dateStart = validDate(text(input.date_start, 10));
  const campaignId = text(input.campaign_id, 255);
  const adsetId = text(input.adset_id, 255) ?? "unknown-adset";
  const adId = text(input.ad_id, 255);
  const accountId = text(input.account_id, 255) ?? "unknown-account";
  if (!dateStart || !campaignId || !adId) return null;

  const actions = input.actions;
  const raw = input.raw ?? input;
  const landingPageViews =
    number(input.landing_page_views) ||
    actionValue(actions, ["landing_page_view"]);
  const addToCart =
    number(input.add_to_cart) ||
    actionValue(actions, ["add_to_cart", "omni_add_to_cart"]);
  const initiateCheckout =
    number(input.initiate_checkout) ||
    actionValue(actions, ["initiate_checkout", "omni_initiated_checkout"]);
  const purchases =
    number(input.purchases) ||
    actionValue(actions, ["purchase", "omni_purchase"]);

  return {
    accountId,
    dateStart,
    campaignId,
    campaignName: text(input.campaign_name),
    adsetId,
    adsetName: text(input.adset_name),
    adId,
    adName: text(input.ad_name),
    creativeId: text(input.creative_id, 255),
    spend: Math.max(0, number(input.spend)),
    impressions: integer(input.impressions),
    reach: integer(input.reach),
    frequency: Math.max(0, number(input.frequency)),
    clicks: integer(input.clicks),
    uniqueClicks: integer(input.unique_clicks),
    landingPageViews: integer(landingPageViews),
    addToCart: integer(addToCart),
    initiateCheckout: integer(initiateCheckout),
    purchases: Math.max(0, number(purchases)),
    purchaseValue: Math.max(0, number(input.purchase_value)),
    currency: text(input.currency, 16),
    actions,
    raw,
  };
}

export async function ensureMetaAdsTable(sql: SqlClient): Promise<void> {
  await sql`
    create table if not exists public.meta_ads_daily (
      account_id text not null,
      date_start date not null,
      campaign_id text not null,
      campaign_name text,
      adset_id text not null,
      adset_name text,
      ad_id text not null,
      ad_name text,
      creative_id text,
      spend numeric not null default 0,
      impressions bigint not null default 0,
      reach bigint not null default 0,
      frequency numeric not null default 0,
      clicks bigint not null default 0,
      unique_clicks bigint not null default 0,
      landing_page_views bigint not null default 0,
      add_to_cart bigint not null default 0,
      initiate_checkout bigint not null default 0,
      purchases numeric not null default 0,
      purchase_value numeric not null default 0,
      currency text,
      actions jsonb,
      raw jsonb,
      ingested_at timestamptz not null default now(),
      primary key (account_id, date_start, ad_id)
    )
  `;
  await sql`
    create index if not exists meta_ads_daily_campaign_date_idx
      on public.meta_ads_daily (campaign_id, date_start desc)
  `;
}

export async function upsertMetaAdsDaily(
  sql: SqlClient,
  row: NormalizedMetaAdsDaily,
): Promise<void> {
  await sql`
    insert into public.meta_ads_daily (
      account_id, date_start, campaign_id, campaign_name,
      adset_id, adset_name, ad_id, ad_name, creative_id,
      spend, impressions, reach, frequency, clicks, unique_clicks,
      landing_page_views, add_to_cart, initiate_checkout,
      purchases, purchase_value, currency, actions, raw, ingested_at
    ) values (
      ${row.accountId}, ${row.dateStart}::date, ${row.campaignId}, ${row.campaignName},
      ${row.adsetId}, ${row.adsetName}, ${row.adId}, ${row.adName}, ${row.creativeId},
      ${row.spend}, ${row.impressions}, ${row.reach}, ${row.frequency},
      ${row.clicks}, ${row.uniqueClicks}, ${row.landingPageViews},
      ${row.addToCart}, ${row.initiateCheckout}, ${row.purchases},
      ${row.purchaseValue}, ${row.currency}, ${JSON.stringify(row.actions ?? null)}::jsonb,
      ${JSON.stringify(row.raw ?? null)}::jsonb, now()
    )
    on conflict (account_id, date_start, ad_id) do update set
      campaign_id = excluded.campaign_id,
      campaign_name = excluded.campaign_name,
      adset_id = excluded.adset_id,
      adset_name = excluded.adset_name,
      ad_name = excluded.ad_name,
      creative_id = excluded.creative_id,
      spend = excluded.spend,
      impressions = excluded.impressions,
      reach = excluded.reach,
      frequency = excluded.frequency,
      clicks = excluded.clicks,
      unique_clicks = excluded.unique_clicks,
      landing_page_views = excluded.landing_page_views,
      add_to_cart = excluded.add_to_cart,
      initiate_checkout = excluded.initiate_checkout,
      purchases = excluded.purchases,
      purchase_value = excluded.purchase_value,
      currency = excluded.currency,
      actions = excluded.actions,
      raw = excluded.raw,
      ingested_at = now()
  `;
}
