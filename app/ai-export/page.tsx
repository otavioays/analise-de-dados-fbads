import Link from "next/link";

import { getSql } from "@/lib/neon";
import CopyButton from "./CopyButton";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type SearchParams = Promise<{
  days?: string | string[];
  campaign?: string | string[];
  content?: string | string[];
}>;

type Row = Record<string, string | number | boolean | null>;

const validPeriods = new Set([1, 7, 14, 30, 90]);

function firstParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function num(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function rate(value: number, total: number): number {
  return total > 0 ? Number(((value / total) * 100).toFixed(2)) : 0;
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
        count(*) filter (where s.quick_exit) as quick_exits,
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

  const creatives = (creativeResult as Row[]).map((row) => {
    const creativeSessions = num(row.sessions);
    const creativeClicks = num(row.clicks);
    const creativeCheckouts = num(row.checkouts);
    const creativePurchases = num(row.purchases);
    return {
      campaign: row.campaign,
      creative: row.content,
      sessions: creativeSessions,
      avg_visible_seconds: Number(num(row.avg_visible_seconds).toFixed(1)),
      avg_scroll_percent: Number(num(row.avg_scroll).toFixed(1)),
      click_rate_percent: rate(creativeClicks, creativeSessions),
      checkout_rate_percent: rate(creativeCheckouts, creativeSessions),
      purchase_rate_percent: rate(creativePurchases, creativeSessions),
      purchases: creativePurchases,
    };
  });

  const exportData = {
    schema: "conversion_tracker_ai_export_v1",
    generated_at: new Date().toISOString(),
    analysis_request: "Analise os dados, identifique gargalos, compare criativos, levante hipóteses e recomende os próximos testes por prioridade.",
    filters: { days, campaign: campaign || null, creative: content || null },
    attribution: {
      model: "first_page_view_per_session",
      fallback: "properties.first_touch",
      test_traffic_excluded: true,
      purchase_requires_same_session: true,
    },
    funnel: {
      visitors: num(summary.visitors),
      sessions,
      buy_clicks: clicks,
      add_to_carts: carts,
      checkouts,
      purchases,
      click_rate_percent: rate(clicks, sessions),
      cart_rate_percent: rate(carts, sessions),
      checkout_rate_percent: rate(checkouts, sessions),
      purchase_rate_percent: rate(purchases, sessions),
      click_to_checkout_percent: rate(checkouts, clicks),
      checkout_to_purchase_percent: rate(purchases, checkouts),
    },
    behavior: {
      avg_visible_seconds: Number(num(summary.avg_visible_seconds).toFixed(1)),
      avg_scroll_percent: Number(num(summary.avg_scroll).toFixed(1)),
      quick_exits: num(summary.quick_exits),
      quick_exit_rate_percent: rate(num(summary.quick_exits), sessions),
      javascript_errors: num(summary.javascript_errors),
    },
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
      "Amostras pequenas podem gerar taxas instáveis.",
      "Compare qualidade de sessão e conversão, não apenas volume.",
      "Ausência de criativo significa UTM ausente ou visita direta.",
    ],
  };

  const code = JSON.stringify(exportData, null, 2);
  const filters = filterResult as Row[];
  const campaigns = Array.from(new Set(filters.map((row) => String(row.utm_campaign ?? "").trim()).filter(Boolean)));
  const contents = Array.from(new Set(filters.filter((row) => !campaign || row.utm_campaign === campaign).map((row) => String(row.utm_content ?? "").trim()).filter(Boolean)));

  return (
    <main className="shell dashboardShell">
      <header className="dashboardHeader">
        <div>
          <p className="eyebrow">ITERAÇÃO 7</p>
          <h1 className="dashboardTitle">Exportação para IA</h1>
          <p className="subtitle dashboardSubtitle">
            Gere um código autocontido com funil, comportamento, atribuição, criativos e sessões recentes.
          </p>
        </div>
        <Link className="secondaryLink" href="/">Voltar à central</Link>
      </header>

      <form className="filterBar" method="get">
        <label><span>Período</span><select name="days" defaultValue={String(days)}><option value="1">24 horas</option><option value="7">7 dias</option><option value="14">14 dias</option><option value="30">30 dias</option><option value="90">90 dias</option></select></label>
        <label><span>Campanha</span><select name="campaign" defaultValue={campaign}><option value="">Todas</option>{campaigns.map((item) => <option key={item}>{item}</option>)}</select></label>
        <label><span>Criativo</span><select name="content" defaultValue={content}><option value="">Todos</option>{contents.map((item) => <option key={item}>{item}</option>)}</select></label>
        <button className="filterButton" type="submit">Gerar código</button>
      </form>

      <section className="panel">
        <div className="panelHeader dashboardPanelHeader">
          <div><p className="eyebrow">PACOTE DE DADOS</p><h2>Código pronto para copiar</h2></div>
          <CopyButton value={code} />
        </div>
        <p className="subtitle" style={{ marginBottom: 16 }}>
          Cole este bloco em uma IA e peça diagnóstico, hipóteses, priorização de testes ou comparação entre criativos.
        </p>
        <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 720, overflow: "auto", padding: 20, borderRadius: 16, background: "rgba(0,0,0,.28)", fontSize: 13, lineHeight: 1.55 }}>
          <code>{code}</code>
        </pre>
      </section>
    </main>
  );
}
