import type { Metadata, Viewport } from "next";
import { Bebas_Neue, Inter } from "next/font/google";
import { AppShell } from "@/components/shell";
import { PwaRegister } from "@/components/pwa-register";
import { scheduleFacsimileRematch } from "@/lib/covers/facsimile-rematch";
import { scheduleShelfFormatBackfill } from "@/lib/shelf-format-backfill";
import { readBackfillStatus } from "@/lib/covers/files";
import { getViewer } from "@/lib/auth";
import { ACCENT_RGB, defaultPreferences } from "@/lib/settings/preferences";
import { getPreferences } from "@/lib/settings/service";
import "./globals.css";

const display = Bebas_Neue({
  weight: "400",
  subsets: ["latin"],
  variable: "--font-display",
  display: "swap",
});

const body = Inter({
  subsets: ["latin"],
  variable: "--font-body",
  display: "swap",
});

export const metadata: Metadata = {
  title: { default: "Longbox", template: "%s · Longbox" },
  description: "A self-hosted tracker for one physical comic collection.",
  applicationName: "Longbox",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "Longbox" },
  icons: {
    icon: [
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: "/icons/apple-touch-icon.png",
  },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: "#0d0e12",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  scheduleFacsimileRematch();
  scheduleShelfFormatBackfill();
  const viewer = await getViewer();
  const prefs = await getPreferences().catch(() => defaultPreferences());
  return (
    <html lang="en" className={`${display.variable} ${body.variable}`} style={{ "--accent-rgb": ACCENT_RGB[prefs.display.accent] } as React.CSSProperties}>
      <body className="font-sans antialiased">
        <link rel="manifest" href="/manifest.webmanifest" crossOrigin="use-credentials" />
        <AppShell viewer={viewer} backfill={readBackfillStatus()}>
          {children}
        </AppShell>
        <PwaRegister />
      </body>
    </html>
  );
}
