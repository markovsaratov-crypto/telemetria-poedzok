"use client";

// src/components/mobile/Analytics/AnalyticsScreen.tsx
// ТЗ §2.5: Экран 3 — Аналитика (агрегированная)
// Header + Filters + 6 KPI cards + Top routes

import * as React from "react";
import { motion } from "framer-motion";
import { TrendingUp, Clock, MapPin, Gauge, Leaf, Target } from "lucide-react";
import { useStats, useRoutes } from "@/lib/hooks";
import { MetricTile } from "../shared/MetricTile";
import { Skeleton } from "@/components/ui/skeleton";

interface AnalyticsScreenProps {
  onRouteTap?: (routeId: string) => void;
}

export function AnalyticsScreen({ onRouteTap }: AnalyticsScreenProps) {
  const { data: stats, isLoading } = useStats();
  const { data: routesData } = useRoutes();

  if (isLoading || !stats) {
    return (
      <div className="flex flex-col h-full pb-16">
        <header className="sticky top-0 z-20 bg-card/95 backdrop-blur-md border-b safe-top h-14 flex items-center px-4">
          <h1 className="text-[22px] font-bold">Аналитика</h1>
        </header>
        <div className="p-4 space-y-4">
          <Skeleton className="h-8 w-full shimmer" />
          <div className="grid grid-cols-3 gap-2">
            {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="aspect-square rounded-xl shimmer" />)}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full pb-16">
      {/* Header */}
      <header className="sticky top-0 z-20 bg-card/95 backdrop-blur-md border-b safe-top h-14 flex items-center justify-between px-4">
        <h1 className="text-[22px] font-bold">Аналитика</h1>
      </header>

      <div className="flex-1 overflow-y-auto scroll-telem p-4 space-y-6">
        {/* KPI cards (6, 3x2) */}
        <div>
          <h2 className="text-sm font-semibold mb-3 text-muted-foreground">KPI за период</h2>
          <div className="grid grid-cols-3 gap-2">
            <MetricTile label="Поездок" value={stats.totalSessions} />
            <MetricTile label="За рулём" value={Math.round(stats.totalPoints / 60)} unit="ч" />
            <MetricTile label="Дистанция" value={(stats.totalPoints / 100).toFixed(0)} unit="км" />
            <MetricTile label="Ср. скорость" value="—" />
            <MetricTile label="EcoScore" value="—" />
            <MetricTile label="Отклонение" value="—" />
          </div>
        </div>

        {/* Top routes */}
        {routesData?.routes && routesData.routes.length > 0 && (
          <div>
            <h2 className="text-sm font-semibold mb-3 text-muted-foreground">Топ маршрутов</h2>
            <div className="space-y-2">
              {routesData.routes.map((route: any, idx: number) => (
                <motion.button
                  key={route.id}
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: idx * 0.05 }}
                  onClick={() => onRouteTap?.(route.id)}
                  className="w-full flex items-center gap-3 p-3 bg-card border rounded-xl active:bg-accent/30 transition-colors"
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{route.name}</div>
                    <div className="text-[11px] text-muted-foreground">
                      {route._count?.sessions || 0} поездок
                    </div>
                  </div>
                  <TrendingUp className="h-4 w-4 text-muted-foreground" />
                </motion.button>
              ))}
            </div>
          </div>
        )}

        {/* Additional sections */}
        <div>
          <h2 className="text-sm font-semibold mb-3 text-muted-foreground">Сводка</h2>
          <div className="space-y-1">
            <StatRow label="Всего GPS-точек" value={stats.totalPoints.toLocaleString("ru-RU")} />
            <StatRow label="TrafficJob в очереди" value={stats.pendingJobs} />
            <StatRow label="Объём данных" value={`${(stats.totalPayloadBytes / 1024 / 1024).toFixed(1)} МБ`} />
            <StatRow label="Версия" value={stats.version || "2.6.0"} />
          </div>
        </div>
      </div>
    </div>
  );
}

function StatRow({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex justify-between text-xs py-2 border-b border-border/40">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium tabular-nums">{value}</span>
    </div>
  );
}
