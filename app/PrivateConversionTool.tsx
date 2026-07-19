"use client";

import { useEffect, useMemo, useState } from "react";

type CopyState = "idle" | "loading" | "copied" | "error";
type SampleStatus =
  | "missing"
  | "insufficient"
  | "directional"
  | "decision_ready"
  | "strong";

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
  reach: string;
  threeSecondViews: string;
  linkClicks: string;
  landingPageViews: string;
  addToCarts: string;
  checkouts: string;
  purchases: string;
  revenue: string;
};

const STORAGE_KEY = "private_conversion_unit_economics_v2";
const FUNNEL_STORAGE_KEY = "private_conversion_manual_funnel_v2";

const SOP = {
  version: "private_ecommerce_funnel_sop_v1",
  minimums: {
    creative: {
      impressions: 2_000,
      link_clicks_alternative: 30,
      rule: "2.000 impressões ou 30 cliques no link",
    },
    landing_delivery: {
      link_clicks: 30,
      rule: "30 cliques no link",
    },
    page: {
      landing_page_views: 100,
      rule: "100 visualizações da página",
    },
    cart: {
      add_to_carts: 10,
      rule: "10 adições ao carrinho para leitura inicial",
    },
    checkout: {
      minimum_checkouts: 10,
      preferred_checkouts: 20,
      rule: "10 checkouts para sinal direcional; 20 para decisão mais firme",
    },
    cac: {
      initial_signal_purchases: 5,
      decision_purchases: 10,
      strong_purchases: 20,
      rule: "5 compras para sinal; 10 para decisão; 20 para leitura forte",
    },
  },
  kpis: {
    hook_rate_percent: { poor_below: 20, good_from: 30 },
    link_ctr_percent: { poor_below: 1, good_from: 1.5 },
    click_to_landing_page_rate_percent: { poor_below: 70, good_from: 80 },
    add_to_cart_rate_percent: { poor_below: 4, good_from: 8 },
    add_to_cart_to_checkout_rate_percent: { poor_below: 30, good_from: 45 },
    checkout_to_purchase_rate_percent: { poor_below: 35, good_from: 50 },
    landing_page_to_purchase_rate_percent: { poor_below: 1, good_from: 2, strong_from: 3 },
  },
} as const;

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
  reach: "",
  threeSecondViews: "",
  linkClicks: "",
  landingPageViews: "",
  addToCarts: "",
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

function sampleStatusLabel(status: SampleStatus): string {
  switch (status) {
    case "strong":
      return "Amostra forte";
    case "decision_ready":
      return "Pronto para decisão";
    case "directional":
      return "Sinal direcional";
    case "insufficient":
      return "Amostra insuficiente";
    default:
      return "Sem dados";
  }
}

