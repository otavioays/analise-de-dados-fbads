import Link from "next/link";

import { getDatabaseConfig } from "@/lib/neon";

const testEvents = [
  {
    name: "buy_button_click",
    label: "1. Clique em comprar",
    properties: { product_id: "watch_01", price: 89.9 },
  },
  {
    name: "add_to_cart",
    label: "2. Adicionar ao carrinho",
    properties: { product_id: "watch_01", quantity: 1, price: 89.9 },
  },
  {
    name: "checkout_started",
    label: "3. Iniciar checkout",
    properties: { cart_value: 89.9, currency: "BRL" },
  },
  {
    name: "purchase",
    label: "4. Simular compra",
    properties: {
      order_id: "TEST-ORDER-001",
      value: 89.9,
      currency: "BRL",
      test: true,
    },
  },
];

const dashboardLinks = [
  { href: "/dashboard", label: "Abrir dashboard do funil", primary: true },
  { href: "/behavior", label: "Ver comportamento na página", primary: false },
  { href: "/sessions", label: "Explorar sessões individuais", primary: false },
  { href: "/compare", label: "Comparar criativos", primary: false },
  { href: "/ai-export", label: "Copiar dados para IA", primary: false },
  { href: "/session-lab", label: "Testar integridade da sessão", primary: false },
  { href: "/attribution-lab", label: "Simular compra cross-session", primary: false },
  { href: "/attribution-audit", label: "Auditar atribuição de compras", primary: false },
];

export default function Home() {
  const databaseConfig = getDatabaseConfig();
  const isConfigured = databaseConfig.isConfigured;

  return (
    <main className="shell">
      <section className="hero">
        <p className="eyebrow">CENTRAL DE CONTROLE</p>
        <h1>Conversion Tracker</h1>
        <p className="subtitle">
          Acesse conversão, comportamento, jornadas, comparação de criativos,
          atribuição entre sessões e exportação estruturada para IA.
        </p>

        <div className={isConfigured ? "status ready" : "status pending"}>
          <span className="statusDot" />
          <div>
            <strong>
              {isConfigured ? "Neon configurado" : "Neon ainda não configurado"}
            </strong>
            <p>
              {isConfigured
                ? `Conexão detectada por ${databaseConfig.variableName}. Os painéis estão liberados.`
                : "Nenhuma variável de conexão do Neon foi encontrada neste deploy."}
            </p>
          </div>
        </div>

        {!isConfigured && (
          <div style={{ marginTop: 16 }}>
            <Link className="primaryLink" href="/setup">
              Configurar conexão do Neon
            </Link>
          </div>
        )}

        <nav
          aria-label="Painéis de análise"
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 12,
            marginTop: 20,
          }}
        >
          {dashboardLinks.map((item) => {
            const className = item.primary ? "primaryLink" : "secondaryLink";

            if (isConfigured || item.href === "/session-lab") {
              return (
                <Link className={className} href={item.href} key={item.href}>
                  {item.label}
                </Link>
              );
            }

            return (
              <span
                aria-disabled="true"
                className={className}
                key={item.href}
                title="Configure o Neon antes de abrir este painel"
                style={{ cursor: "not-allowed", opacity: 0.45 }}
              >
                {item.label}
              </span>
            );
          })}
        </nav>

        {!isConfigured && (
          <p className="subtitle" style={{ marginTop: 14, fontSize: 14 }}>
            Os painéis ficam bloqueados para evitar o erro de servidor enquanto o banco não estiver conectado.
          </p>
        )}
      </section>

      <section className="panel">
        <div className="panelHeader">
          <div>
            <p className="eyebrow">TESTE DO FUNIL</p>
            <h2>Dispare os eventos em ordem</h2>
          </div>
          <span className="hint">
            {isConfigured ? "Abra o console do navegador" : "Aguardando conexão com o banco"}
          </span>
        </div>

        <div className="eventGrid">
          {testEvents.map((event) => (
            <button
              key={event.name}
              type="button"
              className="eventButton"
              data-track={event.name}
              data-track-properties={JSON.stringify(event.properties)}
              disabled={!isConfigured}
              title={
                isConfigured
                  ? undefined
                  : "Configure o Neon antes de disparar eventos de teste"
              }
              style={!isConfigured ? { cursor: "not-allowed", opacity: 0.45 } : undefined}
            >
              <span>{event.label}</span>
              <code>{event.name}</code>
            </button>
          ))}
        </div>
      </section>

      <section className="panel compact">
        <p className="eyebrow">STATUS</p>
        <ol className="checklist">
          <li>Neon conectado à Vercel.</li>
          <li>Tabela <code>analytics_events</code> criada.</li>
          <li>Eventos do funil gravados corretamente.</li>
          <li>Sessões persistentes entre abas por 30 minutos.</li>
          <li>Dashboard de conversão disponível em <code>/dashboard</code>.</li>
          <li>Análise comportamental disponível em <code>/behavior</code>.</li>
          <li>Jornadas individuais disponíveis em <code>/sessions</code>.</li>
          <li>Ranking de criativos disponível em <code>/compare</code>.</li>
          <li>Exportação para IA disponível em <code>/ai-export</code>.</li>
          <li>Bancada cross-session disponível em <code>/attribution-lab</code>.</li>
          <li>Auditoria de compras disponível em <code>/attribution-audit</code>.</li>
        </ol>
      </section>
    </main>
  );
}
