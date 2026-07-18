import Link from "next/link";

import { getSql } from "@/lib/neon";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type SearchParams = Promise<{
  days?: string | string[];
  campaign?: string | string[];
  content?: string | string[];
}>;

type SummaryRow = {
  sessions?: string | number;
  avg_visible_seconds?: string | number;
  avg_max_scroll?: string | number;
  quick_exits?: string | number;
  javascript_errors?: string | number;
  avg_seconds_to_click?: string | number;
};

type ScrollRow = {
  depth?: string | number;
  sessions?: string | number;
};

type SectionRow = {
  section_name?: string | null;
  chapter?: string | null;
  sessions?: string | number;
};

type PlacementRow = {
  placement?: string | null;
  clicks?: string | number;
  avg_seconds?: string | number;
  avg_scroll?: string | number;
};

type FilterRow = {
  utm_campaign?: string | null;
  utm_content?: string | null;
};

const validPeriods = new Set([1, 7, 14, 30, 90]);

function firstParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function numberValue(value: string | number | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function percentage(value: number, total: number): string {
  const result = total > 0 ? (value / total) * 100 : 0;
  return `${result.toLocaleString("pt-BR", {
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

export default async function BehaviorPage({
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

  const [summaryResult, scrollResult, sectionsResult, placementsResult, filtersResult] =
    await Promise.all([
      sql`
        with cohort as (
          select distinct session_id
          from public.analytics_events
          where received_at >= now() - (${days} * interval '1 day')
            and event_name = 'page_view'
            and coalesce(properties ->> 'test', 'false') <> 'true'
            and (${campaign} = '' or coalesce(utm_campaign, '') = ${campaign})
            and (${content} = '' or coalesce(utm_content, '') = ${content})
        ), summaries as (
          select distinct on (e.session_id)
            e.session_id,
            nullif(e.properties ->> 'visible_seconds', '')::numeric as visible_seconds,
            nullif(e.properties ->> 'max_scroll_depth', '')::numeric as max_scroll_depth,
            coalesce((e.properties ->> 'quick_exit')::boolean, false) as quick_exit
          from public.analytics_events e
          join cohort c on c.session_id = e.session_id
          where e.event_name = 'session_summary'
          order by e.session_id, e.client_timestamp desc
        ), click_timing as (
          select distinct on (e.session_id)
            e.session_id,
            nullif(e.properties ->> 'seconds_to_click', '')::numeric as seconds_to_click
          from public.analytics_events e
          join cohort c on c.session_id = e.session_id
          where e.event_name = 'buy_intent_timing'
          order by e.session_id, e.client_timestamp asc
        )
        select
          count(*) as sessions,
          coalesce(avg(s.visible_seconds), 0) as avg_visible_seconds,
          coalesce(avg(s.max_scroll_depth), 0) as avg_max_scroll,
          count(*) filter (where s.quick_exit) as quick_exits,
          (
            select count(*)
            from public.analytics_events e
            join cohort c on c.session_id = e.session_id
            where e.event_name = 'javascript_error'
          ) as javascript_errors,
          coalesce(avg(ct.seconds_to_click), 0) as avg_seconds_to_click
        from cohort c
        left join summaries s on s.session_id = c.session_id
        left join click_timing ct on ct.session_id = c.session_id
      `,
      sql`
        with cohort as (
          select distinct session_id
          from public.analytics_events
          where received_at >= now() - (${days} * interval '1 day')
            and event_name = 'page_view'
            and coalesce(properties ->> 'test', 'false') <> 'true'
            and (${campaign} = '' or coalesce(utm_campaign, '') = ${campaign})
            and (${content} = '' or coalesce(utm_content, '') = ${content})
        )
        select
          (e.properties ->> 'depth')::integer as depth,
          count(distinct e.session_id) as sessions
        from public.analytics_events e
        join cohort c on c.session_id = e.session_id
        where e.event_name = 'scroll_depth'
        group by 1
        order by 1
      `,
      sql`
        with cohort as (
          select distinct session_id
          from public.analytics_events
          where received_at >= now() - (${days} * interval '1 day')
            and event_name = 'page_view'
            and coalesce(properties ->> 'test', 'false') <> 'true'
            and (${campaign} = '' or coalesce(utm_campaign, '') = ${campaign})
            and (${content} = '' or coalesce(utm_content, '') = ${content})
        )
        select
          coalesce(nullif(e.properties ->> 'section_name', ''), 'Seção sem nome') as section_name,
          e.properties ->> 'chapter' as chapter,
          count(distinct e.session_id) as sessions
        from public.analytics_events e
        join cohort c on c.session_id = e.session_id
        where e.event_name = 'section_view'
        group by 1, 2
        order by min(nullif(e.properties ->> 'chapter', '')::integer) nulls last, sessions desc
      `,
      sql`
        with cohort as (
          select distinct session_id
          from public.analytics_events
          where received_at >= now() - (${days} * interval '1 day')
            and event_name = 'page_view'
            and coalesce(properties ->> 'test', 'false') <> 'true'
            and (${campaign} = '' or coalesce(utm_campaign, '') = ${campaign})
            and (${content} = '' or coalesce(utm_content, '') = ${content})
        )
        select
          coalesce(nullif(e.properties ->> 'placement', ''), 'unknown') as placement,
          count(*) as clicks,
          coalesce(avg(nullif(e.properties ->> 'seconds_to_click', '')::numeric), 0) as avg_seconds,
          coalesce(avg(nullif(e.properties ->> 'max_scroll_depth', '')::numeric), 0) as avg_scroll
        from public.analytics_events e
        join cohort c on c.session_id = e.session_id
        where e.event_name = 'buy_intent_timing'
        group by 1
        order by clicks desc
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
    ]);

  const summaryRows = Array.isArray(summaryResult) ? (summaryResult as SummaryRow[]) : [];
  const scrollRows = Array.isArray(scrollResult) ? (scrollResult as ScrollRow[]) : [];
  const sectionRows = Array.isArray(sectionsResult) ? (sectionsResult as SectionRow[]) : [];
  const placementRows = Array.isArray(placementsResult)
    ? (placementsResult as PlacementRow[])
    : [];
  const filterRows = Array.isArray(filtersResult) ? (filtersResult as FilterRow[]) : [];
  const summary = summaryRows[0] ?? {};
  const sessions = numberValue(summary.sessions);
  const avgVisible = numberValue(summary.avg_visible_seconds);
  const avgScroll = numberValue(summary.avg_max_scroll);
  const quickExits = numberValue(summary.quick_exits);
  const errors = numberValue(summary.javascript_errors);
  const avgClick = numberValue(summary.avg_seconds_to_click);

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

  return (
    <main className="shell dashboardShell">
      <header className="dashboardHeader">
        <div>
          <p className="eyebrow">ITERAÇÃO 3</p>
          <h1 className="dashboardTitle">Comportamento na página</h1>
          <p className="subtitle dashboardSubtitle">
            Veja atenção, rolagem, seções vistas, tempo até o clique e erros técnicos.
          </p>
        </div>
        <Link className="secondaryLink" href="/dashboard">
          Voltar ao funil
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
        <label>
          <span>Criativo</span>
          <select name="content" defaultValue={content}>
            <option value="">Todos</option>
            {contents.map((item) => (
              <option key={item} value={item}>{item}</option>
            ))}
          </select>
        </label>
        <button className="filterButton" type="submit">Aplicar filtros</button>
      </form>

      <section className="metricGrid" aria-label="Resumo comportamental">
        <article className="metricCard">
          <span>Tempo visível médio</span>
          <strong>{secondsLabel(avgVisible)}</strong>
          <small>Aba realmente ativa</small>
        </article>
        <article className="metricCard">
          <span>Rolagem média</span>
          <strong>{Math.round(avgScroll)}%</strong>
          <small>Profundidade máxima por sessão</small>
        </article>
        <article className="metricCard">
          <span>Saídas rápidas</span>
          <strong>{percentage(quickExits, sessions)}</strong>
          <small>{quickExits.toLocaleString("pt-BR")} de {sessions.toLocaleString("pt-BR")} sessões</small>
        </article>
        <article className="metricCard">
          <span>Tempo até comprar</span>
          <strong>{avgClick > 0 ? secondsLabel(avgClick) : "—"}</strong>
          <small>{errors.toLocaleString("pt-BR")} erros JavaScript</small>
        </article>
      </section>

      <section className="panel">
        <div className="panelHeader dashboardPanelHeader">
          <div><p className="eyebrow">ATENÇÃO</p><h2>Profundidade de rolagem</h2></div>
          <span className="hint">Sessões que alcançaram cada marco</span>
        </div>
        <div className="funnelList">
          {scrollRows.length === 0 ? (
            <div className="emptyState">Os novos eventos começarão a aparecer nas próximas visitas.</div>
          ) : scrollRows.map((row) => {
            const depth = numberValue(row.depth);
            const count = numberValue(row.sessions);
            return (
              <article className="funnelRow" key={depth}>
                <div className="funnelCopy">
                  <div><strong>{depth}% da página</strong><code>scroll_depth</code></div>
                  <div className="funnelNumbers"><strong>{count}</strong><span>{percentage(count, sessions)}</span></div>
                </div>
                <div className="funnelTrack" aria-hidden="true"><div className="funnelFill" style={{ width: percentage(count, sessions) }} /></div>
              </article>
            );
          })}
        </div>
      </section>

      <section className="panel">
        <div className="panelHeader dashboardPanelHeader">
          <div><p className="eyebrow">CONTEÚDO</p><h2>Seções visualizadas</h2></div>
          <span className="hint">Alcance por capítulo da landing page</span>
        </div>
        <div className="tableScroller">
          <table className="dataTable">
            <thead><tr><th>Capítulo</th><th>Seção</th><th>Sessões</th><th>Alcance</th></tr></thead>
            <tbody>
              {sectionRows.length === 0 ? (
                <tr><td colSpan={4}>Nenhuma seção registrada ainda.</td></tr>
              ) : sectionRows.map((row, index) => {
                const count = numberValue(row.sessions);
                return (
                  <tr key={`${row.chapter}-${row.section_name}-${index}`}>
                    <td>{row.chapter ?? "—"}</td><td>{row.section_name ?? "Sem nome"}</td>
                    <td>{count}</td><td>{percentage(count, sessions)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <div className="panelHeader dashboardPanelHeader">
          <div><p className="eyebrow">INTENÇÃO</p><h2>Onde o clique acontece</h2></div>
          <span className="hint">Posição, tempo e rolagem antes do CTA</span>
        </div>
        <div className="tableScroller">
          <table className="dataTable">
            <thead><tr><th>Posição</th><th>Cliques</th><th>Tempo médio</th><th>Rolagem média</th></tr></thead>
            <tbody>
              {placementRows.length === 0 ? (
                <tr><td colSpan={4}>Nenhum clique comportamental registrado ainda.</td></tr>
              ) : placementRows.map((row, index) => (
                <tr key={`${row.placement}-${index}`}>
                  <td>{row.placement ?? "unknown"}</td>
                  <td>{numberValue(row.clicks)}</td>
                  <td>{secondsLabel(numberValue(row.avg_seconds))}</td>
                  <td>{Math.round(numberValue(row.avg_scroll))}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
