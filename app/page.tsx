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
  const hasSupabaseUrl = Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL);
  const hasServiceRole = Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY);
  const isConfigured = hasSupabaseUrl && hasServiceRole;

  return (
    <main className="shell">
      <section className="hero">
        <p className="eyebrow">ITERAÇÃO 1</p>
        <h1>Conversion Tracker</h1>
        <p className="subtitle">
          Esta página serve como bancada de testes. O <code>page_view</code> é
          disparado automaticamente; os botões abaixo simulam as etapas do
          funil.
        </p>

        <div className={isConfigured ? "status ready" : "status pending"}>
          <span className="statusDot" />
          <div>
            <strong>
              {isConfigured
                ? "Supabase configurado"
                : "Supabase ainda não configurado"}
            </strong>
            <p>
              {isConfigured
                ? "Os eventos já podem ser gravados no banco."
                : "Adicione as variáveis de ambiente antes de testar os eventos."}
            </p>
          </div>
        </div>
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
        <p className="eyebrow">CHECKLIST</p>
        <ol className="checklist">
          <li>Executar a migration SQL no Supabase.</li>
          <li>Preencher o arquivo <code>.env.local</code>.</li>
          <li>Rodar <code>npm install</code> e <code>npm run dev</code>.</li>
          <li>Clicar nos quatro botões desta página.</li>
          <li>Confirmar os registros na tabela <code>analytics_events</code>.</li>
        </ol>
      </section>
    </main>
  );
}
