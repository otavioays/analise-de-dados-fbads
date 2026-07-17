import Link from "next/link";

import { getSql } from "@/lib/neon";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type DashboardSearchParams = Promise<{
  days?: string | string[];
  campaign?: string | string[];
  content?: string | string[];
}>;

type MetricRow = {
  visitors?: string | number;
  sessions?: string | number;
  page_views?: string | number;
  buy_clicks?: string | number;
  carts?: string | number;
  checkouts?: string | number;
  purchases?: string | number;
};

type FilterRow = {
  utm_campaign?: string | null;
  utm_content?: string | null;
};

type BreakdownRow = {
  campaign?: string | null;
  content?: string | null;
  sessions?: string | number;
  purchases?: string | number;
};

const validPeriods = new Set([1, 7, 14, 30, 90]);

function firstParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function asCount(value: string | number | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function percentage(current: number, previous: number): number {
  return previous > 0 ? (current / previous) * 100 : 0;
}

function formatPercentage(value: number): string {
  return `${value.toLocaleString("pt-BR", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })}%`;
}

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: DashboardSearchParams;
}) {
  const params = await searchParams;
  const requestedDays = Number(firstParam(params.days));
  const days = validPeriods.has(requestedDays) ? requestedDays : 7;
  const campaign = firstParam(params.campaign).slice(0, 255);
  const content = firstParam(params.content).slice(0, 255);
  const sql = getSql();

  const [metricsResult, filtersResult, breakdownResult] = await Promise.all([
    sql`
      with base_events as (
        select *
        from public.analytics_events
        where received_at >= now() - (${days} * interval '1 day')
          and coalesce(properties ->> 'test', 'false') <> 'true'
      ),
      cohort as (
        select distinct session_id
        from base_events
        where event_name = 'page_view'
          and (${campaign} = '' or coalesce(utm_campaign, '') = ${campaign})
          and (${content} = '' or coalesce(utm_content, '') = ${content})
      )
      select
        count(distinct e.visitor_id) filter (where e.event_name = 'page_view') as visitors,
        count(distinct cohort.session_id) as sessions,
        count(*) filter (where e.event_name = 'page_view') as page_views,
        count(distinct e.session_id) filter (where e.event_name = 'buy_button_click') as buy_clicks,
        count(distinct e.session_id) filter (where e.event_name = 'add_to_cart') as carts,
        count(distinct e.session_id) filter (where e.event_name = 'checkout_started') as checkouts,
        count(distinct e.session_id) filter (where e.event_name = 'purchase') as purchases
      from cohort
      left join base_events e on e.session_id = cohort.session_id
    `,
    sql`
      select distinct utm_campaign, utm_content
      from public.analytics_events
      where received_at >= now() - interval '90 days'
        and event_name = 'page_view'
        and coalesce(properties ->> 'test', 'false') <> 'true'
        and (utm_campaign is not null or utm_content is not null)
      order by utm_campaign nulls last, utm_content nulls last
      limit 250
    `,
    sql`
      with base_events as (
        select *
        from public.analytics_events
        where received_at >= now() - (${days} * interval '1 day')
          and coalesce(properties ->> 'test', 'false') <> 'true'
      ),
      attributed_sessions as (
        select distinct on (session_id)
          session_id,
          coalesce(nullif(utm_campaign, ''), 'Sem campanha') as campaign,
          coalesce(nullif(utm_content, ''), 'Sem criativo') as content
        from base_events
        where event_name = 'page_view'
          and (${campaign} = '' or coalesce(utm_campaign, '') = ${campaign})
          and (${content} = '' or coalesce(utm_content, '') = ${content})
        order by session_id, client_timestamp asc
      ),
      purchased_sessions as (
        select distinct session_id
        from base_events
        where event_name = 'purchase'
      )
      select
        attributed_sessions.campaign,
        attributed_sessions.content,
        count(*) as sessions,
        count(purchased_sessions.session_id) as purchases
      from attributed_sessions
      left join purchased_sessions
        on purchased_sessions.session_id = attributed_sessions.session_id
      group by attributed_sessions.campaign, attributed_sessions.content
      order by sessions desc, purchases desc
      limit 12
    `,
  ]);

  const metricRows = Array.isArray(metricsResult)
    ? (metricsResult as MetricRow[])
    : [];
  const filterRows = Array.isArray(filtersResult)
    ? (filtersResult as FilterRow[])
    : [];
  const breakdownRows = Array.isArray(breakdownResult)
    ? (breakdownResult as BreakdownRow[])
    : [];
  const metric = metricRows[0] ?? {};

  const visitors = asCount(metric.visitors);
  const sessions = asCount(metric.sessions);
  const pageViews = asCount(metric.page_views);
  const buyClicks = asCount(metric.buy_clicks);
  const carts = asCount(metric.carts);
  const checkouts = asCount(metric.checkouts);
  const purchases = asCount(metric.purchases);

  const campaigns = Array.from(
    new Set(
      filterRows
        .map((row) => row.utm_campaign?.trim())
        .filter((value): value is string => Boolean(value)),
    ),
  );
  const contents = Array.from(
    new Set(
      filterRows
        .filter((row) => !campaign || row.utm_campaign === campaign)
        .map((row) => row.utm_content?.trim())
        .filter((value): value is string => Boolean(value)),
    ),
  );

  const funnelStages = [
    { label: "Visitaram a página", event: "session", value: sessions },
    {
      label: "Clicaram em comprar",
      event: "buy_button_click",
      value: buyClicks,
    },
    { label: "Adicionaram ao carrinho", event: "add_to_cart", value: carts },
    {
      label: "Iniciaram checkout",
      event: "checkout_started",
      value: checkouts,
    },
    { label: "Compraram", event: "purchase", value: purchases },
  ];
  const funnelMaximum = Math.max(...funnelStages.map((stage) => stage.value), 1);

  return (
    <main className="shell dashboardShell">
      <header className="dashboardHeader">
        <div>
          <p className="eyebrow">ITERAÇÃO 2</p>
          <h1 className="dashboardTitle">Dashboard do funil</h1>
          <p className="subtitle dashboardSubtitle">
            Veja quantas sessões avançam em cada etapa e filtre os dados por
            período, campanha e criativo.
          </p>
        </div>
        <Link className="secondaryLink" href="/">
          Abrir bancada de testes
        </Link>
      </header>

      <form className="filterBar" method="get">
        <label>
          <span>Período</span>
          <select name="days" defaultValue={String(days)}>
            <option value="1">Últimas 24 horas</option>
            <option value="7">Últimos 7 dias</option>
            <option value="14">Últimos 14 dias</option>
            <option value="30">Últimos 30 dias</option>
            <option value="90">Últimos 90 dias</option>
          </select>
        </label>

        <label>
          <span>Campanha</span>
          <select name="campaign" defaultValue={campaign}>
            <option value="">Todas</option>
            {campaigns.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>

        <label>
          <span>Criativo</span>
          <select name="content" defaultValue={content}>
            <option value="">Todos</option>
            {contents.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </label>

        <button className="filterButton" type="submit">
          Aplicar filtros
        </button>
      </form>

      <section className="metricGrid" aria-label="Resumo do período">
        <article className="metricCard">
          <span>Visitantes</span>
          <strong>{visitors.toLocaleString("pt-BR")}</strong>
          <small>IDs anônimos únicos</small>
        </article>
        <article className="metricCard">
          <span>Sessões</span>
          <strong>{sessions.toLocaleString("pt-BR")}</strong>
          <small>{pageViews.toLocaleString("pt-BR")} page views</small>
        </article>
        <article className="metricCard">
          <span>Compras</span>
          <strong>{purchases.toLocaleString("pt-BR")}</strong>
          <small>{formatPercentage(percentage(purchases, sessions))} das sessões</small>
        </article>
        <article className="metricCard">
          <span>Checkout → compra</span>
          <strong>{formatPercentage(percentage(purchases, checkouts))}</strong>
          <small>{checkouts.toLocaleString("pt-BR")} checkouts iniciados</small>
        </article>
      </section>

      <section className="panel">
        <div className="panelHeader dashboardPanelHeader">
          <div>
            <p className="eyebrow">CONVERSÃO</p>
            <h2>Funil por coorte de sessões</h2>
          </div>
          <span className="hint">Somente jornadas iniciadas na página, sem eventos de teste</span>
        </div>

        {sessions === 0 ? (
          <div className="emptyState">
            Nenhum evento foi encontrado com os filtros selecionados.
          </div>
        ) : (
          <div className="funnelList">
            {funnelStages.map((stage, index) => {
              const previous = index === 0 ? stage.value : funnelStages[index - 1].value;
              const stepRate = index === 0 ? 100 : percentage(stage.value, previous);
              const width = Math.max((stage.value / funnelMaximum) * 100, stage.value > 0 ? 3 : 0);

              return (
                <article className="funnelRow" key={stage.event}>
                  <div className="funnelCopy">
                    <div>
                      <strong>{stage.label}</strong>
                      <code>{stage.event}</code>
                    </div>
                    <div className="funnelNumbers">
                      <strong>{stage.value.toLocaleString("pt-BR")}</strong>
                      <span>{formatPercentage(stepRate)}</span>
                    </div>
                  </div>
                  <div className="funnelTrack" aria-hidden="true">
                    <div className="funnelFill" style={{ width: `${width}%` }} />
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      <section className="panel">
        <div className="panelHeader dashboardPanelHeader">
          <div>
            <p className="eyebrow">AQUISIÇÃO</p>
            <h2>Campanhas e criativos</h2>
          </div>
          <span className="hint">Atribuição herdada da primeira page view da sessão</span>
        </div>

        <div className="tableScroller">
          <table className="dataTable">
            <thead>
              <tr>
                <th>Campanha</th>
                <th>Criativo</th>
                <th>Sessões</th>
                <th>Compras</th>
                <th>Conversão</th>
              </tr>
            </thead>
            <tbody>
              {breakdownRows.length === 0 ? (
                <tr>
                  <td colSpan={5}>Nenhum dado disponível.</td>
                </tr>
              ) : (
                breakdownRows.map((row, index) => {
                  const rowSessions = asCount(row.sessions);
                  const rowPurchases = asCount(row.purchases);

                  return (
                    <tr key={`${row.campaign}-${row.content}-${index}`}>
                      <td>{row.campaign ?? "Sem campanha"}</td>
                      <td>{row.content ?? "Sem criativo"}</td>
                      <td>{rowSessions.toLocaleString("pt-BR")}</td>
                      <td>{rowPurchases.toLocaleString("pt-BR")}</td>
                      <td>{formatPercentage(percentage(rowPurchases, rowSessions))}</td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
