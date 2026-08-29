import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import "./telematika-v4.css";
import { Providers } from "@/components/providers";
import { PwaRegister } from "@/components/pwa-register";
// v2.9.9: баннер «Доступна новая версия» (управляемое обновление SW)
import { SwUpdateToast } from "@/components/sw-update-toast";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin", "cyrillic"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin", "cyrillic"],
});

export const metadata: Metadata = {
  title: "Телематика Маркова",
  description:
    "Дашборд поездок и аналитика телеметрии: сессии, маршруты, плавность вождения, пробки и качество данных.",
  keywords: ["телеметрия", "GPS", "поездки", "маршруты", "Telemetria"],
  authors: [{ name: "Telemetria" }],
  icons: {
    icon: [
      { url: "/logo.svg", type: "image/svg+xml" },
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: "/icons/apple-touch-icon.png",
  },
  manifest: "/manifest.webmanifest",
  applicationName: "Телематика Маркова",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Телематика",
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#c73a63" },
    { media: "(prefers-color-scheme: dark)", color: "#17151a" },
  ],
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ru" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        <Providers>{children}</Providers>
        <PwaRegister />
        <SwUpdateToast />
      </body>
    </html>
  );
}
