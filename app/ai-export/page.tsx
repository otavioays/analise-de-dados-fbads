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

type TestRecommendation = {
  priority: number;
  area: string;
  test: string;
  hypothesis: string;
  impact: "Muito alto" | "Alto" | "Médio";
  difficulty: "Baixa" | "Média" | "Alta";
  success_metric: string;
};

type ScoreStatus = "measured" | "directional" | "insufficient_data";

type ScoredArea = {
  key: "traffic" | "landing" | "offer" | "checkout";
  label: string;
  score: number | null;
  directionalScore: number;
  status: ScoreStatus;
  minimumSample: string;
};

const validPeriods = new Set([1, 7, 14, 30, 90]);
const MIN_DIAGNOSTIC_SESSIONS = 30;
const MIN_CREATIVE_SESSIONS = 20;
const MIN_CHECKOUTS = 10;
const MIN_SUMMARY_COVERAGE = 0.8;

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

function confidenceFromSample(sessions: number, checkouts: number, purchases: number): number {
  const sessionComponent = Math.sqrt(Math.min(sessions, 100) / 100) * 70;
  const checkoutComponent = Math.sqrt(Math.min(checkouts, 10) / 10) * 20;
  const purchaseComponent = (Math.min(purchases, 5) / 5) * 10;
  return score(sessionComponent + checkoutComponent + purchaseComponent);
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

  const [summaryResult, creativeResult, sessionResult, filterResult] = await Promise.all([
    sql`
      with base_events as (
        select *
        from public.analytics_events
        where received_at >= now() - (${days} * interval '1 day')
          and coalesce(properties ->> 'test', 'false') <> 'true'
      ), attributed as (
        select distinct on (session_id)
          session_id,
          visitor_id,
          client_timestamp as started_at,
          device_type,
          coalesce(nullif(utm_source, ''), nullif(properties #>> '{first_touch,utm_source}', '')) as source,
          coalesce(nullif(utm_medium, ''), nullif(properties #>> '{first_touch,utm_medium}', '')) as medium,
          coalesce(nullif(utm_campaign, ''), nullif(properties #>> '{first_touch,utm_campaign}', '')) as campaign,
          coalesce(nullif(utm_content, ''), nullif(properties #>> '{first_touch,utm_content}', '')) as content
        from base_events
        where event_name = 'page_view'
        order by session_id, client_timestamp asc
      ), cohort as (
        select * from attributed
        where (${campaign} = '' or coalesce(campaign, '') = ${campaign})
          and (${content} = '' or coalesce(content, '') = ${content})
      ), summaries as (
        select distinct on (session_id)
          session_id,
          nullif(properties ->> 'visible_seconds', '')::numeric as visible_seconds,
          nullif(properties ->> 'max_scroll_depth', '')::numeric as max_scroll,
          coalesce((properties ->> 'quick_exit')::boolean, false) as quick_exit
        from base_events
        where event_name = 'session_summary'
        order by session_id, client_timestamp desc
      ), event_rollup as (
        select
          session_id,
          count(*) as event_count,
          bool_or(event_name = 'buy_button_click') as clicked,
          bool_or(event_name = 'add_to_cart') as added_to_cart,
          bool_or(event_name = 'checkout_started') as checkout,
          bool_or(event_name = 'purchase') as purchase,
          count(*) filter (where event_name = 'javascript_error') as javascript_errors
        from base_events
        group by session_id
      )
      select
        count(distinct c.visitor_id) as visitors,
        count(*) as sessions,
        count(*) filter (where coalesce(r.clicked, false)) as clicks,
        count(*) filter (where coalesce(r.added_to_cart, false)) as carts,
        count(*) filter (where coalesce(r.checkout, false)) as checkouts,
        count(*) filter (where coalesce(r.purchase, false)) as purchases,
        coalesce(avg(s.visible_seconds) filter (where s.session_id is not null), 0) as avg_visible_seconds,
        coalesce(avg(s.max_scroll) filter (where s.session_id is not null), 0) as avg_scroll,
        count(*) filter (where s.quick_exit) as quick_exits,
        coalesce(sum(r.javascript_errors), 0) as javascript_errors,
        count(*) filter (where s.session_id is not null) as summary_sessions,
        count(*) filter (where c.campaign is not null) as attributed_sessions,
        count(*) filter (where c.campaign is null) as unattributed_sessions,
        count(*) filter (where c.campaign is not null and coalesce(r.clicked, false)) as attributed_clicks,
        count(*) filter (where c.campaign is null and coalesce(r.clicked, false)) as unattributed_clicks,
        count(*) filter (where c.campaign is not null and coalesce(r.added_to_cart, false)) as attributed_carts,
        count(*) filter (where c.campaign is null and coalesce(r.added_to_cart, false)) as unattributed_carts,
        count(*) filter (where c.campaign is not null and coalesce(r.checkout, false)) as attributed_checkouts,
        count(*) filter (where c.campaign is null and coalesce(r.checkout, false)) as unattributed_checkouts,
        count(*) filter (where c.campaign is not null and coalesce(r.purchase, false)) as attributed_purchases,
        count(*) filter (where c.campaign is null and coalesce(r.purchase, false)) as unattributed_purchases,
        count(*) filter (where c.campaign is not null and s.session_id is not null) as attributed_summary_sessions,
        coalesce(avg(s.visible_seconds) filter (where c.campaign is not null and s.session_id is not null), 0) as attributed_avg_visible_seconds,
        coalesce(avg(s.max_scroll) filter (where c.campaign is not null and s.session_id is not null), 0) as attributed_avg_scroll,
        count(*) filter (where c.campaign is not null and s.quick_exit) as attributed_quick_exits,
        count(*) filter (where c.device_type = 'mobile') as mobile_sessions,
        count(*) filter (where c.device_type = 'desktop') as desktop_sessions,
        count(*) filter (where c.device_type = 'tablet') as tablet_sessions
      from cohort c
      left join event_rollup r on r.session_id = c.session_id
      left join summaries s on s.session_id = c.session_id
    `,
    sql`
      with base_events as (
        select *
        from public.analytics_events
        where received_at >= now() - (${days} * interval '1 day')
          and coalesce(properties ->> 'test', 'false') <> 'true'
      ), attributed as (
        select distinct on (session_id)
          session_id,
          coalesce(nullif(utm_campaign, ''), nullif(properties #>> '{first_touch,utm_campaign}', '')) as campaign,
          coalesce(nullif(utm_content, ''), nullif(properties #>> '{first_touch,utm_content}', '')) as content
        from base_events
        where event_name = 'page_view'
        order by session_id, client_timestamp asc
      ), summaries as (
        select distinct on (session_id)
          session_id,
          nullif(properties ->> 'visible_seconds', '')::numeric as visible_seconds,
          nullif(properties ->> 'max_scroll_depth', '')::numeric as max_scroll
        from base_events
        where event_name = 'session_summary'
        order by session_id, client_timestamp desc
      ), event_rollup as (
        select
          session_id,
          bool_or(event_name = 'buy_button_click') as clicked,
          bool_or(event_name = 'add_to_cart') as added_to_cart,
          bool_or(event_name = 'checkout_started') as checkout,
          bool_or(event_name = 'purchase') as purchase
        from base_events
        group by session_id
      )
      select
        a.campaign,
        a.content,
        count(*) as sessions,
        count(*) filter (where coalesce(r.clicked, false)) as clicks,
        count(*) filter (where coalesce(r.added_to_cart, false)) as carts,
        count(*) filter (where coalesce(r.checkout, false)) as checkouts,
        count(*) filter (where coalesce(r.purchase, false)) as purchases,
        coalesce(avg(s.visible_seconds) filter (where s.session_id is not null), 0) as avg_visible_seconds,
        coalesce(avg(s.max_scroll) filter (where s.session_id is not null), 0) as avg_scroll,
        count(*) filter (where s.session_id is not null) as summary_sessions
      from attributed a
      left join event_rollup r on r.session_id = a.session_id
      left join summaries s on s.session_id = a.session_id
      where (${campaign} = '' or coalesce(a.campaign, '') = ${campaign})
        and (${content} = '' or coalesce(a.content, '') = ${content})
      group by a.campaign, a.content
      order by purchases desc, checkouts desc, clicks desc, sessions desc
      limit 30
    `,
    sql`
      with base_events as (
        select *
        from public.analytics_events
        where received_at >= now() - (${days} * interval '1 day')
          and coalesce(properties ->> 'test', 'false') <> 'true'
      ), attributed as (
        select distinct on (session_id)
          session_id,
          visitor_id,
          client_timestamp as started_at,
          device_type,
          coalesce(nullif(utm_source, ''), nullif(properties #>> '{first_touch,utm_source}', '')) as source,
          coalesce(nullif(utm_medium, ''), nullif(properties #>> '{first_touch,utm_medium}', '')) as medium,
          coalesce(nullif(utm_campaign, ''), nullif(properties #>> '{first_touch,utm_campaign}', '')) as campaign,
          coalesce(nullif(utm_content, ''), nullif(properties #>> '{first_touch,utm_content}', '')) as content
        from base_events
        where event_name = 'page_view'
        order by session_id, client_timestamp asc
      ), event_rollup as (
        select
          session_id,
          count(*) as event_count,
          bool_or(event_name = 'buy_button_click') as clicked,
          bool_or(event_name = 'checkout_started') as checkout,
          bool_or(event_name = 'purchase') as purchase
        from base_events
        group by session_id
      )
      select
        a.session_id,
        a.visitor_id,
        a.started_at,
        a.device_type,
        a.source,
        a.medium,
        a.campaign,
        a.content,
        coalesce(r.event_count, 0) as event_count,
        coalesce(r.clicked, false) as clicked,
        coalesce(r.checkout, false) as checkout,
        coalesce(r.purchase, false) as purchase
      from attributed a
      left join event_rollup r on r.session_id = a.session_id
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
      order by 1 nulls last, 2 nulls last
      limit 250
    `,
  ]);

  const summary = ((summaryResult as Row[])[0] ?? {}) as Row;
  const visitors = num(summary.visitors);
  const sessions = num(summary.sessions);
  const clicks = num(summary.clicks);
  const carts = num(summary.carts);
  const checkouts = num(summary.checkouts);
  const purchases = num(summary.purchases);
  const summarySessions = num(summary.summary_sessions);
  const attributedSessions = num(summary.attributed_sessions);
  const unattributedSessions = num(summary.unattributed_sessions);
  const attributedClicks = num(summary.attributed_clicks);
  const unattributedClicks = num(summary.unattributed_clicks);
  const attributedCarts = num(summary.attributed_carts);
  const unattributedCarts = num(summary.unattributed_carts);
  const attributedCheckouts = num(summary.attributed_checkouts);
  const unattributedCheckouts = num(summary.unattributed_checkouts);
  const attributedPurchases = num(summary.attributed_purchases);
  const unattributedPurchases = num(summary.unattributed_purchases);
  const attributedSummarySessions = num(summary.attributed_summary_sessions);
  const avgVisible = num(summary.avg_visible_seconds);
  const avgScroll = num(summary.avg_scroll);
  const attributedAvgVisible = num(summary.attributed_avg_visible_seconds);
  const attributedAvgScroll = num(summary.attributed_avg_scroll);
  const quickExitRate = rate(num(summary.quick_exits), summarySessions);
  const attributedQuickExitRate = rate(
    num(summary.attributed_quick_exits),
    attributedSummarySessions,
  );
  const clickRate = rate(clicks, sessions);
  const checkoutRate = rate(checkouts, sessions);
  const purchaseRate = rate(purchases, sessions);
  const checkoutToPurchase = rate(purchases, checkouts);
  const attributedClickRate = rate(attributedClicks, attributedSessions);
  const attributedCheckoutRate = rate(attributedCheckouts, attributedSessions);
  const attributedPurchaseRate = rate(attributedPurchases, attributedSessions);
  const attributedCheckoutToPurchase = rate(attributedPurchases, attributedCheckouts);
  const summaryCoverage = ratio(summarySessions, sessions);
  const attributedSummaryCoverage = ratio(attributedSummarySessions, attributedSessions);
  const attributionCoverage = ratio(attributedSessions, sessions);

  const creatives = (creativeResult as Row[]).map((row) => {
    const rawCampaign = nullableText(row.campaign);
    const rawCreative = nullableText(row.content);
    const creativeSessions = num(row.sessions);
    const creativeClicks = num(row.clicks);
    const creativeCarts = num(row.carts);
    const creativeCheckouts = num(row.checkouts);
    const creativePurchases = num(row.purchases);
    const creativeScroll = num(row.avg_scroll);
    const creativeVisible = num(row.avg_visible_seconds);
    const creativeSummarySessions = num(row.summary_sessions);
    const creativeSummaryCoverage = ratio(creativeSummarySessions, creativeSessions);
    const fullyAttributed = Boolean(rawCampaign && rawCreative);
    const eligibleForRanking =
      fullyAttributed &&
      creativeSessions >= MIN_CREATIVE_SESSIONS &&
      creativeSummaryCoverage >= MIN_SUMMARY_COVERAGE;
    const directionalQualityScore = score(
      rate(creativePurchases, creativeSessions) * 8 +
        rate(creativeCheckouts, creativeSessions) * 2.5 +
        rate(creativeClicks, creativeSessions) * 1.2 +
        Math.min(creativeScroll, 100) * 0.18 +
        Math.min(creativeVisible, 90) * 0.12,
    );

    return {
      campaign: rawCampaign ?? "Direto / não atribuído",
      creative: rawCreative ?? "Não informado",
      attribution_status: !rawCampaign
        ? "unattributed"
        : rawCreative
          ? "fully_attributed"
          : "campaign_only",
      sessions: creativeSessions,
      summary_sessions: creativeSummarySessions,
      summary_coverage_percent: Number((creativeSummaryCoverage * 100).toFixed(2)),
      avg_visible_seconds: Number(creativeVisible.toFixed(1)),
      avg_scroll_percent: Number(creativeScroll.toFixed(1)),
      click_rate_percent: rate(creativeClicks, creativeSessions),
      cart_rate_percent: rate(creativeCarts, creativeSessions),
      checkout_rate_percent: rate(creativeCheckouts, creativeSessions),
      purchase_rate_percent: rate(creativePurchases, creativeSessions),
      purchases: creativePurchases,
      directional_quality_score: directionalQualityScore,
      quality_score: eligibleForRanking ? directionalQualityScore : null,
      eligible_for_creative_ranking: eligibleForRanking,
      confidence: confidenceFromSample(
        creativeSessions,
        creativeCheckouts,
        creativePurchases,
      ),
    };
  });

  const trafficDirectional = score(
    70 - attributedQuickExitRate * 1.2 + Math.min(attributedAvgVisible, 60) * 0.5,
  );
  const landingDirectional = score(
    attributedAvgScroll * 0.5 +
      Math.min(attributedAvgVisible, 90) * 0.35 +
      attributedClickRate * 1.2,
  );
  const offerDirectional = score(attributedClickRate * 5 + attributedCheckoutRate * 4);
  const checkoutDirectional =
    attributedCheckouts > 0 ? score(attributedCheckoutToPurchase * 1.2) : 0;

  const behaviorSampleValid =
    attributedSessions >= MIN_DIAGNOSTIC_SESSIONS &&
    attributedSummaryCoverage >= MIN_SUMMARY_COVERAGE;
  const conversionSampleValid = attributedSessions >= MIN_DIAGNOSTIC_SESSIONS;
  const checkoutSampleValid = attributedCheckouts >= MIN_CHECKOUTS;

  const scoredAreas: ScoredArea[] = [
    {
      key: "traffic",
      label: "Aquisição / tráfego",
      score: behaviorSampleValid ? trafficDirectional : null,
      directionalScore: trafficDirectional,
      status: behaviorSampleValid
        ? "measured"
        : attributedSessions > 0 && attributedSummarySessions > 0
          ? "directional"
          : "insufficient_data",
      minimumSample: `${MIN_DIAGNOSTIC_SESSIONS} sessões atribuídas e 80% de cobertura comportamental`,
    },
    {
      key: "landing",
      label: "Landing page",
      score: behaviorSampleValid ? landingDirectional : null,
      directionalScore: landingDirectional,
      status: behaviorSampleValid
        ? "measured"
        : attributedSessions > 0 && attributedSummarySessions > 0
          ? "directional"
          : "insufficient_data",
      minimumSample: `${MIN_DIAGNOSTIC_SESSIONS} sessões atribuídas e 80% de cobertura comportamental`,
    },
    {
      key: "offer",
      label: "Oferta e CTA",
      score: conversionSampleValid ? offerDirectional : null,
      directionalScore: offerDirectional,
      status: conversionSampleValid
        ? "measured"
        : attributedSessions > 0
          ? "directional"
          : "insufficient_data",
      minimumSample: `${MIN_DIAGNOSTIC_SESSIONS} sessões atribuídas`,
    },
    {
      key: "checkout",
      label: "Checkout",
      score: checkoutSampleValid ? checkoutDirectional : null,
      directionalScore: checkoutDirectional,
      status: checkoutSampleValid
        ? "measured"
        : attributedCheckouts > 0
          ? "directional"
          : "insufficient_data",
      minimumSample: `${MIN_CHECKOUTS} checkouts atribuídos`,
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

  const weightedScores = scoredAreas
    .filter((area): area is ScoredArea & { score: number } => area.score !== null)
    .map((area) => {
      const weights = { traffic: 0.18, landing: 0.28, offer: 0.34, checkout: 0.2 };
      return { value: area.score, weight: weights[area.key] };
    });
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
    attributedSessions,
    attributedCheckouts,
    attributedPurchases,
  );

  const dataQualityWarnings: string[] = [];
  if (sessions < MIN_DIAGNOSTIC_SESSIONS) {
    dataQualityWarnings.push(
      `Amostra total pequena: ${sessions} sessões. Não declare vencedor ou gargalo causal.`,
    );
  }
  if (attributedSessions < MIN_DIAGNOSTIC_SESSIONS) {
    dataQualityWarnings.push(
      `Somente ${attributedSessions} sessões possuem campanha atribuída; os scores de campanha permanecem direcionais.`,
    );
  }
  if (summaryCoverage < MIN_SUMMARY_COVERAGE) {
    dataQualityWarnings.push(
      `A cobertura de session_summary é ${rate(summarySessions, sessions)}%; médias comportamentais podem estar enviesadas.`,
    );
  }
  if (sessions > 0 && attributionCoverage < 0.8) {
    dataQualityWarnings.push(
      `${unattributedSessions} de ${sessions} sessões estão sem campanha atribuída. Separe tráfego direto de mídia antes de comparar criativos.`,
    );
  }
  if (unattributedCheckouts > 0 && attributedCheckouts === 0) {
    dataQualityWarnings.push(
      "Todos os checkouts observados vieram de tráfego não atribuído; eles não diagnosticam o checkout da campanha.",
    );
  }
  if (visitors > 0 && sessions / visitors >= 2) {
    dataQualityWarnings.push(
      `${sessions} sessões para ${visitors} visitantes indicam recorrência alta ou possível fragmentação de sessão.`,
    );
  }
  if (sessions >= 10 && num(summary.mobile_sessions) === 0) {
    dataQualityWarnings.push(
      "Nenhuma sessão mobile foi registrada. Confirme segmentação, classificação de dispositivo e tráfego de teste.",
    );
  }
  if (attributedCheckouts < MIN_CHECKOUTS) {
    dataQualityWarnings.push(
      `Checkout possui ${attributedCheckouts} observações atribuídas; são necessárias pelo menos ${MIN_CHECKOUTS} para uma leitura inicial.`,
    );
  }
  if (dataQualityWarnings.length === 0) {
    dataQualityWarnings.push("Nenhum alerta estrutural relevante foi detectado neste recorte.");
  }

  const tests: TestRecommendation[] = [];
  if (
    summaryCoverage < MIN_SUMMARY_COVERAGE ||
    attributionCoverage < 0.8 ||
    unattributedCheckouts > 0 ||
    (visitors > 0 && sessions / visitors >= 2)
  ) {
    tests.push({
      priority: tests.length + 1,
      area: "Medição e atribuição",
      test: "Validar session_id, visitor_id, UTMs e cobertura do session_summary",
      hypothesis:
        "Parte do diagnóstico pode estar sendo alterada por fragmentação de sessões, ausência de atribuição ou cobertura incompleta.",
      impact: "Muito alto",
      difficulty: "Média",
      success_metric:
        "Atingir pelo menos 90% de atribuição/cobertura e eliminar sessões duplicadas no mesmo visitante e janela de 30 minutos.",
    });
  }
  if (attributedSessions >= 10 && attributedClickRate < 10) {
    tests.push({
      priority: tests.length + 1,
      area: "Oferta e CTA",
      test: "Medir impressão do CTA e testar somente a primeira dobra",
      hypothesis:
        "Se o evento estiver íntegro, o tráfego atribuído consome a página sem avançar para a ação de compra.",
      impact: "Muito alto",
      difficulty: "Baixa",
      success_metric:
        "Aumentar CTA clicks ÷ CTA impressions, sem usar sessões como denominador principal.",
    });
  }
  if (
    attributedSummarySessions >= 10 &&
    attributedAvgScroll >= 50 &&
    attributedClickRate < 10
  ) {
    tests.push({
      priority: tests.length + 1,
      area: "Mensagem de vendas",
      test: "Antecipar um único argumento decisivo antes do primeiro CTA",
      hypothesis:
        "A rolagem sugere consumo, mas não prova que benefício, preço ou redução de risco foram percebidos no momento certo.",
      impact: "Alto",
      difficulty: "Média",
      success_metric:
        "Elevar a taxa de clique por impressão do CTA mantendo a cobertura comportamental estável.",
    });
  }
  if (attributedCheckouts >= MIN_CHECKOUTS && attributedCheckoutToPurchase < 30) {
    tests.push({
      priority: tests.length + 1,
      area: "Checkout",
      test: "Isolar frete, prazo, confiança e falhas de pagamento em testes separados",
      hypothesis:
        "Com volume suficiente, a perda após checkout pode indicar fricção comercial ou técnica.",
      impact: "Muito alto",
      difficulty: "Média",
      success_metric: "Aumentar checkout para compra para pelo menos 30%.",
    });
  } else if (checkouts > 0) {
    tests.push({
      priority: tests.length + 1,
      area: "Medição do checkout",
      test: "Auditar o único fluxo observado sem classificá-lo como gargalo",
      hypothesis:
        "O volume atual é insuficiente para distinguir abandono normal, problema técnico ou perda de atribuição.",
      impact: "Alto",
      difficulty: "Baixa",
      success_metric:
        `Confirmar origem, visitor_id, checkout_id e resultado de pagamento até acumular ${MIN_CHECKOUTS} checkouts atribuídos.`,
    });
  }
  if (tests.length === 0) {
    tests.push({
      priority: 1,
      area: "Amostra",
      test: "Acumular sessões atribuídas sem alterar múltiplas variáveis",
      hypothesis: "Os sinais atuais ainda não apontam um gargalo confiável.",
      impact: "Médio",
      difficulty: "Baixa",
      success_metric: `Atingir pelo menos ${MIN_DIAGNOSTIC_SESSIONS} sessões atribuídas e ${MIN_CHECKOUTS} checkouts.`,
    });
  }

  const directionalBottleneck =
    attributedSessions >= 10 && attributedClicks === 0
      ? "Página para CTA no tráfego atribuído"
      : biggestBottleneck?.label ?? null;

  const mainDiagnosis =
    sessions === 0
      ? "Nenhuma sessão válida foi encontrada neste recorte."
      : unattributedCheckouts > 0 && attributedCheckouts === 0
        ? "O checkout observado veio de tráfego não atribuído. Antes de culpar o checkout, corrija a atribuição e valide a passagem da campanha para o CTA."
        : attributedSessions < MIN_DIAGNOSTIC_SESSIONS
          ? `Há ${attributedSessions} sessões atribuídas, abaixo do mínimo de ${MIN_DIAGNOSTIC_SESSIONS}. O sinal mais útil é direcional, não causal.`
          : biggestBottleneck?.key === "checkout"
            ? "Com amostra mínima no checkout, a maior perda medida ocorre após o início do pagamento."
            : biggestBottleneck?.key === "offer"
              ? "A campanha recebe atenção, mas a oferta converte essa atenção em ação abaixo dos demais estágios medidos."
              : biggestBottleneck?.key === "landing"
                ? "A landing não sustenta atenção ou progressão com a mesma força dos demais estágios medidos."
                : "Os dados medidos apontam primeiro para aquisição ou congruência anúncio-página.";

  const targetPurchaseRate = Math.max(attributedPurchaseRate, 2);
  const potentialPurchasesAtTarget = Number(
    ((attributedSessions * targetPurchaseRate) / 100).toFixed(2),
  );
  const estimatedMissingPurchases = Number(
    Math.max(0, potentialPurchasesAtTarget - attributedPurchases).toFixed(2),
  );
  const estimatedRevenueGap =
    aov === null ? null : Number((estimatedMissingPurchases * aov).toFixed(2));
  const estimatedCampaignTrafficCost =
    cpc === null ? null : Number((attributedSessions * cpc).toFixed(2));

  const exportData = {
    schema: "conversion_tracker_campaign_dna_v3",
    generated_at: new Date().toISOString(),
    analysis_request:
      "Valide o diagnóstico usando os dados brutos, conteste conclusões frágeis, identifique gargalos e recomende testes incrementais por prioridade. Não trate correlação como causalidade.",
    filters: { days, campaign: campaign || null, creative: content || null },
    business_inputs: {
      average_order_value: aov,
      average_cost_per_click: cpc,
      currency: "BRL",
      note: "Valores financeiros são estimativas e só aparecem quando AOV ou CPC são informados.",
    },
    attribution: {
      model: "first_page_view_per_session",
      fallback: "properties.first_touch",
      test_traffic_excluded: true,
      purchase_requires_same_session: true,
      cross_session_purchase_resolution: false,
      limitation:
        "Compras confirmadas em outra sessão, aba, domínio ou webhook podem ficar sem a campanha original nesta versão.",
    },
    data_quality: {
      aggregation_level: "one_row_per_session_before_averaging",
      visitors,
      sessions,
      sessions_per_visitor: visitors > 0 ? Number((sessions / visitors).toFixed(2)) : 0,
      summary_sessions: summarySessions,
      summary_coverage_percent: Number((summaryCoverage * 100).toFixed(2)),
      attributed_sessions: attributedSessions,
      unattributed_sessions: unattributedSessions,
      attribution_coverage_percent: Number((attributionCoverage * 100).toFixed(2)),
      mobile_sessions: num(summary.mobile_sessions),
      desktop_sessions: num(summary.desktop_sessions),
      tablet_sessions: num(summary.tablet_sessions),
      warnings: dataQualityWarnings,
    },
    campaign_dna: {
      health_score: healthScore,
      health_label: healthLabel(healthScore),
      confidence_score: confidence,
      sample_warning: attributedSessions < MIN_DIAGNOSTIC_SESSIONS,
      traffic_quality_score: scoredAreas.find((area) => area.key === "traffic")?.score ?? null,
      landing_quality_score: scoredAreas.find((area) => area.key === "landing")?.score ?? null,
      offer_quality_score: scoredAreas.find((area) => area.key === "offer")?.score ?? null,
      checkout_quality_score: scoredAreas.find((area) => area.key === "checkout")?.score ?? null,
      directional_scores: Object.fromEntries(
        scoredAreas.map((area) => [area.key, area.directionalScore]),
      ),
      score_status: Object.fromEntries(
        scoredAreas.map((area) => [area.key, area.status]),
      ),
      best_creative_quality_score: bestCreativeQuality,
      biggest_bottleneck: biggestBottleneck?.label ?? null,
      directional_bottleneck: directionalBottleneck,
      main_diagnosis: mainDiagnosis,
    },
    funnel: {
      aggregate: {
        visitors,
        sessions,
        buy_clicks: clicks,
        add_to_carts: carts,
        checkouts,
        purchases,
        click_rate_percent: clickRate,
        cart_rate_percent: rate(carts, sessions),
        checkout_rate_percent: checkoutRate,
        purchase_rate_percent: purchaseRate,
        click_to_checkout_percent: rate(checkouts, clicks),
        checkout_to_purchase_percent: checkoutToPurchase,
      },
      attributed_campaign_traffic: {
        sessions: attributedSessions,
        buy_clicks: attributedClicks,
        add_to_carts: attributedCarts,
        checkouts: attributedCheckouts,
        purchases: attributedPurchases,
        click_rate_percent: attributedClickRate,
        cart_rate_percent: rate(attributedCarts, attributedSessions),
        checkout_rate_percent: attributedCheckoutRate,
        purchase_rate_percent: attributedPurchaseRate,
        checkout_to_purchase_percent: attributedCheckoutToPurchase,
      },
      unattributed_traffic: {
        sessions: unattributedSessions,
        buy_clicks: unattributedClicks,
        add_to_carts: unattributedCarts,
        checkouts: unattributedCheckouts,
        purchases: unattributedPurchases,
      },
    },
    behavior: {
      aggregate: {
        avg_visible_seconds: Number(avgVisible.toFixed(1)),
        avg_scroll_percent: Number(avgScroll.toFixed(1)),
        quick_exits: num(summary.quick_exits),
        quick_exit_rate_percent: quickExitRate,
        summary_sessions: summarySessions,
      },
      attributed_campaign_traffic: {
        avg_visible_seconds: Number(attributedAvgVisible.toFixed(1)),
        avg_scroll_percent: Number(attributedAvgScroll.toFixed(1)),
        quick_exits: num(summary.attributed_quick_exits),
        quick_exit_rate_percent: attributedQuickExitRate,
        summary_sessions: attributedSummarySessions,
      },
      javascript_errors: num(summary.javascript_errors),
    },
    opportunity_estimate: {
      benchmark_purchase_rate_percent: targetPurchaseRate,
      attributed_sessions_used: attributedSessions,
      potential_purchases_at_benchmark: potentialPurchasesAtTarget,
      estimated_missing_purchases: estimatedMissingPurchases,
      estimated_revenue_gap: estimatedRevenueGap,
      estimated_campaign_traffic_cost: estimatedCampaignTrafficCost,
      caveat:
        "Estimativa direcional sobre sessões atribuídas, não previsão financeira. Sessões não equivalem necessariamente a cliques pagos.",
    },
    prioritized_tests: tests,
    creatives,
    recent_sessions: (sessionResult as Row[]).map((row) => {
      const rawCampaign = nullableText(row.campaign);
      const rawCreative = nullableText(row.content);
      return {
        session_id: row.session_id,
        visitor_id: row.visitor_id,
        started_at: row.started_at,
        device: row.device_type,
        source: nullableText(row.source),
        medium: nullableText(row.medium),
        campaign: rawCampaign ?? "Direto / não atribuído",
        creative: rawCreative ?? "Não informado",
        attribution_status: !rawCampaign
          ? "unattributed"
          : rawCreative
            ? "fully_attributed"
            : "campaign_only",
        event_count: num(row.event_count),
        clicked: bool(row.clicked),
        checkout: bool(row.checkout),
        purchase: bool(row.purchase),
      };
    }),
    interpretation_notes: [
      "Médias comportamentais agora são calculadas após reduzir os eventos para uma linha por sessão.",
      "Tráfego direto ou sem UTM não concorre como melhor criativo.",
      "Score nulo significa amostra insuficiente, não desempenho zero.",
      "Checkout só recebe score medido após pelo menos 10 checkouts atribuídos.",
      "Correlação entre rolagem, tempo e conversão não comprova causalidade.",
      "Métricas de Meta Ads ainda precisam ser integradas para custo, CTR, frequência e alcance reais.",
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
          <p className="eyebrow">ITERAÇÃO 9</p>
          <h1 className="dashboardTitle">DNA da campanha</h1>
          <p className="subtitle dashboardSubtitle">
            Diagnóstico com médias por sessão, separação de atribuição e scores que admitem quando ainda não sabem.
          </p>
        </div>
        <Link className="secondaryLink" href="/">Voltar à central</Link>
      </header>

      <form className="filterBar" method="get">
        <label><span>Período</span><select name="days" defaultValue={String(days)}><option value="1">24 horas</option><option value="7">7 dias</option><option value="14">14 dias</option><option value="30">30 dias</option><option value="90">90 dias</option></select></label>
        <label><span>Campanha</span><select name="campaign" defaultValue={campaign}><option value="">Todas</option>{campaigns.map((item) => <option key={item}>{item}</option>)}</select></label>
        <label><span>Criativo</span><select name="content" defaultValue={content}><option value="">Todos</option>{contents.map((item) => <option key={item}>{item}</option>)}</select></label>
        <label><span>Ticket médio (R$)</span><input name="aov" inputMode="decimal" defaultValue={aov ?? ""} placeholder="89,90" /></label>
        <label><span>CPC médio (R$)</span><input name="cpc" inputMode="decimal" defaultValue={cpc ?? ""} placeholder="1,50" /></label>
        <button className="filterButton" type="submit">Gerar diagnóstico</button>
      </form>

      <section className="metricGrid" aria-label="DNA da campanha">
        <article className="metricCard"><span>Saúde geral</span><strong>{healthScore === null ? "N/D" : `${healthScore}/100`}</strong><small>{healthLabel(healthScore)}</small></article>
        <article className="metricCard"><span>Maior gargalo</span><strong style={{ fontSize: 22 }}>{biggestBottleneck?.label ?? "Não determinado"}</strong><small>{directionalBottleneck ? `Sinal: ${directionalBottleneck}` : "Sem sinal suficiente"}</small></article>
        <article className="metricCard"><span>Confiança</span><strong>{confidence}/100</strong><small>{attributedSessions} sessões atribuídas</small></article>
        <article className="metricCard"><span>Próximo teste</span><strong style={{ fontSize: 18 }}>{tests[0].area}</strong><small>{tests[0].impact} impacto · dificuldade {tests[0].difficulty.toLowerCase()}</small></article>
      </section>

      <section className="panel">
        <div className="panelHeader dashboardPanelHeader">
          <div><p className="eyebrow">QUALIDADE DOS DADOS</p><h2>{summarySessions}/{sessions} sessões com resumo comportamental</h2></div>
          <span className="hint">{rate(attributedSessions, sessions)}% com campanha atribuída</span>
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
                <div>
                  <strong>{area.label}</strong>
                  <code>{area.key}_quality · {statusLabel(area.status)}</code>
                  <small>Mínimo: {area.minimumSample}</small>
                </div>
                <div className="funnelNumbers">
                  <strong>{area.score === null ? "N/D" : area.score}</strong>
                  <span>{area.score === null ? `sinal ${area.directionalScore}` : "/100"}</span>
                </div>
              </div>
              <div className="funnelTrack"><div className="funnelFill" style={{ width: `${area.directionalScore}%` }} /></div>
            </article>
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="panelHeader dashboardPanelHeader">
          <div><p className="eyebrow">PLANO DE AÇÃO</p><h2>Testes incrementais priorizados</h2></div>
          <span className="hint">Uma variável por vez</span>
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
          O JSON separa tráfego atribuído e direto, registra limitações e preserva os dados brutos para validação externa.
        </p>
        <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 720, overflow: "auto", padding: 20, borderRadius: 16, background: "rgba(0,0,0,.28)", fontSize: 13, lineHeight: 1.55 }}>
          <code>{code}</code>
        </pre>
      </section>
    </main>
  );
}
