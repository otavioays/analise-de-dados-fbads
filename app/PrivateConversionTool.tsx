"use client";

import { useEffect, useMemo, useState } from "react";

type CopyState = "idle" | "loading" | "copied" | "error";
type Inputs = {
  averageOrderValue: string;
  contributionMarginPercent: string;
  desiredProfitPercent: string;
};
type FunnelInputs = {
  campaignLabel: string;
  periodLabel: string;
  spend: string;
  impressions: string;
  linkClicks: string;
  landingPageViews: string;
  checkouts: string;
  purchases: string;
  revenue: string;
};

const STORAGE_KEY = "private_conversion_unit_economics_v2";
const FUNNEL_STORAGE_KEY = "private_conversion_manual_funnel_v1";
const DEFAULT_INPUTS: Inputs = {
  averageOrderValue: "169",
  contributionMarginPercent: "69",
  desiredProfitPercent: "20",
};
const DEFAULT_FUNNEL_INPUTS: FunnelInputs = {
  campaignLabel: "",
  periodLabel: "",
  spend: "",
  impressions: "",
  linkClicks: "",
  landingPageViews: "",
  checkouts: "",
  purchases: "",
  revenue: "",
};

const money = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
  minimumFractionDigits: 2,
});

function parseDecimal(value: string): number | null {
  const raw = value.trim().replace(/\s/g, "");
  if (!raw) return null;
  const normalized = raw.includes(",")
    ? raw.replace(/\./g, "").replace(",", ".")
    : raw;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function safeDivide(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null || denominator <= 0) return null;
  return round(numerator / denominator, 4);
}

function percent(numerator: number | null, denominator: number | null): number | null {
  const ratio = safeDivide(numerator, denominator);
  return ratio === null ? null : round(ratio * 100, 4);
}

function displayMoney(value: number | null): string {
  return value === null ? "—" : money.format(value);
}

