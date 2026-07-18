import type { Metadata } from "next";
import Script from "next/script";

import "./globals.css";

export const metadata: Metadata = {
  title: "Conversion Tracker",
  description: "Painel privado de rastreamento de conversão.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="pt-BR">
      <body>
        {children}
        <Script
          src="/tracker.js"
          strategy="afterInteractive"
          data-debug="true"
          data-internal="true"
          data-session-timeout-minutes="30"
        />
      </body>
    </html>
  );
}
