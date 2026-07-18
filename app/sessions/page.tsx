import Link from "next/link";

import { getSql } from "@/lib/neon";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type SearchParams = Promise<{
  days?: string | string[];
  campaign?: string | string[];
  content?: string | string[];
  session?: string | string[];
}>;

type SessionRow = {
  session_id?: string;
  visitor_id?: string;
  started_at?: string;
  last_event_at?: string;
  device_type?: string | null;
  utm_source?: string | null;
  utm_medium?: string | null;
  utm_campaign?: string | null;
  utm_content?: string | null;
  last_utm_source?: string | null;
  last_utm_medium?: string | null;
  last_utm_campaign?: string | null;
  last_utm_content?: string | null;
  events?: string | number;
  max_scroll?: string | number;
  visible_seconds?: string | number;
  bought?: boolean;
  checkout?: boolean;
  cart?: boolean;
  clicked?: boolean;
};

type EventRow = {
  event_name?: string;
  client_timestamp?: string;
  page_path?: string | null;
  properties?: Record<string, unknown> | null;
};

type FilterRow = {
  utm_campaign?: string | null;
  utm_content?: string | null;
};

const validPeriods = new Set([1, 7, 14, 30, 90]);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function firstParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function numberValue(value: string | number | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function secondsLabel(value: number): string {
  if (value < 60) return `${Math.round(value)}s`;
  const minutes = Math.floor(value / 60);
  const seconds = Math.round(value % 60);
  return `${minutes}m ${seconds}s`;
}

function dateLabel(value: string | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function timeLabel(value: string | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function stageLabel(row: SessionRow): string {
  if (row.bought) return "Convertido";
  if (row.checkout) return "Abandono de checkout";
  if (row.cart) return "Abandono de carrinho";
  if (row.clicked) return "Intenção de compra";
  if (numberValue(row.max_scroll) >= 50) return "Interessado";
  return "Baixa intenção";
}

function sourceLabel(row: SessionRow): string {
  if (!row.utm_source && !row.utm_medium) return "Direto";
  return [row.utm_source, row.utm_medium].filter(Boolean).join(" / ");
}

function campaignLabel(row: SessionRow): string {
  return row.utm_campaign || "Sem campanha";
}

function creativeLabel(row: SessionRow): string {
  if (row.utm_content) return row.utm_content;
  if (!row.utm_source && !row.utm_campaign) return "Visita direta";
  return "Criativo não informado";
}

function eventDescription(row: EventRow): string {
  const properties = row.properties ?? {};

  switch (row.event_name) {
    case "page_view":
      return `Abriu ${row.page_path || "a página"}`;
    case "scroll_depth":
      return `Chegou a ${String(properties.depth ?? 0)}% da página`;
    case "section_view":
      return `Visualizou ${String(properties.section_name ?? "uma seção")}`;
    case "engagement_time":
      return `Permaneceu ativo por ${String(properties.seconds ?? 0)} segundos`;
    case "buy_intent_timing":
      return `Clicou no CTA ${String(properties.placement ?? "unknown")} após ${String(properties.seconds_to_click ?? 0)}s`;
    case "buy_button_click":
      return "Clicou em comprar";
    case "add_to_cart":
      return "Adicionou o produto ao carrinho";
    case "checkout_started":
      return "Iniciou o checkout";
    case "purchase":
      return "Compra confirmada";
    case "session_summary":
      return `Sessão resumida com ${String(properties.visible_seconds ?? 0)}s ativos e ${String(properties.max_scroll_depth ?? 0)}% de rolagem`;
    case "javascript_error":
      return `Erro: ${String(properties.message ?? "JavaScript")}`;
    default:
      return row.event_name ?? "Evento";
  }
}

export default async function SessionsPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const requestedDays = Number(firstParam(params.days));
  const days = validPeriods.has(requestedDays) ? requestedDays : 7;
  const campaign = firstParam(params.campaign).slice(0, 255);
  const content = firstParam(params.content).slice(0, 255);
  const requestedSession = firstParam(params.session);
  const selectedSession = uuidPattern.test(requestedSession) ? requestedSession : "";
  const sql = getSql();

  const [sessionsResult, filtersResult, eventsResult] = await Promise.all([
    sql`
      with base_events as (
        select
          e.*,
          coalesce(nullif(e.utm_source, ''), nullif(e.properties -> 'first_touch' ->> 'utm_source', '')) as resolved_source,
          coalesce(nullif(e.utm_medium, ''), nullif(e.properties -> 'first_touch' ->> 'utm_medium', '')) as resolved_medium,
          coalesce(nullif(e.utm_campaign, ''), nullif(e.properties -> 'first_touch' ->> 'utm_campaign', '')) as resolved_campaign,
          coalesce(nullif(e.utm_content, ''), nullif(e.properties -> 'first_touch' ->> 'utm_content', '')) as resolved_content
        from public.analytics_events e
        where e.received_at >= now() - (${days} * interval '1 day')
          and coalesce(e.properties ->> 'test', 'false') <> 'true'
      ), entries as (
        select distinct on (session_id)
          session_id,
          visitor_id,
          client_timestamp as started_at,
          device_type,
          resolved_source as utm_source,
          resolved_medium as utm_medium,
          resolved_campaign as utm_campaign,
          resolved_content as utm_content
        from base_events
        where event_name = 'page_view'
          and (${campaign} = '' or coalesce(resolved_campaign, '') = ${campaign})
          and (${content} = '' or coalesce(resolved_content, '') = ${content})
        order by session_id, client_timestamp asc
      ), last_touches as (
        select distinct on (session_id)
          session_id,
          resolved_source as last_utm_source,
          resolved_medium as last_utm_medium,
          resolved_campaign as last_utm_campaign,
          resolved_content as last_utm_content
        from base_events
        where resolved_source is not null
           or resolved_medium is not null
           or resolved_campaign is not null
           or resolved_content is not null
        order by session_id, client_timestamp desc
      ), summaries as (
        select distinct on (session_id)
          session_id,
          nullif(properties ->> 'max_scroll_depth', '')::numeric as max_scroll,
          nullif(properties ->> 'visible_seconds', '')::numeric as visible_seconds
        from base_events
        where event_name = 'session_summary'
        order by session_id, client_timestamp desc
      )
      select
        entries.session_id,
        entries.visitor_id,
        entries.started_at,
        max(e.client_timestamp) as last_event_at,
        entries.device_type,
        entries.utm_source,
        entries.utm_medium,
        entries.utm_campaign,
        entries.utm_content,
        last_touches.last_utm_source,
        last_touches.last_utm_medium,
        last_touches.last_utm_campaign,
        last_touches.last_utm_content,
        count(e.event_id) as events,
        coalesce(summaries.max_scroll, max(nullif(e.properties ->> 'depth', '')::numeric) filter (where e.event_name = 'scroll_depth'), 0) as max_scroll,
        coalesce(summaries.visible_seconds, max(nullif(e.properties ->> 'seconds', '')::numeric) filter (where e.event_name = 'engagement_time'), 0) as visible_seconds,
        bool_or(e.event_name = 'buy_button_click') as clicked,
        bool_or(e.event_name = 'add_to_cart') as cart,
        bool_or(e.event_name = 'checkout_started') as checkout,
        bool_or(e.event_name = 'purchase') as bought
      from entries
      left join base_events e on e.session_id = entries.session_id
      left join summaries on summaries.session_id = entries.session_id
      left join last_touches on last_touches.session_id = entries.session_id
      group by entries.session_id, entries.visitor_id, entries.started_at, entries.device_type,
        entries.utm_source, entries.utm_medium, entries.utm_campaign, entries.utm_content,
        last_touches.last_utm_source, last_touches.last_utm_medium,
        last_touches.last_utm_campaign, last_touches.last_utm_content,
        summaries.max_scroll, summaries.visible_seconds
      order by entries.started_at desc
      limit 50
    `,
    sql`
      select distinct
        coalesce(nullif(utm_campaign, ''), nullif(properties -> 'first_touch' ->> 'utm_campaign', '')) as utm_campaign,
        coalesce(nullif(utm_content, ''), nullif(properties -> 'first_touch' ->> 'utm_content', '')) as utm_content
      from public.analytics_events
      where received_at >= now() - interval '90 days'
        and event_name = 'page_view'
        and coalesce(properties ->> 'test', 'false') <> 'true'
        and (
          coalesce(nullif(utm_campaign, ''), nullif(properties -> 'first_touch' ->> 'utm_campaign', '')) is not null
          or coalesce(nullif(utm_content, ''), nullif(properties -> 'first_touch' ->> 'utm_content', '')) is not null
        )
      order by utm_campaign nulls last, utm_content nulls last
      limit 250
    `,
    selectedSession
      ? sql`
          select event_name, client_timestamp, page_path, properties
          from public.analytics_events
          where session_id = ${selectedSession}::uuid
            and coalesce(properties ->> 'test', 'false') <> 'true'
          order by client_timestamp asc
          limit 250
        `
      : Promise.resolve([]),
  ]);

  const sessions = Array.isArray(sessionsResult) ? (sessionsResult as SessionRow[]) : [];
  const filters = Array.isArray(filtersResult) ? (filtersResult as FilterRow[]) : [];
  const events = Array.isArray(eventsResult) ? (eventsResult as EventRow[]) : [];
  const selected = sessions.find((row) => row.session_id === selectedSession);
  const campaigns = Array.from(
    new Set(
      filters
        .map((row) => row.utm_campaign?.trim())
        .filter((value): value is string => Boolean(value)),
    ),
  );
  const contents = Array.from(
    new Set(
      filters
        .filter((row) => !campaign || row.utm_campaign === campaign)
        .map((row) => row.utm_content?.trim())
        .filter((value): value is string => Boolean(value)),
    ),
  );

  return (
    <main className="shell dashboardShell">
      <header className="dashboardHeader">
        <div>
          <p className="eyebrow">ITERAÇÃO 5</p>
          <h1 className="dashboardTitle">Sessões e atribuição</h1>
          <p className="subtitle dashboardSubtitle">
            First touch resiliente, last touch e jornada completa de cada visitante.
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
            {campaigns.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        </label>
        <label>
          <span>Criativo</span>
          <select name="content" defaultValue={content}>
            <option value="">Todos</option>
            {contents.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        </label>
        <button className="filterButton" type="submit">Aplicar filtros</button>
      </form>

      <section className="panel compact">
        <p className="eyebrow">MODELO DE ATRIBUIÇÃO</p>
        <p className="subtitle dashboardSubtitle">
          A origem principal vem da primeira visualização da sessão. Quando as colunas UTM estão vazias,
          o sistema recupera automaticamente os dados preservados em <code>first_touch</code>.
        </p>
      </section>

      <section className="panel">
        <div className="panelHeader dashboardPanelHeader">
          <div><p className="eyebrow">JORNADAS</p><h2>Últimas sessões</h2></div>
          <span className="hint">Até 50 sessões por consulta</span>
        </div>
        <div className="tableScroller">
          <table className="dataTable">
            <thead>
              <tr>
                <th>Início</th><th>Atribuição</th><th>Dispositivo</th><th>Tempo</th><th>Rolagem</th><th>Estágio</th><th></th>
              </tr>
            </thead>
            <tbody>
              {sessions.length === 0 ? (
                <tr><td colSpan={7}>Nenhuma sessão encontrada.</td></tr>
              ) : sessions.map((row) => {
                const href = `/sessions?days=${days}&campaign=${encodeURIComponent(campaign)}&content=${encodeURIComponent(content)}&session=${row.session_id}`;
                return (
                  <tr key={row.session_id}>
                    <td>{dateLabel(row.started_at)}</td>
                    <td>
                      <strong>{sourceLabel(row)}</strong><br />
                      <span>{campaignLabel(row)}</span><br />
                      <small>{creativeLabel(row)}</small>
                    </td>
                    <td>{row.device_type || "—"}</td>
                    <td>{secondsLabel(numberValue(row.visible_seconds))}</td>
                    <td>{Math.round(numberValue(row.max_scroll))}%</td>
                    <td>{stageLabel(row)}</td>
                    <td><Link className="secondaryLink" href={href}>Abrir</Link></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {selectedSession ? (
        <section className="panel">
          <div className="panelHeader dashboardPanelHeader">
            <div>
              <p className="eyebrow">LINHA DO TEMPO</p>
              <h2>{selected ? stageLabel(selected) : "Sessão selecionada"}</h2>
            </div>
            <span className="hint">ID {selectedSession.slice(0, 8)}…</span>
          </div>

          {selected ? (
            <div className="metricGrid" aria-label="Atribuição da sessão">
              <article className="metricCard">
                <span>First touch</span>
                <strong>{sourceLabel(selected)}</strong>
                <small>{campaignLabel(selected)} · {creativeLabel(selected)}</small>
              </article>
              <article className="metricCard">
                <span>Last touch</span>
                <strong>{[selected.last_utm_source, selected.last_utm_medium].filter(Boolean).join(" / ") || "Mesmo first touch"}</strong>
                <small>{selected.last_utm_campaign || campaignLabel(selected)} · {selected.last_utm_content || creativeLabel(selected)}</small>
              </article>
              <article className="metricCard">
                <span>Eventos</span>
                <strong>{numberValue(selected.events).toLocaleString("pt-BR")}</strong>
                <small>Interações registradas</small>
              </article>
              <article className="metricCard">
                <span>Estágio final</span>
                <strong>{stageLabel(selected)}</strong>
                <small>{secondsLabel(numberValue(selected.visible_seconds))} ativos</small>
              </article>
            </div>
          ) : null}

          {events.length === 0 ? (
            <div className="emptyState">Nenhum evento encontrado para esta sessão.</div>
          ) : (
            <div className="funnelList">
              {events.map((event, index) => (
                <article className="funnelRow" key={`${event.client_timestamp}-${event.event_name}-${index}`}>
                  <div className="funnelCopy">
                    <div>
                      <strong>{eventDescription(event)}</strong>
                      <code>{event.event_name}</code>
                    </div>
                    <div className="funnelNumbers"><span>{timeLabel(event.client_timestamp)}</span></div>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      ) : null}
    </main>
  );
}
