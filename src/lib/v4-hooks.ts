// src/lib/v4-hooks.ts — v2.10.0 React Query хуки для v4 analytics (R1 Live API).
// Используют api-client (credentials:"include"). queryKey: ["v4", "...", sessionId]
// для инвалидации по сессии при переключении поездки.
//
// v2.10.2: + usePeriodStats — агрегат ВСЕХ поездок за выбранный период.
// Период-режим (когда конкретная поездка не выбрана) показывает метрики
// по всем поездкам периода: суммы, взвешенные средние, склеенный
// скоростной профиль/трек/G-G — те же блоки, что и для одной поездки.

"use client";

import { useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  type TrackResponse,
  type EventsResponse,
  type SessionListItem,
} from "./api-client";
import { useSessions, fetchSessionsStatsBatch, seedSessionsStatsFromBatch, type SessionStats } from "./hooks";
import { useTrips } from "./trip-hooks"; // v2.26.0: счётчик ПОЕЗДОК периода
import { haversineM } from "./geo"; // v2.31.0 (MAJ-10): §8.2 в период-режиме
import { type PeriodKey } from "./v4-utils";

// /api/stats/speed-record — §4.5 MaxSpeedAllTime (v2.13.0 Ф1).
export interface SpeedRecordResponse {
  maxSpeedAllTimeKmh: number | null;
  sessionId: string | null;
  date: string | null;
}
export function useSpeedRecord() {
  return useQuery<SpeedRecordResponse | null>({
    queryKey: ["v4", "speed-record"],
    queryFn: () => api.get<SpeedRecordResponse>("/api/stats/speed-record"),
    staleTime: 300_000, // кэш сервера тоже 5 мин
    retry: 1,
  });
}

// /api/sessions/[id]/track — Leaflet polyline + segments + harsh points.
export function useV4Track(sessionId: string | null) {
  return useQuery<TrackResponse | null>({
    queryKey: ["v4", "track", sessionId],
    queryFn: () => {
      if (!sessionId) return null;
      return api.get<TrackResponse>(`/api/sessions/${sessionId}/track`);
    },
    enabled: !!sessionId,
    staleTime: 60_000,
    retry: 1,
  });
}

// /api/sessions/[id]/events — G-G diagram + harsh events + summary.
export function useV4Events(sessionId: string | null) {
  return useQuery<EventsResponse | null>({
    queryKey: ["v4", "events", sessionId],
    queryFn: () => {
      if (!sessionId) return null;
      return api.get<EventsResponse>(`/api/sessions/${sessionId}/events`);
    },
    enabled: !!sessionId,
    staleTime: 60_000,
    retry: 1,
  });
}

// === Период-агрегат (v2.10.2) ===

// v2.31.0 (MIN-9): 30 → 50 — скоуп агрегата = скоупу списка записей (useSessions
// limit 50) и вкладки «Поездки» (useTrips limit 50): шапка «N поездок · M записей»
// и Σ-статы покрывают один и тот же набор, счётчики вкладок сходятся. Все батч-роуты
// принимают ≤50 id (BATCH_MAX_IDS); статы — предрасчёт из персистентного кэша.
const MAX_PERIOD_SESSIONS = 50;

export function periodStartMs(period: PeriodKey, now = Date.now()): number {
  const d = new Date(now);
  switch (period) {
    case "today":
      return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    case "week":
      return now - 7 * 86_400_000;
    case "d30":
      return now - 30 * 86_400_000;
    // v2.12.0: «Месяц» (календарный с 1-го числа) удалён — 30 дней скользящим окном достаточно
    case "all":
    default:
      return 0;
  }
}

export function sessionsInPeriod(list: SessionListItem[], period: PeriodKey): SessionListItem[] {
  const from = periodStartMs(period);
  return list.filter((s) => {
    const t = new Date(s.startTime).getTime();
    return Number.isFinite(t) && t >= from;
  });
}

export interface PeriodAggregate {
  stats: SessionStats;
  events: EventsResponse;
  track: TrackResponse;
  /** v2.26.0 (ТЗ §11): ПОЕЗДКИ = серверные Trip (fallback на записи, если поездки ещё не заведены — expand-фаза) */
  trips: number;
  /** v2.26.0: записи периода (транспортные фрагменты) — «· M записей» в шапке */
  sessionsCount: number;
  rangeStart: string;
  rangeEnd: string;
}

