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
        <CardDescription className="text-xs">
          {stats.pointCount} точек · {fmtNumber(stats.distance / 1000, 2)} км · {formatDuration(stats.duration)}
        </CardDescription>
      </CardHeader>
      <CardContent>
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
      </CardContent>
    </Card>
  );
}

function formatDuration(sec: number): string {
  if (sec < 60) return `${Math.round(sec)}с`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}м`;
  const h = Math.floor(m / 60);
  return `${h}ч ${m % 60}м`;
}