function metricHealth(
  value: number | null,
  sampleStatus: SampleStatus,
  poorBelow: number,
  goodFrom: number,
): "unavailable" | "sample_insufficient" | "bottleneck" | "watch" | "healthy" {
  if (value === null) return "unavailable";
  if (sampleStatus === "missing" || sampleStatus === "insufficient") {
    return "sample_insufficient";
  }
  if (value < poorBelow) return "bottleneck";
  if (value >= goodFrom) return "healthy";
  return "watch";
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

      const storedFunnel =
        window.localStorage.getItem(FUNNEL_STORAGE_KEY) ??
        window.localStorage.getItem("private_conversion_manual_funnel_v1");
      if (storedFunnel) {
        const parsed = JSON.parse(storedFunnel) as Partial<FunnelInputs>;
        setFunnelInputs({
          campaignLabel:
            typeof parsed.campaignLabel === "string" ? parsed.campaignLabel : "",
          periodLabel: typeof parsed.periodLabel === "string" ? parsed.periodLabel : "",
          spend: typeof parsed.spend === "string" ? parsed.spend : "",
          impressions: typeof parsed.impressions === "string" ? parsed.impressions : "",
          reach: typeof parsed.reach === "string" ? parsed.reach : "",
          threeSecondViews:
            typeof parsed.threeSecondViews === "string" ? parsed.threeSecondViews : "",
          linkClicks: typeof parsed.linkClicks === "string" ? parsed.linkClicks : "",
          landingPageViews:
            typeof parsed.landingPageViews === "string" ? parsed.landingPageViews : "",
          addToCarts: typeof parsed.addToCarts === "string" ? parsed.addToCarts : "",
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
    const reach = parseDecimal(funnelInputs.reach);
    const threeSecondViews = parseDecimal(funnelInputs.threeSecondViews);
    const linkClicks = parseDecimal(funnelInputs.linkClicks);
    const landingPageViews = parseDecimal(funnelInputs.landingPageViews);
    const addToCarts = parseDecimal(funnelInputs.addToCarts);
    const checkouts = parseDecimal(funnelInputs.checkouts);
    const purchases = parseDecimal(funnelInputs.purchases);
    const revenue = parseDecimal(funnelInputs.revenue);
    const values = [
      spend,
      impressions,
      reach,
      threeSecondViews,
      linkClicks,
      landingPageViews,
      addToCarts,
      checkouts,
      purchases,
      revenue,
    ];
    const configured =
      values.some((value) => value !== null) ||
      funnelInputs.campaignLabel.trim().length > 0 ||
      funnelInputs.periodLabel.trim().length > 0;
    const valid = values.every((value) => value === null || value >= 0);
    const warnings: string[] = [];

    if (reach !== null && impressions !== null && reach > impressions) {
      warnings.push("Alcance maior que impressões.");
    }
    if (
      threeSecondViews !== null &&
      impressions !== null &&
      threeSecondViews > impressions
    ) {
      warnings.push("Visualizações de 3 segundos maiores que impressões.");
    }
    if (linkClicks !== null && impressions !== null && linkClicks > impressions) {
      warnings.push("Cliques maiores que impressões.");
    }
    if (landingPageViews !== null && linkClicks !== null && landingPageViews > linkClicks) {
      warnings.push("Visualizações da página maiores que cliques no link.");
    }
    if (addToCarts !== null && landingPageViews !== null && addToCarts > landingPageViews) {
      warnings.push("Adições ao carrinho maiores que visualizações da página.");
    }
    if (checkouts !== null && addToCarts !== null && checkouts > addToCarts) {
      warnings.push("Checkouts maiores que adições ao carrinho.");
    }
    if (purchases !== null && checkouts !== null && purchases > checkouts) {
      warnings.push("Compras maiores que checkouts.");
    }
    if (revenue !== null && revenue > 0 && (purchases === null || purchases === 0)) {
      warnings.push("Existe receita informada sem compras no período.");
    }
    if (addToCarts === null && checkouts !== null) {
      warnings.push(
        "ATCs não informados: o analisador não consegue separar totalmente página e carrinho.",
      );
    }

    const hookRate = percent(threeSecondViews, impressions);
    const frequency = safeDivide(impressions, reach);
    const ctr = percent(linkClicks, impressions);
    const clickToLandingPageRate = percent(landingPageViews, linkClicks);
    const addToCartRate = percent(addToCarts, landingPageViews);
    const addToCartToCheckoutRate = percent(checkouts, addToCarts);
    const addToCartToPurchaseRate = percent(purchases, addToCarts);
    const landingPageToCheckoutRate = percent(checkouts, landingPageViews);
    const checkoutToPurchaseRate = percent(purchases, checkouts);
    const landingPageToPurchaseRate = percent(purchases, landingPageViews);
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
    const economicsCacStatus =
      cac === null || targetCac === null
        ? "unavailable"
        : cac <= targetCac
          ? "within_target"
          : "above_target";

    const creativeSampleStatus: SampleStatus =
      impressions === null && linkClicks === null
        ? "missing"
        : (impressions ?? 0) >= SOP.minimums.creative.impressions ||
            (linkClicks ?? 0) >= SOP.minimums.creative.link_clicks_alternative
          ? "decision_ready"
          : "insufficient";
    const landingDeliverySampleStatus: SampleStatus =
      linkClicks === null
        ? "missing"
        : linkClicks >= SOP.minimums.landing_delivery.link_clicks
          ? "decision_ready"
          : "insufficient";
    const pageSampleStatus: SampleStatus =
      landingPageViews === null
        ? "missing"
        : landingPageViews >= SOP.minimums.page.landing_page_views
          ? "decision_ready"
          : "insufficient";
    const cartSampleStatus: SampleStatus =
      addToCarts === null
        ? "missing"
        : addToCarts >= SOP.minimums.cart.add_to_carts
          ? "directional"
          : "insufficient";
    const checkoutSampleStatus: SampleStatus =
      checkouts === null
        ? "missing"
        : checkouts < SOP.minimums.checkout.minimum_checkouts
          ? "insufficient"
          : checkouts < SOP.minimums.checkout.preferred_checkouts
            ? "directional"
            : "decision_ready";
    const cacSampleStatus: SampleStatus =
      purchases === null
        ? "missing"
        : purchases < SOP.minimums.cac.initial_signal_purchases
          ? "insufficient"
          : purchases < SOP.minimums.cac.decision_purchases
            ? "directional"
            : purchases < SOP.minimums.cac.strong_purchases
              ? "decision_ready"
              : "strong";

    const evaluations = [
      {
        order: 1,
        stage: "creative_hook",
        metric: "hook_rate_percent",
        label: "Hook do criativo",
        value: hookRate,
        sample_status: creativeSampleStatus,
        health: metricHealth(
          hookRate,
          creativeSampleStatus,
          SOP.kpis.hook_rate_percent.poor_below,
          SOP.kpis.hook_rate_percent.good_from,
        ),
        probable_problem:
          "A primeira cena ou frase não está interrompendo o scroll com força suficiente.",
      },
      {
        order: 2,
        stage: "creative_click",
        metric: "link_ctr_percent",
        label: "Mensagem e clique do criativo",
        value: ctr,
        sample_status: creativeSampleStatus,
        health: metricHealth(
          ctr,
          creativeSampleStatus,
          SOP.kpis.link_ctr_percent.poor_below,
          SOP.kpis.link_ctr_percent.good_from,
        ),
        probable_problem:
          "O anúncio aparece, mas promessa, mensagem, oferta ou CTA não geram clique suficiente.",
      },
      {
        order: 3,
        stage: "landing_delivery",
        metric: "click_to_landing_page_rate_percent",
        label: "Entrega do clique até a página",
        value: clickToLandingPageRate,
        sample_status: landingDeliverySampleStatus,
        health: metricHealth(
          clickToLandingPageRate,
          landingDeliverySampleStatus,
          SOP.kpis.click_to_landing_page_rate_percent.poor_below,
          SOP.kpis.click_to_landing_page_rate_percent.good_from,
        ),
        probable_problem:
          "Parte relevante dos cliques não carrega a página; verifique velocidade, domínio, redirecionamento e rastreamento.",
      },
      {
        order: 4,
        stage: "sales_page",
        metric: "add_to_cart_rate_percent",
        label: "Página e oferta",
        value: addToCartRate,
        sample_status: pageSampleStatus,
        health: metricHealth(
          addToCartRate,
          pageSampleStatus,
          SOP.kpis.add_to_cart_rate_percent.poor_below,
          SOP.kpis.add_to_cart_rate_percent.good_from,
        ),
        probable_problem:
          "A página recebe tráfego, mas produto, preço, oferta, confiança ou congruência não geram intenção suficiente.",
      },
      {
        order: 5,
        stage: "cart",
        metric: "add_to_cart_to_checkout_rate_percent",
        label: "Carrinho",
        value: addToCartToCheckoutRate,
        sample_status: cartSampleStatus,
        health: metricHealth(
          addToCartToCheckoutRate,
          cartSampleStatus,
          SOP.kpis.add_to_cart_to_checkout_rate_percent.poor_below,
          SOP.kpis.add_to_cart_to_checkout_rate_percent.good_from,
        ),
        probable_problem:
          "A intenção existe, mas carrinho, frete, prazo, valor final ou botão impedem o avanço.",
      },
      {
        order: 6,
        stage: "checkout",
        metric: "checkout_to_purchase_rate_percent",
        label: "Checkout e pagamento",
        value: checkoutToPurchaseRate,
        sample_status: checkoutSampleStatus,
        health: metricHealth(
          checkoutToPurchaseRate,
          checkoutSampleStatus,
          SOP.kpis.checkout_to_purchase_rate_percent.poor_below,
          SOP.kpis.checkout_to_purchase_rate_percent.good_from,
        ),
        probable_problem:
          "Pessoas iniciam checkout, mas pagamento, frete, confiança, campos ou erros técnicos impedem a compra.",
      },
      {
        order: 7,
        stage: "full_funnel",
        metric: "landing_page_to_purchase_rate_percent",
        label: "Conversão completa da página",
        value: landingPageToPurchaseRate,
        sample_status: pageSampleStatus,
        health: metricHealth(
          landingPageToPurchaseRate,
          pageSampleStatus,
          SOP.kpis.landing_page_to_purchase_rate_percent.poor_below,
          SOP.kpis.landing_page_to_purchase_rate_percent.good_from,
        ),
        probable_problem:
          "O funil completo converte abaixo do mínimo, mas a etapa anterior vermelha deve ser corrigida primeiro.",
      },
      {
        order: 8,
        stage: "economics",
        metric: "cac_vs_target",
        label: "CAC e economia da oferta",
        value: cac,
        sample_status: cacSampleStatus,
        health:
          cac === null || targetCac === null
            ? "unavailable"
            : cacSampleStatus === "missing" || cacSampleStatus === "insufficient"
              ? "sample_insufficient"
              : cac > targetCac
                ? "bottleneck"
                : "healthy",
        probable_problem:
          "O funil pode converter, mas o custo por cliente excede o CAC que preserva o lucro desejado.",
      },
    ] as const;

    const firstProbableBottleneck =
      evaluations.find((evaluation) => evaluation.health === "bottleneck") ?? null;
    const firstInsufficientStage =
      evaluations.find((evaluation) => evaluation.health === "sample_insufficient") ?? null;

    const diagnosisSummary = firstProbableBottleneck
      ? `${firstProbableBottleneck.label}: gargalo provável com ${sampleStatusLabel(firstProbableBottleneck.sample_status).toLowerCase()}.`
      : firstInsufficientStage
        ? `Ainda não há amostra mínima para confirmar o funil. Próxima etapa: ${firstInsufficientStage.label}.`
        : evaluations.every(
              (evaluation) =>
                evaluation.health === "healthy" ||
                evaluation.health === "watch" ||
                evaluation.health === "unavailable",
            )
          ? "Nenhum gargalo grave confirmado nas etapas com amostra suficiente."
          : "Preencha os dados para iniciar o diagnóstico.";

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
        reach: reach === null ? null : round(reach, 4),
        three_second_video_views:
          threeSecondViews === null ? null : round(threeSecondViews, 4),
        link_clicks: linkClicks === null ? null : round(linkClicks, 4),
        landing_page_views:
          landingPageViews === null ? null : round(landingPageViews, 4),
        add_to_carts: addToCarts === null ? null : round(addToCarts, 4),
        checkouts: checkouts === null ? null : round(checkouts, 4),
        purchases: purchases === null ? null : round(purchases, 4),
        revenue: revenue === null ? null : round(revenue),
      },
      metrics: {
        hook_rate_percent: hookRate,
        frequency,
        ctr_percent: ctr,
        cpm:
          spend !== null && impressions !== null && impressions > 0
            ? round((spend / impressions) * 1_000, 4)
            : null,
        cpc: safeDivide(spend, linkClicks),
        click_to_landing_page_rate_percent: clickToLandingPageRate,
        cost_per_landing_page_view: safeDivide(spend, landingPageViews),
        add_to_cart_rate_percent: addToCartRate,
        cost_per_add_to_cart: safeDivide(spend, addToCarts),
        add_to_cart_to_checkout_rate_percent: addToCartToCheckoutRate,
        add_to_cart_to_purchase_rate_percent: addToCartToPurchaseRate,
        landing_page_to_checkout_rate_percent: landingPageToCheckoutRate,
        cost_per_checkout: safeDivide(spend, checkouts),
        checkout_to_purchase_rate_percent: checkoutToPurchaseRate,
        landing_page_to_purchase_rate_percent: landingPageToPurchaseRate,
        cac,
        roas,
        observed_average_order_value: observedAov,
        revenue_per_landing_page_view: safeDivide(revenue, landingPageViews),
      },
      economics_comparison: {
        target_cac: targetCac,
        actual_cac: cac,
        cac_status: economicsCacStatus,
        cac_difference: cacDifference,
        cac_difference_percent: cacDifferencePercent,
        max_spend_at_target_cac: maxSpendAtTargetCac,
        spend_headroom_vs_target: spendHeadroom,
        estimated_contribution_profit_after_ads: contributionProfitAfterAds,
        estimated_contribution_profit_per_purchase: profitPerPurchase,
      },
      sample_readiness: {
        creative: {
          status: creativeSampleStatus,
          label: sampleStatusLabel(creativeSampleStatus),
          current_impressions: impressions,
          required_impressions: SOP.minimums.creative.impressions,
          current_link_clicks: linkClicks,
          alternative_required_link_clicks:
            SOP.minimums.creative.link_clicks_alternative,
          rule: SOP.minimums.creative.rule,
        },
        landing_delivery: {
          status: landingDeliverySampleStatus,
          label: sampleStatusLabel(landingDeliverySampleStatus),
          current_link_clicks: linkClicks,
          required_link_clicks: SOP.minimums.landing_delivery.link_clicks,
          rule: SOP.minimums.landing_delivery.rule,
        },
        page: {
          status: pageSampleStatus,
          label: sampleStatusLabel(pageSampleStatus),
          current_landing_page_views: landingPageViews,
          required_landing_page_views: SOP.minimums.page.landing_page_views,
          rule: SOP.minimums.page.rule,
        },
        cart: {
          status: cartSampleStatus,
          label: sampleStatusLabel(cartSampleStatus),
          current_add_to_carts: addToCarts,
          required_add_to_carts: SOP.minimums.cart.add_to_carts,
          rule: SOP.minimums.cart.rule,
        },
        checkout: {
          status: checkoutSampleStatus,
          label: sampleStatusLabel(checkoutSampleStatus),
          current_checkouts: checkouts,
          minimum_checkouts: SOP.minimums.checkout.minimum_checkouts,
          preferred_checkouts: SOP.minimums.checkout.preferred_checkouts,
          rule: SOP.minimums.checkout.rule,
        },
        cac: {
          status: cacSampleStatus,
          label: sampleStatusLabel(cacSampleStatus),
          current_purchases: purchases,
          initial_signal_purchases: SOP.minimums.cac.initial_signal_purchases,
          decision_purchases: SOP.minimums.cac.decision_purchases,
          strong_purchases: SOP.minimums.cac.strong_purchases,
          rule: SOP.minimums.cac.rule,
        },
      },
      diagnosis: {
        sop_version: SOP.version,
        policy:
          "Only flag a probable bottleneck when that stage meets its minimum sample. Fix the first red stage before optimizing later stages.",
        kpi_thresholds: SOP.kpis,
        stage_evaluations: evaluations,
        first_probable_bottleneck: firstProbableBottleneck,
        first_stage_waiting_for_sample: firstInsufficientStage,
        summary: diagnosisSummary,
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
      window.setTimeout(() => setCopyState("idle"), 2_200);
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
    <section style={{ display: "grid", gap: 18, maxWidth: 760, width: "100%" }}>
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
            O analisador só confirma gargalos quando a etapa alcança a amostra mínima do SOP.
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
              placeholder="Ex.: NNC 01 · Cogumelos"
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
            ["reach", "Alcance"],
            ["threeSecondViews", "Views de 3s"],
            ["linkClicks", "Cliques no link"],
            ["landingPageViews", "Visitas à página"],
            ["addToCarts", "ATCs"],
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
            <div style={{ display: "grid", gap: 14 }}>
              <div
                style={{
                  display: "grid",
                  gap: 10,
                  gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
                }}
              >
                {([
                  [
                    "Criativo",
                    funnelCalculation.sample_readiness.creative.label,
                    `${funnelCalculation.inputs.impressions ?? 0}/2.000 imp. ou ${funnelCalculation.inputs.link_clicks ?? 0}/30 cliques`,
                  ],
                  [
                    "Página",
                    funnelCalculation.sample_readiness.page.label,
                    `${funnelCalculation.inputs.landing_page_views ?? 0}/100 LPVs`,
                  ],
                  [
                    "Checkout",
                    funnelCalculation.sample_readiness.checkout.label,
                    `${funnelCalculation.inputs.checkouts ?? 0}/10 mínimo · 20 ideal`,
                  ],
                  [
                    "CAC",
                    funnelCalculation.sample_readiness.cac.label,
                    `${funnelCalculation.inputs.purchases ?? 0}/10 compras · 20 forte`,
                  ],
                ] as const).map(([label, status, progress]) => (
                  <div
                    key={label}
                    style={{
                      background: "rgba(255,255,255,.055)",
                      borderRadius: 14,
                      display: "grid",
                      gap: 4,
                      padding: 12,
                    }}
                  >
                    <strong style={{ fontSize: 13 }}>{label}</strong>
                    <span style={{ fontSize: 12, opacity: 0.8 }}>{status}</span>
                    <span style={{ fontSize: 11, opacity: 0.58 }}>{progress}</span>
                  </div>
                ))}
              </div>

              <div
                style={{
                  background: "rgba(255,255,255,.065)",
                  borderRadius: 14,
                  display: "grid",
                  gap: 5,
                  padding: 14,
                }}
              >
                <span style={{ fontSize: 12, opacity: 0.65 }}>Diagnóstico pelo SOP</span>
                <strong style={{ fontSize: 16 }}>
                  {funnelCalculation.diagnosis.summary}
                </strong>
                {funnelCalculation.diagnosis.first_probable_bottleneck ? (
                  <span style={{ fontSize: 13, opacity: 0.78 }}>
                    {
                      funnelCalculation.diagnosis.first_probable_bottleneck
                        .probable_problem
                    }
                  </span>
                ) : null}
              </div>

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
                  LPV → ATC: {displayPercent(funnelCalculation.metrics.add_to_cart_rate_percent)}
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
