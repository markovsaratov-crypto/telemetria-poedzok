"use client";

// src/components/mobile/Analytics/AnalyticsScreen.tsx
// ТЗ §2.5 + ттз.docx: Экран 3 — Аналитика
// Структура: KPI tiles (6) + Скоростной профиль + План-факт/поведение + Трафик + Переключатель режимов

import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { BarChart3, FileText, ChevronDown, Clock, Gauge, Leaf, Target, Timer, AlertTriangle, TrendingUp, TrendingDown, TrafficCone } from "lucide-react";
import { useStats, useRoutes, useSessions, useSessionStats } from "@/lib/hooks";
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
  const { data: routesData } = useRoutes();

  const sessions = sessionsData?.sessions || [];
  const currentStats = mode === "aggregate" ? stats : sessionStats;

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
            {/* === Блок 1: KPI плитки (6 шт, 3 в ряд) === */}
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
                  value={(currentStats as any).avgSpeed ? Math.round((currentStats as any).avgSpeed * 3.6) : "—"}
                  unit="км/ч"
                />
                <MetricTile
                  label="EcoScore"
                  value={(currentStats as any).ecoScore ?? "—"}
                  status={
                    (currentStats as any).ecoScore >= 80 ? "success"
                    : (currentStats as any).ecoScore >= 60 ? "warning"
                    : "error"
                  }
                />
                <MetricTile
                  label="Отклонение"
                  value={(currentStats as any).deviation ? `${(currentStats as any).deviation > 0 ? "+" : ""}${(currentStats as any).deviation.toFixed(0)}%` : "—"}
                  status={
                    Math.abs((currentStats as any).deviation || 0) > 10 ? "error"
                    : Math.abs((currentStats as any).deviation || 0) > 5 ? "warning"
                    : "success"
                  }
                />
                <MetricTile
                  label="В пробках"
                  value={(currentStats as any).timeInTraffic ? Math.round((currentStats as any).timeInTraffic / 60) : "—"}
                  unit="мин"
                />
              </div>
            </div>

            {/* === Блок 2: Скоростной профиль === */}
            <SpeedProfileBlock stats={currentStats as any} />

            {/* === Блок 3: План-факт и поведение (2 колонки) === */}
            <PlanFactBehaviorBlock stats={currentStats as any} />

            {/* === Блок 4: Трафик и заторы (только если есть traffic) === */}
            {(currentStats as any).trafficFetched && <TrafficBlock stats={currentStats as any} />}

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

