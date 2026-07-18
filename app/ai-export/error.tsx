"use client";

import Link from "next/link";
import { useEffect } from "react";

export default function AiExportError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("AI export route failed", error);
  }, [error]);

  return (
    <main className="shell dashboardShell">
      <header className="dashboardHeader">
        <div>
          <p className="eyebrow">ITERAÇÃO 9 · DIAGNÓSTICO</p>
          <h1 className="dashboardTitle">A página não conseguiu consultar os dados</h1>
          <p className="subtitle dashboardSubtitle">
            O deploy terminou, mas a execução da rota falhou. Em previews da Vercel, a causa mais comum é a variável DATABASE_URL não estar habilitada para o ambiente Preview.
          </p>
        </div>
        <Link className="secondaryLink" href="/">Voltar à central</Link>
      </header>

      <section className="panel">
        <div className="panelHeader dashboardPanelHeader">
          <div>
            <p className="eyebrow">PRÓXIMA VERIFICAÇÃO</p>
            <h2>Abra /api/health/db neste mesmo domínio</h2>
          </div>
          <span className="hint">Digest: {error.digest ?? "não informado"}</span>
        </div>

        <div className="funnelList">
          <article className="funnelRow">
            <div className="funnelCopy">
              <div>
                <strong>Se retornar database_url_missing</strong>
                <code>Vercel → Settings → Environment Variables → DATABASE_URL → Preview</code>
                <small>Depois faça um novo deploy do preview.</small>
              </div>
            </div>
          </article>

          <article className="funnelRow">
            <div className="funnelCopy">
              <div>
                <strong>Se retornar database_ok</strong>
                <code>O banco está acessível e a falha está em uma das consultas da página.</code>
                <small>O endpoint não retorna credenciais nem o conteúdo do banco.</small>
              </div>
            </div>
          </article>
        </div>

        <button className="filterButton" type="button" onClick={reset}>
          Tentar novamente
        </button>
      </section>
    </main>
  );
}