function sum(nums: Array<number | null | undefined>): number {
  let acc = 0;
  for (const n of nums) if (n != null && Number.isFinite(n)) acc += n;
  return acc;
}

function avg(nums: Array<number | null | undefined>): number | null {
  const vals = nums.filter((n) => n != null && Number.isFinite(n)) as number[];
  if (!vals.length) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

// Взвешенное среднее (по длительности сессии).
function wavg(items: Array<{ v: number | null; w: number }>): number | null {
  let vs = 0, ws = 0;
  for (const { v, w } of items) {
    if (v == null || !Number.isFinite(v) || w <= 0) continue;
    vs += v * w; ws += w;
  }
  return ws > 0 ? vs / ws : null;
}

function mergeBbox(boxes: SessionStats["bbox"][]): SessionStats["bbox"] {
  const valid = boxes.filter(Boolean);
  if (!valid.length) return { minLat: 0, maxLat: 0, minLon: 0, maxLon: 0 };
  return {
    minLat: Math.min(...valid.map((b) => b.minLat)),
    maxLat: Math.max(...valid.map((b) => b.maxLat)),
    minLon: Math.min(...valid.map((b) => b.minLon)),
    maxLon: Math.max(...valid.map((b) => b.maxLon)),
  };
}

function aggregateStats(items: SessionStats[], sessionId: string): SessionStats {
  // Хронологический порядок (старые → новые) для склейки профилей.
  const sorted = [...items].sort(
    (a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime()
  );

  const distance = sum(sorted.map((s) => s.distance));
  const duration = sum(sorted.map((s) => s.duration));
  const movingTime = sum(sorted.map((s) => s.movingTime));
  const idleTime = sum(sorted.map((s) => s.idleTime));
  const gapTime = sum(sorted.map((s) => s.gapTime ?? 0));
  const pointCount = sum(sorted.map((s) => s.pointCount));
  const elevationGain = sum(sorted.map((s) => s.elevationGain));
  const elevationLoss = sum(sorted.map((s) => s.elevationLoss));

  // Склеенный скоростной профиль: t каждой сессии смещается на накопленную
  // длительность предыдущих (визуально — одна длинная «запись» из N поездок).
  let tOffset = 0;
  const speedProfile: NonNullable<SessionStats["speedProfile"]> = [];
  for (const s of sorted) {
    for (const p of s.speedProfile ?? []) {
      speedProfile.push({ ...p, t: tOffset + p.t });
    }
    tOffset += Math.max(0, s.duration ?? 0);
  }
  // Даунсемпл до ~720 сэмплов, чтобы не раздувать DOM.
  const MAX_PROFILE = 720;
  let profile = speedProfile;
  if (speedProfile.length > MAX_PROFILE) {
    const step = (speedProfile.length - 1) / (MAX_PROFILE - 1);
    profile = Array.from({ length: MAX_PROFILE }, (_, i) =>
      speedProfile[Math.round(i * step)]
    );
  }

  // method-объекты из каждой сессии
  const m = sorted.map((s) => s.methodology).filter(Boolean) as NonNullable<
    SessionStats["methodology"]
  >[];
  const routes = sorted.map((s) => s.route).filter(Boolean) as NonNullable<
    SessionStats["route"]
  >[];

  // v2.31.0 (MAJ-4): согласованные популяции числителя/знаменателя план-факта
  // периода. Раньше числитель Δ по времени = Σ активных длительностей ВСЕХ
  // записей периода, а знаменатель = Σ планов только сопоставимых (coverage
  // ≥ 50%) — активное время записей без плана систематически завышало «+N
  // мин/поездку» и hero «Отклонение по времени». Теперь и числитель, и
  // знаменатель — только записи с сопоставимым планом (как в §6.3).
  const comparableActualDurTotal = sum(
    sorted
      .filter((s) => s.route && s.route.planComparable !== false)
      .map((s) => {
        const at = s.methodology?.activeTrip;
        return at?.hasActiveTrip && (at.activeDuration ?? 0) > 0
          ? at.activeDuration
          : (s.duration ?? 0);
      })
  );
  const comparableDistTotal = sum(
    sorted.filter((s) => s.route && s.route.planComparable !== false).map((s) => s.distance ?? 0)
  );

  // FIX-C1/C2: активные составляющие периода — сумма активных длительностей/хвостов
  // поездок (§4.11). Раньше агрегат avgSpeed и Δ по времени считались от полной
  // длительности записей — стоянки-хвосты занижали среднюю и завышали отклонение от плана.
  const activeDurations = m.map((x) => (x.activeTrip?.hasActiveTrip ? x.activeTrip.activeDuration : 0));
  const activeDurTotal = sum(activeDurations);
  const preIdleTotal = sum(m.map((x) => x.activeTrip?.preTripIdle ?? 0));
  const postIdleTotal = sum(m.map((x) => x.activeTrip?.postTripIdle ?? 0));
  const activeIdleTotal = sum(m.map((x) => x.activeTrip?.activeIdleTime ?? 0));
  const anyActive = activeDurations.some((d) => d > 0);

  // v2.25.0 (П.5): в агрегат плана идут ТОЛЬКО сопоставимые планы (покрытие ≥ 50%
  // фактической дистанции записи). План «дом→работа» 1,7 км против записи на весь
  // день 36 км раньше загромождал период-агрегат «перерасходом +558 мин/поездку».
  const comparableRoutes = routes.filter((r) => r.planComparable !== false);
  const anyRouteMarkedNotComparable = routes.some((r) => r.planComparable === false);
  const planDistanceM = sum(comparableRoutes.map((r) => r.planDistanceM));
  const planDurationSec = sum(comparableRoutes.map((r) => r.planDurationSec));
  const trafficDurationSec = sum(comparableRoutes.map((r) => r.trafficDurationSec));
  const timeLostToTrafficSec = sum(comparableRoutes.map((r) => r.timeLostToTrafficSec));
  // v2.13.0 (Ф4): знаменатель «мин/поездку» — только записи с реальным планом
  // (planDurationSec > 0; нулевые планы 2ГИС для джиттер-сессий не считаются).
  const planTripCount = comparableRoutes.filter((r) => (r.planDurationSec ?? 0) > 0).length;

  const ecoScoreValue = wavg(
    m.map((x) => ({ v: x.ecoScore?.value ?? null, w: x.activeTrip?.activeDuration ?? 0 })) as Array<{ v: number | null; w: number }>
  );
  // v2.31.0 (MIN-8): средняя надёжность периода + рейтинг по порогам §11.6
  const relValue = avg(m.map((x) => x.sessionReliability?.value ?? null));
  const relRating =
    relValue == null
      ? "insufficient_data"
      : relValue >= 0.85
        ? "high"
        : relValue >= 0.6
          ? "medium"
          : relValue >= 0.3
            ? "low"
            : "unreliable";
  // v2.26.1: подписи рейтинга — та же шкала стиля вождения, что и в ecoLab
  // (плавно / умеренно / агрессивно); старое «резко» было непонятно пользователю.
  const rating =
    ecoScoreValue == null
      ? "—"
      : ecoScoreValue >= 80
        ? "плавно"
        : ecoScoreValue >= 60
          ? "умеренно"
          : "агрессивно";

  const hours = duration / 3600;
  const distTotal = distance;
  // FIX-C1: средняя скорость периода = Σ активных дистанций / Σ активных длительностей
  // (согласовано с поездиным KPI §4.3). Fallback на полную длительность — для legacy-данных.
  const avgSpeedBase = activeDurTotal > 0 ? activeDurTotal : duration;

  // v2.31.0 (MAJ-10): §8.2 в период-режиме — путь/прямая(старт→финиш), как в
  // одиночном. Раньше агрегат подменял смысл на факт/план (Σ дистанций/Σ
  // планов), а тултип «Путь против прямой» врал. Прямая = от старта первой
  // активной поездки до финиша последней.
  const firstActive = m.find((x) => x.activeTrip?.hasActiveTrip)?.activeTrip;
  const lastActive = [...m].reverse().find((x) => x.activeTrip?.hasActiveTrip)?.activeTrip;
  const directM =
    firstActive && lastActive
      ? haversineM(
          firstActive.activeStartCoord.lat,
          firstActive.activeStartCoord.lon,
          lastActive.activeEndCoord.lat,
          lastActive.activeEndCoord.lon
        )
      : 0;

  return {
    sessionId,
    pointCount,
    distance,
    duration,
    movingTime,
    idleTime,
    gapTime,
    speedProfile: profile,
    hasAltitude: sorted.some((s) => s.hasAltitude),
    routeHash: null,
    topologyHash: null,
    // v2.31.0 (MIN-15б): дистанция 0 (период из одних джиттер-записей) — «—»,
    // а не «0,0 км/ч»
    avgSpeed: distance > 0 && avgSpeedBase > 0 ? distance / avgSpeedBase : null,
    maxSpeed: Math.max(0, ...sorted.map((s) => s.maxSpeed ?? 0)),
    avgAltitude: wavg(
      sorted.map((s) => ({ v: s.avgAltitude, w: s.pointCount ?? 0 })) as Array<{ v: number | null; w: number }>
    ),
    elevationGain,
    elevationLoss,
    bbox: mergeBbox(sorted.map((s) => s.bbox)),
    startTime: sorted[0]?.startTime ?? new Date().toISOString(),
    endTime: sorted.length
      ? sorted[sorted.length - 1].endTime ?? sorted[sorted.length - 1].startTime
      : null,
    methodology: {
      movingTime,
      idleTime,
      gapTime,
      speedP50: avg(m.map((x) => x.speedP50)),
      speedStdDev: avg(m.map((x) => x.speedStdDev)),
      // Распределение по бакетам §5.3 (v2.31.0: 6 бакетов 0-20…100+) —
      // ВЗВЕШЕННОЕ среднее гистограмм.
      // v2.29.0 (MI-11 кодревью): раньше проценты сессий складывались как равные
      // (2 сессии → до 200%; короткая поездка весила как длинная). Теперь вес =
      // активная длительность записи (гистограммы — доли активных точек);
      // fallback на pointCount, у пустых — 1.
      speedDistribution: (() => {
        const pairs = sorted
          .map((s) => {
            const d = s.methodology?.speedDistribution;
            if (!Array.isArray(d) || d.length === 0) return null;
            const w = s.methodology?.activeTrip?.activeDuration ?? s.pointCount ?? 1;
            return { d, w: Math.max(1, w) };
          })
          .filter((p): p is { d: number[]; w: number } => p != null);
        if (!pairs.length) return [];
        const len = Math.max(...pairs.map((p) => p.d.length));
        const wSum = sum(pairs.map((p) => p.w));
        return Array.from({ length: len }, (_, i) =>
          Math.round((sum(pairs.map((p) => (p.d[i] ?? 0) * p.w)) / wSum) * 10) / 10
        );
      })(),
      timeInTraffic: sum(m.map((x) => x.timeInTraffic)),
      timeAtCruise: sum(m.map((x) => x.timeAtCruise)),
      speedVariation: avg(m.map((x) => x.speedVariation)) ?? 0,
      harshBrakingCount: sum(m.map((x) => x.harshBrakingCount)),
      harshAccelCount: sum(m.map((x) => x.harshAccelCount)),
      ecoScore: {
        value: ecoScoreValue,
        // Частоты событий на час за весь период (§7.3).
        brakingRate: hours > 0 ? sum(m.map((x) => x.harshBrakingCount)) / hours : 0,
        accelRate: hours > 0 ? sum(m.map((x) => x.harshAccelCount)) / hours : 0,
        jerkRate: hours > 0 ? avg(m.map((x) => x.jerkRms)) ?? 0 : 0,
        rating,
        baselineVersion: "период-агрегат",
        breakdown: {
          brakingPenalty: avg(m.map((x) => x.ecoScore?.breakdown?.brakingPenalty ?? null)) ?? 0,
          accelPenalty: avg(m.map((x) => x.ecoScore?.breakdown?.accelPenalty ?? null)) ?? 0,
          jerkPenalty: avg(m.map((x) => x.ecoScore?.breakdown?.jerkPenalty ?? null)) ?? 0,
        },
      },
      accelerationRms: wavg(
        m.map((x) => ({ v: x.accelerationRms, w: x.movingTime ?? 0 })) as Array<{ v: number | null; w: number }>
      ),
      jerkRms: wavg(
        m.map((x) => ({ v: x.jerkRms, w: x.movingTime ?? 0 })) as Array<{ v: number | null; w: number }>
      ),
      speedConsistencyIndex: avg(m.map((x) => x.speedConsistencyIndex)),
      bearingConsistency: avg(m.map((x) => x.bearingConsistency)),
      uTurnCount: sum(m.map((x) => x.uTurnCount)),
      turnCount: sum(m.map((x) => x.turnCount)),
      highSpeedCornering: sum(m.map((x) => x.highSpeedCornering)),
      // v2.31.0 (MAJ-10): §8.2 — путь/прямая (см. directM выше); факт/план
      // остаётся в route.durationDeviationPct/distanceDeviationPct
      routeEfficiency: distTotal > 0 && directM > 1 ? Math.round((distTotal / directM) * 100) / 100 : null,
      avgAccuracy: avg(m.map((x) => x.avgAccuracy)),
      pointDensity: duration > 0 ? pointCount / duration : null,
      gapCount: sum(m.map((x) => x.gapCount)),
      gapTotalDurationMs: sum(m.map((x) => x.gapTotalDurationMs)),
      accuracyP90: avg(m.map((x) => x.accuracyP90)),
      completenessScore: avg(m.map((x) => x.completenessScore)) ?? 0,
      sessionReliability: {
        value: relValue,
        completenessScore: avg(m.map((x) => x.sessionReliability?.completenessScore ?? null)),
        driftScore: avg(m.map((x) => x.sessionReliability?.driftScore ?? null)),
        plausibilityScore: avg(m.map((x) => x.sessionReliability?.plausibilityScore ?? null)),
        // v2.31.0 (MIN-8): честный рейтинг надёжности периода — пороги §11.6
        // (0,85/0,6/0,3) от среднего value. Раньше сюда попадал eco-рейтинг
        // («плавно/умеренно/агрессивно») — тайл «Надёжность записи» показывал
        // стиль вождения вместо качества GPS.
        rating: relRating,
      },
      activeTrip: {
        // FIX-C1/C2: агрегат активных поездок периода (суммы по поездкам §4.11) —
        // шапка периода и KPI «в поездках» теперь показывают честное активное время
        hasActiveTrip: anyActive,
        activeStartTime: m.find((x) => x.activeTrip?.hasActiveTrip)?.activeTrip.activeStartTime ?? 0,
        activeEndTime: [...m].reverse().find((x) => x.activeTrip?.hasActiveTrip)?.activeTrip.activeEndTime ?? 0,
        activeDuration: activeDurTotal,
        activeStartCoord: m.find((x) => x.activeTrip?.hasActiveTrip)?.activeTrip.activeStartCoord ?? { lat: 0, lon: 0 },
        activeEndCoord: [...m].reverse().find((x) => x.activeTrip?.hasActiveTrip)?.activeTrip.activeEndCoord ?? { lat: 0, lon: 0 },
        preTripIdle: preIdleTotal,
        postTripIdle: postIdleTotal,
        activeIdleTime: activeIdleTotal,
      },
      motion: { movingTime, idleTime, gapTime, states: [] },
    },
    route: {
      provider: routes.length ? routes[0].provider : null,
      planDistanceM,
      planDurationSec,
      trafficFetched: routes.some((r) => r.trafficFetched),
      trafficDurationSec,
      timeLostToTrafficSec,
      // v2.13.0 (Ф5): 2 знака после запятой — раньше агрегат отдавал сырой float
      // («-5,987384005838807%» в UI). Синхронно с pct() одиночной сессии.
      durationDeviationPct:
        // FIX-C2 + v2.31.0 (MAJ-4): факт = Σ активных длительностей ТОЛЬКО
        // записей с сопоставимым планом (§6.2) — популяции числителя/знаменателя
        // совпадают, записи без плана не завышают отклонение
        planDurationSec > 0 && comparableActualDurTotal > 0
          ? Math.round((comparableActualDurTotal - planDurationSec) / planDurationSec * 10000) / 100
          : null,
      distanceDeviationPct:
        // v2.31.0 (MAJ-4): числитель — дистанции только сопоставимых записей
        planDistanceM > 0 && comparableDistTotal > 0
          ? Math.round((comparableDistTotal - planDistanceM) / planDistanceM * 10000) / 100
          : null,
      speedDeviationPct: null,
      // v2.13.0 (Ф4): для честного «мин/поездку» в виджете эффективности (v2.21.0 — bullet chart)
      planTripCount,
      // v2.25.0 (П.5): были планы, но все несопоставимы → UI покажет
      // «план не сопоставим», а не «нет данных о плане»
      planComparable: planTripCount > 0 ? true : anyRouteMarkedNotComparable ? false : null,
      // v2.31.0 (MAJ-4): Σ активных длительностей записей с сопоставимым планом —
      // «факт» план-факта периода в UI (hero «Отклонение по времени», bullet
      // «Эффективность»). Только агрегат; одиночная сессия не проставляет.
      planActualDurationSec:
        comparableActualDurTotal > 0 ? Math.round(comparableActualDurTotal) : null,
    },
  };
}

// v2.13.0 (Ф2): равномерный сэмпл вместо «первые N хронологически» — раньше
// срез 3000 G-G точек описывал 16 августа при подписи «30 дней».
function sampleUniform<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items;
  const step = (items.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => items[Math.round(i * step)]);
}

const round2 = (x: number) => Math.round(x * 100) / 100;

function aggregateEvents(items: EventsResponse[]): EventsResponse {
  // Порядок входного массива уже хронологический (от вызывающего).
  // v2.19.0: ?? [] — пустая форма events-роута (<5 точек) не содержит
  // hscEvents/harshEvents-ключей вовсе; раньше flatMap клал undefined
  // в агрегат (кандидат на краш рендера карты HSC-событий периода).
  const maneuvers = sampleUniform(items.flatMap((e) => e.maneuvers ?? []), 4000);
  const ggPoints = sampleUniform(items.flatMap((e) => e.gg?.points ?? []), 3000);
  const harshEvents = sampleUniform(items.flatMap((e) => e.harshEvents ?? []), 2000);
  const hscEvents = sampleUniform(items.flatMap((e) => e.hscEvents ?? []), 2000);
  return {
    sessionId: `period:${items.length}`,
    deviceId: "aggregate",
    maneuvers,
    gg: { points: ggPoints, rings: items[0]?.gg?.rings ?? [0.2, 0.4, 0.6] },
    harshEvents,
    hscEvents,
    summary: {
      // v2.13.0 (Ф5): округление 2 знака — раньше сырой avg давал
      // «accelerationRMS 0.48666666666666664 м/с²» в шапке блока 06.
      accelerationRMS: round2(avg(items.map((e) => e.summary?.accelerationRMS ?? null)) ?? 0),
      jerkRMS: round2(avg(items.map((e) => e.summary?.jerkRMS ?? null)) ?? 0),
      harshBraking: sum(items.map((e) => e.summary?.harshBraking ?? 0)),
      harshAcceleration: sum(items.map((e) => e.summary?.harshAcceleration ?? 0)),
      maneuvers: sum(items.map((e) => e.summary?.maneuvers ?? 0)),
      hscCount: sum(items.map((e) => e.summary?.hscCount ?? 0)),
    },
  };
}

function aggregateTrack(items: TrackResponse[]): TrackResponse {
  if (!items.length) {
    return {
      sessionId: "period:0",
      deviceId: "aggregate",
      startTime: new Date().toISOString(),
      endTime: null,
      pointCount: 0,
      bounds: null,
      points: [],
      segments: [],
      gaps: [],
      harshPoints: [],
      markers: null,
      defaultLayer: "speed",
      availableLayers: ["speed"],
      legend: [],
    };
  }
  const bounds: TrackResponse["bounds"] = items.reduce(
    (acc, t) => {
      if (!t.bounds) return acc;
      const [[minLat, minLon], [maxLat, maxLon]] = t.bounds;
      if (!acc) return [[minLat, minLon], [maxLat, maxLon]] as TrackResponse["bounds"];
      return [
        [Math.min(acc[0][0], minLat), Math.min(acc[0][1], minLon)],
        [Math.max(acc[1][0], maxLat), Math.max(acc[1][1], maxLon)],
      ] as TrackResponse["bounds"];
    },
    null as TrackResponse["bounds"]
  );
  const points = items.flatMap((t) => t.points);
  const segments = items.flatMap((t) => t.segments);
  // Разрывы ссылаются на индексы points[] своей сессии — переиндексируем
  // со смещением на накопленную длину предыдущих треков (и уникальные fromIdx
  // устраняют дубль React-ключей gap-<fromIdx> при склейке).
  const gaps: TrackResponse["gaps"] = [];
  let pointOffset = 0;
  for (const t of items) {
    for (const g of t.gaps ?? []) {
      gaps.push({
        fromIdx: g.fromIdx + pointOffset,
        toIdx: g.toIdx + pointOffset,
        durationSec: g.durationSec,
      });
    }
    pointOffset += (t.points?.length ?? 0);
  }
  const harshPoints = items.flatMap((t) => t.harshPoints);
  const first = items[0];
  const last = items[items.length - 1];
  return {
    sessionId: `period:${items.length}`,
    deviceId: "aggregate",
    startTime: first.startTime,
    endTime: last.endTime,
    pointCount: sum(items.map((t) => t.pointCount)),
    bounds,
    points,
    segments,
    gaps,
    harshPoints,
    markers:
      first.markers && last.markers
        ? { start: first.markers.start, finish: last.markers.finish }
        : null,
    defaultLayer: first.defaultLayer,
    availableLayers: first.availableLayers,
    legend: first.legend,
  };
}

// usePeriodStats — агрегат всех поездок выбранного периода.
// Возвращает { data: PeriodAggregate | null, trips, isLoading, isError }.
export function usePeriodStats(period: PeriodKey) {
  const sessions = useSessions({ limit: 50 });
  // v2.26.0 (ТЗ §11): счётчик ПОЕЗДОК — из /api/trips (spanStart в периоде);
  // записи — транспортные фрагменты. Пока поездки не заведены (expand-фаза:
  // TRIP_ENABLED=false / backfill не выполнен) — честный fallback на записи.
  // v2.31.0 (MIN-9): limit 100 → 50 — тот же скоуп, что вкладка «Поездки»:
  // счётчик шапки Аналитики = числу карточек вкладки.
  const tripsQ = useTrips({ limit: 50 });
  const qc = useQueryClient();
  const list = sessions.data?.sessions ?? [];
  const inPeriod = useMemo(() => sessionsInPeriod(list, period), [list, period]);
  const ids = useMemo(() => inPeriod.map((s) => s.id), [inPeriod]);
  const idsKey = ids.join(",");
  const periodFromMs = periodStartMs(period);
  const tripsInPeriod = useMemo(() => {
    const tl = tripsQ.data?.trips ?? [];
    if (tl.length === 0) return 0; // поездки не заведены — fallback ниже
    return tl.filter((t) => {
      const ts = new Date(t.spanStart).getTime();
      const te = t.spanEnd != null ? new Date(t.spanEnd).getTime() : null;
      // v2.31.0 (MIN-15а): поездка, начавшаяся до периода и продолжающаяся
      // в нём, тоже входит — пересечение [spanStart, spanEnd] с [from, ∞),
      // а не только spanStart ≥ from (раньше «вчера→сегодня» не считалась)
      return (
        Number.isFinite(ts) &&
        (ts >= periodFromMs || (te != null && Number.isFinite(te) && te >= periodFromMs))
      );
    }).length;
  }, [tripsQ.data, periodFromMs]);
  const tripsCount = tripsInPeriod > 0 || (tripsQ.data?.trips?.length ?? 0) > 0 ? tripsInPeriod : inPeriod.length;

  const agg = useQuery<PeriodAggregate | null>({
    queryKey: ["v4", "period-aggregate", period, idsKey],
    queryFn: async () => {
      if (!ids.length) return null;
      const capped = ids.slice(0, MAX_PERIOD_SESSIONS);
      // v2.17.0 (батч-статс): статы периода — ОДНИМ запросом /api/stats/batch
      // вместо ≤30 параллельных /api/sessions/[id]/stats (самая тяжёлая нога
      // период-агрегата: полный конвейер + спидограмма по каждой сессии).
      // v2.17.2: через qc.fetchQuery с тем же ключом ["stats-batch", idsKey],
      // что лейаут-префетч и «Поездки» — параллельные потребели дедуплицируются
      // в один HTTP-запрос, результат остаётся в кэше; ответ просеивается в
      // per-session кэш (seedSessionsStatsFromBatch) — «Поездки» после
      // аналитики рендерятся мгновенно. Запрошенные, но отсутствующие в
      // ответе, добираются по одному (missing).
      const cappedKey = Array.from(new Set(capped)).sort().join(",");
      // v2.19.0: events/track периода — тоже БАТЧАМИ (/api/events/batch,
      // /api/track/batch; единый конвейер с одиночными роутами + чанки параллельно
      // + серверный TTL-кэш 30с). Раньше — 2×N поштучных запросов под семафором 6
      // (последняя оставшаяся N+1-нога период-агрегата после батч-статса v2.17.0).
      const idsQuery = capped.join(",");
      const [batch, eventsBatch, trackBatch] = await Promise.all([
        qc.fetchQuery({
          queryKey: ["stats-batch", cappedKey],
          queryFn: () => fetchSessionsStatsBatch(capped),
          staleTime: 30_000,
        }),
        api.get<{ events: EventsResponse[]; missing: string[] }>("/api/events/batch", { ids: idsQuery }),
        api.get<{ tracks: TrackResponse[]; missing: string[] }>("/api/track/batch", { ids: idsQuery }),
      ]);
      seedSessionsStatsFromBatch(qc, batch.stats);
      const fallbackIds = batch.missing;
      const fallbackStats = fallbackIds.length
        ? await Promise.all(
            fallbackIds.map((id) =>
              api.get<SessionStats>(`/api/sessions/${id}/stats`).catch(() => null)
            )
          )
        : [];
      const okStats = [
        ...batch.stats,
        ...fallbackStats.filter((s): s is SessionStats => s != null),
      ];
      const okEvents = (eventsBatch.events ?? []).filter(Boolean);
      const okTracks = (trackBatch.tracks ?? []).filter((t) => t && (t.points?.length ?? 0) > 0);
      if (!okStats.length) return null;
      const chrono = [...inPeriod.slice(0, MAX_PERIOD_SESSIONS)].sort(
        (a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime()
      );
      const rangeStart = chrono[0]?.startTime ?? new Date().toISOString();
      const rangeEnd =
        chrono[chrono.length - 1]?.endTime ?? chrono[chrono.length - 1]?.startTime ?? rangeStart;
      return {
        stats: aggregateStats(okStats, `period:${period}:${okStats.length}`),
        events: aggregateEvents(okEvents),
        track: aggregateTrack(okTracks),
        trips: tripsCount,
        sessionsCount: okStats.length,
        rangeStart,
        rangeEnd,
      };
    },
    enabled: ids.length > 0,
    staleTime: 60_000,
    retry: 1,
  });

  // v2.29.0 (MI-12 кодревью): trips пробрасывается и ВНУТРЬ data — потребители
  // (analytics-view) читают periodAgg.data.trips, а не верхнеуровневый trips;
  // раньше в data попадало значение, замороженное на момент queryFn (гонка
  // /api/trips vs /api/sessions: шапка показывала записи вместо поездок до
  // истечения staleTime агрегата). Теперь data.trips всегда = живой счётчик.
  const data = useMemo(
    () => (agg.data ? { ...agg.data, trips: tripsCount } : agg.data),
    [agg.data, tripsCount]
  );
  return {
    ...agg,
    data,
    trips: tripsCount,
    isLoading: sessions.isLoading || agg.isLoading,
    isError: sessions.isError || agg.isError,
  };
}
