"use client";

// src/components/session-stats-card.tsx — детальная статистика сессии с расширенными метриками.

import * as React from "react";
import { motion } from "framer-motion";
import {
  Route as RouteIcon,
  Clock,
  Gauge,
  TrendingUp,
  TrendingDown,
  MapPin,
  Timer,
  Coffee,
  Mountain,
} from "lucide-react";
import { useSessionStats } from "@/lib/hooks";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { fmtNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

interface SessionStatsCardProps {
  sessionId: string;
}

export function SessionStatsCard({ sessionId }: SessionStatsCardProps) {
  const { data: stats, isLoading } = useSessionStats(sessionId);

  if (isLoading) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <RouteIcon className="h-4 w-4 text-primary" />
            Детальная статистика
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full shimmer" />
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!stats) {
    return null;
  }

  const items = [
    {
      icon: <RouteIcon className="h-3.5 w-3.5" />,
      label: "Дистанция",
      value: stats.distance > 0 ? `${fmtNumber(stats.distance / 1000, 2)} км` : "—",
      sub: `${fmtNumber(stats.distance)} м`,
      color: "text-emerald-600 dark:text-emerald-400",
    },
    {
      icon: <Clock className="h-3.5 w-3.5" />,
      label: "Длительность",
      value: formatDuration(stats.duration),
      sub: "общее время",
      color: "text-teal-600 dark:text-teal-400",
    },
    {
      icon: <Timer className="h-3.5 w-3.5" />,
      label: "В движении",
      value: formatDuration(stats.movingTime),
      sub: `${Math.round((stats.movingTime / (stats.duration || 1)) * 100)}% времени`,
      color: "text-emerald-600 dark:text-emerald-400",
    },
    {
      icon: <Coffee className="h-3.5 w-3.5" />,
      label: "Стоянки",
      value: formatDuration(stats.idleTime),
      sub: `${Math.round((stats.idleTime / (stats.duration || 1)) * 100)}% времени`,
      color: "text-amber-600 dark:text-amber-400",
    },
    {
      icon: <Gauge className="h-3.5 w-3.5" />,
      label: "Ср. скорость",
      value: stats.avgSpeed != null ? `${fmtNumber(stats.avgSpeed * 3.6, 1)} км/ч` : "—",
      sub: stats.avgSpeed != null ? `${fmtNumber(stats.avgSpeed, 1)} м/с` : "нет данных",
      color: "text-teal-600 dark:text-teal-400",
    },
    {
      icon: <Gauge className="h-3.5 w-3.5" />,
      label: "Макс. скорость",
      value: stats.maxSpeed != null && stats.maxSpeed > 0 ? `${fmtNumber(stats.maxSpeed * 3.6, 1)} км/ч` : "—",
      sub: stats.maxSpeed != null ? `${fmtNumber(stats.maxSpeed, 1)} м/с` : "",
      color: "text-rose-600 dark:text-rose-400",
    },
    {
      icon: <TrendingUp className="h-3.5 w-3.5" />,
      label: "Набор высоты",
      value: stats.elevationGain > 0 ? `${fmtNumber(stats.elevationGain)} м` : "—",
      sub: "подъём",
      color: "text-emerald-600 dark:text-emerald-400",
    },
    {
      icon: <TrendingDown className="h-3.5 w-3.5" />,
      label: "Снижение",
      value: stats.elevationLoss > 0 ? `${fmtNumber(stats.elevationLoss)} м` : "—",
      sub: "спуск",
      color: "text-amber-600 dark:text-amber-400",
    },
    {
      icon: <Mountain className="h-3.5 w-3.5" />,
      label: "Ср. высота",
      value: stats.avgAltitude != null ? `${fmtNumber(stats.avgAltitude)} м` : "—",
      sub: "над уровнем моря",
      color: "text-zinc-600 dark:text-zinc-400",
    },
    {
      icon: <MapPin className="h-3.5 w-3.5" />,
      label: "BBox",
      value: stats.bbox ? `${fmtNumber((stats.bbox.maxLat - stats.bbox.minLat) * 111, 1)}×${fmtNumber((stats.bbox.maxLon - stats.bbox.minLon) * 111, 1)} км` : "—",
      sub: "площадь покрытия",
      color: "text-muted-foreground",
    },
  ];

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <RouteIcon className="h-4 w-4 text-primary" />
          Детальная статистика
        </CardTitle>
        <CardDescription className="text-xs flex flex-wrap items-center gap-2">
          <span>{stats.pointCount} точек · {fmtNumber(stats.distance / 1000, 2)} км · {formatDuration(stats.duration)}</span>
          {stats.routeHash && (
            <span className="inline-flex items-center rounded-full border bg-muted/50 px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground" title={`topology: ${stats.topologyHash ?? "—"}`}>
              {stats.routeHash}
            </span>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
          {items.map((it, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.03 }}
              className="rounded-lg border bg-card/50 p-2.5 space-y-1"
            >
              <div className="flex items-center gap-1 text-[10px] text-muted-foreground">
                <span className={it.color}>{it.icon}</span>
                <span className="truncate">{it.label}</span>
              </div>
              <div className={cn("text-sm font-semibold tabular-nums truncate", it.color)}>
                {it.value}
              </div>
              {it.sub && (
                <div className="text-[9px] text-muted-foreground truncate">
                  {it.sub}
                </div>
              )}
            </motion.div>
          ))}
        </div>

        {/* v2.9: метрики методологии (62 в 8 группах + routeId) (разделы 5, 7, 8.2, 11) */}
        {stats.methodology && <MethodologyGrid m={stats.methodology} />}
        {/* P1-7: план-фактный анализ из результата ворчера */}
        {stats.route && (stats.route.planDistanceM != null || stats.route.trafficFetched) && <PlanFactBlock r={stats.route} />}
      </CardContent>
    </Card>
  );
}

