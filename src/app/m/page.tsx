"use client";

// src/app/m/page.tsx — мобильный вход (та же логика, что и /).
// AUDIT B-17: раньше — полная копия page.tsx; теперь общий корень app-root.tsx.

import { AppRoot } from "@/components/v4/app-root";

export default function MobilePage() {
  return <AppRoot />;
}
