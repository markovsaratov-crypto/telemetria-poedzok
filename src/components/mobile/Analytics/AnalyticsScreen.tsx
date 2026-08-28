"use client";

// src/components/mobile/Analytics/AnalyticsScreen.tsx
// ТЗ §2.5: Экран 3 — Аналитика
// Real metrics from /api/stats (aggregate) + /api/sessions/[id]/stats (per-trip detail)
// + /api/sessions/[id] for traffic (plan distance/duration).

import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { BarChart3, FileText, Clock, Gauge, Activity, Timer, AlertTriangle, TrafficCone, Route as RouteIcon, TrendingUp, MapPin } from "lucide-react";
import { useStats, useRoutes, useSessions, useSessionStats, useSession, useAggregateStats, useSpeedDistribution } from "@/lib/hooks";
import { MetricTile } from "../shared/MetricTile";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

type ViewMode = "aggregate" | "detail";

export function AnalyticsScreen({ onRouteTap }: { onRouteTap?: (id: string) => void }) {
  const [mode, setMode] = React.useState<ViewMode>("aggregate");
  const [selectedSession, setSelectedSession] = React.useState<string | null>(null);

  const { data: stats, isLoading: statsLoading } = useStats();
  const { data: sessionsData } = useSessions({ limit: 20 });
  const { data: sessionStats, isLoading: sessionStatsLoading } = useSessionStats(selectedSession);
  const { data: sessionDetail } = useSession(selectedSession);
  const { data: routesData } = useRoutes();
  const { data: aggregateStats } = useAggregateStats();
  const { data: speedDist } = useSpeedDistribution();

  const sessions = sessionsData?.sessions || [];

  // Aggregate KPIs from /api/stats
  const aggKpis = {
    duration: aggregateStats?.totalDurationSec ?? 0,
    distance: aggregateStats?.totalDistanceM ?? 0,
    avgSpeed: aggregateStats?.avgSpeedMs ?? null,
    maxSpeed: speedDist?.maxSpeedMs ?? null,
    movingTime: 0,
    idleTime: 0,
  };

  // Per-trip KPIs from /api/sessions/[id]/stats
  const tripStats = sessionStats
    ? {
        duration: sessionStats.duration || 0,
        distance: sessionStats.distance || 0,
        avgSpeed: sessionStats.avgSpeed,
        maxSpeed: sessionStats.maxSpeed,
        movingTime: sessionStats.movingTime || 0,
        idleTime: sessionStats.idleTime || 0,
      }
    : null;

  // Plan-vs-fact: extract planned distance/duration from session.traffic (TrafficJob result)
  const traffic = (sessionDetail as any)?.traffic as {
    status?: string;
    distanceM?: number;
    durationSec?: number;
    provider?: string;
    trafficFetched?: boolean;
  } | undefined;
  const plannedDistance = traffic?.distanceM ?? null;
  const plannedDuration = traffic?.durationSec ?? null;

  const currentStats = mode === "aggregate" ? aggKpis : tripStats;

  return (
    <div className="flex flex-col h-full pb-16">
      {/* Header with mode switcher */}
      <header className="sticky top-0 z-20 bg-card/95 backdrop-blur-md border-b safe-top">
        <div className="flex items-center justify-between h-14 px-4">
          <h1 className="text-[22px] font-bold">Аналитика</h1>
        </div>
        {/* Segmented control: Аналитика / Поездка */}
        <div className="flex gap-1 px-4 pb-2">
          <button
            onClick={() => setMode("aggregate")}
            className={cn(
              "flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-medium transition-colors min-h-[36px]",
              mode === "aggregate" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
            )}
          >
            <BarChart3 className="h-3.5 w-3.5" /> Аналитика
          </button>
          <button
            onClick={() => setMode("detail")}
            className={cn(
              "flex-1 flex items-center justify-center gap-1.5 py-2 rounded-lg text-xs font-medium transition-colors min-h-[36px]",
              mode === "detail" ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
            )}
          >
            <FileText className="h-3.5 w-3.5" /> Поездка
          </button>
        </div>
        {/* Session selector (detail mode only) */}
        {mode === "detail" && (
          <div className="px-4 pb-2">
            <select
              value={selectedSession || ""}
              onChange={(e) => setSelectedSession(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-card border text-sm text-foreground"
            >
              <option value="">Выберите поездку</option>
              {sessions.map((s: any) => (
                <option key={s.id} value={s.id}>
                  {s.deviceName || s.deviceId} · {new Date(s.startTime).toLocaleDateString("ru-RU", { day: "numeric", month: "short" })}
                </option>
              ))}
            </select>
          </div>
        )}
      </header>

      <div className="flex-1 overflow-y-auto scroll-telem p-4 space-y-6">
        {mode === "detail" && !selectedSession ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <FileText className="h-12 w-12 text-muted-foreground/30 mb-3" />
            <p className="text-sm text-muted-foreground">Выберите поездку для анализа</p>
          </div>
        ) : (statsLoading || sessionStatsLoading) && !currentStats ? (
          <div className="space-y-4">
            <div className="grid grid-cols-3 gap-2">
              {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="aspect-square rounded-xl shimmer" />)}
            </div>
            <Skeleton className="h-32 w-full rounded-xl shimmer" />
          </div>
        ) : currentStats ? (
          <>
            {/* === Блок 1: KPI плитки (6 шт, 3 в ряд) — REAL METRICS === */}
            <div>
              <h2 className="text-sm font-semibold mb-3 text-muted-foreground">KPI</h2>
              <div className="grid grid-cols-3 gap-2">
                <MetricTile
                  label="Длительность"
                  value={Math.round((currentStats as any).duration / 60)}
                  unit="мин"
                />
                <MetricTile
                  label="Дистанция"
                  value={((currentStats as any).distance / 1000).toFixed(1)}
                  unit="км"
                />
                <MetricTile
                  label="Ср. скорость"
                  value={(currentStats as any).avgSpeed ? ((currentStats as any).avgSpeed * 3.6).toFixed(1) : "—"}
                  unit="км/ч"
                />
                {/* REAL: Макс. скорость */}
                <MetricTile
                  label="Макс. скорость"
                  value={(currentStats as any).maxSpeed ? Math.round((currentStats as any).maxSpeed * 3.6) : "—"}
                  unit="км/ч"
                  status={
                    (currentStats as any).maxSpeed == null ? "neutral"
                    : (currentStats as any).maxSpeed * 3.6 > 110 ? "error"
                    : (currentStats as any).maxSpeed * 3.6 > 60 ? "warning"
                    : "success"
                  }
                />
                {/* REAL: В движении (movingTime) */}
                <MetricTile
                  label="В движении"
                  value={(currentStats as any).movingTime ? Math.round((currentStats as any).movingTime / 60) : "—"}
                  unit="мин"
                  status={
                    (currentStats as any).movingTime == null ? "neutral"
                    : (currentStats as any).movingTime > 600 ? "success"
                    : "neutral"
                  }
                />
                {/* REAL: Остановки (idleTime) */}
                <MetricTile
                  label="Остановки"
                  value={(currentStats as any).idleTime ? Math.round((currentStats as any).idleTime / 60) : "—"}
                  unit="мин"
                  status={
                    (currentStats as any).idleTime == null ? "neutral"
                    : (currentStats as any).idleTime > 600 ? "error"
                    : (currentStats as any).idleTime > 180 ? "warning"
                    : "success"
                  }
                />
              </div>
            </div>

            {/* === Блок 2: Скоростной профиль (horizontal bullet chart) === */}
            <SpeedProfileBlock stats={currentStats as any} speedDist={speedDist} />

            {/* === Блок 3: План-факт и поведение (2 колонки) — REAL plan-fact === */}
            <PlanFactBehaviorBlock
              stats={currentStats as any}
              plannedDistance={plannedDistance}
              plannedDuration={plannedDuration}
              trafficProvider={traffic?.provider ?? null}
            />

            {/* === Блок 4: Трафик и заторы === */}
            {traffic?.trafficFetched && <TrafficBlock stats={currentStats as any} traffic={traffic} />}

            {/* === Топ маршрутов (aggregate mode only) === */}
            {mode === "aggregate" && routesData?.routes && routesData.routes.length > 0 && (
              <div>
                <h2 className="text-sm font-semibold mb-3 text-muted-foreground">Топ маршрутов</h2>
                <div className="space-y-2">
                  {routesData.routes.slice(0, 5).map((route: any, idx: number) => (
                    <motion.button
                      key={route.id}
                      initial={{ opacity: 0, x: -8 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: idx * 0.05 }}
                      onClick={() => onRouteTap?.(route.id)}
                      className="w-full flex items-center justify-between p-3 bg-card border rounded-xl active:bg-accent/30"
                    >
                      <span className="text-sm font-medium truncate flex-1">{route.name}</span>
                      <span className="text-xs text-muted-foreground ml-2">{route._count?.sessions || 0} поездок</span>
                    </motion.button>
                  ))}
                </div>
              </div>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}

// === Блок 2: Скоростной профиль — horizontal bullet chart ===
function SpeedProfileBlock({ stats, speedDist }: { stats: any; speedDist: any }) {
  const [showDetail, setShowDetail] = React.useState(false);
  const maxSpeedMs = stats?.maxSpeed ?? speedDist?.maxSpeedMs ?? 0;
  const maxSpeedKmh = Math.round(maxSpeedMs * 3.6);
  const avgSpeedMs = stats?.avgSpeed ?? speedDist?.avgSpeedMs ?? 0;
  const avgSpeedKmh = avgSpeedMs != null ? (avgSpeedMs * 3.6).toFixed(1) : "—";

  // Horizontal bullet chart: avg speed as a thin line on a 0..max+20% bar
  const barMax = Math.max(maxSpeedKmh + 20, 60);
  const avgPct = avgSpeedMs != null ? Math.min(100, ((avgSpeedMs * 3.6) / barMax) * 100) : 0;
  const maxPct = Math.min(100, (maxSpeedKmh / barMax) * 100);

  // Distribution buckets (from server or fallback 4 buckets)
  const buckets = speedDist?.buckets?.length
    ? speedDist.buckets
    : [
        { label: "0-20", count: 0, percent: 0 },
        { label: "20-40", count: 0, percent: 0 },
        { label: "40-60", count: 0, percent: 0 },
        { label: "60+", count: 0, percent: 0 },
      ];
  const maxBucket = Math.max(...buckets.map((b: any) => b.count), 1);

  return (
    <div>
      <h2 className="text-sm font-semibold mb-3 text-muted-foreground">Скоростной профиль</h2>
      <div className="bg-card border rounded-xl p-4 space-y-3">
        {/* Horizontal bullet chart */}
        <button onClick={() => setShowDetail(!showDetail)} className="w-full">
          {/* Horizontal bars per bucket (small) */}
          <div className="space-y-1.5 mb-3">
            {buckets.map((b: any, i: number) => (
              <div key={i} className="flex items-center gap-2">
                <span className="text-[10px] text-muted-foreground w-10 text-right shrink-0">{b.label}</span>
                <div className="flex-1 h-2 bg-muted rounded-full overflow-hidden relative">
                  <div
                    className="h-full rounded-full transition-all"
                    style={{
                      width: `${(b.count / maxBucket) * 100}%`,
                      backgroundColor: i === 0 ? "oklch(0.70 0.20 350)"
                        : i === 1 ? "oklch(0.80 0.15 85)"
                        : i === 2 ? "oklch(0.70 0.17 50)"
                        : "oklch(0.65 0.18 145)",
                    }}
                  />
                </div>
                <span className="text-[9px] text-muted-foreground tabular-nums w-10 shrink-0">{b.percent}%</span>
              </div>
            ))}
          </div>

          {/* Bullet chart: avg speed vs max speed */}
          <div className="pt-2 border-t">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-[10px] text-muted-foreground">Ср. vs Макс</span>
              <span className="text-[10px] text-muted-foreground tabular-nums">{barMax} км/ч</span>
            </div>
            <div className="relative h-3 bg-muted rounded-full overflow-hidden">
              {/* max bar */}
              <div
                className="absolute inset-y-0 left-0 bg-amber-500/40 rounded-l-full"
                style={{ width: `${maxPct}%` }}
              />
              {/* avg line (bullet) */}
              <div
                className="absolute inset-y-0 w-0.5 bg-emerald-600"
                style={{ left: `${avgPct}%` }}
              />
            </div>
            <div className="flex items-center justify-between mt-1 text-[10px]">
              <span className="text-emerald-600 dark:text-emerald-400">ср {avgSpeedKmh} км/ч</span>
              <span className="text-amber-600 dark:text-amber-400">макс {maxSpeedKmh} км/ч</span>
            </div>
          </div>
        </button>

        {/* Detail (expandable) */}
        <AnimatePresence>
          {showDetail && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="overflow-hidden"
            >
              <div className="pt-3 border-t space-y-1">
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">Всего точек со скоростью:</span>
                  <span className="font-medium tabular-nums">{speedDist?.total ?? "—"}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">Макс. скорость:</span>
                  <span className="font-medium tabular-nums">{maxSpeedKmh} км/ч</span>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

// === Блок 3: План-факт и поведение — REAL plan-fact data ===
function PlanFactBehaviorBlock({
  stats,
  plannedDistance,
  plannedDuration,
  trafficProvider,
}: {
  stats: any;
  plannedDistance: number | null;
  plannedDuration: number | null;
  trafficProvider: string | null;
}) {
  // Actual distance/duration from session stats
  const factDistance = stats?.distance ?? null;
  const factDuration = stats?.duration ?? null;

  // Deviations
  const distanceDeviation =
    plannedDistance != null && factDistance != null && plannedDistance > 0
      ? ((factDistance - plannedDistance) / plannedDistance) * 100
      : null;
  const timeDeviation =
    plannedDuration != null && factDuration != null && plannedDuration > 0
      ? ((factDuration - plannedDuration) / plannedDuration) * 100
      : null;

  const leftItems = [
    {
      label: "План дистанция",
      value: plannedDistance != null ? (plannedDistance / 1000).toFixed(2) : null,
      unit: "км",
      type: "neutral" as const,
    },
    {
      label: "Факт дистанция",
      value: factDistance != null ? (factDistance / 1000).toFixed(2) : null,
      unit: "км",
      type: "neutral" as const,
    },
    {
      label: "Отклон. по времени",
      value: timeDeviation,
      unit: "%",
      type: "deviation" as const,
    },
  ];
  const rightItems = [
    {
      label: "Отклон. по дистанции",
      value: distanceDeviation,
      unit: "%",
      type: "deviation" as const,
    },
    {
      label: "В движении",
      value: stats?.movingTime ? Math.round(stats.movingTime / 60) : null,
      unit: "мин",
      type: "neutral" as const,
    },
    {
      label: "Провайдер маршрута",
      value: trafficProvider ?? null,
      unit: "",
      type: "neutral" as const,
    },
  ];

  return (
    <div>
      <h2 className="text-sm font-semibold mb-3 text-muted-foreground">План-факт и поведение</h2>
      <div className="grid grid-cols-2 gap-3">
        {/* Left column */}
        <div className="space-y-2">
          {leftItems.map((item, i) => (
            <div key={i} className={cn(
              "p-3 rounded-xl border",
              item.type === "deviation" && item.value != null
                ? Math.abs(item.value) > 15 ? "bg-[oklch(0.95_0.05_25)] dark:bg-[oklch(0.25_0.05_25)]"
                : Math.abs(item.value) > 5 ? "bg-[oklch(0.95_0.05_85)] dark:bg-[oklch(0.25_0.05_85)]"
                : "bg-[oklch(0.95_0.05_145)] dark:bg-[oklch(0.25_0.05_145)]"
                : "bg-card"
            )}>
              <div className="text-[11px] text-muted-foreground">{item.label}</div>
              <div className="text-lg font-bold tabular-nums">
                {item.value != null
                  ? `${item.value > 0 && item.type === "deviation" ? "+" : ""}${typeof item.value === "number" ? item.value.toFixed(item.type === "deviation" ? 0 : 2) : item.value}${item.unit}`
                  : "—"}
              </div>
            </div>
          ))}
        </div>
        {/* Right column */}
        <div className="space-y-2">
          {rightItems.map((item, i) => (
            <div key={i} className={cn(
              "p-3 rounded-xl border",
              item.type === "deviation" && item.value != null
                ? Math.abs(item.value) > 15 ? "bg-[oklch(0.95_0.05_25)] dark:bg-[oklch(0.25_0.05_25)]"
                : Math.abs(item.value) > 5 ? "bg-[oklch(0.95_0.05_85)] dark:bg-[oklch(0.25_0.05_85)]"
                : "bg-[oklch(0.95_0.05_145)] dark:bg-[oklch(0.25_0.05_145)]"
                : "bg-card"
            )}>
              <div className="text-[11px] text-muted-foreground">{item.label}</div>
              <div className="text-lg font-bold tabular-nums truncate">
                {item.value != null
                  ? `${item.value > 0 && item.type === "deviation" ? "+" : ""}${typeof item.value === "number" ? item.value.toFixed(item.type === "deviation" ? 0 : 2) : item.value}${item.unit}`
                  : "—"}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// === Блок 4: Трафик и заторы ===
function TrafficBlock({ stats, traffic }: { stats: any; traffic: any }) {
  const movingTime = stats?.movingTime ?? 0;
  const idleTime = stats?.idleTime ?? 0;
  const congestionPct = movingTime + idleTime > 0 ? (idleTime / (movingTime + idleTime)) * 100 : 0;
  return (
    <div>
      <h2 className="text-sm font-semibold mb-3 text-muted-foreground flex items-center gap-1.5">
        <TrafficCone className="h-4 w-4" /> Трафик и заторы
      </h2>
      <div className="bg-card border rounded-xl p-4 space-y-2">
        <div className="flex justify-between text-xs py-1 border-b border-border/40">
          <span className="text-muted-foreground">Провайдер</span>
          <span className="font-medium">{traffic?.provider || "—"}</span>
        </div>
        <div className="flex justify-between text-xs py-1 border-b border-border/40">
          <span className="text-muted-foreground">Плановая дистанция</span>
          <span className="font-medium tabular-nums">
            {traffic?.distanceM ? `${(traffic.distanceM / 1000).toFixed(2)} км` : "—"}
          </span>
        </div>
        <div className="flex justify-between text-xs py-1 border-b border-border/40">
          <span className="text-muted-foreground">Плановое время</span>
          <span className="font-medium tabular-nums">
            {traffic?.durationSec ? `${Math.round(traffic.durationSec / 60)} мин` : "—"}
          </span>
        </div>
        <div className="flex justify-between text-xs py-1">
          <span className="text-muted-foreground">Время в остановках</span>
          <span className="font-medium tabular-nums">
            {idleTime > 0 ? Math.round(idleTime / 60) : 0} мин
            <span className="text-muted-foreground ml-1">
              ({Math.round(congestionPct)}%)
            </span>
          </span>
        </div>
      </div>
    </div>
  );
}
