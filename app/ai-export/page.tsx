import Link from "next/link";

import { getSql } from "@/lib/neon";
import CopyButton from "./CopyButton";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type SearchParams = Promise<{
  days?: string | string[];
  campaign?: string | string[];
  content?: string | string[];
  aov?: string | string[];
  cpc?: string | string[];
}>;

type Row = Record<string, string | number | boolean | null>;
type ScoreStatus = "measured" | "directional" | "insufficient_data";

type TestRecommendation = {
  priority: number;
  area: string;
  test: string;
  hypothesis: string;
  impact: "Muito alto" | "Alto" | "Médio";
  difficulty: "Baixa" | "Média" | "Alta";
  success_metric: string;
};

type ScoredArea = {
  key: "traffic" | "landing" | "offer" | "checkout";
  label: string;
  score: number | null;
  directionalScore: number;
  status: ScoreStatus;
  minimumSample: string;
};

const validPeriods = new Set([1, 7, 14, 30, 90]);
const MIN_DIAGNOSTIC_VISITORS = 30;
const MIN_CREATIVE_VISITORS = 20;
const MIN_CHECKOUT_VISITORS = 10;
const MIN_SUMMARY_COVERAGE = 0.8;
const MIN_SESSION_V2_COVERAGE = 0.8;

function firstParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function num(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function bool(value: unknown): boolean {
  return value === true || value === "true" || value === 1 || value === "1";
}

function nullableText(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function boundedInput(value: string, maximum: number): number | null {
  const normalized = value.replace(",", ".").trim();
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= maximum ? parsed : null;
}

function rate(value: number, total: number): number {
  return total > 0 ? Number(((value / total) * 100).toFixed(2)) : 0;
}

function ratio(value: number, total: number): number {
  return total > 0 ? value / total : 0;
}

function clamp(value: number, min = 0, max = 100): number {
  return Math.min(max, Math.max(min, value));
}

function score(value: number): number {
  return Math.round(clamp(value));
}

function confidenceFromSample(
  visitors: number,
  checkoutVisitors: number,
  purchaseVisitors: number,
): number {
  const visitorComponent = Math.sqrt(Math.min(visitors, 100) / 100) * 70;
  const checkoutComponent = Math.sqrt(Math.min(checkoutVisitors, 10) / 10) * 20;
  const purchaseComponent = (Math.min(purchaseVisitors, 5) / 5) * 10;
  return score(visitorComponent + checkoutComponent + purchaseComponent);
}

function healthLabel(value: number | null): string {
  if (value === null) return "Dados insuficientes";
  if (value >= 80) return "Saudável";
  if (value >= 65) return "Promissor";
  if (value >= 45) return "Instável";
  return "Crítico";
}

function statusLabel(status: ScoreStatus): string {
  if (status === "measured") return "medido";
  if (status === "directional") return "direcional";
  return "dados insuficientes";
}

export default async function AiExportPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const requestedDays = Number(firstParam(params.days));
  const days = validPeriods.has(requestedDays) ? requestedDays : 7;
  const campaign = firstParam(params.campaign).slice(0, 255);
  const content = firstParam(params.content).slice(0, 255);
  const aov = boundedInput(firstParam(params.aov), 1_000_000);
  const cpc = boundedInput(firstParam(params.cpc), 100_000);
  const sql = getSql();

  const [summaryResult, concentrationResult, creativeResult, sessionResult, filterResult] =
    await Promise.all([
      sql`
        with base_events as (
          select *
          from public.analytics_events
          where received_at >= now() - (${days} * interval '1 day')
            and coalesce(properties ->> 'test', 'false') <> 'true'
            and coalesce(properties ->> 'internal_traffic', 'false') <> 'true'
        ), attributed as (
          select distinct on (session_id)
            session_id,
            visitor_id,
            client_timestamp as started_at,
            device_type,
            coalesce(nullif(utm_source, ''), nullif(properties #>> '{first_touch,utm_source}', '')) as source,
            coalesce(nullif(utm_medium, ''), nullif(properties #>> '{first_touch,utm_medium}', '')) as medium,
            coalesce(nullif(utm_campaign, ''), nullif(properties #>> '{first_touch,utm_campaign}', '')) as campaign,
            coalesce(nullif(utm_content, ''), nullif(properties #>> '{first_touch,utm_content}', '')) as content,
            coalesce(nullif(fbclid, ''), nullif(properties #>> '{first_touch,fbclid}', '')) as fbclid,
            coalesce(nullif(properties ->> 'session_storage_version', '')::integer, 1) as session_storage_version
          from base_events
          where event_name = 'page_view'
          order by session_id, client_timestamp asc
        ), cohort as (
          select *
          from attributed
          where (${campaign} = '' or coalesce(campaign, '') = ${campaign})
            and (${content} = '' or coalesce(content, '') = ${content})
        ), summaries as (
          select
            session_id,
            sum(coalesce(nullif(properties ->> 'visible_seconds', '')::numeric, 0)) as visible_seconds,
            max(coalesce(nullif(properties ->> 'max_scroll_depth', '')::numeric, 0)) as max_scroll,
            bool_and(coalesce((properties ->> 'quick_exit')::boolean, false)) as quick_exit,
            count(*) as summary_count
          from base_events
          where event_name = 'session_summary'
          group by session_id
        ), event_rollup as (
          select
            session_id,
            count(*) as event_count,
            bool_or(event_name = 'cta_impression') as cta_impression,
            bool_or(event_name = 'buy_button_click') as clicked,
            bool_or(event_name = 'add_to_cart') as added_to_cart,
            bool_or(event_name = 'checkout_started') as checkout,
            bool_or(event_name = 'purchase') as purchase,
            count(*) filter (where event_name = 'javascript_error') as javascript_errors
          from base_events
          group by session_id
        ), facts as (
          select
            c.*,
            coalesce(r.event_count, 0) as event_count,
            coalesce(r.cta_impression, false) as cta_impression,
            coalesce(r.clicked, false) as clicked,
            coalesce(r.added_to_cart, false) as added_to_cart,
            coalesce(r.checkout, false) as checkout,
            coalesce(r.purchase, false) as purchase,
            coalesce(r.javascript_errors, 0) as javascript_errors,
            s.visible_seconds,
            s.max_scroll,
            s.quick_exit,
            s.summary_count
          from cohort c
          left join event_rollup r on r.session_id = c.session_id
          left join summaries s on s.session_id = c.session_id
        )
        select
          count(distinct visitor_id) as visitors,
          count(*) as sessions,
          count(*) filter (where summary_count is not null) as summary_sessions,
          count(*) filter (where session_storage_version >= 2) as session_v2_sessions,
          count(*) filter (where campaign is not null) as attributed_sessions,
          count(distinct visitor_id) filter (where campaign is not null) as attributed_visitors,
          count(*) filter (where campaign is null) as unattributed_sessions,
          count(distinct visitor_id) filter (where campaign is null) as unattributed_visitors,
          count(distinct fbclid) filter (where fbclid is not null) as paid_click_ids,
          count(*) filter (where source = 'facebook' and fbclid is null) as facebook_sessions_without_fbclid,
          count(distinct visitor_id) filter (where cta_impression) as cta_impression_visitors,
          count(distinct visitor_id) filter (where clicked) as click_visitors,
          count(distinct visitor_id) filter (where added_to_cart) as cart_visitors,
          count(distinct visitor_id) filter (where checkout) as checkout_visitors,
          count(distinct visitor_id) filter (where purchase) as purchase_visitors,
          count(distinct visitor_id) filter (where campaign is not null and cta_impression) as attributed_cta_impression_visitors,
          count(distinct visitor_id) filter (where campaign is not null and clicked) as attributed_click_visitors,
          count(distinct visitor_id) filter (where campaign is not null and added_to_cart) as attributed_cart_visitors,
          count(distinct visitor_id) filter (where campaign is not null and checkout) as attributed_checkout_visitors,
          count(distinct visitor_id) filter (where campaign is not null and purchase) as attributed_purchase_visitors,
          coalesce(avg(visible_seconds) filter (where summary_count is not null), 0) as avg_visible_seconds,
          coalesce(avg(max_scroll) filter (where summary_count is not null), 0) as avg_scroll,
          count(*) filter (where quick_exit) as quick_exits,
          coalesce(avg(visible_seconds) filter (where campaign is not null and summary_count is not null), 0) as attributed_avg_visible_seconds,
          coalesce(avg(max_scroll) filter (where campaign is not null and summary_count is not null), 0) as attributed_avg_scroll,
          count(*) filter (where campaign is not null and summary_count is not null) as attributed_summary_sessions,
          count(*) filter (where campaign is not null and quick_exit) as attributed_quick_exits,
          coalesce(sum(javascript_errors), 0) as javascript_errors,
          count(*) filter (where device_type = 'mobile') as mobile_sessions,
          count(*) filter (where device_type = 'desktop') as desktop_sessions,
          count(*) filter (where device_type = 'tablet') as tablet_sessions
        from facts
      `,
      sql`
        with base_events as (
          select *
          from public.analytics_events
          where received_at >= now() - (${days} * interval '1 day')
            and coalesce(properties ->> 'test', 'false') <> 'true'
            and coalesce(properties ->> 'internal_traffic', 'false') <> 'true'
        ), attributed as (
          select distinct on (session_id)
            session_id,
            visitor_id,
            coalesce(nullif(utm_campaign, ''), nullif(properties #>> '{first_touch,utm_campaign}', '')) as campaign,
            coalesce(nullif(utm_content, ''), nullif(properties #>> '{first_touch,utm_content}', '')) as content
          from base_events
          where event_name = 'page_view'
          order by session_id, client_timestamp asc
        ), cohort as (
          select *
          from attributed
          where (${campaign} = '' or coalesce(campaign, '') = ${campaign})
            and (${content} = '' or coalesce(content, '') = ${content})
        ), visitor_counts as (
          select visitor_id, count(*) as sessions
          from cohort
          group by visitor_id
        )
        select
          coalesce(max(sessions), 0) as max_sessions_per_visitor,
          count(*) filter (where sessions > 1) as visitors_with_multiple_sessions,
          coalesce(sum(sessions), 0) as sessions,
          count(*) as visitors,
          coalesce(max(sessions)::numeric / nullif(sum(sessions), 0) * 100, 0) as top_visitor_session_share_percent
        from visitor_counts
      `,
      sql`
        with base_events as (
          select *
          from public.analytics_events
          where received_at >= now() - (${days} * interval '1 day')
            and coalesce(properties ->> 'test', 'false') <> 'true'
            and coalesce(properties ->> 'internal_traffic', 'false') <> 'true'
        ), attributed as (
          select distinct on (session_id)
            session_id,
            visitor_id,
            coalesce(nullif(utm_campaign, ''), nullif(properties #>> '{first_touch,utm_campaign}', '')) as campaign,
            coalesce(nullif(utm_content, ''), nullif(properties #>> '{first_touch,utm_content}', '')) as content,
            coalesce(nullif(fbclid, ''), nullif(properties #>> '{first_touch,fbclid}', '')) as fbclid
          from base_events
          where event_name = 'page_view'
          order by session_id, client_timestamp asc
        ), summaries as (
          select
            session_id,
            sum(coalesce(nullif(properties ->> 'visible_seconds', '')::numeric, 0)) as visible_seconds,
            max(coalesce(nullif(properties ->> 'max_scroll_depth', '')::numeric, 0)) as max_scroll
          from base_events
          where event_name = 'session_summary'
          group by session_id
        ), rollup as (
          select
            session_id,
            bool_or(event_name = 'cta_impression') as cta_impression,
            bool_or(event_name = 'buy_button_click') as clicked,
            bool_or(event_name = 'add_to_cart') as cart,
            bool_or(event_name = 'checkout_started') as checkout,
            bool_or(event_name = 'purchase') as purchase
          from base_events
          group by session_id
        )
        select
          a.campaign,
          a.content,
          count(distinct a.visitor_id) as visitors,
          count(*) as sessions,
          count(distinct a.fbclid) filter (where a.fbclid is not null) as paid_click_ids,
          count(*) filter (where s.session_id is not null) as summary_sessions,
          coalesce(avg(s.visible_seconds) filter (where s.session_id is not null), 0) as avg_visible_seconds,
          coalesce(avg(s.max_scroll) filter (where s.session_id is not null), 0) as avg_scroll,
          count(distinct a.visitor_id) filter (where coalesce(r.cta_impression, false)) as cta_impression_visitors,
          count(distinct a.visitor_id) filter (where coalesce(r.clicked, false)) as click_visitors,
          count(distinct a.visitor_id) filter (where coalesce(r.cart, false)) as cart_visitors,
          count(distinct a.visitor_id) filter (where coalesce(r.checkout, false)) as checkout_visitors,
          count(distinct a.visitor_id) filter (where coalesce(r.purchase, false)) as purchase_visitors
        from attributed a
        left join summaries s on s.session_id = a.session_id
        left join rollup r on r.session_id = a.session_id
        where (${campaign} = '' or coalesce(a.campaign, '') = ${campaign})
          and (${content} = '' or coalesce(a.content, '') = ${content})
        group by a.campaign, a.content
        order by purchase_visitors desc, checkout_visitors desc, click_visitors desc, visitors desc
        limit 30
      `,
      sql`
        with base_events as (
          select *
          from public.analytics_events
          where received_at >= now() - (${days} * interval '1 day')
            and coalesce(properties ->> 'test', 'false') <> 'true'
            and coalesce(properties ->> 'internal_traffic', 'false') <> 'true'
        ), attributed as (
          select distinct on (session_id)
            session_id,
            visitor_id,
            client_timestamp as started_at,
            device_type,
            coalesce(nullif(utm_source, ''), nullif(properties #>> '{first_touch,utm_source}', '')) as source,
            coalesce(nullif(utm_medium, ''), nullif(properties #>> '{first_touch,utm_medium}', '')) as medium,
            coalesce(nullif(utm_campaign, ''), nullif(properties #>> '{first_touch,utm_campaign}', '')) as campaign,
            coalesce(nullif(utm_content, ''), nullif(properties #>> '{first_touch,utm_content}', '')) as content,
            coalesce(nullif(fbclid, ''), nullif(properties #>> '{first_touch,fbclid}', '')) as fbclid,
            coalesce(nullif(properties ->> 'session_storage_version', '')::integer, 1) as session_storage_version,
            properties ->> 'session_started_at' as session_started_at
          from base_events
          where event_name = 'page_view'
          order by session_id, client_timestamp asc
        ), rollup as (
          select
            session_id,
            count(*) as event_count,
            bool_or(event_name = 'cta_impression') as cta_impression,
            bool_or(event_name = 'buy_button_click') as clicked,
            bool_or(event_name = 'checkout_started') as checkout,
            bool_or(event_name = 'purchase') as purchase
          from base_events
          group by session_id
        )
        select
          a.*,
          coalesce(r.event_count, 0) as event_count,
          coalesce(r.cta_impression, false) as cta_impression,
          coalesce(r.clicked, false) as clicked,
          coalesce(r.checkout, false) as checkout,
          coalesce(r.purchase, false) as purchase
        from attributed a
        left join rollup r on r.session_id = a.session_id
        where (${campaign} = '' or coalesce(a.campaign, '') = ${campaign})
          and (${content} = '' or coalesce(a.content, '') = ${content})
        order by a.started_at desc
        limit 20
      `,
      sql`
        select distinct
          coalesce(nullif(utm_campaign, ''), nullif(properties #>> '{first_touch,utm_campaign}', '')) as utm_campaign,
          coalesce(nullif(utm_content, ''), nullif(properties #>> '{first_touch,utm_content}', '')) as utm_content
        from public.analytics_events
        where received_at >= now() - interval '90 days'
          and event_name = 'page_view'
          and coalesce(properties ->> 'test', 'false') <> 'true'
          and coalesce(properties ->> 'internal_traffic', 'false') <> 'true'
        order by 1 nulls last, 2 nulls last
        limit 250
      `,
    ]);

  const summary = ((summaryResult as Row[])[0] ?? {}) as Row;
  const concentration = ((concentrationResult as Row[])[0] ?? {}) as Row;

  const visitors = num(summary.visitors);
  const sessions = num(summary.sessions);
  const summarySessions = num(summary.summary_sessions);
  const sessionV2Sessions = num(summary.session_v2_sessions);
  const attributedSessions = num(summary.attributed_sessions);
  const attributedVisitors = num(summary.attributed_visitors);
  const unattributedSessions = num(summary.unattributed_sessions);
  const unattributedVisitors = num(summary.unattributed_visitors);
  const paidClickIds = num(summary.paid_click_ids);
  const facebookSessionsWithoutFbclid = num(summary.facebook_sessions_without_fbclid);
  const ctaImpressionVisitors = num(summary.cta_impression_visitors);
  const clickVisitors = num(summary.click_visitors);
  const cartVisitors = num(summary.cart_visitors);
  const checkoutVisitors = num(summary.checkout_visitors);
  const purchaseVisitors = num(summary.purchase_visitors);
  const attributedCtaImpressionVisitors = num(summary.attributed_cta_impression_visitors);
  const attributedClickVisitors = num(summary.attributed_click_visitors);
  const attributedCartVisitors = num(summary.attributed_cart_visitors);
  const attributedCheckoutVisitors = num(summary.attributed_checkout_visitors);
  const attributedPurchaseVisitors = num(summary.attributed_purchase_visitors);
  const avgVisible = num(summary.avg_visible_seconds);
  const avgScroll = num(summary.avg_scroll);
  const attributedAvgVisible = num(summary.attributed_avg_visible_seconds);
  const attributedAvgScroll = num(summary.attributed_avg_scroll);
  const attributedSummarySessions = num(summary.attributed_summary_sessions);
  const attributedQuickExitRate = rate(
    num(summary.attributed_quick_exits),
    attributedSummarySessions,
  );
  const summaryCoverage = ratio(summarySessions, sessions);
  const attributedSummaryCoverage = ratio(attributedSummarySessions, attributedSessions);
  const sessionV2Coverage = ratio(sessionV2Sessions, sessions);
  const attributionCoverage = ratio(attributedVisitors, visitors);
  const sessionsPerVisitor = visitors > 0 ? sessions / visitors : 0;
  const maxSessionsPerVisitor = num(concentration.max_sessions_per_visitor);
  const visitorsWithMultipleSessions = num(concentration.visitors_with_multiple_sessions);
  const topVisitorShare = num(concentration.top_visitor_session_share_percent);

  const attributedCtaClickRate = rate(
    attributedClickVisitors,
    attributedCtaImpressionVisitors,
  );
  const attributedVisitorClickRate = rate(attributedClickVisitors, attributedVisitors);
  const attributedVisitorCheckoutRate = rate(
    attributedCheckoutVisitors,
    attributedVisitors,
  );
  const attributedCheckoutPurchaseRate = rate(
    attributedPurchaseVisitors,
    attributedCheckoutVisitors,
  );

  const creatives = (creativeResult as Row[]).map((row) => {
    const rawCampaign = nullableText(row.campaign);
    const rawCreative = nullableText(row.content);
    const creativeVisitors = num(row.visitors);
    const creativeSessions = num(row.sessions);
    const creativeSummarySessions = num(row.summary_sessions);
    const creativeCtaVisitors = num(row.cta_impression_visitors);
    const creativeClickVisitors = num(row.click_visitors);
    const creativeCheckoutVisitors = num(row.checkout_visitors);
    const creativePurchaseVisitors = num(row.purchase_visitors);
    const creativeSummaryCoverage = ratio(creativeSummarySessions, creativeSessions);
    const fullyAttributed = Boolean(rawCampaign && rawCreative);
    const eligibleForRanking =
      fullyAttributed &&
      creativeVisitors >= MIN_CREATIVE_VISITORS &&
      creativeSummaryCoverage >= MIN_SUMMARY_COVERAGE;
    const clickRate = rate(
      creativeClickVisitors,
      creativeCtaVisitors > 0 ? creativeCtaVisitors : creativeVisitors,
    );
    const directionalQualityScore = score(
      rate(creativePurchaseVisitors, creativeVisitors) * 8 +
        rate(creativeCheckoutVisitors, creativeVisitors) * 2.5 +
        clickRate * 1.2 +
        Math.min(num(row.avg_scroll), 100) * 0.18 +
        Math.min(num(row.avg_visible_seconds), 90) * 0.12,
    );

    return {
      campaign: rawCampaign ?? "Direto / não atribuído",
      creative: rawCreative ?? "Não informado",
      attribution_status: !rawCampaign
        ? "unattributed"
        : rawCreative
          ? "fully_attributed"
          : "campaign_only",
      unique_visitors: creativeVisitors,
      sessions: creativeSessions,
      sessions_per_visitor:
        creativeVisitors > 0 ? Number((creativeSessions / creativeVisitors).toFixed(2)) : 0,
      paid_click_ids: num(row.paid_click_ids),
      summary_sessions: creativeSummarySessions,
      summary_coverage_percent: Number((creativeSummaryCoverage * 100).toFixed(2)),
      avg_visible_seconds: Number(num(row.avg_visible_seconds).toFixed(1)),
      avg_scroll_percent: Number(num(row.avg_scroll).toFixed(1)),
      cta_impression_visitors: creativeCtaVisitors,
      click_visitors: creativeClickVisitors,
      cart_visitors: num(row.cart_visitors),
      checkout_visitors: creativeCheckoutVisitors,
      purchase_visitors: creativePurchaseVisitors,
      cta_click_rate_percent: clickRate,
      visitor_checkout_rate_percent: rate(creativeCheckoutVisitors, creativeVisitors),
      visitor_purchase_rate_percent: rate(creativePurchaseVisitors, creativeVisitors),
      directional_quality_score: directionalQualityScore,
      quality_score: eligibleForRanking ? directionalQualityScore : null,
      eligible_for_creative_ranking: eligibleForRanking,
      confidence: confidenceFromSample(
        creativeVisitors,
        creativeCheckoutVisitors,
        creativePurchaseVisitors,
      ),
    };
  });

  const behaviorSampleValid =
    attributedVisitors >= MIN_DIAGNOSTIC_VISITORS &&
    attributedSummaryCoverage >= MIN_SUMMARY_COVERAGE &&
    sessionV2Coverage >= MIN_SESSION_V2_COVERAGE;
  const offerSampleValid = attributedVisitors >= MIN_DIAGNOSTIC_VISITORS;
  const checkoutSampleValid = attributedCheckoutVisitors >= MIN_CHECKOUT_VISITORS;

  const trafficDirectional = score(
    70 - attributedQuickExitRate * 1.2 + Math.min(attributedAvgVisible, 60) * 0.5,
  );
  const landingDirectional = score(
    attributedAvgScroll * 0.5 +
      Math.min(attributedAvgVisible, 90) * 0.35 +
      attributedVisitorClickRate * 1.2,
  );
  const offerDirectional = score(
    (attributedCtaImpressionVisitors > 0
      ? attributedCtaClickRate
      : attributedVisitorClickRate) * 5 +
      attributedVisitorCheckoutRate * 4,
  );
  const checkoutDirectional =
    attributedCheckoutVisitors > 0 ? score(attributedCheckoutPurchaseRate * 1.2) : 0;

  const scoredAreas: ScoredArea[] = [
    {
      key: "traffic",
      label: "Aquisição / tráfego",
      score: behaviorSampleValid ? trafficDirectional : null,
      directionalScore: trafficDirectional,
      status: behaviorSampleValid
        ? "measured"
        : attributedVisitors > 0 && attributedSummarySessions > 0
          ? "directional"
          : "insufficient_data",
      minimumSample: `${MIN_DIAGNOSTIC_VISITORS} visitantes atribuídos, 80% de resumos e sessões v2`,
    },
    {
      key: "landing",
      label: "Landing page",
      score: behaviorSampleValid ? landingDirectional : null,
      directionalScore: landingDirectional,
      status: behaviorSampleValid
        ? "measured"
        : attributedVisitors > 0 && attributedSummarySessions > 0
          ? "directional"
          : "insufficient_data",
      minimumSample: `${MIN_DIAGNOSTIC_VISITORS} visitantes atribuídos, 80% de resumos e sessões v2`,
    },
    {
      key: "offer",
      label: "Oferta e CTA",
      score: offerSampleValid ? offerDirectional : null,
      directionalScore: offerDirectional,
      status: offerSampleValid
        ? "measured"
        : attributedVisitors > 0
          ? "directional"
          : "insufficient_data",
      minimumSample: `${MIN_DIAGNOSTIC_VISITORS} visitantes atribuídos`,
    },
    {
      key: "checkout",
      label: "Checkout",
      score: checkoutSampleValid ? checkoutDirectional : null,
      directionalScore: checkoutDirectional,
      status: checkoutSampleValid
        ? "measured"
        : attributedCheckoutVisitors > 0
          ? "directional"
          : "insufficient_data",
      minimumSample: `${MIN_CHECKOUT_VISITORS} visitantes atribuídos no checkout`,
    },
  ];

  const measuredAreas = scoredAreas.filter(
    (area): area is ScoredArea & { score: number } => area.score !== null,
  );
  const biggestBottleneck =
    measuredAreas.length > 0
      ? [...measuredAreas].sort((a, b) => a.score - b.score)[0]
      : null;

  const eligibleCreativeScores = creatives
    .filter((item) => item.eligible_for_creative_ranking && item.quality_score !== null)
    .map((item) => item.quality_score as number);
  const bestCreativeQuality =
    eligibleCreativeScores.length > 0 ? Math.max(...eligibleCreativeScores) : null;

  const weights = { traffic: 0.18, landing: 0.28, offer: 0.34, checkout: 0.2 };
  const weightedScores = measuredAreas.map((area) => ({
    value: area.score,
    weight: weights[area.key],
  }));
  if (bestCreativeQuality !== null) {
    weightedScores.push({ value: bestCreativeQuality, weight: 0.1 });
  }
  const totalWeight = weightedScores.reduce((sum, item) => sum + item.weight, 0);
  const healthScore =
    totalWeight >= 0.6
      ? score(
          weightedScores.reduce((sum, item) => sum + item.value * item.weight, 0) /
            totalWeight,
        )
      : null;
  const confidence = confidenceFromSample(
    attributedVisitors,
    attributedCheckoutVisitors,
    attributedPurchaseVisitors,
  );

  const dataQualityWarnings: string[] = [];
  if (visitors < MIN_DIAGNOSTIC_VISITORS) {
    dataQualityWarnings.push(
      `Amostra pequena: ${visitors} visitantes únicos. Não declare vencedor ou gargalo causal.`,
    );
  }
  if (attributedVisitors < MIN_DIAGNOSTIC_VISITORS) {
    dataQualityWarnings.push(
      `Somente ${attributedVisitors} visitantes possuem campanha atribuída; os scores permanecem direcionais.`,
    );
  }
  if (summaryCoverage < MIN_SUMMARY_COVERAGE) {
    dataQualityWarnings.push(
      `A cobertura de session_summary é ${rate(summarySessions, sessions)}%; médias comportamentais podem estar enviesadas.`,
    );
  }
  if (sessionV2Coverage < MIN_SESSION_V2_COVERAGE) {
    dataQualityWarnings.push(
      `Apenas ${rate(sessionV2Sessions, sessions)}% das sessões usam persistência v2. Aguarde tráfego novo antes de comparar com o histórico fragmentado.`,
    );
  }
  if (visitors > 0 && sessionsPerVisitor >= 1.8) {
    dataQualityWarnings.push(
      `${sessions} sessões para ${visitors} visitantes (${sessionsPerVisitor.toFixed(2)} por visitante) ainda indicam recorrência alta ou fragmentação histórica.`,
    );
  }
  if (topVisitorShare >= 35) {
    dataQualityWarnings.push(
      `Um único visitante concentra ${topVisitorShare.toFixed(1)}% das sessões. Trate a amostra como altamente concentrada.`,
    );
  }
  if (visitorsWithMultipleSessions > 0) {
    dataQualityWarnings.push(
      `${visitorsWithMultipleSessions} visitantes possuem mais de uma sessão; o máximo observado é ${maxSessionsPerVisitor}.`,
    );
  }
  if (visitors > 0 && attributionCoverage < 0.8) {
    dataQualityWarnings.push(
      `${unattributedVisitors} de ${visitors} visitantes estão sem campanha atribuída.`,
    );
  }
  if (facebookSessionsWithoutFbclid > 0) {
    dataQualityWarnings.push(
      `${facebookSessionsWithoutFbclid} sessões atribuídas ao Facebook não possuem fbclid; custo e cliques pagos reais não podem ser inferidos.`,
    );
  }
  if (sessions >= 10 && num(summary.mobile_sessions) === 0) {
    dataQualityWarnings.push(
      "Nenhuma sessão mobile foi registrada. Confirme segmentação, classificação e instalação do tracker na versão mobile.",
    );
  }
  if (attributedCheckoutVisitors < MIN_CHECKOUT_VISITORS) {
    dataQualityWarnings.push(
      `Checkout possui ${attributedCheckoutVisitors} visitantes atribuídos; são necessários pelo menos ${MIN_CHECKOUT_VISITORS} para uma leitura inicial.`,
    );
  }
  if (dataQualityWarnings.length === 0) {
    dataQualityWarnings.push("Nenhum alerta estrutural relevante foi detectado neste recorte.");
  }

  const tests: TestRecommendation[] = [];
  if (
    sessionV2Coverage < MIN_SESSION_V2_COVERAGE ||
    topVisitorShare >= 35 ||
    sessionsPerVisitor >= 1.8
  ) {
    tests.push({
      priority: tests.length + 1,
      area: "Integridade de sessão",
      test: "Acumular tráfego com sessão v2 e comparar visitantes, sessões e concentração",
      hypothesis:
        "A leitura histórica ainda mistura sessões antigas fragmentadas com o novo modelo persistente de 30 minutos.",
      impact: "Muito alto",
      difficulty: "Baixa",
      success_metric:
        "Atingir 80% de sessões v2, reduzir a concentração do maior visitante e estabilizar sessões por visitante.",
    });
  }
  if (attributionCoverage < 0.8 || facebookSessionsWithoutFbclid > 0) {
    tests.push({
      priority: tests.length + 1,
      area: "Atribuição de mídia",
      test: "Validar UTMs e preservar fbclid na primeira page view",
      hypothesis:
        "Parte do tráfego pago pode estar chegando sem identificador suficiente para separar clique real, retorno e acesso direto.",
      impact: "Muito alto",
      difficulty: "Média",
      success_metric:
        "Atingir 90% de visitantes atribuídos e registrar fbclid quando ele existir na URL de entrada.",
    });
  }
  if (attributedVisitors >= 5 && attributedVisitorClickRate < 10) {
    tests.push({
      priority: tests.length + 1,
      area: "Oferta e CTA",
      test: "Medir impressão do CTA e alterar somente a primeira dobra",
      hypothesis:
        "Após estabilizar visitantes únicos, a página pode estar gerando consumo sem transformar atenção em ação.",
      impact: "Muito alto",
      difficulty: "Baixa",
      success_metric:
        "Elevar visitantes que clicam ÷ visitantes que visualizaram o CTA, sem usar sessões como denominador principal.",
    });
  }
  if (
    attributedCheckoutVisitors >= MIN_CHECKOUT_VISITORS &&
    attributedCheckoutPurchaseRate < 30
  ) {
    tests.push({
      priority: tests.length + 1,
      area: "Checkout",
      test: "Isolar frete, prazo, confiança e falhas de pagamento em testes separados",
      hypothesis:
        "Com volume mínimo por visitante, a perda após checkout pode indicar fricção comercial ou técnica.",
      impact: "Muito alto",
      difficulty: "Média",
      success_metric: "Aumentar visitantes com compra ÷ visitantes no checkout para pelo menos 30%.",
    });
  }
  if (tests.length === 0) {
    tests.push({
      priority: 1,
      area: "Amostra",
      test: "Acumular visitantes únicos sem alterar múltiplas variáveis",
      hypothesis: "Os sinais atuais ainda não apontam um gargalo confiável.",
      impact: "Médio",
      difficulty: "Baixa",
      success_metric: `Atingir pelo menos ${MIN_DIAGNOSTIC_VISITORS} visitantes atribuídos e ${MIN_CHECKOUT_VISITORS} no checkout.`,
    });
  }

  const directionalBottleneck =
    attributedVisitors >= 5 && attributedClickVisitors === 0
      ? "Página para CTA no tráfego atribuído"
      : biggestBottleneck?.label ?? null;

  const mainDiagnosis =
    visitors === 0
      ? "Nenhum visitante válido foi encontrado neste recorte."
      : sessionV2Coverage < MIN_SESSION_V2_COVERAGE
        ? "O tracker de sessão foi corrigido, mas o recorte ainda contém histórico fragmentado. Priorize tráfego novo com sessão v2 antes de julgar a página."
        : topVisitorShare >= 35
          ? "A amostra está concentrada em poucos visitantes. Use visitantes únicos, não sessões, como unidade principal de decisão."
          : attributedVisitors < MIN_DIAGNOSTIC_VISITORS
            ? `Há ${attributedVisitors} visitantes atribuídos, abaixo do mínimo de ${MIN_DIAGNOSTIC_VISITORS}. O sinal é direcional, não causal.`
            : biggestBottleneck?.key === "checkout"
              ? "Com amostra mínima por visitante, a maior perda medida ocorre após o início do checkout."
              : biggestBottleneck?.key === "offer"
                ? "A oferta converte visitantes expostos em ação abaixo dos demais estágios medidos."
                : biggestBottleneck?.key === "landing"
                  ? "A landing sustenta atenção ou progressão abaixo dos demais estágios medidos."
                  : "Os dados medidos apontam primeiro para aquisição ou congruência anúncio-página.";

  const benchmarkPurchaseRate = Math.max(
    rate(attributedPurchaseVisitors, attributedVisitors),
    2,
  );
  const potentialPurchasesAtBenchmark = Number(
    ((attributedVisitors * benchmarkPurchaseRate) / 100).toFixed(2),
  );
  const estimatedMissingPurchases = Number(
    Math.max(0, potentialPurchasesAtBenchmark - attributedPurchaseVisitors).toFixed(2),
  );
  const estimatedRevenueGap =
    aov === null ? null : Number((estimatedMissingPurchases * aov).toFixed(2));
  const estimatedPaidTrafficCost =
    cpc === null || paidClickIds === 0 ? null : Number((paidClickIds * cpc).toFixed(2));

  const exportData = {
    schema: "conversion_tracker_campaign_dna_v4",
    generated_at: new Date().toISOString(),
    analysis_request:
      "Valide o diagnóstico usando visitantes únicos, conteste conclusões frágeis, identifique concentração e recomende testes incrementais. Não trate sessões como pessoas nem correlação como causalidade.",
    filters: { days, campaign: campaign || null, creative: content || null },
    business_inputs: {
      average_order_value: aov,
      average_cost_per_click: cpc,
      currency: "BRL",
    },
    attribution: {
      model: "first_page_view_per_session",
      fallback: "properties.first_touch",
      test_and_internal_traffic_excluded: true,
      purchase_requires_same_session: true,
      cross_session_purchase_resolution: false,
      limitation:
        "Compras confirmadas em outra sessão, domínio ou webhook podem ficar sem a campanha original.",
    },
    session_integrity: {
      model: "local_storage_with_30_minute_inactivity_timeout",
      unique_visitors: visitors,
      sessions,
      sessions_per_visitor: Number(sessionsPerVisitor.toFixed(2)),
      session_v2_sessions: sessionV2Sessions,
      session_v2_coverage_percent: Number((sessionV2Coverage * 100).toFixed(2)),
      max_sessions_per_visitor: maxSessionsPerVisitor,
      visitors_with_multiple_sessions: visitorsWithMultipleSessions,
      top_visitor_session_share_percent: Number(topVisitorShare.toFixed(2)),
    },
    data_quality: {
      summary_sessions: summarySessions,
      summary_coverage_percent: Number((summaryCoverage * 100).toFixed(2)),
      attributed_visitors: attributedVisitors,
      attributed_sessions: attributedSessions,
      unattributed_visitors: unattributedVisitors,
      unattributed_sessions: unattributedSessions,
      visitor_attribution_coverage_percent: Number((attributionCoverage * 100).toFixed(2)),
      paid_click_ids: paidClickIds,
      facebook_sessions_without_fbclid: facebookSessionsWithoutFbclid,
      mobile_sessions: num(summary.mobile_sessions),
      desktop_sessions: num(summary.desktop_sessions),
      tablet_sessions: num(summary.tablet_sessions),
      warnings: dataQualityWarnings,
    },
    campaign_dna: {
      health_score: healthScore,
      health_label: healthLabel(healthScore),
      confidence_score: confidence,
      sample_warning: attributedVisitors < MIN_DIAGNOSTIC_VISITORS,
      traffic_quality_score: scoredAreas.find((area) => area.key === "traffic")?.score ?? null,
      landing_quality_score: scoredAreas.find((area) => area.key === "landing")?.score ?? null,
      offer_quality_score: scoredAreas.find((area) => area.key === "offer")?.score ?? null,
      checkout_quality_score: scoredAreas.find((area) => area.key === "checkout")?.score ?? null,
      directional_scores: Object.fromEntries(
        scoredAreas.map((area) => [area.key, area.directionalScore]),
      ),
      score_status: Object.fromEntries(scoredAreas.map((area) => [area.key, area.status])),
      best_creative_quality_score: bestCreativeQuality,
      biggest_bottleneck: biggestBottleneck?.label ?? null,
      directional_bottleneck: directionalBottleneck,
      main_diagnosis: mainDiagnosis,
    },
    funnel_by_unique_visitor: {
      aggregate: {
        visitors,
        cta_impression_visitors: ctaImpressionVisitors,
        click_visitors: clickVisitors,
        cart_visitors: cartVisitors,
        checkout_visitors: checkoutVisitors,
        purchase_visitors: purchaseVisitors,
      },
      attributed_campaign_traffic: {
        visitors: attributedVisitors,
        sessions: attributedSessions,
        cta_impression_visitors: attributedCtaImpressionVisitors,
        click_visitors: attributedClickVisitors,
        cart_visitors: attributedCartVisitors,
        checkout_visitors: attributedCheckoutVisitors,
        purchase_visitors: attributedPurchaseVisitors,
        cta_click_rate_percent: attributedCtaClickRate,
        visitor_click_rate_percent: attributedVisitorClickRate,
        visitor_checkout_rate_percent: attributedVisitorCheckoutRate,
        checkout_to_purchase_percent: attributedCheckoutPurchaseRate,
      },
      unattributed_traffic: {
        visitors: unattributedVisitors,
        sessions: unattributedSessions,
      },
    },
    behavior: {
      aggregate: {
        avg_visible_seconds: Number(avgVisible.toFixed(1)),
        avg_scroll_percent: Number(avgScroll.toFixed(1)),
        quick_exits: num(summary.quick_exits),
        summary_sessions: summarySessions,
      },
      attributed_campaign_traffic: {
        avg_visible_seconds: Number(attributedAvgVisible.toFixed(1)),
        avg_scroll_percent: Number(attributedAvgScroll.toFixed(1)),
        quick_exit_rate_percent: attributedQuickExitRate,
        summary_sessions: attributedSummarySessions,
      },
      javascript_errors: num(summary.javascript_errors),
    },
    opportunity_estimate: {
      benchmark_purchase_rate_percent: benchmarkPurchaseRate,
      attributed_visitors_used: attributedVisitors,
      potential_purchases_at_benchmark: potentialPurchasesAtBenchmark,
      estimated_missing_purchases: estimatedMissingPurchases,
      estimated_revenue_gap: estimatedRevenueGap,
      paid_click_ids_used: paidClickIds,
      estimated_paid_traffic_cost: estimatedPaidTrafficCost,
      caveat:
        "Custo só é estimado quando há fbclid distinto. Sessões e visitantes não são tratados como cliques pagos.",
    },
    prioritized_tests: tests,
    creatives,
    recent_sessions: (sessionResult as Row[]).map((row) => ({
      session_id: row.session_id,
      visitor_id: row.visitor_id,
      started_at: row.started_at,
      session_started_at: row.session_started_at,
      session_storage_version: num(row.session_storage_version),
      device: row.device_type,
      source: nullableText(row.source),
      medium: nullableText(row.medium),
      campaign: nullableText(row.campaign) ?? "Direto / não atribuído",
      creative: nullableText(row.content) ?? "Não informado",
      fbclid_present: Boolean(nullableText(row.fbclid)),
      event_count: num(row.event_count),
      cta_impression: bool(row.cta_impression),
      clicked: bool(row.clicked),
      checkout: bool(row.checkout),
      purchase: bool(row.purchase),
    })),
    interpretation_notes: [
      "Visitantes únicos são a unidade principal de confiança e conversão.",
      "Sessões v2 persistem entre abas e expiram após 30 minutos de inatividade.",
      "Tráfego interno é marcado como test e excluído das consultas.",
      "Score nulo significa amostra insuficiente, não desempenho zero.",
      "Custo não é estimado a partir de sessões; exige fbclid distinto.",
      "Correlação entre rolagem, tempo e conversão não comprova causalidade.",
    ],
  };

  const code = JSON.stringify(exportData, null, 2);
  const filters = filterResult as Row[];
  const campaigns = Array.from(
    new Set(filters.map((row) => String(row.utm_campaign ?? "").trim()).filter(Boolean)),
  );
  const contents = Array.from(
    new Set(
      filters
        .filter((row) => !campaign || row.utm_campaign === campaign)
        .map((row) => String(row.utm_content ?? "").trim())
        .filter(Boolean),
    ),
  );

  return (
    <main className="shell dashboardShell">
      <header className="dashboardHeader">
        <div>
          <p className="eyebrow">ITERAÇÃO 10</p>
          <h1 className="dashboardTitle">DNA da campanha</h1>
          <p className="subtitle dashboardSubtitle">
            Diagnóstico por visitantes únicos, sessões persistentes e concentração real da amostra.
          </p>
        </div>
        <Link className="secondaryLink" href="/">Voltar à central</Link>
      </header>

      <form className="filterBar" method="get">
        <label><span>Período</span><select name="days" defaultValue={String(days)}><option value="1">24 horas</option><option value="7">7 dias</option><option value="14">14 dias</option><option value="30">30 dias</option><option value="90">90 dias</option></select></label>
        <label><span>Campanha</span><select name="campaign" defaultValue={campaign}><option value="">Todas</option>{campaigns.map((item) => <option key={item}>{item}</option>)}</select></label>
        <label><span>Criativo</span><select name="content" defaultValue={content}><option value="">Todos</option>{contents.map((item) => <option key={item}>{item}</option>)}</select></label>
        <label><span>Ticket médio (R$)</span><input name="aov" inputMode="decimal" defaultValue={aov ?? ""} placeholder="169" /></label>
        <label><span>CPC médio (R$)</span><input name="cpc" inputMode="decimal" defaultValue={cpc ?? ""} placeholder="1,70" /></label>
        <button className="filterButton" type="submit">Gerar diagnóstico</button>
      </form>

      <section className="metricGrid" aria-label="DNA da campanha">
        <article className="metricCard"><span>Saúde geral</span><strong>{healthScore === null ? "N/D" : `${healthScore}/100`}</strong><small>{healthLabel(healthScore)}</small></article>
        <article className="metricCard"><span>Visitantes atribuídos</span><strong>{attributedVisitors}</strong><small>{attributedSessions} sessões</small></article>
        <article className="metricCard"><span>Sessões v2</span><strong>{rate(sessionV2Sessions, sessions)}%</strong><small>persistência entre abas</small></article>
        <article className="metricCard"><span>Maior gargalo</span><strong style={{ fontSize: 20 }}>{biggestBottleneck?.label ?? "Não determinado"}</strong><small>{directionalBottleneck ? `Sinal: ${directionalBottleneck}` : "Sem sinal suficiente"}</small></article>
      </section>

      <section className="panel">
        <div className="panelHeader dashboardPanelHeader">
          <div><p className="eyebrow">INTEGRIDADE DE SESSÃO</p><h2>{sessions} sessões para {visitors} visitantes</h2></div>
          <span className="hint">Maior visitante: {topVisitorShare.toFixed(1)}% das sessões</span>
        </div>
        <div className="funnelList">
          {dataQualityWarnings.map((warning, index) => (
            <article className="funnelRow" key={`${index}-${warning}`}>
              <div className="funnelCopy"><div><strong>{warning}</strong><code>alerta_{index + 1}</code></div></div>
            </article>
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="panelHeader dashboardPanelHeader">
          <div><p className="eyebrow">DIAGNÓSTICO</p><h2>{mainDiagnosis}</h2></div>
          <span className="hint">Confiança {confidence}/100</span>
        </div>
        <div className="funnelList">
          {scoredAreas.map((area) => (
            <article className="funnelRow" key={area.key}>
              <div className="funnelCopy">
                <div><strong>{area.label}</strong><code>{area.key}_quality · {statusLabel(area.status)}</code><small>Mínimo: {area.minimumSample}</small></div>
                <div className="funnelNumbers"><strong>{area.score === null ? "N/D" : area.score}</strong><span>{area.score === null ? `sinal ${area.directionalScore}` : "/100"}</span></div>
              </div>
              <div className="funnelTrack"><div className="funnelFill" style={{ width: `${area.directionalScore}%` }} /></div>
            </article>
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="panelHeader dashboardPanelHeader">
          <div><p className="eyebrow">PLANO DE AÇÃO</p><h2>Testes incrementais priorizados</h2></div>
          <span className="hint">Visitantes, não sessões</span>
        </div>
        <div className="funnelList">
          {tests.map((test) => (
            <article className="funnelRow" key={`${test.priority}-${test.test}`}>
              <div className="funnelCopy">
                <div><strong>{test.priority}. {test.test}</strong><code>{test.area}</code><small>{test.hypothesis}</small></div>
                <div className="funnelNumbers"><strong>{test.impact}</strong><span>{test.difficulty}</span></div>
              </div>
            </article>
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="panelHeader dashboardPanelHeader">
          <div><p className="eyebrow">PACOTE ESTRUTURADO</p><h2>Código pronto para copiar</h2></div>
          <CopyButton value={code} />
        </div>
        <p className="subtitle" style={{ marginBottom: 16 }}>
          O JSON v4 mede concentração, visitantes únicos, sessões v2, fbclid e tráfego interno.
        </p>
        <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 720, overflow: "auto", padding: 20, borderRadius: 16, background: "rgba(0,0,0,.28)", fontSize: 13, lineHeight: 1.55 }}>
          <code>{code}</code>
        </pre>
      </section>
    </main>
  );
}
