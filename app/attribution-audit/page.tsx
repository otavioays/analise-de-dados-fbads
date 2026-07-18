import Link from "next/link";

import { getSql } from "@/lib/neon";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type SearchParams = Promise<{ days?: string | string[] }>;
type Row = Record<string, string | number | boolean | null>;

const validPeriods = new Set([1, 7, 14, 30, 90]);

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

function shortId(value: unknown): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) return "—";
  return normalized.length > 18 ? `${normalized.slice(0, 8)}…${normalized.slice(-6)}` : normalized;
}

function dateLabel(value: unknown): string {
  if (!value) return "—";
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("pt-BR");
}

export default async function AttributionAuditPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const requestedDays = Number(firstParam(params.days));
  const days = validPeriods.has(requestedDays) ? requestedDays : 7;
  const sql = getSql();

  const [summaryResult, methodResult, purchaseResult] = await Promise.all([
    sql`
      with purchases as (
        select
          event_id,
          session_id::text as actual_session_id,
          visitor_id::text as actual_visitor_id,
          coalesce(nullif(properties #>> '{conversion_attribution,session_id}', ''), session_id::text) as attributed_session_id,
          coalesce(nullif(properties #>> '{conversion_attribution,visitor_id}', ''), visitor_id::text) as attributed_visitor_id,
          coalesce(nullif(properties #>> '{conversion_attribution,method}', ''), 'legacy_unresolved') as method,
          coalesce((properties #>> '{conversion_attribution,cross_session}')::boolean, false) as cross_session,
          nullif(properties #>> '{conversion_attribution,checkout_id}', '') as checkout_id,
          nullif(properties #>> '{conversion_attribution,order_id}', '') as order_id
        from public.analytics_events
        where event_name = 'purchase'
          and received_at >= now() - (${days} * interval '1 day')
          and coalesce(properties ->> 'test', 'false') <> 'true'
          and coalesce(properties ->> 'internal_traffic', 'false') <> 'true'
      )
      select
        count(*) as purchases,
        count(*) filter (where method <> 'legacy_unresolved') as resolved_purchases,
        count(*) filter (where cross_session) as cross_session_purchases,
        count(*) filter (where method = 'legacy_unresolved') as legacy_unresolved_purchases,
        count(distinct attributed_visitor_id) as attributed_purchase_visitors,
        count(distinct attributed_session_id) as attributed_purchase_sessions
      from purchases
    `,
    sql`
      select
        coalesce(nullif(properties #>> '{conversion_attribution,method}', ''), 'legacy_unresolved') as method,
        count(*) as purchases,
        count(*) filter (
          where coalesce((properties #>> '{conversion_attribution,cross_session}')::boolean, false)
        ) as cross_session_purchases
      from public.analytics_events
      where event_name = 'purchase'
        and received_at >= now() - (${days} * interval '1 day')
        and coalesce(properties ->> 'test', 'false') <> 'true'
        and coalesce(properties ->> 'internal_traffic', 'false') <> 'true'
      group by 1
      order by purchases desc, method asc
    `,
    sql`
      select
        event_id::text,
        received_at,
        client_timestamp,
        session_id::text as actual_session_id,
        visitor_id::text as actual_visitor_id,
        coalesce(nullif(properties #>> '{conversion_attribution,session_id}', ''), session_id::text) as attributed_session_id,
        coalesce(nullif(properties #>> '{conversion_attribution,visitor_id}', ''), visitor_id::text) as attributed_visitor_id,
        coalesce(nullif(properties #>> '{conversion_attribution,method}', ''), 'legacy_unresolved') as method,
        coalesce((properties #>> '{conversion_attribution,cross_session}')::boolean, false) as cross_session,
        nullif(properties #>> '{conversion_attribution,checkout_id}', '') as checkout_id,
        coalesce(
          nullif(properties #>> '{conversion_attribution,order_id}', ''),
          nullif(properties ->> 'order_id', '')
        ) as order_id,
        nullif(utm_campaign, '') as campaign,
        nullif(utm_content, '') as creative
      from public.analytics_events
      where event_name = 'purchase'
        and received_at >= now() - (${days} * interval '1 day')
        and coalesce(properties ->> 'test', 'false') <> 'true'
        and coalesce(properties ->> 'internal_traffic', 'false') <> 'true'
      order by received_at desc
      limit 50
    `,
  ]);

  const summary = ((summaryResult as Row[])[0] ?? {}) as Row;
  const purchases = num(summary.purchases);
  const resolvedPurchases = num(summary.resolved_purchases);
  const crossSessionPurchases = num(summary.cross_session_purchases);
  const unresolvedPurchases = num(summary.legacy_unresolved_purchases);
  const rows = purchaseResult as Row[];
  const methods = (methodResult as Row[]).map((row) => ({
    method: String(row.method ?? "legacy_unresolved"),
    purchases: num(row.purchases),
    cross_session_purchases: num(row.cross_session_purchases),
  }));

  const exportData = {
    schema: "conversion_attribution_audit_v1",
    generated_at: new Date().toISOString(),
    filters: { days },
    summary: {
      purchases,
      resolved_purchases: resolvedPurchases,
      resolution_rate_percent:
        purchases > 0 ? Number(((resolvedPurchases / purchases) * 100).toFixed(2)) : 0,
      cross_session_purchases: crossSessionPurchases,
      unresolved_legacy_purchases: unresolvedPurchases,
      attributed_purchase_visitors: num(summary.attributed_purchase_visitors),
      attributed_purchase_sessions: num(summary.attributed_purchase_sessions),
    },
    methods,
    recent_purchases: rows.map((row) => ({
      event_id: row.event_id,
      received_at: row.received_at,
      actual_session_id: row.actual_session_id,
      attributed_session_id: row.attributed_session_id,
      actual_visitor_id: row.actual_visitor_id,
      attributed_visitor_id: row.attributed_visitor_id,
      method: row.method,
      cross_session: bool(row.cross_session),
      checkout_id: row.checkout_id,
      order_id: row.order_id,
      campaign: row.campaign,
      creative: row.creative,
    })),
    interpretation_notes: [
      "A sessão real da compra nunca é sobrescrita.",
      "A sessão atribuída representa a melhor origem recuperável para análise de campanha.",
      "checkout_id e IDs explícitos são evidência forte; o último acesso atribuído do visitante é fallback direcional.",
      "Eventos antigos sem conversion_attribution permanecem como legacy_unresolved.",
    ],
  };

  return (
    <main className="shell dashboardShell">
      <header className="dashboardHeader">
        <div>
          <p className="eyebrow">ITERAÇÃO 11 · AUDITORIA</p>
          <h1 className="dashboardTitle">Atribuição entre sessões</h1>
          <p className="subtitle dashboardSubtitle">
            Compara a sessão em que a compra aconteceu com a sessão recuperada como origem comercial.
          </p>
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <Link className="secondaryLink" href="/attribution-lab">Abrir bancada</Link>
          <Link className="secondaryLink" href="/">Voltar à central</Link>
        </div>
      </header>

      <form className="filterBar" method="get">
        <label>
          Período
          <select name="days" defaultValue={String(days)}>
            {[1, 7, 14, 30, 90].map((period) => (
              <option key={period} value={period}>{period} dias</option>
            ))}
          </select>
        </label>
        <button className="filterButton" type="submit">Atualizar</button>
      </form>

      <section className="metricGrid" aria-label="Resumo de atribuição">
        <article className="metricCard"><span>Compras</span><strong>{purchases}</strong><small>no recorte</small></article>
        <article className="metricCard"><span>Resolvidas</span><strong>{resolvedPurchases}</strong><small>com método registrado</small></article>
        <article className="metricCard"><span>Cross-session</span><strong>{crossSessionPurchases}</strong><small>origem em outra sessão</small></article>
        <article className="metricCard"><span>Legado</span><strong>{unresolvedPurchases}</strong><small>sem resolução histórica</small></article>
      </section>

      <section className="panel">
        <div className="panelHeader dashboardPanelHeader">
          <div><p className="eyebrow">MÉTODOS</p><h2>Como cada compra foi ligada</h2></div>
        </div>
        <div className="funnelList">
          {methods.length === 0 ? (
            <p className="subtitle">Nenhuma compra válida encontrada neste período.</p>
          ) : methods.map((item) => (
            <article className="funnelRow" key={item.method}>
              <div className="funnelCopy">
                <div>
                  <strong>{item.method}</strong>
                  <small>{item.cross_session_purchases} cross-session de {item.purchases} compras</small>
                </div>
              </div>
              <strong>{item.purchases}</strong>
            </article>
          ))}
        </div>
      </section>

      <section className="panel">
        <div className="panelHeader dashboardPanelHeader">
          <div><p className="eyebrow">COMPRAS RECENTES</p><h2>Sessão real versus atribuída</h2></div>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 900 }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", padding: 10 }}>Recebida</th>
                <th style={{ textAlign: "left", padding: 10 }}>Método</th>
                <th style={{ textAlign: "left", padding: 10 }}>Real</th>
                <th style={{ textAlign: "left", padding: 10 }}>Atribuída</th>
                <th style={{ textAlign: "left", padding: 10 }}>Checkout</th>
                <th style={{ textAlign: "left", padding: 10 }}>Pedido</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={String(row.event_id)} style={{ borderTop: "1px solid rgba(255,255,255,.08)" }}>
                  <td style={{ padding: 10 }}>{dateLabel(row.received_at)}</td>
                  <td style={{ padding: 10 }}>{String(row.method ?? "legacy_unresolved")}{bool(row.cross_session) ? " · cross-session" : ""}</td>
                  <td style={{ padding: 10 }}><code>{shortId(row.actual_session_id)}</code></td>
                  <td style={{ padding: 10 }}><code>{shortId(row.attributed_session_id)}</code></td>
                  <td style={{ padding: 10 }}><code>{shortId(row.checkout_id)}</code></td>
                  <td style={{ padding: 10 }}><code>{shortId(row.order_id)}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <div className="panelHeader dashboardPanelHeader">
          <div><p className="eyebrow">JSON</p><h2>Auditoria estruturada</h2></div>
        </div>
        <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere", maxHeight: 620, overflowY: "auto" }}>
          {JSON.stringify(exportData, null, 2)}
        </pre>
      </section>
    </main>
  );
}
