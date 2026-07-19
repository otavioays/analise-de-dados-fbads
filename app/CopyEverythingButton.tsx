"use client";

import { useState } from "react";

type State = "idle" | "loading" | "copied" | "error";

export default function CopyEverythingButton() {
  const [state, setState] = useState<State>("idle");

  async function copyEverything() {
    if (state === "loading") return;

    setState("loading");

    try {
      const response = await fetch("/api/export?days=90&raw_limit=10000", {
        cache: "no-store",
      });

      if (!response.ok) {
        throw new Error(`Export failed with status ${response.status}`);
      }

      const payload = await response.json();
      await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
      setState("copied");
      window.setTimeout(() => setState("idle"), 2200);
    } catch (error) {
      console.error("Could not copy conversion intelligence export", error);
      setState("error");
      window.setTimeout(() => setState("idle"), 3200);
    }
  }

  const label =
    state === "loading"
      ? "Montando dossiê..."
      : state === "copied"
        ? "Tudo copiado"
        : state === "error"
          ? "Falhou. Tentar novamente"
          : "Copiar tudo para a IA";

  return (
    <button
      type="button"
      onClick={copyEverything}
      disabled={state === "loading"}
      aria-live="polite"
      style={{
        appearance: "none",
        border: 0,
        borderRadius: 18,
        cursor: state === "loading" ? "wait" : "pointer",
        fontSize: "clamp(18px, 2.2vw, 30px)",
        fontWeight: 700,
        letterSpacing: "-0.02em",
        padding: "24px 36px",
        minWidth: "min(86vw, 440px)",
        minHeight: 84,
        boxShadow: "0 18px 60px rgba(0,0,0,.24)",
      }}
    >
      {label}
    </button>
  );
}