// ——— P1-6: блок метрик методологии (v2.9: 62 метрики в 8 группах + routeId) ———
interface MethodologyMetrics {
  // Группа 1
  movingTime: number;
  idleTime: number;
  gapTime: number;
  // Группа 2
  speedP50: number | null;
  speedStdDev: number | null;
  speedDistribution: number[];
  timeInTraffic: number;
  timeAtCruise: number;
  speedVariation: number;
  // Группа 4 — поведение (включая v2.9 новые)
  harshBrakingCount: number;
  harshAccelCount: number;
  ecoScore: { value: number | null; rating: string; baselineVersion: string };
  accelerationRms: number | null;
  jerkRms: number | null;
  speedConsistencyIndex: number | null;
  bearingConsistency: number | null;
  uTurnCount: number;
  turnCount: number;
  highSpeedCornering: number;
  // Группа 5
  routeEfficiency: number | null;
  avgAccuracy: number | null;
  // Группа 8
  pointDensity: number | null;
  gapCount: number;
  gapTotalDurationMs: number;
  accuracyP90: number | null;
  completenessScore: number;
  sessionReliability: { value: number | null; rating: string };
  // v2.9: служебные
  activeTrip: {
    hasActiveTrip: boolean;
    activeDuration: number;
    preTripIdle: number;
    postTripIdle: number;
    activeIdleTime: number;
  };
}

function ecoColor(v: number | null): string {
  if (v == null) return "text-muted-foreground";
  if (v >= 80) return "text-emerald-600 dark:text-emerald-400";
  if (v >= 60) return "text-amber-600 dark:text-amber-400";
  if (v >= 40) return "text-orange-600 dark:text-orange-400";
  return "text-red-600 dark:text-red-400";
}

function reliabilityColor(v: number | null): string {
  if (v == null) return "text-muted-foreground";
  if (v >= 0.85) return "text-emerald-600 dark:text-emerald-400";
  if (v >= 0.6) return "text-teal-600 dark:text-teal-400";
  if (v >= 0.3) return "text-amber-600 dark:text-amber-400";
  return "text-red-600 dark:text-red-400";
}