function displayPercent(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(2)}%`;
}

async function writeClipboard(text: string): Promise<void> {
  let modernError: unknown = null;

  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch (error) {
      modernError = error;
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "0";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);

  try {
    const copied = document.execCommand("copy");
    if (!copied) {
      throw modernError instanceof Error
        ? modernError
        : new Error("O navegador recusou os dois métodos de cópia.");
    }
  } finally {
    textarea.remove();
  }
}

function readableError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message.slice(0, 260);
  return String(error).slice(0, 260);
}

export default function PrivateConversionTool() {
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const [copyError, setCopyError] = useState<string | null>(null);
  const [inputs, setInputs] = useState<Inputs>(DEFAULT_INPUTS);
  const [funnelInputs, setFunnelInputs] = useState<FunnelInputs>(DEFAULT_FUNNEL_INPUTS);

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored) as Partial<Inputs>;
        setInputs({
          averageOrderValue:
            typeof parsed.averageOrderValue === "string"
              ? parsed.averageOrderValue
              : DEFAULT_INPUTS.averageOrderValue,
          contributionMarginPercent:
            typeof parsed.contributionMarginPercent === "string"
              ? parsed.contributionMarginPercent
              : DEFAULT_INPUTS.contributionMarginPercent,
          desiredProfitPercent:
            typeof parsed.desiredProfitPercent === "string"
              ? parsed.desiredProfitPercent
              : DEFAULT_INPUTS.desiredProfitPercent,
        });
      }

      const storedFunnel = window.localStorage.getItem(FUNNEL_STORAGE_KEY);
      if (storedFunnel) {
        const parsed = JSON.parse(storedFunnel) as Partial<FunnelInputs>;
        setFunnelInputs({
          campaignLabel:
            typeof parsed.campaignLabel === "string" ? parsed.campaignLabel : "",
          periodLabel: typeof parsed.periodLabel === "string" ? parsed.periodLabel : "",
          spend: typeof parsed.spend === "string" ? parsed.spend : "",
          impressions: typeof parsed.impressions === "string" ? parsed.impressions : "",
          linkClicks: typeof parsed.linkClicks === "string" ? parsed.linkClicks : "",
          landingPageViews:
            typeof parsed.landingPageViews === "string" ? parsed.landingPageViews : "",
          checkouts: typeof parsed.checkouts === "string" ? parsed.checkouts : "",
          purchases: typeof parsed.purchases === "string" ? parsed.purchases : "",
          revenue: typeof parsed.revenue === "string" ? parsed.revenue : "",
        });
      }
    } catch {
      // Defaults remain active when local storage is unavailable or malformed.
    }
  }, []);

  const calculation = useMemo(() => {
    const averageOrderValue = parseDecimal(inputs.averageOrderValue);
    const contributionMarginPercent = parseDecimal(inputs.contributionMarginPercent);
    const desiredProfitPercent = parseDecimal(inputs.desiredProfitPercent);

    if (
      averageOrderValue === null ||
      contributionMarginPercent === null ||
      desiredProfitPercent === null
    ) {
      return {
        configured: false,
        valid: false,
        warning: "Preencha os três campos para calcular o CAC ideal.",
      } as const;
    }

    const valid =
      averageOrderValue > 0 &&
      contributionMarginPercent >= 0 &&
      contributionMarginPercent <= 100 &&
      desiredProfitPercent >= 0 &&
      desiredProfitPercent <= contributionMarginPercent;

    if (!valid) {
      return {
        configured: true,
        valid: false,
        inputs: {
          average_order_value: averageOrderValue,
          contribution_margin_percent: contributionMarginPercent,
          desired_profit_percent: desiredProfitPercent,
        },
        warning:
          desiredProfitPercent > contributionMarginPercent
            ? "O lucro desejado não pode ser maior que a margem disponível antes da mídia."
            : "Use ticket maior que zero e percentuais entre 0% e 100%.",
      } as const;
    }

    const contributionMarginValue = averageOrderValue * (contributionMarginPercent / 100);
    const desiredProfitValue = averageOrderValue * (desiredProfitPercent / 100);
    const targetCac = Math.max(0, contributionMarginValue - desiredProfitValue);
    const breakEvenCac = contributionMarginValue;

    return {
      configured: true,
      valid: true,
      currency: "BRL",
      inputs: {
        average_order_value: round(averageOrderValue),
        contribution_margin_percent: round(contributionMarginPercent, 4),
        desired_profit_percent: round(desiredProfitPercent, 4),
      },
      outputs: {
        contribution_margin_before_ads: round(contributionMarginValue),
        break_even_cac: round(breakEvenCac),
        target_cac: round(targetCac),
        desired_profit_after_ads: round(desiredProfitValue),
        break_even_roas:
          breakEvenCac > 0 ? round(averageOrderValue / breakEvenCac, 4) : null,
        target_roas: targetCac > 0 ? round(averageOrderValue / targetCac, 4) : null,
      },
      formulas: {
        contribution_margin_before_ads:
          "average_order_value * contribution_margin_percent / 100",
        break_even_cac: "contribution_margin_before_ads",
        target_cac:
          "average_order_value * (contribution_margin_percent - desired_profit_percent) / 100",
        target_roas: "average_order_value / target_cac",
      },
      interpretation:
        "target_cac preserva o lucro desejado; break_even_cac é apenas o teto antes de zerar o lucro.",
      warning: null,
    } as const;
  }, [inputs]);

  const funnelCalculation = useMemo(() => {
    const spend = parseDecimal(funnelInputs.spend);
    const impressions = parseDecimal(funnelInputs.impressions);
    const linkClicks = parseDecimal(funnelInputs.linkClicks);
    const landingPageViews = parseDecimal(funnelInputs.landingPageViews);
    const checkouts = parseDecimal(funnelInputs.checkouts);
    const purchases = parseDecimal(funnelInputs.purchases);
    const revenue = parseDecimal(funnelInputs.revenue);
    const values = [spend, impressions, linkClicks, landingPageViews, checkouts, purchases, revenue];
    const configured =
      values.some((value) => value !== null) ||
      funnelInputs.campaignLabel.trim().length > 0 ||
      funnelInputs.periodLabel.trim().length > 0;
    const valid = values.every((value) => value === null || value >= 0);
    const warnings: string[] = [];

    if (linkClicks !== null && impressions !== null && linkClicks > impressions) {
      warnings.push("Cliques maiores que impressões.");
    }
    if (landingPageViews !== null && linkClicks !== null && landingPageViews > linkClicks) {
      warnings.push("Visualizações da página maiores que cliques no link.");
    }
    if (checkouts !== null && landingPageViews !== null && checkouts > landingPageViews) {
      warnings.push("Checkouts maiores que visualizações da página.");
    }
    if (purchases !== null && checkouts !== null && purchases > checkouts) {
      warnings.push("Compras maiores que checkouts.");
    }
    if (revenue !== null && revenue > 0 && (purchases === null || purchases === 0)) {
      warnings.push("Existe receita informada sem compras no período.");
    }

    const cac = safeDivide(spend, purchases);
    const roas = safeDivide(revenue, spend);
    const observedAov = safeDivide(revenue, purchases);
    const targetCac = calculation.valid ? calculation.outputs.target_cac : null;
    const marginPercent = calculation.valid
      ? calculation.inputs.contribution_margin_percent
      : null;
    const maxSpendAtTargetCac =
      purchases !== null && targetCac !== null ? round(purchases * targetCac) : null;
    const spendHeadroom =
      maxSpendAtTargetCac !== null && spend !== null
        ? round(maxSpendAtTargetCac - spend)
        : null;
    const contributionProfitAfterAds =
      revenue !== null && spend !== null && marginPercent !== null
        ? round(revenue * (marginPercent / 100) - spend)
        : null;
    const profitPerPurchase = safeDivide(contributionProfitAfterAds, purchases);
    const cacDifference =
      cac !== null && targetCac !== null ? round(cac - targetCac) : null;
    const cacDifferencePercent =
      cac !== null && targetCac !== null && targetCac > 0
        ? round(((cac - targetCac) / targetCac) * 100, 4)
        : null;
    const cacStatus =
      cac === null || targetCac === null
        ? "unavailable"
        : cac <= targetCac
          ? "within_target"
          : "above_target";

    return {
      configured,
      valid,
      currency: "BRL",
      context: {
        campaign: funnelInputs.campaignLabel.trim() || null,
        period: funnelInputs.periodLabel.trim() || null,
      },
      inputs: {
        spend: spend === null ? null : round(spend),
        impressions: impressions === null ? null : round(impressions, 4),
        link_clicks: linkClicks === null ? null : round(linkClicks, 4),
        landing_page_views:
          landingPageViews === null ? null : round(landingPageViews, 4),
        checkouts: checkouts === null ? null : round(checkouts, 4),
        purchases: purchases === null ? null : round(purchases, 4),
        revenue: revenue === null ? null : round(revenue),
      },
      metrics: {
        ctr_percent: percent(linkClicks, impressions),
        cpm: spend !== null && impressions !== null && impressions > 0
          ? round((spend / impressions) * 1000, 4)
          : null,
        cpc: safeDivide(spend, linkClicks),
        click_to_landing_page_rate_percent: percent(landingPageViews, linkClicks),
        cost_per_landing_page_view: safeDivide(spend, landingPageViews),
        landing_page_to_checkout_rate_percent: percent(checkouts, landingPageViews),
        cost_per_checkout: safeDivide(spend, checkouts),
        checkout_to_purchase_rate_percent: percent(purchases, checkouts),
        landing_page_to_purchase_rate_percent: percent(purchases, landingPageViews),
        cac,
        roas,
        observed_average_order_value: observedAov,
        revenue_per_landing_page_view: safeDivide(revenue, landingPageViews),
      },
      economics_comparison: {
        target_cac: targetCac,
        actual_cac: cac,
        cac_status: cacStatus,
        cac_difference: cacDifference,
        cac_difference_percent: cacDifferencePercent,
        max_spend_at_target_cac: maxSpendAtTargetCac,
        spend_headroom_vs_target: spendHeadroom,
        estimated_contribution_profit_after_ads: contributionProfitAfterAds,
        estimated_contribution_profit_per_purchase: profitPerPurchase,
      },
      warnings: valid ? warnings : ["Use apenas valores maiores ou iguais a zero."],
    } as const;
  }, [funnelInputs, calculation]);

  function updateInput(key: keyof Inputs, value: string) {
    const next = { ...inputs, [key]: value };
    setInputs(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // The calculator remains usable without persistence.
    }
  }

  function updateFunnelInput(key: keyof FunnelInputs, value: string) {
    const next = { ...funnelInputs, [key]: value };
    setFunnelInputs(next);
    try {
      window.localStorage.setItem(FUNNEL_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // The funnel remains usable without persistence.
    }
  }

  async function copyEverything() {
    if (copyState === "loading") return;
    setCopyState("loading");
    setCopyError(null);

    try {
      const response = await fetch("/api/export?days=90&raw_limit=10000", {
        cache: "no-store",
      });
      const responseText = await response.text();

      if (!response.ok) {
        throw new Error(
          `Exportação retornou HTTP ${response.status}: ${responseText.slice(0, 180)}`,
        );
      }

      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(responseText) as Record<string, unknown>;
      } catch {
        throw new Error("A API respondeu, mas o conteúdo não era um JSON válido.");
      }

      payload.business_economics = {
        source: "private_target_cac_calculator",
        calculated_at: new Date().toISOString(),
        ...calculation,
      };
      payload.manual_funnel = {
        source: "private_manual_funnel_snapshot",
        captured_at: new Date().toISOString(),
        ...funnelCalculation,
      };

      await writeClipboard(JSON.stringify(payload, null, 2));
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 2200);
    } catch (error) {
      console.error("Could not copy private conversion intelligence", error);
      setCopyError(readableError(error));
      setCopyState("error");
    }
  }

  const buttonLabel =
    copyState === "loading"
      ? "Montando dossiê..."
      : copyState === "copied"
        ? "Tudo copiado"
        : copyState === "error"
          ? "Tentar copiar novamente"
          : "Copiar tudo para a IA";

  const fieldStyle = {
    background: "rgba(255,255,255,.06)",
    border: "1px solid rgba(255,255,255,.14)",
    borderRadius: 12,
    color: "inherit",
    fontSize: 17,
    minHeight: 48,
    outline: "none",
    padding: "10px 12px",
    width: "100%",
  } as const;
  const cardStyle = {
    background: "rgba(255,255,255,.045)",
    border: "1px solid rgba(255,255,255,.1)",
    borderRadius: 20,
    boxShadow: "0 18px 60px rgba(0,0,0,.18)",
    display: "grid",
    gap: 16,
    padding: 20,
  } as const;

  return (
    <section style={{ display: "grid", gap: 18, maxWidth: 720, width: "100%" }}>
      <div style={cardStyle}>
        <div>
          <strong style={{ display: "block", fontSize: 19 }}>Calculadora de CAC ideal</strong>
          <span style={{ fontSize: 13, opacity: 0.68 }}>
            Preserve lucro sem confundir CAC alvo com CAC de equilíbrio.
          </span>
        </div>

        <div
          style={{
            display: "grid",
            gap: 12,
            gridTemplateColumns: "repeat(auto-fit, minmax(145px, 1fr))",
          }}
        >
          <label style={{ display: "grid", fontSize: 13, gap: 6 }}>
            Ticket médio (R$)
            <input
              inputMode="decimal"
              value={inputs.averageOrderValue}
              onChange={(event) => updateInput("averageOrderValue", event.target.value)}
              style={fieldStyle}
            />
          </label>
          <label style={{ display: "grid", fontSize: 13, gap: 6 }}>
            Margem de contribuição antes da mídia (%)
            <input
              inputMode="decimal"
              value={inputs.contributionMarginPercent}
              onChange={(event) =>
                updateInput("contributionMarginPercent", event.target.value)
              }
              style={fieldStyle}
            />
          </label>
          <label style={{ display: "grid", fontSize: 13, gap: 6 }}>
            Lucro que deseja preservar (%)
            <input
              inputMode="decimal"
              value={inputs.desiredProfitPercent}
              onChange={(event) => updateInput("desiredProfitPercent", event.target.value)}
              style={fieldStyle}
            />
          </label>
        </div>

        {calculation.valid ? (
          <div
            style={{
              display: "grid",
              gap: 10,
              gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
            }}
          >
            <div style={{ background: "rgba(255,255,255,.06)", borderRadius: 14, padding: 14 }}>
              <span style={{ display: "block", fontSize: 12, opacity: 0.65 }}>CAC ideal</span>
              <strong style={{ fontSize: 25 }}>
                {money.format(calculation.outputs.target_cac)}
              </strong>
            </div>
            <div style={{ background: "rgba(255,255,255,.06)", borderRadius: 14, padding: 14 }}>
              <span style={{ display: "block", fontSize: 12, opacity: 0.65 }}>
                CAC de equilíbrio
              </span>
              <strong style={{ fontSize: 25 }}>
                {money.format(calculation.outputs.break_even_cac)}
              </strong>
            </div>
            <div style={{ fontSize: 13, opacity: 0.72 }}>
              Lucro preservado: {money.format(calculation.outputs.desired_profit_after_ads)}
            </div>
            <div style={{ fontSize: 13, opacity: 0.72, textAlign: "right" }}>
              ROAS alvo: {calculation.outputs.target_roas?.toFixed(2) ?? "∞"}x
            </div>
          </div>
        ) : (
          <p role="status" style={{ fontSize: 13, margin: 0, opacity: 0.86 }}>
            {calculation.warning}
          </p>
        )}
      </div>

      <div style={cardStyle}>
        <div>
          <strong style={{ display: "block", fontSize: 19 }}>Dados do funil</strong>
          <span style={{ fontSize: 13, opacity: 0.68 }}>
            Cole o snapshot do período para comparar o CAC real com o CAC ideal.
          </span>
        </div>

        <div
          style={{
            display: "grid",
            gap: 12,
            gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))",
          }}
        >
          <label style={{ display: "grid", fontSize: 13, gap: 6 }}>
            Campanha ou conjunto (opcional)
            <input
              value={funnelInputs.campaignLabel}
              onChange={(event) => updateFunnelInput("campaignLabel", event.target.value)}
              placeholder="Ex.: NNC 01 · Relógio"
              style={fieldStyle}
            />
          </label>
          <label style={{ display: "grid", fontSize: 13, gap: 6 }}>
            Período analisado (opcional)
            <input
              value={funnelInputs.periodLabel}
              onChange={(event) => updateFunnelInput("periodLabel", event.target.value)}
              placeholder="Ex.: 19 a 25/07"
              style={fieldStyle}
            />
          </label>
        </div>

        <div
          style={{
            display: "grid",
            gap: 12,
            gridTemplateColumns: "repeat(auto-fit, minmax(125px, 1fr))",
          }}
        >
          {([
            ["spend", "Investimento (R$)"],
            ["impressions", "Impressões"],
            ["linkClicks", "Cliques no link"],
            ["landingPageViews", "Visitas à página"],
            ["checkouts", "Checkouts"],
            ["purchases", "Compras"],
            ["revenue", "Receita (R$)"],
          ] as const).map(([key, label]) => (
            <label key={key} style={{ display: "grid", fontSize: 13, gap: 6 }}>
              {label}
              <input
                inputMode="decimal"
                value={funnelInputs[key]}
                onChange={(event) => updateFunnelInput(key, event.target.value)}
                style={fieldStyle}
              />
            </label>
          ))}
        </div>

        {funnelCalculation.configured ? (
          funnelCalculation.valid ? (
            <div style={{ display: "grid", gap: 12 }}>
              <div
                style={{
                  display: "grid",
                  gap: 10,
                  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
                }}
              >
                <div style={{ background: "rgba(255,255,255,.06)", borderRadius: 14, padding: 14 }}>
                  <span style={{ display: "block", fontSize: 12, opacity: 0.65 }}>CAC real</span>
                  <strong style={{ fontSize: 23 }}>
                    {displayMoney(funnelCalculation.metrics.cac)}
                  </strong>
                </div>
                <div style={{ background: "rgba(255,255,255,.06)", borderRadius: 14, padding: 14 }}>
                  <span style={{ display: "block", fontSize: 12, opacity: 0.65 }}>ROAS real</span>
                  <strong style={{ fontSize: 23 }}>
                    {funnelCalculation.metrics.roas === null
                      ? "—"
                      : `${funnelCalculation.metrics.roas.toFixed(2)}x`}
                  </strong>
                </div>
                <div style={{ fontSize: 13, opacity: 0.76 }}>
                  Página → checkout: {displayPercent(funnelCalculation.metrics.landing_page_to_checkout_rate_percent)}
                </div>
                <div style={{ fontSize: 13, opacity: 0.76, textAlign: "right" }}>
                  Checkout → compra: {displayPercent(funnelCalculation.metrics.checkout_to_purchase_rate_percent)}
                </div>
              </div>

              <div style={{ fontSize: 13, opacity: 0.82 }}>
                {funnelCalculation.economics_comparison.cac_status === "within_target"
                  ? "CAC real dentro do alvo."
                  : funnelCalculation.economics_comparison.cac_status === "above_target"
                    ? `CAC real ${displayMoney(funnelCalculation.economics_comparison.cac_difference)} acima do alvo.`
                    : "Informe investimento e compras para comparar o CAC real com o alvo."}
              </div>

              {funnelCalculation.warnings.length > 0 ? (
                <p role="status" style={{ fontSize: 13, margin: 0, opacity: 0.86 }}>
                  {funnelCalculation.warnings.join(" ")}
                </p>
              ) : null}
            </div>
          ) : (
            <p role="status" style={{ fontSize: 13, margin: 0, opacity: 0.86 }}>
              {funnelCalculation.warnings.join(" ")}
            </p>
          )
        ) : (
          <p style={{ fontSize: 13, margin: 0, opacity: 0.62 }}>
            Os campos podem ficar vazios. O dossiê continuará usando apenas os eventos rastreados.
          </p>
        )}
      </div>

      <button
        type="button"
        onClick={copyEverything}
        disabled={copyState === "loading"}
        aria-live="polite"
        style={{
          appearance: "none",
          border: 0,
          borderRadius: 18,
          cursor: copyState === "loading" ? "wait" : "pointer",
          fontSize: "clamp(18px, 2.2vw, 28px)",
          fontWeight: 700,
          letterSpacing: "-0.02em",
          minHeight: 78,
          padding: "22px 32px",
          boxShadow: "0 18px 60px rgba(0,0,0,.24)",
          width: "100%",
        }}
      >
        {buttonLabel}
      </button>

      {copyError ? (
        <p role="alert" style={{ fontSize: 13, margin: 0, opacity: 0.86 }}>
          {copyError}
        </p>
      ) : null}
    </section>
  );
}