// === Блок 2: Скоростной профиль ===
function SpeedProfileBlock({ stats }: { stats: any }) {
  const [showDetail, setShowDetail] = React.useState(false);
  const maxSpeed = stats?.maxSpeed ? Math.round(stats.maxSpeed * 3.6) : 0;
  const avgSpeed = stats?.avgSpeed ? Math.round(stats.avgSpeed * 3.6) : 0;

  // Mini histogram (4 buckets)
  const buckets = [
    { label: "0-20", value: 30, color: "oklch(0.70 0.20 350)" },
    { label: "20-40", value: 45, color: "oklch(0.80 0.15 85)" },
    { label: "40-60", value: 20, color: "oklch(0.70 0.17 50)" },
    { label: "60+", value: 5, color: "oklch(0.65 0.18 145)" },
  ];
  const maxBucket = Math.max(...buckets.map(b => b.value));

  return (
    <div>
      <h2 className="text-sm font-semibold mb-3 text-muted-foreground">Скоростной профиль</h2>
      <div className="bg-card border rounded-xl p-4 space-y-3">
        {/* Mini histogram */}
        <button onClick={() => setShowDetail(!showDetail)} className="w-full">
          <div className="flex items-end justify-between gap-2 h-16">
            {buckets.map((b, i) => (
              <div key={i} className="flex-1 flex flex-col items-center gap-1">
                <div
                  className="w-full rounded-t-md transition-all"
                  style={{ height: `${(b.value / maxBucket) * 100}%`, backgroundColor: b.color, minHeight: "4px" }}
                />
                <span className="text-[9px] text-muted-foreground">{b.label}</span>
              </div>
            ))}
          </div>
        </button>

        {/* Stats */}
        <div className="flex items-center justify-between">
          <div>
            <div className="text-2xl font-bold tabular-nums">{avgSpeed}<span className="text-xs font-normal text-muted-foreground ml-1">км/ч</span></div>
            <div className="text-[10px] text-muted-foreground">Медианная скорость</div>
          </div>
          <div className="text-right">
            <div className="text-sm font-medium tabular-nums">{maxSpeed} км/ч</div>
            <div className="text-[10px] text-muted-foreground">Макс. скорость</div>
          </div>
        </div>

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
                  <span className="text-muted-foreground">Станд. отклонение:</span>
                  <span className="font-medium tabular-nums">{stats?.speedStdDev ? Math.round(stats.speedStdDev * 3.6) : "—"} км/ч</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">Крейсерское время:</span>
                  <span className="font-medium tabular-nums">{stats?.timeAtCruise ? Math.round(stats.timeAtCruise / 60) : "—"} мин</span>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

// === Блок 3: План-факт и поведение ===
function PlanFactBehaviorBlock({ stats }: { stats: any }) {
  const leftItems = [
    { label: "Отклон. дистанции", value: stats?.distanceDeviation, unit: "%", type: "deviation" as const },
    { label: "Отклон. скорости", value: stats?.speedDeviation, unit: "%", type: "deviation" as const },
    { label: "Потери из-за пробок", value: stats?.timeLostToTraffic ? Math.round(stats.timeLostToTraffic / 60) : null, unit: "мин", type: "neutral" as const },
  ];
  const rightItems = [
    { label: "Резкие торможения", value: stats?.harshBrakingCount ?? null, unit: "шт", type: "count" as const, threshold: 3 },
    { label: "Резкие разгоны", value: stats?.harshAccelCount ?? null, unit: "шт", type: "count" as const, threshold: 3 },
    { label: "Индекс плавности", value: stats?.speedVariation ? Math.round(100 - stats.speedVariation / 10) : null, unit: "/100", type: "score" as const },
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
                ? Math.abs(item.value) > 10 ? "bg-[oklch(0.95_0.05_25)] dark:bg-[oklch(0.25_0.05_25)]"
                : Math.abs(item.value) > 5 ? "bg-[oklch(0.95_0.05_85)] dark:bg-[oklch(0.25_0.05_85)]"
                : "bg-[oklch(0.95_0.05_145)] dark:bg-[oklch(0.25_0.05_145)]"
                : "bg-card"
            )}>
              <div className="text-[11px] text-muted-foreground">{item.label}</div>
              <div className="text-lg font-bold tabular-nums">
                {item.value != null ? `${item.value > 0 ? "+" : ""}${item.value}${item.unit}` : "—"}
              </div>
            </div>
          ))}
        </div>
        {/* Right column */}
        <div className="space-y-2">
          {rightItems.map((item, i) => (
            <div key={i} className={cn(
              "p-3 rounded-xl border",
              item.type === "count" && item.value != null && item.value > (item.threshold || 3)
                ? "bg-[oklch(0.95_0.05_25)] dark:bg-[oklch(0.25_0.05_25)]"
                : "bg-card"
            )}>
              <div className="text-[11px] text-muted-foreground">{item.label}</div>
              <div className="text-lg font-bold tabular-nums">
                {item.value != null ? `${item.value}${item.unit}` : "—"}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// === Блок 4: Трафик и заторы ===
function TrafficBlock({ stats }: { stats: any }) {
  return (
    <div>
      <h2 className="text-sm font-semibold mb-3 text-muted-foreground flex items-center gap-1.5">
        <TrafficCone className="h-4 w-4" /> Трафик и заторы
      </h2>
      <div className="bg-card border rounded-xl p-4 space-y-2">
        <div className="flex justify-between text-xs py-1 border-b border-border/40">
          <span className="text-muted-foreground">Пробочные сегменты</span>
          <span className="font-medium tabular-nums">{stats.congestedSegments || 0} из {stats.totalSegments || 0}</span>
        </div>
        <div className="flex justify-between text-xs py-1 border-b border-border/40">
          <span className="text-muted-foreground">Время в заторах</span>
          <span className="font-medium tabular-nums">
            {stats.timeInCongestion ? Math.round(stats.timeInCongestion / 60) : 0} мин
            <span className="text-muted-foreground ml-1">
              ({stats.movingTime ? Math.round((stats.timeInCongestion / stats.movingTime) * 100) : 0}%)
            </span>
          </span>
        </div>
        {stats.avgTrafficSpeed && (
          <div className="flex justify-between text-xs py-1">
            <span className="text-muted-foreground">Ср. скорость с пробками</span>
            <span className="font-medium tabular-nums">{Math.round(stats.avgTrafficSpeed)} км/ч</span>
          </div>
        )}
      </div>
    </div>
  );
}
