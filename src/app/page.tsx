"use client";

// src/app/page.tsx — v4.0: логин ИЛИ TelematikaLayout (Аналитика / Поездки / Админ).
// AUDIT B-17: логика вынесена в components/v4/app-root.tsx (общая с /m).

import { AppRoot } from "@/components/v4/app-root";

export default function Home() {
  return <AppRoot />;
}
