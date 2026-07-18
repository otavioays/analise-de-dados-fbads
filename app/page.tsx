import Link from "next/link";

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

export default function Home() {
  const isConfigured = Boolean(process.env.DATABASE_URL);

  return (
    <main className="shell">
      <section className="hero">
        <p className="eyebrow">CENTRAL DE CONTROLE</p>
        <h1>Conversion Tracker</h1>
        <p className="subtitle">
          Acesse conversão, comportamento e jornadas individuais ou use esta
          página como bancada para disparar eventos de teste.
        </p>

        <div className={isConfigured ? "status ready" : "status pending"}>
          <span className="statusDot" />
          <div>
            <strong>
              {isConfigured ? "Neon configurado" : "Neon ainda não configurado"}
            </strong>
            <p>
              {isConfigured
                ? "A captura está ativa e os painéis estão prontos para análise."
                : "Conecte o banco e disponibilize DATABASE_URL na Vercel."}
            </p>
          </div>
        </div>

        <nav
          aria-label="Painéis de análise"
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 12,
            marginTop: 20,
          }}
        >
          <Link className="primaryLink" href="/dashboard">
            Abrir dashboard do funil
          </Link>
          <Link className="secondaryLink" href="/behavior">
            Ver comportamento na página
          </Link>
          <Link className="secondaryLink" href="/sessions">
            Explorar sessões individuais
          </Link>
        </nav>
      </section>

      <section className="panel">
        <div className="panelHeader">
          <div>
            <p className="eyebrow">TESTE DO FUNIL</p>
            <h2>Dispare os eventos em ordem</h2>
          </div>
          <span className="hint">Abra o console do navegador</span>
        </div>

        <div className="eventGrid">
          {testEvents.map((event) => (
            <button
              key={event.name}
              type="button"
              className="eventButton"
              data-track={event.name}
              data-track-properties={JSON.stringify(event.properties)}
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
          <li>Dashboard de conversão disponível em <code>/dashboard</code>.</li>
          <li>Análise comportamental disponível em <code>/behavior</code>.</li>
          <li>Jornadas individuais disponíveis em <code>/sessions</code>.</li>
        </ol>
      </section>
    </main>
  );
}
