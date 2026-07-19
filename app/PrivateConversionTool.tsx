"use client";

import { useEffect, useMemo, useState } from "react";

type CopyState = "idle" | "loading" | "copied" | "error";
type Inputs = {
  averageOrderValue: string;
  contributionMarginPercent: string;
  desiredProfitPercent: string;
};

const STORAGE_KEY = "private_conversion_unit_economics_v2";
const DEFAULT_INPUTS: Inputs = {
  averageOrderValue: "169",
  contributionMarginPercent: "69",
  desiredProfitPercent: "20",
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

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(STORAGE_KEY);
      if (!stored) return;
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

  function updateInput(key: keyof Inputs, value: string) {
    const next = { ...inputs, [key]: value };
    setInputs(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // The calculator remains usable without persistence.
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

  return (
    <section style={{ display: "grid", gap: 18, maxWidth: 560, width: "100%" }}>
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
