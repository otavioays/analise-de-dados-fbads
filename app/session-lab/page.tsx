"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

type TrackerApi = {
  track: (eventName: string, properties?: Record<string, unknown>) => Promise<boolean>;
  forceNewSession: () => string;
  setInternalTraffic: (enabled: boolean) => boolean;
  getVisitorId: () => string;
  getSessionId: () => string;
  isInternalTraffic: () => boolean;
};

declare global {
  interface Window {
    ConversionTracker?: TrackerApi;
  }
}

type Snapshot = {
  ready: boolean;
  visitorId: string;
  sessionId: string;
  internalTraffic: boolean;
  timeoutMinutes: number;
  sessionStartedAt: string;
  lastActivityAt: string;
};

const emptySnapshot: Snapshot = {
  ready: false,
  visitorId: "—",
  sessionId: "—",
  internalTraffic: true,
  timeoutMinutes: 30,
  sessionStartedAt: "—",
  lastActivityAt: "—",
};

function dateLabel(value: unknown): string {
  const timestamp = Number(value);
  if (!Number.isFinite(timestamp)) return "—";
  return new Date(timestamp).toLocaleString("pt-BR");
}

export default function SessionLabPage() {
  const [snapshot, setSnapshot] = useState<Snapshot>(emptySnapshot);

  const refresh = useCallback(() => {
    const tracker = window.ConversionTracker;
    if (!tracker) {
      setSnapshot(emptySnapshot);
      return;
    }

    let stored: Record<string, unknown> | null = null;
    try {
      const raw = window.localStorage.getItem("fbads_conversion_tracker_session_v2");
      stored = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    } catch {
      stored = null;
    }

    setSnapshot({
      ready: true,
      visitorId: tracker.getVisitorId(),
      sessionId: tracker.getSessionId(),
      internalTraffic: tracker.isInternalTraffic(),
      timeoutMinutes: 30,
      sessionStartedAt: dateLabel(stored?.started_at),
      lastActivityAt: dateLabel(stored?.last_activity_at),
    });
  }, []);

  useEffect(() => {
    refresh();
    const interval = window.setInterval(refresh, 500);
    return () => window.clearInterval(interval);
  }, [refresh]);

  function forceNewSession() {
    window.ConversionTracker?.forceNewSession();
    refresh();
  }

  return (
    <main className="shell dashboardShell">
      <header className="dashboardHeader">
        <div>
          <p className="eyebrow">ITERAÇÃO 10.1 · BANCADA</p>
          <h1 className="dashboardTitle">Integridade da sessão</h1>
          <p className="subtitle dashboardSubtitle">
            Abra esta página em outra aba. O visitante e a sessão devem permanecer iguais durante 30 minutos de atividade.
          </p>
        </div>
        <Link className="secondaryLink" href="/">Voltar à central</Link>
      </header>

      <section className="metricGrid" aria-label="Estado atual da sessão">
        <article className="metricCard">
          <span>Tracker</span>
          <strong style={{ fontSize: 22 }}>{snapshot.ready ? "Carregado" : "Aguardando"}</strong>
          <small>atualização automática</small>
        </article>
        <article className="metricCard">
          <span>Timeout</span>
          <strong>{snapshot.timeoutMinutes} min</strong>
          <small>de inatividade</small>
        </article>
        <article className="metricCard">
          <span>Tráfego interno</span>
          <strong style={{ fontSize: 22 }}>{snapshot.internalTraffic ? "Sim" : "Não"}</strong>
          <small>excluído dos dashboards</small>
        </article>
        <article className="metricCard">
          <span>Persistência</span>
          <strong style={{ fontSize: 22 }}>localStorage v2</strong>
          <small>compartilhada entre abas</small>
        </article>
      </section>

      <section className="panel">
        <div className="panelHeader dashboardPanelHeader">
          <div><p className="eyebrow">IDENTIFICADORES</p><h2>Compare nas duas abas</h2></div>
          <a className="primaryLink" href="/session-lab" target="_blank" rel="noreferrer">Abrir outra aba</a>
        </div>
        <div className="funnelList">
          <article className="funnelRow">
            <div className="funnelCopy">
              <div><strong>Visitor ID</strong><code style={{ overflowWrap: "anywhere" }}>{snapshot.visitorId}</code><small>Deve permanecer estável por navegador.</small></div>
            </div>
          </article>
          <article className="funnelRow">
            <div className="funnelCopy">
              <div><strong>Session ID</strong><code style={{ overflowWrap: "anywhere" }}>{snapshot.sessionId}</code><small>Deve ser o mesmo em abas e recarregamentos dentro da janela.</small></div>
            </div>
          </article>
          <article className="funnelRow">
            <div className="funnelCopy">
              <div><strong>Início da sessão</strong><code>{snapshot.sessionStartedAt}</code><small>Só muda ao expirar ou ao forçar manualmente.</small></div>
            </div>
          </article>
          <article className="funnelRow">
            <div className="funnelCopy">
              <div><strong>Última atividade</strong><code>{snapshot.lastActivityAt}</code><small>É renovada enquanto novos eventos são enviados.</small></div>
            </div>
          </article>
        </div>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 18 }}>
          <button className="filterButton" type="button" onClick={refresh}>Atualizar</button>
          <button className="secondaryLink" type="button" onClick={forceNewSession}>Forçar nova sessão</button>
        </div>
      </section>

      <section className="panel compact">
        <p className="eyebrow">TESTE ESPERADO</p>
        <ol className="checklist">
          <li>Abra esta página em uma segunda aba.</li>
          <li>Confirme que os dois IDs são idênticos.</li>
          <li>Recarregue ambas as abas e confirme novamente.</li>
          <li>Clique em <strong>Forçar nova sessão</strong> e veja o novo ID aparecer nas duas abas.</li>
        </ol>
      </section>
    </main>
  );
}
