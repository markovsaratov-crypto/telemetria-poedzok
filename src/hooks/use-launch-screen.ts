"use client";

// src/hooks/use-launch-screen.ts — v2.38.2 · F75: приложение чтит ?screen= при запуске.
// PWA-ярлык «Все поездки» (manifest.webmanifest) открывает /m?screen=trips, но
// параметр нигде не парсился — ярлык всегда показывал дефолтную вкладку
// «Аналитика». Стейт вкладки живёт в AppRoot (useState, вне зоны правок этого
// фикса), поэтому параметр потребляется здесь: на маунте AnalyticsView (дефолтный
// раздел) читаем ?screen= и переключаем вкладку через ШТАТНЫЙ хоткей Alt+1/2/3 —
// глобальный keydown-роутер telematika-layout (TABS: 1=analytics, 2=trips,
// 3=admin). Это тот же путь, что и ручное нажатие Alt+N: действуют те же гварды
// (role=user → «Админ» заблокирован в guardedSetTab app-root). После срабатывания
// параметр вычищается из URL (history.replaceState), чтобы F5 не возвращал
// пользователя на раздел ярлыка.

import * as React from "react";

// v4-вкладки, доступные через Alt+N (порядок TABS в telematika-layout).
const SCREEN_TO_ALT: Record<string, string> = {
  analytics: "1",
  trips: "2",
  admin: "3",
};

export function useLaunchScreen(): void {
  React.useEffect(() => {
    let screen: string | null = null;
    try {
      screen = new URLSearchParams(window.location.search).get("screen");
    } catch {
      return; // location/search недоступны — остаёмся на дефолтной вкладке
    }
    const altKey = screen ? SCREEN_TO_ALT[screen.toLowerCase()] : undefined;
    if (!altKey) return;

    // Дочерние эффекты стартуют раньше родительских: keydown-роутер
    // telematika-layout в этом же коммите ещё не подписан — ждём конца
    // коммита (setTimeout 0 → макротаск после флаша всех эффектов).
    const t = window.setTimeout(() => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: altKey, altKey: true })
      );
      // Параметр «израсходован»: чистим URL — перезагрузка страницы не
      // должна перескакивать на раздел ярлыка.
      try {
        window.history.replaceState(null, "", window.location.pathname);
      } catch {
        /* replaceState недоступен — параметр просто останется в URL */
      }
    }, 0);
    return () => window.clearTimeout(t);
  }, []);
}
