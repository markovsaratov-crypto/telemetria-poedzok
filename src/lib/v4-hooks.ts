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
import { useQuery } from "@tanstack/react-query";
import {
  api,
  type TrackResponse,
  type EventsResponse,
  type SessionListItem,
} from "./api-client";
import { useSessions, type SessionStats } from "./hooks";
import { type PeriodKey } from "./v4-utils";

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

const MAX_PERIOD_SESSIONS = 30;

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
  trips: number;
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

  // FIX-C1/C2: активные составляющие периода — сумма активных длительностей/хвостов
  // поездок (§4.11). Раньше агрегат avgSpeed и Δ по времени считались от полной
  // длительности записей — стоянки-хвосты занижали среднюю и завышали отклонение от плана.
  const activeDurations = m.map((x) => (x.activeTrip?.hasActiveTrip ? x.activeTrip.activeDuration : 0));
  const activeDurTotal = sum(activeDurations);
  const preIdleTotal = sum(m.map((x) => x.activeTrip?.preTripIdle ?? 0));
  const postIdleTotal = sum(m.map((x) => x.activeTrip?.postTripIdle ?? 0));
  const activeIdleTotal = sum(m.map((x) => x.activeTrip?.activeIdleTime ?? 0));
  const anyActive = activeDurations.some((d) => d > 0);

  const planDistanceM = sum(routes.map((r) => r.planDistanceM));
  const planDurationSec = sum(routes.map((r) => r.planDurationSec));
  const trafficDurationSec = sum(routes.map((r) => r.trafficDurationSec));
  const timeLostToTrafficSec = sum(routes.map((r) => r.timeLostToTrafficSec));

  const ecoScoreValue = wavg(
    m.map((x) => ({ v: x.ecoScore?.value ?? null, w: x.activeTrip?.activeDuration ?? 0 })) as Array<{ v: number | null; w: number }>
  );
  const rating =
    ecoScoreValue == null
      ? "—"
      : ecoScoreValue >= 80
        ? "отлично"
        : ecoScoreValue >= 60
          ? "неплохо"
          : "резко";

  const hours = duration / 3600;
  const distTotal = distance;
  // FIX-C1: средняя скорость периода = Σ активных дистанций / Σ активных длительностей
  // (согласовано с поездиным KPI §4.3). Fallback на полную длительность — для legacy-данных.
  const avgSpeedBase = activeDurTotal > 0 ? activeDurTotal : duration;

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
    avgSpeed: avgSpeedBase > 0 ? distance / avgSpeedBase : null,
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
      // Распределение по 6 бакетам — поэлементная сумма гистограмм.
      speedDistribution: (() => {
        const dists = m
          .map((x) => x.speedDistribution)
          .filter((d): d is number[] => Array.isArray(d) && d.length > 0);
        if (!dists.length) return [];
        const len = Math.max(...dists.map((d) => d.length));
        return Array.from({ length: len }, (_, i) => sum(dists.map((d) => d[i] ?? 0)));
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
      // Общая эффективность: факт против плана по всем поездкам с маршрутом.
      routeEfficiency: planDistanceM > 0 ? distTotal / planDistanceM : null,
      avgAccuracy: avg(m.map((x) => x.avgAccuracy)),
      pointDensity: duration > 0 ? pointCount / duration : null,
      gapCount: sum(m.map((x) => x.gapCount)),
      gapTotalDurationMs: sum(m.map((x) => x.gapTotalDurationMs)),
      accuracyP90: avg(m.map((x) => x.accuracyP90)),
      completenessScore: avg(m.map((x) => x.completenessScore)) ?? 0,
      sessionReliability: {
        value: avg(m.map((x) => x.sessionReliability?.value ?? null)),
        completenessScore: avg(m.map((x) => x.sessionReliability?.completenessScore ?? null)),
        driftScore: avg(m.map((x) => x.sessionReliability?.driftScore ?? null)),
        plausibilityScore: avg(m.map((x) => x.sessionReliability?.plausibilityScore ?? null)),
        rating: avg(m.map((x) => x.sessionReliability?.value ?? null)) != null ? rating : "н/д",
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
      durationDeviationPct:
        // FIX-C2: факт = Σ активных длительностей (§6.2), а не полные записи
        planDurationSec > 0
          ? ((activeDurTotal > 0 ? activeDurTotal : duration) - planDurationSec) / planDurationSec * 100
          : null,
      distanceDeviationPct:
        planDistanceM > 0 ? ((distance - planDistanceM) / planDistanceM) * 100 : null,
      speedDeviationPct: null,
    },
  };
}

function aggregateEvents(items: EventsResponse[]): EventsResponse {
  // Порядок входного массива уже хронологический (от вызывающего).
  const maneuvers = items.flatMap((e) => e.maneuvers).slice(0, 4000);
  const ggPoints = items.flatMap((e) => e.gg?.points ?? []).slice(0, 3000);
  const harshEvents = items.flatMap((e) => e.harshEvents).slice(0, 2000);
  const hscEvents = items.flatMap((e) => e.hscEvents).slice(0, 2000);
  return {
    sessionId: `period:${items.length}`,
    deviceId: "aggregate",
    maneuvers,
    gg: { points: ggPoints, rings: items[0]?.gg?.rings ?? [0.2, 0.4, 0.6] },
    harshEvents,
    hscEvents,
    summary: {
      accelerationRMS: avg(items.map((e) => e.summary?.accelerationRMS ?? null)) ?? 0,
      jerkRMS: avg(items.map((e) => e.summary?.jerkRMS ?? null)) ?? 0,
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
  const list = sessions.data?.sessions ?? [];
  const inPeriod = useMemo(() => sessionsInPeriod(list, period), [list, period]);
  const ids = useMemo(() => inPeriod.map((s) => s.id), [inPeriod]);
  const idsKey = ids.join(",");

  const agg = useQuery<PeriodAggregate | null>({
    queryKey: ["v4", "period-aggregate", period, idsKey],
    queryFn: async () => {
      if (!ids.length) return null;
      const capped = ids.slice(0, MAX_PERIOD_SESSIONS);
      const [statsArr, eventsArr, trackArr] = await Promise.all([
        Promise.all(capped.map((id) => api.get<SessionStats>(`/api/sessions/${id}/stats`))),
        Promise.all(capped.map((id) => api.get<EventsResponse>(`/api/sessions/${id}/events`))),
        Promise.all(capped.map((id) => api.get<TrackResponse>(`/api/sessions/${id}/track`))),
      ]);
      const okStats = statsArr.filter(Boolean);
      const okEvents = eventsArr.filter(Boolean);
      const okTracks = trackArr.filter((t) => t && (t.points?.length ?? 0) > 0);
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
        trips: okStats.length,
        rangeStart,
        rangeEnd,
      };
    },
    enabled: ids.length > 0,
    staleTime: 60_000,
    retry: 1,
  });

  return {
    ...agg,
    trips: ids.length,
    isLoading: sessions.isLoading || agg.isLoading,
    isError: sessions.isError || agg.isError,
  };
}
