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

const validPeriods = new Set([1, 7, 14, 30, 90]);

function firstParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function num(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
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

function clamp(value: number, min = 0, max = 100): number {
  return Math.min(max, Math.max(min, value));
}

function score(value: number): number {
  return Math.round(clamp(value));
}

function confidenceFromSample(sessions: number, purchases: number): number {
  const volume = Math.min(70, Math.log10(Math.max(sessions, 1) + 1) * 35);
  const outcomeBonus = Math.min(20, purchases * 4);
  return score(10 + volume + outcomeBonus);
}

function healthLabel(value: number): string {
  if (value >= 80) return "Saudável";
  if (value >= 65) return "Promissor";
  if (value >= 45) return "Instável";
  return "Crítico";
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
      )
      select
        count(distinct cohort.visitor_id) as visitors,
        count(distinct cohort.session_id) as sessions,
        count(distinct e.session_id) filter (where e.event_name = 'buy_button_click') as clicks,
        count(distinct e.session_id) filter (where e.event_name = 'add_to_cart') as carts,
        count(distinct e.session_id) filter (where e.event_name = 'checkout_started') as checkouts,
        count(distinct e.session_id) filter (where e.event_name = 'purchase') as purchases,
        coalesce(avg(s.visible_seconds), 0) as avg_visible_seconds,
        coalesce(avg(s.max_scroll), 0) as avg_scroll,
        count(distinct cohort.session_id) filter (where s.quick_exit) as quick_exits,
        count(*) filter (where e.event_name = 'javascript_error') as javascript_errors
      from cohort
      left join base_events e on e.session_id = cohort.session_id
      left join summaries s on s.session_id = cohort.session_id
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
          coalesce(nullif(utm_campaign, ''), nullif(properties #>> '{first_touch,utm_campaign}', ''), 'Sem campanha') as campaign,
          coalesce(nullif(utm_content, ''), nullif(properties #>> '{first_touch,utm_content}', ''), 'Não informado') as content
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
      )
      select
        a.campaign,
        a.content,
        count(*) as sessions,
        count(*) filter (where exists(select 1 from base_events e where e.session_id = a.session_id and e.event_name = 'buy_button_click')) as clicks,
        count(*) filter (where exists(select 1 from base_events e where e.session_id = a.session_id and e.event_name = 'checkout_started')) as checkouts,
        count(*) filter (where exists(select 1 from base_events e where e.session_id = a.session_id and e.event_name = 'purchase')) as purchases,
        coalesce(avg(s.visible_seconds), 0) as avg_visible_seconds,
        coalesce(avg(s.max_scroll), 0) as avg_scroll
      from attributed a
      left join summaries s on s.session_id = a.session_id
      where (${campaign} = '' or a.campaign = ${campaign})
        and (${content} = '' or a.content = ${content})
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
          client_timestamp as started_at,
          device_type,
          coalesce(nullif(utm_campaign, ''), nullif(properties #>> '{first_touch,utm_campaign}', ''), 'Direto') as campaign,
          coalesce(nullif(utm_content, ''), nullif(properties #>> '{first_touch,utm_content}', ''), 'Não informado') as content
        from base_events
        where event_name = 'page_view'
        order by session_id, client_timestamp asc
      )
      select
        a.session_id,
        a.started_at,
        a.device_type,
        a.campaign,
        a.content,
        count(e.event_id) as event_count,
        bool_or(e.event_name = 'buy_button_click') as clicked,
        bool_or(e.event_name = 'checkout_started') as checkout,
        bool_or(e.event_name = 'purchase') as purchase
      from attributed a
      left join base_events e on e.session_id = a.session_id
      where (${campaign} = '' or a.campaign = ${campaign})
        and (${content} = '' or a.content = ${content})
      group by a.session_id, a.started_at, a.device_type, a.campaign, a.content
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
  const sessions = num(summary.sessions);
  const clicks = num(summary.clicks);
  const carts = num(summary.carts);
  const checkouts = num(summary.checkouts);
  const purchases = num(summary.purchases);
  const avgVisible = num(summary.avg_visible_seconds);
  const avgScroll = num(summary.avg_scroll);
  const quickExitRate = rate(num(summary.quick_exits), sessions);
  const clickRate = rate(clicks, sessions);
  const checkoutRate = rate(checkouts, sessions);
  const purchaseRate = rate(purchases, sessions);
  const checkoutToPurchase = rate(purchases, checkouts);

  const creatives = (creativeResult as Row[]).map((row) => {
    const creativeSessions = num(row.sessions);
    const creativeClicks = num(row.clicks);
    const creativeCheckouts = num(row.checkouts);
    const creativePurchases = num(row.purchases);
    const creativeScroll = num(row.avg_scroll);
    const creativeVisible = num(row.avg_visible_seconds);
    const qualityScore = score(
      rate(creativePurchases, creativeSessions) * 8 +
        rate(creativeCheckouts, creativeSessions) * 2.5 +
        rate(creativeClicks, creativeSessions) * 1.2 +
        Math.min(creativeScroll, 100) * 0.18 +
        Math.min(creativeVisible, 90) * 0.12,
    );
    return {
      campaign: row.campaign,
      creative: row.content,
      sessions: creativeSessions,
      avg_visible_seconds: Number(creativeVisible.toFixed(1)),
      avg_scroll_percent: Number(creativeScroll.toFixed(1)),
      click_rate_percent: rate(creativeClicks, creativeSessions),
      checkout_rate_percent: rate(creativeCheckouts, creativeSessions),
      purchase_rate_percent: rate(creativePurchases, creativeSessions),
      purchases: creativePurchases,
      quality_score: qualityScore,
      confidence: confidenceFromSample(creativeSessions, creativePurchases),
    };
  });

  const trafficQuality = score(100 - quickExitRate * 1.8 + Math.min(avgVisible, 60) * 0.45);
  const landingQuality = score(avgScroll * 0.5 + Math.min(avgVisible, 90) * 0.35 + clickRate * 1.2);
  const offerQuality = score(clickRate * 5 + checkoutRate * 4);
  const checkoutQuality = checkouts > 0 ? score(checkoutToPurchase * 1.2) : 0;
  const creativeQuality = creatives.length > 0 ? Math.max(...creatives.map((item) => item.quality_score)) : 0;
  const healthScore = score(
    trafficQuality * 0.18 +
      landingQuality * 0.24 +
      offerQuality * 0.28 +
      checkoutQuality * 0.2 +
      creativeQuality * 0.1,
  );
  const confidence = confidenceFromSample(sessions, purchases);

  const scoredAreas = [
    { key: "traffic", label: "Aquisição / tráfego", score: trafficQuality },
    { key: "landing", label: "Landing page", score: landingQuality },
    { key: "offer", label: "Oferta e CTA", score: offerQuality },
    { key: "checkout", label: "Checkout", score: checkoutQuality },
  ];
  const biggestBottleneck = [...scoredAreas].sort((a, b) => a.score - b.score)[0];

  const tests: TestRecommendation[] = [];
  if (clickRate < 10) {
    tests.push({
      priority: 1,
      area: "Oferta e CTA",
      test: "Testar uma proposta de valor e um CTA acima da dobra",
      hypothesis: "A página gera atenção, mas não transforma interesse em intenção de compra.",
      impact: "Muito alto",
      difficulty: "Baixa",
      success_metric: "Aumentar a taxa de clique em comprar para pelo menos 10%.",
    });
  }
  if (avgScroll >= 50 && clickRate < 10) {
    tests.push({
      priority: tests.length + 1,
      area: "Mensagem de vendas",
      test: "Reposicionar benefícios, prova e preço antes do ponto médio da página",
      hypothesis: "O visitante consome a página, porém recebe o argumento decisivo tarde demais.",
      impact: "Alto",
      difficulty: "Média",
      success_metric: "Elevar cliques no CTA sem reduzir tempo ativo ou rolagem.",
    });
  }
  if (checkouts > 0 && checkoutToPurchase < 30) {
    tests.push({
      priority: tests.length + 1,
      area: "Checkout",
      test: "Revisar confiança, frete, prazo, meios de pagamento e erros do checkout",
      hypothesis: "Existe intenção suficiente para iniciar o checkout, mas há fricção ou surpresa antes do pagamento.",
      impact: "Muito alto",
      difficulty: "Média",
      success_metric: "Aumentar checkout para compra para pelo menos 30%.",
    });
  }
  if (quickExitRate > 35) {
    tests.push({
      priority: tests.length + 1,
      area: "Congruência anúncio-página",
      test: "Alinhar headline, imagem principal e promessa com o criativo vencedor",
      hypothesis: "Parte do tráfego não encontra na página a continuação da promessa do anúncio.",
      impact: "Alto",
      difficulty: "Baixa",
      success_metric: "Reduzir saídas rápidas abaixo de 30%.",
    });
  }
  if (tests.length === 0) {
    tests.push({
      priority: 1,
      area: "Amostra",
      test: "Acumular mais sessões antes de alterar o funil",
      hypothesis: "Os sinais atuais ainda não apontam um gargalo confiável.",
      impact: "Médio",
      difficulty: "Baixa",
      success_metric: "Atingir pelo menos 100 sessões atribuídas e 10 checkouts.",
    });
  }

  const targetPurchaseRate = Math.max(purchaseRate, 2);
  const potentialPurchasesAtTarget = Number(((sessions * targetPurchaseRate) / 100).toFixed(2));
  const estimatedMissingPurchases = Number(Math.max(0, potentialPurchasesAtTarget - purchases).toFixed(2));
  const estimatedRevenueGap = aov === null ? null : Number((estimatedMissingPurchases * aov).toFixed(2));
  const estimatedTrafficCost = cpc === null ? null : Number((sessions * cpc).toFixed(2));

  const mainDiagnosis =
    sessions < 30
      ? "A amostra ainda é pequena. Use o diagnóstico como direção de teste, não como veredito."
      : biggestBottleneck.key === "checkout"
        ? "A principal perda ocorre após o início do checkout. Priorize fricção, confiança, preço final e meios de pagamento."
        : biggestBottleneck.key === "offer"
          ? "A página recebe atenção, mas a oferta não converte essa atenção em ação na mesma proporção."
          : biggestBottleneck.key === "landing"
            ? "A landing não sustenta atenção ou não conduz o visitante com clareza suficiente até a oferta."
            : "A qualidade do tráfego ou a congruência entre anúncio e página é o primeiro ponto a investigar.";

  const exportData = {
    schema: "conversion_tracker_campaign_dna_v2",
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
    },
    campaign_dna: {
      health_score: healthScore,
      health_label: healthLabel(healthScore),
      confidence_score: confidence,
      sample_warning: sessions < 30,
      traffic_quality_score: trafficQuality,
      landing_quality_score: landingQuality,
      offer_quality_score: offerQuality,
      checkout_quality_score: checkoutQuality,
      best_creative_quality_score: creativeQuality,
      biggest_bottleneck: biggestBottleneck.label,
      main_diagnosis: mainDiagnosis,
    },
    funnel: {
      visitors: num(summary.visitors),
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
    behavior: {
      avg_visible_seconds: Number(avgVisible.toFixed(1)),
      avg_scroll_percent: Number(avgScroll.toFixed(1)),
      quick_exits: num(summary.quick_exits),
      quick_exit_rate_percent: quickExitRate,
      javascript_errors: num(summary.javascript_errors),
    },
    opportunity_estimate: {
      benchmark_purchase_rate_percent: targetPurchaseRate,
      potential_purchases_at_benchmark: potentialPurchasesAtTarget,
      estimated_missing_purchases: estimatedMissingPurchases,
      estimated_revenue_gap: estimatedRevenueGap,
      estimated_traffic_cost: estimatedTrafficCost,
      caveat: "Estimativa direcional, não previsão financeira. O benchmark mínimo de 2% não considera nicho, preço, margem ou qualidade da mídia.",
    },
    prioritized_tests: tests,
    creatives,
    recent_sessions: (sessionResult as Row[]).map((row) => ({
      session_id: row.session_id,
      started_at: row.started_at,
      device: row.device_type,
      campaign: row.campaign,
      creative: row.content,
      event_count: num(row.event_count),
      clicked: Boolean(row.clicked),
      checkout: Boolean(row.checkout),
      purchase: Boolean(row.purchase),
    })),
    interpretation_notes: [
      "Amostras pequenas podem gerar taxas extremamente instáveis.",
      "Scores são heurísticas para priorização, não provas causais.",
      "Compare qualidade de sessão e conversão, não apenas volume.",
      "Ausência de criativo significa UTM ausente ou visita direta.",
      "Métricas de Meta Ads ainda precisam ser adicionadas manualmente ao prompt se não estiverem integradas ao tracker.",
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
          <p className="eyebrow">ITERAÇÃO 8</p>
          <h1 className="dashboardTitle">DNA da campanha</h1>
          <p className="subtitle dashboardSubtitle">
            Gere um diagnóstico de CRO com scores, gargalo principal, impacto estimado e próximos testes.
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
        <article className="metricCard"><span>Saúde geral</span><strong>{healthScore}/100</strong><small>{healthLabel(healthScore)}</small></article>
        <article className="metricCard"><span>Maior gargalo</span><strong style={{ fontSize: 22 }}>{biggestBottleneck.label}</strong><small>Score {biggestBottleneck.score}/100</small></article>
        <article className="metricCard"><span>Confiança</span><strong>{confidence}/100</strong><small>{sessions} sessões analisadas</small></article>
        <article className="metricCard"><span>Próximo teste</span><strong style={{ fontSize: 18 }}>{tests[0].area}</strong><small>{tests[0].impact} impacto · dificuldade {tests[0].difficulty.toLowerCase()}</small></article>
      </section>

      <section className="panel">
        <div className="panelHeader dashboardPanelHeader">
          <div><p className="eyebrow">DIAGNÓSTICO</p><h2>{mainDiagnosis}</h2></div>
          <span className="hint">Heurística com confiança {confidence}/100</span>
        </div>
        <div className="funnelList">
          {scoredAreas.map((area) => (
            <article className="funnelRow" key={area.key}>
              <div className="funnelCopy"><div><strong>{area.label}</strong><code>{area.key}_quality</code></div><div className="funnelNumbers"><strong>{area.score}</strong><span>/100</span></div></div>
              <div className="funnelTrack"><div className="funnelFill" style={{ width: `${area.score}%` }} /></div>
            </article>
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="panelHeader dashboardPanelHeader">
          <div><p className="eyebrow">PLANO DE AÇÃO</p><h2>Testes priorizados</h2></div>
          <span className="hint">Do maior impacto para o menor</span>
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
          O JSON contém diagnóstico e dados brutos para que outra IA possa validar, contestar e aprofundar a análise.
        </p>
        <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 720, overflow: "auto", padding: 20, borderRadius: 16, background: "rgba(0,0,0,.28)", fontSize: 13, lineHeight: 1.55 }}>
          <code>{code}</code>
        </pre>
      </section>
    </main>
  );
}
