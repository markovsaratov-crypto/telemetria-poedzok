// src/app/shared/[token]/page.tsx — публичная страница шаринга поездки (P1-9).
// Раньше маршрута не существовало вовсе (404) — сценарий «поделиться поездкой»
// был мёртв. Без внешних зависимостей (карт нет) — SVG-превью трека в клиентском
// островке SharedView: устойчиво и быстро.
//
// v2.38.1 (ревью F23): серверная обёртка с generateMetadata — страница была
// ЦЕЛИКОМ клиентской ("use client"), из-за чего og:title/description/image не
// существовали ни в HTML, ни в HEAD: мессенджеры (Telegram/WhatsApp/Twitter —
// robots.txt явно разрешает их ботов) показывали голый URL. Токен резолвится
// СЕРВЕРНО через ту же библиотеку, что и /api/share (verifyShareToken +
// sharePayload — прямой вызов, без HTTP-само-вызова), KPI едут в og:description.
// Данные передаются островку пропсом — двойной fetch (сервер + клиент) устранён,
// клиентский fetch /api/share удалён.
//
// v2.38.1 (ревью F21): payload уже прорежен сервером до ≤800 точек (share.ts),
// клиентский рендер обёрнут в ErrorBoundary, min/max — циклами (не спредом).

import type { Metadata } from "next";
import { cache } from "react";
import { headers } from "next/headers";
import { verifyShareToken, sharePayload } from "@/lib/share";
import { SharedView, type SharedPayload, type SharedState } from "./shared-view";

// Один вызов библиотеки на рендер страницы: generateMetadata и компонент
// страницы запускаются Next.js независимо — React cache дедуплицирует
// резолв токена и чтение сессии в рамках одного запроса.
const loadSharedState = cache(async (token: string): Promise<SharedState> => {
  try {
    // verifyShareToken async (внутри timing-safe сверка подписи) — см. share.ts
    const verified = await verifyShareToken(token);
    if (!verified) {
      return { kind: "error", message: "Ссылка недействительна или её срок истёк." };
    }
    const requestId = `shared-page-${token.slice(0, 8)}`;
    const res = await sharePayload(verified.sessionId, verified.expiresAt, requestId);
    if (res.status === 404) {
      return { kind: "error", message: "Поездка не найдена или удалена." };
    }
    if (res.status !== 200) {
      return { kind: "error", message: "Не удалось загрузить поездку. Попробуйте позже." };
    }
    return { kind: "ok", data: (await res.json()) as SharedPayload };
  } catch {
    return { kind: "error", message: "Не удалось загрузить поездку. Попробуйте позже." };
  }
});

// Абсолютный origin для og:image/og:url — из заголовков запроса (домен
// приложения не зашит в конфиг: prod poedzok.fun / push-канал / localhost).
async function requestOrigin(): Promise<string | null> {
  const h = await headers();
  const host = h.get("host");
  if (!host) return null;
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
  return `${proto}://${host}`;
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ token: string }>;
}): Promise<Metadata> {
  const { token } = await params;
  const state = await loadSharedState(token);
  if (state.kind !== "ok") {
    // Токен невалиден/истёк/сессия удалена — минимальные метаданные без KPI
    return {
      title: "Поездка недоступна — Телемат",
      description: "Ссылка недействительна, истёк её срок или поездка удалена.",
    };
  }

  const data = state.data;
  // KPI в метаданные — по активной части (FIX-C3), как на самой странице
  const km =
    data.distanceM != null && Number.isFinite(data.distanceM) && data.distanceM > 0
      ? `${(data.distanceM / 1000).toFixed(1).replace(".", ",")} км`
      : null;
  const startMs = new Date(data.startTime).getTime();
  const dateStr = Number.isFinite(startMs)
    ? new Date(startMs).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" })
    : null;
  const durSec =
    data.activeDurationSec && data.activeDurationSec > 0
      ? data.activeDurationSec
      : Math.max(0, (new Date(data.endTime).getTime() - startMs) / 1000);
  const durStr = Number.isFinite(durSec) && durSec > 0
    ? durSec >= 3600
      ? `${Math.floor(durSec / 3600)} ч ${Math.round((durSec % 3600) / 60)} мин`
      : durSec >= 60
        ? `${Math.round(durSec / 60)} мин`
        : `${Math.round(durSec)} сек`
    : null;
  const avgKmh =
    data.distanceM != null && data.activeDurationSec != null && data.activeDurationSec > 0 && data.distanceM > 0
      ? `${((data.distanceM / data.activeDurationSec) * 3.6).toFixed(1).replace(".", ",")} км/ч`
      : null;

  const title = km ? `Поездка Телемат — ${km}` : "Поездка Телемат";
  const parts = [dateStr, km, durStr, avgKmh ? `ср. ${avgKmh}` : null].filter(Boolean);
  const description = parts.length > 0 ? parts.join(" · ") : "Поездка с GPS-треком и показателями вождения.";

  const origin = await requestOrigin();
  const images = origin ? [{ url: `${origin}/logo.png`, width: 512, height: 512, alt: "Телемат" }] : undefined;
  const url = origin ? `${origin}/shared/${token}` : undefined;

  // robots не ограничиваем: public/robots.txt уже разрешает Googlebot/Twitterbot/
  // facebookexternalhit — страница публична по спеке (матрица §7, P1-9)
  return {
    title,
    description,
    openGraph: {
      title,
      description,
      siteName: "Телемат",
      locale: "ru_RU",
      type: "website",
      url,
      images,
    },
    twitter: {
      card: "summary",
      title,
      description,
      images: images ? [images[0].url] : undefined,
    },
  };
}

export default async function SharedPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const state = await loadSharedState(token);
  return <SharedView state={state} />;
}
