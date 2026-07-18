"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

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
};

const emptySnapshot: Snapshot = {
  ready: false,
  visitorId: "—",
  sessionId: "—",
  internalTraffic: true,
};

const checkoutStorageKey = "conversion_attribution_lab_checkout_id";

function newCheckoutId(): string {
  const suffix = Math.random().toString(36).slice(2, 10);
  return `LAB-CHECKOUT-${Date.now()}-${suffix}`;
}

export default function AttributionLabPage() {
  const [snapshot, setSnapshot] = useState<Snapshot>(emptySnapshot);
  const [checkoutId, setCheckoutId] = useState("");
  const [checkoutSessionId, setCheckoutSessionId] = useState("");
  const [purchaseSessionId, setPurchaseSessionId] = useState("");
  const [status, setStatus] = useState("Aguardando tracker.");
  const [busy, setBusy] = useState(false);

  const validationUrl = useMemo(
    () =>
      "/attribution-lab?ct_internal=0&utm_source=validation&utm_medium=lab&utm_campaign=attribution-v1&utm_content=cross-session",
    [],
  );

  const refresh = useCallback(() => {
    const tracker = window.ConversionTracker;
    if (!tracker) {
      setSnapshot(emptySnapshot);
      return;
    }

    setSnapshot({
      ready: true,
      visitorId: tracker.getVisitorId(),
      sessionId: tracker.getSessionId(),
      internalTraffic: tracker.isInternalTraffic(),
    });
  }, []);

  useEffect(() => {
    let stored = "";
    try {
      stored = window.localStorage.getItem(checkoutStorageKey) ?? "";
    } catch {
      stored = "";
    }

    const resolved = stored || newCheckoutId();
    setCheckoutId(resolved);
    try {
      window.localStorage.setItem(checkoutStorageKey, resolved);
    } catch {}

    refresh();
    const interval = window.setInterval(refresh, 500);
    return () => window.clearInterval(interval);
  }, [refresh]);

  function enableValidationTraffic() {
    const tracker = window.ConversionTracker;
    if (!tracker) return;
    tracker.setInternalTraffic(false);
    setStatus("Tráfego de validação ativado. Os próximos eventos entrarão na auditoria.");
    refresh();
  }

  function resetScenario() {
    const next = newCheckoutId();
    setCheckoutId(next);
    setCheckoutSessionId("");
    setPurchaseSessionId("");
    setStatus("Novo cenário criado.");
    try {
      window.localStorage.setItem(checkoutStorageKey, next);
    } catch {}
  }

  async function trackCheckout() {
    const tracker = window.ConversionTracker;
    if (!tracker || !checkoutId) return;
    setBusy(true);
    const sessionId = tracker.getSessionId();
    const ok = await tracker.track("checkout_started", {
      checkout_id: checkoutId,
      cart_value: 169,
      currency: "BRL",
      attribution_lab: true,
    });
    setCheckoutSessionId(sessionId);
    setStatus(ok ? "Checkout registrado na sessão A." : "Falha ao registrar checkout.");
    setBusy(false);
    refresh();
  }

  function forceNewSession() {
    const tracker = window.ConversionTracker;
    if (!tracker) return;
    const next = tracker.forceNewSession();
    setPurchaseSessionId(next);
    setStatus("Nova sessão criada. Agora registre a compra na sessão B.");
    refresh();
  }

  async function trackPurchase() {
    const tracker = window.ConversionTracker;
    if (!tracker || !checkoutId) return;
    setBusy(true);
    const sessionId = tracker.getSessionId();
    const orderId = `LAB-ORDER-${Date.now()}`;
    const ok = await tracker.track("purchase", {
      checkout_id: checkoutId,
      order_id: orderId,
      value: 169,
      currency: "BRL",
      attribution_lab: true,
    });
    setPurchaseSessionId(sessionId);
    setStatus(
      ok
        ? "Compra registrada. A auditoria deve ligá-la à sessão do checkout pelo checkout_id."
        : "Falha ao registrar compra.",
    );
    setBusy(false);
    refresh();
  }

  const crossSessionReady =
    checkoutSessionId && purchaseSessionId && checkoutSessionId !== purchaseSessionId;

  return (
    <main className="shell dashboardShell">
      <header className="dashboardHeader">
        <div>
          <p className="eyebrow">ITERAÇÃO 11 · BANCADA</p>
          <h1 className="dashboardTitle">Compra em outra sessão</h1>
          <p className="subtitle dashboardSubtitle">
            Simule checkout na sessão A e compra na sessão B usando o mesmo checkout_id.
          </p>
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <Link className="secondaryLink" href="/attribution-audit">Abrir auditoria</Link>
          <Link className="secondaryLink" href="/">Voltar à central</Link>
        </div>
      </header>

      <section className="panel compact">
        <p className="eyebrow">MODO DE VALIDAÇÃO</p>
        <p className="subtitle">
          A central é tráfego interno por padrão. Abra a URL de validação ou desative o marcador antes de disparar os eventos.
        </p>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 16 }}>
          <a className="primaryLink" href={validationUrl}>Reabrir como tráfego externo</a>
          <button className="secondaryLink" type="button" onClick={enableValidationTraffic}>
            Ativar nesta aba
          </button>
        </div>
      </section>

      <section className="metricGrid" aria-label="Estado do teste">
        <article className="metricCard">
          <span>Tracker</span>
          <strong style={{ fontSize: 22 }}>{snapshot.ready ? "Carregado" : "Aguardando"}</strong>
          <small>API v2</small>
        </article>
        <article className="metricCard">
          <span>Tráfego interno</span>
          <strong style={{ fontSize: 22 }}>{snapshot.internalTraffic ? "Sim" : "Não"}</strong>
          <small>{snapshot.internalTraffic ? "será excluído" : "entrará na auditoria"}</small>
        </article>
        <article className="metricCard">
          <span>Checkout</span>
          <strong style={{ fontSize: 22 }}>{checkoutSessionId ? "Registrado" : "Pendente"}</strong>
          <small>sessão A</small>
        </article>
        <article className="metricCard">
          <span>Cross-session</span>
          <strong style={{ fontSize: 22 }}>{crossSessionReady ? "Pronto" : "Pendente"}</strong>
          <small>sessões diferentes</small>
        </article>
      </section>

      <section className="panel">
        <div className="panelHeader dashboardPanelHeader">
          <div><p className="eyebrow">IDENTIDADE</p><h2>Estado atual</h2></div>
          <button className="secondaryLink" type="button" onClick={resetScenario}>Novo cenário</button>
        </div>
        <div className="funnelList">
          <article className="funnelRow">
            <div className="funnelCopy"><div><strong>Visitor ID</strong><code style={{ overflowWrap: "anywhere" }}>{snapshot.visitorId}</code><small>Deve permanecer igual nas duas sessões.</small></div></div>
          </article>
          <article className="funnelRow">
            <div className="funnelCopy"><div><strong>Sessão atual</strong><code style={{ overflowWrap: "anywhere" }}>{snapshot.sessionId}</code><small>Muda ao forçar nova sessão.</small></div></div>
          </article>
          <article className="funnelRow">
            <div className="funnelCopy"><div><strong>Checkout ID</strong><code style={{ overflowWrap: "anywhere" }}>{checkoutId || "—"}</code><small>É a ponte determinística entre checkout e compra.</small></div></div>
          </article>
          <article className="funnelRow">
            <div className="funnelCopy"><div><strong>Sessão A</strong><code style={{ overflowWrap: "anywhere" }}>{checkoutSessionId || "—"}</code><small>Sessão do checkout.</small></div></div>
          </article>
          <article className="funnelRow">
            <div className="funnelCopy"><div><strong>Sessão B</strong><code style={{ overflowWrap: "anywhere" }}>{purchaseSessionId || "—"}</code><small>Sessão da compra.</small></div></div>
          </article>
        </div>
      </section>

      <section className="panel">
        <div className="panelHeader dashboardPanelHeader">
          <div><p className="eyebrow">ROTEIRO</p><h2>Dispare em ordem</h2></div>
          <span className="hint">{status}</span>
        </div>
        <div className="eventGrid">
          <button className="eventButton" type="button" onClick={trackCheckout} disabled={!snapshot.ready || busy}>
            <span>1. Registrar checkout</span><code>checkout_started</code>
          </button>
          <button className="eventButton" type="button" onClick={forceNewSession} disabled={!checkoutSessionId || busy}>
            <span>2. Criar sessão B</span><code>forceNewSession</code>
          </button>
          <button className="eventButton" type="button" onClick={trackPurchase} disabled={!checkoutSessionId || busy}>
            <span>3. Registrar compra</span><code>purchase</code>
          </button>
          <Link className="eventButton" href="/attribution-audit?days=1">
            <span>4. Conferir resolução</span><code>attribution-audit</code>
          </Link>
        </div>
      </section>

      <section className="panel compact">
        <p className="eyebrow">RESULTADO ESPERADO</p>
        <ol className="checklist">
          <li>A sessão A e a sessão B devem ser diferentes.</li>
          <li>O visitor_id deve permanecer igual.</li>
          <li>A compra deve aparecer com método <code>checkout_id</code>.</li>
          <li><code>cross_session</code> deve ser <code>true</code>.</li>
          <li>A sessão atribuída deve ser a sessão A, sem apagar a sessão B real.</li>
        </ol>
      </section>
    </main>
  );
}
