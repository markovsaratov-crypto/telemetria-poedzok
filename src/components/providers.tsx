"use client";

// src/components/providers.tsx — обёртка для ThemeProvider (next-themes),
// QueryClientProvider (@tanstack/react-query) и Toaster (sonner).

import * as React from "react";
import { ThemeProvider as NextThemesProvider } from "next-themes";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MotionConfig } from "framer-motion";
import { Toaster } from "@/components/ui/sonner";

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = React.useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            gcTime: 5 * 60_000,
            retry: 1,
            refetchOnWindowFocus: false,
          },
        },
      })
  );

  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="light"
      enableSystem
      disableTransitionOnChange
    >
      <QueryClientProvider client={queryClient}>
        {/* v2.38.2 · F85 (кодревью): framer-motion игнорировал
            prefers-reduced-motion — CSS-анимации гасятся (globals.css,
            telematika-v4.css), а JS-спринги/AnimatePresence (шейк логина,
            тосты, вкладки) шли всегда. reducedMotion="user": при системной
            настройке отключаются transform/layout-анимации, прозрачность
            остаётся; раскладка не меняется. */}
        <MotionConfig reducedMotion="user">
          {children}
          <Toaster position="top-right" richColors closeButton />
        </MotionConfig>
      </QueryClientProvider>
    </NextThemesProvider>
  );
}
