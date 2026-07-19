"use client";

import { useMemo, useState } from "react";

type CopyState = "idle" | "loading" | "copied" | "error";

type CalculatorInputs = {
  averageOrderValue: string;
  contributionMarginPercent: string;
  desiredProfitPercent: string;
};

const STORAGE_KEY = "private_conversion_unit_economics_v1";
const DEFAULT_INPUTS: CalculatorInputs = {
  averageOrderValue: "169",
  contributionMarginPercent: "",
  desiredProfitPercent: "20",
};

const moneyFormatter = new Intl.NumberFormat("pt-BR", {
  style: "currency",
  currency: "BRL",
  minimumFractionDigits: 2,
});

function parseDecimal(value: string): number | null {
  const normalized = value.trim().replace(/\./g, "").replace(",", ".");
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function loadInitialInputs(): CalculatorInputs {
  if (typeof window === "undefined") return DEFAULT_INPUTS;

  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (!stored) return DEFAULT_INPUTS;
    const parsed = JSON.parse(stored) as Partial<CalculatorInputs>;
    return {
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
    };
  } catch {
    return DEFAULT_INPUTS;
  }
}

export default function CopyEverythingButton() {
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const [inputs, setInputs] = useState<CalculatorInputs>(loadInitialInputs);

  const calculation = useMemo(() => {
    const averageOrderValue = parseDecimal(inputs.averageOrderValue);
    const contributionMarginPercent = parseDecimal(inputs.contributionMarginPercent);
    const desiredProfitPercent = parseDecimal(inputs.desiredProfitPercent);

    const complete =
      averageOrderValue !== null &&
      contributionMarginPercent !== null &&
      desiredProfitPercent !== null;

    if (!complete) {
      return {
        configured: false,
        valid: false,
        warning: "Preencha os três campos para calcular o CAC ideal.",
      } as const;
    }

    const percentagesValid =
      contributionMarginPercent >= 0 &&
      contributionMarginPercent <= 100 &&
      desiredProfitPercent >= 0 &&
      desiredProfitPercent <= 100;
    const economicsValid =
      averageOrderValue > 0 &&
      percentagesValid &&
      desiredProfitPercent <= contributionMarginPercent;

    if (!economicsValid) {
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

    const contributionMarginValue =
      averageOrderValue * (contributionMarginPercent / 100);
    const desiredProfitValue = averageOrderValue * (desiredProfitPercent / 100);
    const targetCac = Math.max(0, contributionMarginValue - desiredProfitValue);
    const breakEvenCac = contributionMarginValue;
    const targetRoas = targetCac > 0 ? averageOrderValue / targetCac : null;
    const breakEvenRoas =
      breakEvenCac > 0 ? averageOrderValue / breakEvenCac : null;

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
        break_even_roas: breakEvenRoas === null ? null : round(breakEvenRoas, 4),
        target_roas: targetRoas === null ? null : round(targetRoas, 4),
      },
      formulas: {
        contribution_margin_before_ads:
          "average_order_value * contribution_margin_percent",
        break_even_cac: "contribution_margin_before_ads",
        target_cac:
          "average_order_value * (contribution_margin_percent - desired_profit_percent)",
        target_roas: "average_order_value / target_cac",
      },
      interpretation:
        "target_cac preserva o lucro desejado por pedido; break_even_cac é apenas o teto absoluto antes de zerar o lucro.",
      warning: null,
    } as const;
  }, [inputs]);

  function updateInput(key: keyof CalculatorInputs, value: string) {
    const next = { ...inputs, [key]: value };
    setInputs(next);

    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // The calculator remains usable even when storage is unavailable.
    }
  }

  async function copyEverything() {
    if (copyState === "loading") return;

    setCopyState("loading");

    try {
      const response = await fetch("/api/export?days=90&raw_limit=10000", {
        cache: "no-store",
      });

      if (!response.ok) {
        throw new Error(`Export failed with status ${response.status}`);
      }

      const payload = (await response.json()) as Record<string, unknown>;
      payload.business_economics = {
        source: "private_target_cac_calculator",
        calculated_at: new Date().toISOString(),
        ...calculation,
      };

      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 2200);
    } catch (error) {
      console.error("Could not copy conversion intelligence export", error);
      setCopyState("error");
      window.setTimeout(() => setCopyState("idle"), 3200);
    }
  }

  const buttonLabel =
    copyState === "loading"
      ? "Montando dossiê..."
      : copyState === "copied"
        ? "Tudo copiado"
        : copyState === "error"
          ? "Falhou. Tentar novamente"
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

  return (
    <section
      style={{
        display: "grid",
        gap: 18,
        maxWidth: 560,
        width: "100%",
      }}
    >
      <div
        style={{
          background: "rgba(255,255,255,.045)",
          border: "1px solid rgba(255,255,255,.1)",
          borderRadius: 20,
          boxShadow: "0 18px 60px rgba(0,0,0,.18)",
          display: "grid",
          gap: 16,
          padding: 20,
        }}
      >
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
              placeholder="169"
              aria-label="Ticket médio em reais"
              style={fieldStyle}
            />
          </label>

          <label style={{ display: "grid", fontSize: 13, gap: 6 }}>
            Margem antes da mídia (%)
            <input
              inputMode="decimal"
              value={inputs.contributionMarginPercent}
              onChange={(event) =>
                updateInput("contributionMarginPercent", event.target.value)
              }
              placeholder="Ex.: 55"
              aria-label="Margem de contribuição antes da mídia em percentual"
              style={fieldStyle}
            />
          </label>

          <label style={{ display: "grid", fontSize: 13, gap: 6 }}>
            Lucro que deseja preservar (%)
            <input
              inputMode="decimal"
              value={inputs.desiredProfitPercent}
              onChange={(event) => updateInput("desiredProfitPercent", event.target.value)}
              placeholder="20"
              aria-label="Lucro desejado depois da mídia em percentual"
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
            <div
              style={{
                background: "rgba(255,255,255,.06)",
                borderRadius: 14,
                padding: 14,
              }}
            >
              <span style={{ display: "block", fontSize: 12, opacity: 0.65 }}>
                CAC ideal
              </span>
              <strong style={{ fontSize: 25 }}>
                {moneyFormatter.format(calculation.outputs.target_cac)}
              </strong>
            </div>
            <div
              style={{
                background: "rgba(255,255,255,.06)",
                borderRadius: 14,
                padding: 14,
              }}
            >
              <span style={{ display: "block", fontSize: 12, opacity: 0.65 }}>
                CAC de equilíbrio
              </span>
              <strong style={{ fontSize: 25 }}>
                {moneyFormatter.format(calculation.outputs.break_even_cac)}
              </strong>
            </div>
            <div style={{ fontSize: 13, opacity: 0.72 }}>
              Lucro preservado: {moneyFormatter.format(calculation.outputs.desired_profit_after_ads)}
            </div>
            <div style={{ fontSize: 13, opacity: 0.72, textAlign: "right" }}>
              ROAS alvo: {calculation.outputs.target_roas?.toFixed(2) ?? "∞"}x
            </div>
          </div>
        ) : (
          <p
            role="status"
            style={{
              fontSize: 13,
              margin: 0,
              opacity: calculation.configured ? 0.92 : 0.66,
            }}
          >
            {calculation.warning}
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
    </section>
  );
}
