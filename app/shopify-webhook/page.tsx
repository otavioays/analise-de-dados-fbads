import Link from "next/link";
import { headers } from "next/headers";

import { getDatabaseConfig, getSql } from "@/lib/neon";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type StatsRow = {
  total_purchases: string | number | null;
  verified_purchases: string | number | null;
  unresolved_purchases: string | number | null;
  duplicate_safe_orders: string | number | null;
  last_purchase_at: string | null;
};

function num(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export default async function ShopifyWebhookPage() {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host");
  const protocol = requestHeaders.get("x-forwarded-proto") ?? "https";
  const endpoint = host
    ? `${protocol}://${host}/api/shopify/orders-paid`
    : "/api/shopify/orders-paid";

  const databaseConfig = getDatabaseConfig();
  const secretConfigured = Boolean(process.env.SHOPIFY_WEBHOOK_SECRET?.trim());
  let stats: StatsRow = {
    total_purchases: 0,
    verified_purchases: 0,
    unresolved_purchases: 0,
    duplicate_safe_orders: 0,
    last_purchase_at: null,
  };
  let statsError: string | null = null;

  if (databaseConfig.isConfigured) {
    try {
      const sql = getSql();
      const rows = (await sql`
        select
          count(*) as total_purchases,
          count(*) filter (
            where properties ->> 'attribution_resolution' = 'original_session_verified'
          ) as verified_purchases,
          count(*) filter (
            where coalesce(properties ->> 'attribution_eligible', 'false') <> 'true'
          ) as unresolved_purchases,
          count(distinct properties ->> 'order_id') as duplicate_safe_orders,
          max(received_at)::text as last_purchase_at
        from public.analytics_events
        where event_name = 'purchase'
          and properties ->> 'purchase_source' = 'shopify_orders_paid_webhook'
      `) as StatsRow[];
      stats = rows[0] ?? stats;
    } catch (error) {
      console.error("Failed to load Shopify webhook stats", error);
      statsError = "Não foi possível consultar os eventos do webhook neste deploy.";
    }
  }

  const ready = databaseConfig.isConfigured && secretConfigured;

  return (
    <main className="shell dashboardShell">
      <header className="dashboardHeader">
        <div>
          <p className="eyebrow">ITERAÇÃO 11</p>
          <h1 className="dashboardTitle">Atribuição de compras Shopify</h1>
          <p className="subtitle dashboardSubtitle">
            Confirma a compra no servidor e reconecta o pedido à sessão original da landing usando os identificadores preservados no carrinho.
          </p>
        </div>
        <Link className="secondaryLink" href="/">Voltar à central</Link>
      </header>

      <section className="metricGrid" aria-label="Status do webhook Shopify">
        <article className="metricCard">
          <span>Webhook</span>
          <strong>{secretConfigured ? "Pronto" : "Pendente"}</strong>
          <small>{secretConfigured ? "Assinatura HMAC habilitada" : "Falta SHOPIFY_WEBHOOK_SECRET"}</small>
        </article>
        <article className="metricCard">
          <span>Compras recebidas</span>
          <strong>{num(stats.total_purchases)}</strong>
          <small>eventos server-side únicos</small>
        </article>
        <article className="metricCard">
          <span>Sessão verificada</span>
          <strong>{num(stats.verified_purchases)}</strong>
          <small>compras ligadas à sessão original</small>
        </article>
        <article className="metricCard">
          <span>Sem resolução forte</span>
          <strong>{num(stats.unresolved_purchases)}</strong>
          <small>não entram como campanha confirmada</small>
        </article>
      </section>

      <section className="panel">
        <div className="panelHeader dashboardPanelHeader">
          <div>
            <p className="eyebrow">CONFIGURAÇÃO</p>
            <h2>{ready ? "Endpoint pronto para receber pedidos pagos" : "Conclua os dois requisitos abaixo"}</h2>
          </div>
          <span className="hint">Tópico: orders/paid</span>
        </div>

        <div className="funnelList">
          <article className="funnelRow">
            <div className="funnelCopy">
              <div>
                <strong>1. Banco de dados</strong>
                <code>{databaseConfig.isConfigured ? "configurado" : "pendente"}</code>
                <small>
                  {databaseConfig.isConfigured
                    ? `Conexão detectada por ${databaseConfig.variableName}.`
                    : "Configure uma variável de conexão do Neon na Vercel."}
                </small>
              </div>
            </div>
          </article>

          <article className="funnelRow">
            <div className="funnelCopy">
              <div>
                <strong>2. Segredo do webhook</strong>
                <code>{secretConfigured ? "configurado" : "pendente"}</code>
                <small>
                  Crie a variável <code>SHOPIFY_WEBHOOK_SECRET</code> na Vercel usando o segredo de assinatura fornecido pela Shopify.
                </small>
              </div>
            </div>
          </article>

          <article className="funnelRow">
            <div className="funnelCopy">
              <div>
                <strong>3. Endpoint de entrega</strong>
                <code>POST</code>
                <small style={{ overflowWrap: "anywhere" }}>{endpoint}</small>
              </div>
            </div>
          </article>
        </div>
      </section>

      <section className="panel">
        <div className="panelHeader dashboardPanelHeader">
          <div>
            <p className="eyebrow">REGRA DE ATRIBUIÇÃO</p>
            <h2>Identidade explícita antes de qualquer inferência</h2>
          </div>
          <span className="hint">Sem adivinhar campanha</span>
        </div>

        <ol className="checklist">
          <li>A landing envia <code>ct_visitor_id</code> e <code>ct_session_id</code> como atributos do carrinho.</li>
          <li>A Shopify devolve esses atributos no payload do pedido pago.</li>
          <li>O endpoint verifica a assinatura HMAC antes de aceitar o evento.</li>
          <li>Quando a sessão existe no banco, o visitor_id é recuperado dela e a compra entra na sessão original.</li>
          <li>Quando o session_id está ausente ou inválido, a compra é preservada, mas marcada como não resolvida.</li>
          <li>O order_id gera um event_id determinístico, impedindo duplicação em reentregas do webhook.</li>
        </ol>
      </section>

      <section className="panel compact">
        <p className="eyebrow">SAÚDE</p>
        <p className="subtitle" style={{ marginTop: 8 }}>
          {statsError ??
            (stats.last_purchase_at
              ? `Último pedido recebido em ${new Date(stats.last_purchase_at).toLocaleString("pt-BR")}. ${num(stats.duplicate_safe_orders)} pedidos únicos registrados.`
              : "Nenhum pedido pago foi recebido por este webhook ainda.")}
        </p>
      </section>
    </main>
  );
}