function MethodologyGrid({ m }: { m: MethodologyMetrics }) {
  const ecoVal = m.ecoScore?.value ?? null;
  const srelVal = m.sessionReliability?.value ?? null;
  const items = [
    // Группа 1 — базовые
    { label: "Активная поездка", value: m.activeTrip?.hasActiveTrip ? formatDuration(m.activeTrip.activeDuration) : "нет", sub: m.activeTrip?.hasActiveTrip ? `хвосты ${formatDuration(m.activeTrip.preTripIdle + m.activeTrip.postTripIdle)}` : "нет движения", color: m.activeTrip?.hasActiveTrip ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground" },
    { label: "Разрывы трека", value: String(m.gapCount), sub: m.gapTime > 0 ? `потеряно ${formatDuration(m.gapTime)}` : "нет разрывов", color: m.gapCount > 0 ? "text-amber-600 dark:text-amber-400" : "" },
    // Группа 2 — скоростной анализ (по активной части)
    { label: "Скорость P50", value: m.speedP50 != null ? `${fmtNumber(m.speedP50 * 3.6, 1)} км/ч` : "—", sub: "медиана" },
    { label: "StdDev скорости", value: m.speedStdDev != null ? `${fmtNumber(m.speedStdDev * 3.6, 1)} км/ч` : "—", sub: "разброс" },
    { label: "В пробках", value: m.timeInTraffic > 0 ? formatDuration(m.timeInTraffic) : "—", sub: "< 10 км/ч" },
    { label: "Крейсер", value: m.timeAtCruise > 0 ? formatDuration(m.timeAtCruise) : "—", sub: "> 60 км/ч" },
    { label: "Рваность", value: String(m.speedVariation), sub: "Δv > 10 км/ч/10с" },
    // Группа 4 — поведение (включая v2.9 новые)
    { label: "EcoScore (CAP)", value: ecoVal != null ? `${fmtNumber(ecoVal)}/100` : "—", sub: m.ecoScore?.rating ?? "нет данных", color: ecoColor(ecoVal) },
    { label: "Резкие торможения", value: String(m.harshBrakingCount), sub: "> 10 км/ч/с", color: m.harshBrakingCount > 0 ? "text-red-600 dark:text-red-400" : "" },
    { label: "Резкие разгоны", value: String(m.harshAccelCount), sub: "> 10 км/ч/с", color: m.harshAccelCount > 0 ? "text-red-600 dark:text-red-400" : "" },
    { label: "AccelerationRMS", value: m.accelerationRms != null ? `${fmtNumber(m.accelerationRms, 3)} м/с²` : "—", sub: "интенсивность ускорений", color: m.accelerationRms != null && m.accelerationRms > 1.5 ? "text-red-600 dark:text-red-400" : "" },
    { label: "JerkRMS", value: m.jerkRms != null ? `${fmtNumber(m.jerkRms, 3)} м/с³` : "—", sub: "резкость рывков", color: m.jerkRms != null && m.jerkRms > 0.5 ? "text-amber-600 dark:text-amber-400" : "" },
    { label: "Равномерность", value: m.speedConsistencyIndex != null ? `${fmtNumber(m.speedConsistencyIndex * 100, 0)}%` : "—", sub: "инвариант скорости", color: m.speedConsistencyIndex != null && m.speedConsistencyIndex >= 0.8 ? "text-emerald-600 dark:text-emerald-400" : "" },
    { label: "Прямолинейность", value: m.bearingConsistency != null ? `${fmtNumber(m.bearingConsistency * 100, 0)}%` : "—", sub: "по bearing" },
    { label: "Развороты", value: String(m.uTurnCount), sub: "Δbearing > 150°", color: m.uTurnCount > 0 ? "text-red-600 dark:text-red-400" : "" },
    { label: "Повороты", value: String(m.turnCount), sub: "30° < Δb ≤ 150°" },
    { label: "High-speed cornering", value: String(m.highSpeedCornering), sub: "> 60 км/ч + Δb > 45°", color: m.highSpeedCornering > 0 ? "text-red-600 dark:text-red-400" : "" },
    // Группа 5 — география
    { label: "Извилистость", value: m.routeEfficiency != null ? `${fmtNumber(m.routeEfficiency, 2)}×` : "—", sub: "факт / прямая" },
    // Группа 8 — качество данных
    { label: "Плотность точек", value: m.pointDensity != null ? `${fmtNumber(m.pointDensity, 1)}/мин` : "—", sub: "запись GPS" },
    { label: "Точность P90", value: m.accuracyP90 != null ? `${fmtNumber(m.accuracyP90, 1)} м` : "—", sub: "худшие 10%" },
    { label: "Полнота", value: `${fmtNumber(m.completenessScore * 100)}%`, sub: "запись без пропусков" },
    { label: "Ср. точность GPS", value: m.avgAccuracy != null ? `${fmtNumber(m.avgAccuracy, 1)} м` : "—", sub: "среднее по записи" },
    { label: "SessionReliability", value: srelVal != null ? `${fmtNumber(srelVal * 100, 1)}%` : "—", sub: m.sessionReliability?.rating ?? "нет данных", color: reliabilityColor(srelVal) },
  ];
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1.5">Метрики методологии</div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
        {items.map((it, i) => (
          <div key={i} className="rounded-lg border bg-card/40 p-2.5 space-y-1">
            <div className="text-[10px] text-muted-foreground truncate">{it.label}</div>
            <div className={cn("text-sm font-semibold tabular-nums truncate", it.color || "")}>{it.value}</div>
            <div className="text-[9px] text-muted-foreground truncate">{it.sub}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ——— P1-7: план-фактный блок ———
interface RoutePlanFact {
  provider: string | null;
  planDistanceM: number | null;
  planDurationSec: number | null;
  trafficFetched: boolean;
  trafficDurationSec: number | null;
  timeLostToTrafficSec: number | null;
  durationDeviationPct: number | null;
  distanceDeviationPct: number | null;
  speedDeviationPct: number | null;
}

function PlanFactBlock({ r }: { r: RoutePlanFact }) {
  const dev = (v: number | null) => (v == null ? "—" : `${v > 0 ? "+" : ""}${fmtNumber(v, 1)}%`);
  const devColor = (v: number | null) => (v == null ? "" : v > 10 ? "text-red-600 dark:text-red-400" : v > 0 ? "text-amber-600 dark:text-amber-400" : "text-emerald-600 dark:text-emerald-400");
  const items = [
    { label: "План · дистанция", value: r.planDistanceM != null ? `${fmtNumber(r.planDistanceM / 1000, 2)} км` : "—", sub: r.provider ? `провайдер: ${r.provider}` : "нет плана" },
    { label: "План · время", value: r.planDurationSec != null ? formatDuration(r.planDurationSec) : "—", sub: r.trafficDurationSec != null ? "базовая линия 40 км/ч" : "свободный поток" },
    { label: "Δ по времени", value: dev(r.durationDeviationPct), sub: "факт vs план", color: devColor(r.durationDeviationPct) },
    { label: "Δ по дистанции", value: dev(r.distanceDeviationPct), sub: "факт vs план", color: devColor(r.distanceDeviationPct) },
    { label: "Δ по скорости", value: dev(r.speedDeviationPct), sub: "факт vs план", color: devColor(r.speedDeviationPct) },
    { label: "Потери от пробок", value: r.timeLostToTrafficSec != null ? formatDuration(Math.max(r.timeLostToTrafficSec, 0)) : r.trafficFetched ? "—" : "нет данных", sub: r.trafficFetched ? "2ГИС vs базовая линия" : "трафик не запрошен" },
  ];
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1.5">План-фактный анализ</div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
        {items.map((it, i) => (
          <div key={i} className="rounded-lg border bg-card/40 p-2.5 space-y-1">
            <div className="text-[10px] text-muted-foreground truncate">{it.label}</div>
            <div className={cn("text-sm font-semibold tabular-nums truncate", it.color || "")}>{it.value}</div>
            <div className="text-[9px] text-muted-foreground truncate">{it.sub}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function formatDuration(sec: number): string {
  if (sec < 60) return `${Math.round(sec)}с`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}м`;
  const h = Math.floor(m / 60);
  return `${h}ч ${m % 60}м`;
}
