// src/lib/poll-controller.ts — v2.39.0 (§A3, docs/OPTIMIZATION-PROPOSAL.md
// Вариант A): УМНЫЙ ОПРОС фронтенда.
//
// ПРОБЛЕМА: фиксированный 30-с опрос вкладок «Поездки»/«Аналитика» + опрос
// скрытых вкладок тратил фоновый трафик и подогревал квоту D1 (каждый poll =
// пересчёт дашборд-агрегатов). 429/5xx при outage — react-query retry:1 тут же
// повторял запрос, усугубляя шторм.
//
// РЕШЕНИЕ (§A3) — ТРИ правила, константы с комментарием:
//   • базовый интервал 60 с (было 30 с) — POLL_BASE_INTERVAL_MS;
//   • ПОЛНАЯ ПАУЗА при document.hidden: refetchInterval → false (react-query
//     refetchIntervalInBackground=false и так глушил свёрнутые вкладки, но
//     возврат видимости НЕ рефоучил — теперь visibilitychange:visible →
//     немедленный refetch активных смарт-запросов + рестарт интервала);
//   • exponential backoff ×2 при 429/5xx/сетевых ошибках (до 5 мин, сброс при
//     успехе), уважение Retry-After сервера (429-ответы несут retry-after).
//
// ГРАНИЦЫ СЛОЯ (требование задачи): рабочая логика стора/роутов НЕ трогается —
// только слой опроса (useTrips/useSessions/useStats получают новый интервал
// из useSmartPollInterval; queryFn/staleTime/select прежние).
//
// Состояние — на модуль (одна вкладка = один бандл): параллельные запросы
// докладывают исходы в общий контроллер; множественные одновременные ошибки
// не разгоняют backoff многократно (окно дедупликации роста 1 с).

"use client";

import { useEffect, useState } from "react";
import { useQueryClient, type QueryKey } from "@tanstack/react-query";

// ——— §A3: интервалы опроса (константы с комментарием, не магические числа) ———
/** Базовый интервал опроса (было 30 с: ×2 частота = ×2 фоновый расход квоты D1). */
export const POLL_BASE_INTERVAL_MS = 60_000;
/** Множитель backoff при 429/5xx (каждая ошибка удваивает интервал). */
export const POLL_BACKOFF_FACTOR = 2;
/** Потолок backoff (5 мин — сервер в outage не должен поллиться чаще). */
export const POLL_MAX_INTERVAL_MS = 300_000;
/** Окно дедупликации роста: параллельные ошибки не множат backoff. */
const POLL_GROWTH_DEDUP_MS = 1_000;

interface PollState {
  intervalMs: number;
}

const state: PollState = { intervalMs: POLL_BASE_INTERVAL_MS };
let lastFailureAt = 0;
const listeners = new Set<() => void>();

function notify(): void {
  for (const cb of listeners) {
    try {
      cb();
    } catch {
      // подписчик (компонент в размонтировании) — тихо
    }
  }
}

/** Текущий интервал (мс) с учётом backoff. Экспорт для тестов/инструментов. */
export function currentPollIntervalMs(): number {
  return state.intervalMs;
}

function clampInterval(ms: number): number {
  return Math.min(POLL_MAX_INTERVAL_MS, Math.max(POLL_BASE_INTERVAL_MS, Math.round(ms)));
}

/**
 * Доклад об ошибке запроса (вызывает api-client в ветках 429/5xx/catch):
 * интервал ×2, но не чаще роста раз в POLL_GROWTH_DEDUP_MS (шторм параллельных
 * запросов = один шаг backoff). Retry-After (мс) доминирует над расчётным
 * значением, потолок тот же.
 */
export function reportPollFailure(status: number, retryAfterMs?: number | null): void {
  const now = Date.now();
  const isBackoffWorthy = status === 429 || status === 0 || status >= 500;
  if (!isBackoffWorthy) return;
  if (now - lastFailureAt < POLL_GROWTH_DEDUP_MS) return; // уже выросли этим штормом
  lastFailureAt = now;
  const byRetry = retryAfterMs != null && retryAfterMs > 0 ? retryAfterMs : 0;
  const next = clampInterval(Math.max(state.intervalMs * POLL_BACKOFF_FACTOR, byRetry));
  if (next !== state.intervalMs) {
    state.intervalMs = next;
    notify();
  }
}

/** Доклад об успехе (api-client после 2xx) — сброс backoff к базе. */
export function reportPollSuccess(): void {
  if (state.intervalMs !== POLL_BASE_INTERVAL_MS) {
    state.intervalMs = POLL_BASE_INTERVAL_MS;
    notify();
  }
}

/** Видимость вкладки: полная пауза опроса при hidden (§A3). */
export function isDocumentHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

/**
 * Значение refetchInterval для useQuery: false при скрытой вкладке (полная
 * пауза), иначе текущий интервал контроллера. Подписка на изменения backoff
 * + visibilitychange: возврат видимости → НЕМЕДЛЕННЫЙ refetch активных
 * запросов по ключам keys (рефоуч) — свежие данные без ожидания таймера.
 * Использование:
 *   const poll = useSmartPollInterval([["trips", "list", 50]]);
 *   useQuery({ ..., refetchInterval: poll });
 */
export function useSmartPollInterval(keys: readonly unknown[][]): number | false {
  const qc = useQueryClient();
  const [tick, setTick] = useState(0);
  // стабильный ключ эффекта: сериализация — вызывающие передают литералы/мемо
  const keysSerialized = JSON.stringify(keys);

  // подписка на backoff-изменения контроллера
  useEffect(() => {
    const cb = () => setTick((t) => t + 1);
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  }, []);

  // visibilitychange: visible → немедленный рефоуч активных смарт-запросов
  useEffect(() => {
    const parsed = JSON.parse(keysSerialized) as unknown[][];
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        for (const key of parsed) {
          qc.refetchQueries({ queryKey: key as QueryKey, type: "active" }).catch(() => {
            // рефоуч не критичен — таймер интервала всё равно жив
          });
        }
      }
      setTick((t) => t + 1); // перечитать hidden-состояние
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [qc, keysSerialized]);

  if (isDocumentHidden()) return false; // §A3: полная пауза скрытой вкладки
  void tick; // ре-рендер подписки
  return state.intervalMs;
}
