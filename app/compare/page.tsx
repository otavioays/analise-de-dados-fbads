import Link from "next/link";

import { getSql } from "@/lib/neon";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type SearchParams = Promise<{
  days?: string | string[];
  campaign?: string | string[];
}>;

type CreativeRow = {
  campaign?: string | null;
  content?: string | null;
  sessions?: string | number;
  avg_visible_seconds?: string | number;
  avg_scroll?: string | number;
  clicks?: string | number;
  carts?: string | number;
  checkouts?: string | number;
  purchases?: string | number;
};

type CampaignRow = {
  campaign?: string | null;
};

const validPeriods = new Set([1, 7, 14, 30, 90]);

function firstParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function numberValue(value: string | number | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function percentage(value: number, total: number): number {
  return total > 0 ? (value / total) * 100 : 0;
}

function percentageLabel(value: number): string {
  return `${value.toLocaleString("pt-BR", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })}%`;
}

function secondsLabel(value: number): string {
  if (value < 60) return `${Math.round(value)}s`;
  const minutes = Math.floor(value / 60);
  const seconds = Math.round(value % 60);
  return `${minutes}m ${seconds}s`;
}

function score(row: CreativeRow): number {
  const sessions = numberValue(row.sessions);
  const clickRate = percentage(numberValue(row.clicks), sessions);
  const checkoutRate = percentage(numberValue(row.checkouts), sessions);
  const purchaseRate = percentage(numberValue(row.purchases), sessions);
  const scroll = Math.min(numberValue(row.avg_scroll), 100);
  const visible = Math.min(numberValue(row.avg_visible_seconds), 120) / 1.2;

  return Math.round(
    purchaseRate * 4 + checkoutRate * 1.5 + clickRate * 0.5 + scroll * 0.15 + visible * 0.1,
  );
}

function verdict(row: CreativeRow): string {
  const sessions = numberValue(row.sessions);
  const clicks = numberValue(row.clicks);
  const checkouts = numberValue(row.checkouts);
  const purchases = numberValue(row.purchases);
  const clickRate = percentage(clicks, sessions);
  const checkoutRate = percentage(checkouts, sessions);
  const avgScroll = numberValue(row.avg_scroll);

  if (purchases > 0) return "Vencedor de vendas";
  if (checkouts > 0) return "Forte intenção";
  if (clickRate >= 15) return "Gera desejo";
  if (avgScroll >= 60) return "Prende atenção";
  if (sessions < 10) return "Poucos dados";
  return "Tráfego frio";
}

export default async function ComparePage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const requestedDays = Number(firstParam(params.days));
  const days = validPeriods.has(requestedDays) ? requestedDays : 7;
  const campaign = firstParam(params.campaign).slice(0, 255);
  const sql = getSql();

  const [creativeResult, campaignResult] = await Promise.all([
    sql`
      with base_events as (
        select *
        from public.analytics_events
        where received_at >= now() - (${days} * interval '1 day')
          and coalesce(properties ->> 'test', 'false') <> 'true'
      ), attributed_sessions as (
        select distinct on (session_id)
          session_id,
          coalesce(
            nullif(utm_campaign, ''),
            nullif(properties #>> '{first_touch,utm_campaign}', ''),
            'Direto'
          ) as campaign,
          coalesce(
            nullif(utm_content, ''),
            nullif(properties #>> '{first_touch,utm_content}', ''),
            'Criativo não informado'
          ) as content
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
      ), session_metrics as (
        select
          a.session_id,
          a.campaign,
          a.content,
          coalesce(
            s.visible_seconds,
            max(nullif(e.properties ->> 'seconds', '')::numeric)
              filter (where e.event_name = 'engagement_time'),
            0
          ) as visible_seconds,
          coalesce(
            s.max_scroll,
            max(nullif(e.properties ->> 'depth', '')::numeric)
              filter (where e.event_name = 'scroll_depth'),
            0
          ) as max_scroll,
          bool_or(e.event_name = 'buy_button_click') as clicked,
          bool_or(e.event_name = 'add_to_cart') as cart,
          bool_or(e.event_name = 'checkout_started') as checkout,
          bool_or(e.event_name = 'purchase') as purchased
        from attributed_sessions a
        left join base_events e on e.session_id = a.session_id
        left join summaries s on s.session_id = a.session_id
        where (${campaign} = '' or a.campaign = ${campaign})
        group by a.session_id, a.campaign, a.content, s.visible_seconds, s.max_scroll
      )
      select
        campaign,
        content,
        count(*) as sessions,
        coalesce(avg(visible_seconds), 0) as avg_visible_seconds,
        coalesce(avg(max_scroll), 0) as avg_scroll,
        count(*) filter (where clicked) as clicks,
        count(*) filter (where cart) as carts,
        count(*) filter (where checkout) as checkouts,
        count(*) filter (where purchased) as purchases
      from session_metrics
      group by campaign, content
      order by purchases desc, checkouts desc, clicks desc, sessions desc
      limit 50
    `,
    sql`
      with attributed as (
        select distinct on (session_id)
          session_id,
          coalesce(
            nullif(utm_campaign, ''),
            nullif(properties #>> '{first_touch,utm_campaign}', ''),
            'Direto'
          ) as campaign
        from public.analytics_events
        where received_at >= now() - interval '90 days'
          and event_name = 'page_view'
          and coalesce(properties ->> 'test', 'false') <> 'true'
        order by session_id, client_timestamp asc
      )
      select distinct campaign
      from attributed
      order by campaign
      limit 250
    `,
  ]);

  const rows = Array.isArray(creativeResult) ? (creativeResult as CreativeRow[]) : [];
  const campaigns = Array.isArray(campaignResult)
    ? (campaignResult as CampaignRow[])
        .map((row) => row.campaign?.trim())
        .filter((value): value is string => Boolean(value))
    : [];

  const ranked = rows
    .map((row) => ({ row, score: score(row) }))
    .sort((a, b) => b.score - a.score);
  const leader = ranked[0];
  const totalSessions = rows.reduce((sum, row) => sum + numberValue(row.sessions), 0);
  const totalPurchases = rows.reduce((sum, row) => sum + numberValue(row.purchases), 0);

  return (
    <main className="shell dashboardShell">
      <header className="dashboardHeader">
        <div>
          <p className="eyebrow">ITERAÇÃO 6</p>
          <h1 className="dashboardTitle">Comparação de criativos</h1>
          <p className="subtitle dashboardSubtitle">
            Descubra quais anúncios trazem atenção, intenção e vendas, não apenas cliques vazios.
          </p>
        </div>
        <Link className="secondaryLink" href="/">
          Voltar à central
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
              <option key={item} value={item}>{item}</option>
            ))}
          </select>
        </label>
        <button className="filterButton" type="submit">Aplicar filtros</button>
      </form>

      <section className="metricGrid" aria-label="Resumo comparativo">
        <article className="metricCard">
          <span>Criativos analisados</span>
          <strong>{rows.length.toLocaleString("pt-BR")}</strong>
          <small>{totalSessions.toLocaleString("pt-BR")} sessões atribuídas</small>
        </article>
        <article className="metricCard">
          <span>Líder atual</span>
          <strong>{leader?.row.content || "—"}</strong>
          <small>{leader ? `${leader.score} pontos` : "Aguardando dados"}</small>
        </article>
        <article className="metricCard">
          <span>Compras atribuídas</span>
          <strong>{totalPurchases.toLocaleString("pt-BR")}</strong>
          <small>{percentageLabel(percentage(totalPurchases, totalSessions))} das sessões</small>
        </article>
        <article className="metricCard">
          <span>Leitura do líder</span>
          <strong>{leader ? verdict(leader.row) : "—"}</strong>
          <small>Combina intenção e conversão</small>
        </article>
      </section>

      <section className="panel">
        <div className="panelHeader dashboardPanelHeader">
          <div>
            <p className="eyebrow">RANKING</p>
            <h2>Qualidade do tráfego por criativo</h2>
          </div>
          <span className="hint">Ordenado por score de intenção e venda</span>
        </div>

        <div className="tableScroller">
          <table className="dataTable">
            <thead>
              <tr>
                <th>#</th>
                <th>Campanha / criativo</th>
                <th>Sessões</th>
                <th>Tempo</th>
                <th>Rolagem</th>
                <th>Clique</th>
                <th>Checkout</th>
                <th>Compra</th>
                <th>Diagnóstico</th>
              </tr>
            </thead>
            <tbody>
              {ranked.length === 0 ? (
                <tr><td colSpan={9}>Nenhum criativo encontrado no período.</td></tr>
              ) : ranked.map(({ row, score: rowScore }, index) => {
                const sessions = numberValue(row.sessions);
                const clicks = numberValue(row.clicks);
                const checkouts = numberValue(row.checkouts);
                const purchases = numberValue(row.purchases);

                return (
                  <tr key={`${row.campaign}-${row.content}-${index}`}>
                    <td><strong>{index + 1}</strong></td>
                    <td>
                      {row.campaign || "Direto"}
                      <br />
                      <small>{row.content || "Criativo não informado"}</small>
                    </td>
                    <td>{sessions.toLocaleString("pt-BR")}</td>
                    <td>{secondsLabel(numberValue(row.avg_visible_seconds))}</td>
                    <td>{Math.round(numberValue(row.avg_scroll))}%</td>
                    <td>{percentageLabel(percentage(clicks, sessions))}</td>
                    <td>{percentageLabel(percentage(checkouts, sessions))}</td>
                    <td>{percentageLabel(percentage(purchases, sessions))}</td>
                    <td>
                      <strong>{verdict(row)}</strong>
                      <br />
                      <small>{rowScore} pontos</small>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel compact">
        <p className="eyebrow">COMO LER</p>
        <ol className="checklist">
          <li><strong>Prende atenção:</strong> boa rolagem, mas ainda precisa gerar mais desejo.</li>
          <li><strong>Gera desejo:</strong> recebe cliques, mas pode perder força no checkout.</li>
          <li><strong>Forte intenção:</strong> leva pessoas ao checkout, mesmo sem compra registrada ainda.</li>
          <li><strong>Vencedor de vendas:</strong> já possui compra atribuída e merece mais volume com controle.</li>
        </ol>
      </section>
    </main>
  );
}
