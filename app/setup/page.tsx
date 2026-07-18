import Link from "next/link";

import { getDatabaseConfig } from "@/lib/neon";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default function DatabaseSetupPage() {
  const config = getDatabaseConfig();

  return (
    <main className="shell dashboardShell">
      <header className="dashboardHeader">
        <div>
          <p className="eyebrow">CONFIGURAÇÃO DO BANCO</p>
          <h1 className="dashboardTitle">Conectar Neon à Vercel</h1>
          <p className="subtitle dashboardSubtitle">
            Os dashboards dependem do banco. Enquanto nenhuma variável de conexão existir neste ambiente, a navegação ficará bloqueada para evitar erros 500.
          </p>
        </div>
        <Link className="secondaryLink" href="/">Voltar à central</Link>
      </header>

      <section className="metricGrid" aria-label="Status da conexão">
        <article className="metricCard">
          <span>Status</span>
          <strong style={{ fontSize: 22 }}>
            {config.isConfigured ? "Configurado" : "Pendente"}
          </strong>
          <small>
            {config.variableName ?? "Nenhuma variável encontrada"}
          </small>
        </article>
        <article className="metricCard">
          <span>Ambiente</span>
          <strong style={{ fontSize: 22 }}>
            {process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "desconhecido"}
          </strong>
          <small>Production e Preview são configurados separadamente</small>
        </article>
      </section>

      <section className="panel">
        <div className="panelHeader dashboardPanelHeader">
          <div>
            <p className="eyebrow">PASSO A PASSO</p>
            <h2>Adicionar a conexão no projeto da Vercel</h2>
          </div>
        </div>

        <div className="funnelList">
          <article className="funnelRow">
            <div className="funnelCopy">
              <div>
                <strong>1. Copie a connection string no Neon</strong>
                <code>Neon Console → Project → Connect → Connection string</code>
                <small>Use preferencialmente a conexão pooled para funções serverless.</small>
              </div>
            </div>
          </article>

          <article className="funnelRow">
            <div className="funnelCopy">
              <div>
                <strong>2. Crie ou conecte a variável na Vercel</strong>
                <code>Vercel → Project → Settings → Environment Variables</code>
                <small>Nome recomendado: DATABASE_URL. A integração do Neon também pode criar essa variável automaticamente.</small>
              </div>
            </div>
          </article>

          <article className="funnelRow">
            <div className="funnelCopy">
              <div>
                <strong>3. Marque os ambientes necessários</strong>
                <code>Production + Preview</code>
                <small>O preview do PR não herda automaticamente uma variável configurada apenas em Production.</small>
              </div>
            </div>
          </article>

          <article className="funnelRow">
            <div className="funnelCopy">
              <div>
                <strong>4. Gere um deployment novo</strong>
                <code>Redeploy ou novo commit na branch</code>
                <small>Conectar o Neon não dispara necessariamente um deploy. Variáveis novas só entram em deployments criados depois da conexão.</small>
              </div>
            </div>
          </article>
        </div>
      </section>

      <section className="panel">
        <div className="panelHeader dashboardPanelHeader">
          <div>
            <p className="eyebrow">TESTE SEGURO</p>
            <h2>Verificar conexão sem expor a senha</h2>
          </div>
          <a className="primaryLink" href="/api/health/db">Testar conexão</a>
        </div>
        <p className="subtitle">
          O teste informa apenas se uma variável foi encontrada e se o banco respondeu. A connection string nunca é exibida.
        </p>
      </section>
    </main>
  );
}
