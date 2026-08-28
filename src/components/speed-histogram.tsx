"use client";

// src/components/speed-histogram.tsx — horizontal bullet chart of speed distribution.

import * as React from "react";
import { motion } from "framer-motion";
import { BarChart3, Gauge } from "lucide-react";
import { computeSpeedDistribution, maxSpeedMs, meanPointSpeedMs, SPEED_BUCKETS } from "@/lib/kpi"; // P2-13

interface SpeedHistogramProps {
  points: Array<{ speed?: number | null; accuracy?: number | null }>;
  height?: number;
}

// P2-13: единая схема 6 бакетов §5.3 (раньше локальные 7: 0-10…80+)
const BUCKET_COLORS = [
  "oklch(0.596 0.145 162)",
  "oklch(0.6 0.118 184)",
  "oklch(0.7 0.13 150)",
  "oklch(0.828 0.189 84)",
  "oklch(0.769 0.188 70)",
  "oklch(0.55 0.18 40)",
];

export function SpeedHistogram({ points, height = 100 }: SpeedHistogramProps) {
  const { buckets, total, avgKmh, maxKmh } = React.useMemo(() => {
    const { buckets: dist } = computeSpeedDistribution(points);
    // Профиль по точкам: средняя и макс — через единый фильтр выбросов
    const mean = meanPointSpeedMs(points);
    const max = maxSpeedMs(points) ?? 0;
    return {
      buckets: dist.map((b) => b.count),
      total: dist.reduce((a, b) => a + b.count, 0),
      avgKmh: mean != null ? mean * 3.6 : 0,
      maxKmh: max * 3.6,
    };
  }, [points]);

  if (total === 0) {
    return (
      <div
        className="flex items-center justify-center text-xs text-muted-foreground gap-1.5 rounded-lg bg-muted/40"
        style={{ height }}
      >
        <BarChart3 className="h-3.5 w-3.5 opacity-50" />
        Недостаточно данных о скорости
      </div>
    );
  }

  const maxCount = Math.max(...buckets, 1);

  // Bullet chart: avg speed line + max speed bar across the 0..(maxKmh+20) range
  const bulletMax = Math.max(maxKmh + 20, 60);
  const avgPct = Math.min(100, (avgKmh / bulletMax) * 100);
  const maxPct = Math.min(100, (maxKmh / bulletMax) * 100);

  const dominantIdx = buckets.indexOf(maxCount);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs">
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <BarChart3 className="h-3 w-3 text-primary" />
          Распределение скоростей
        </span>
        <span className="font-mono text-muted-foreground">
          {total} точек · пик: <span className="text-primary font-semibold">{SPEED_BUCKETS[dominantIdx].label} км/ч</span>
        </span>
      </div>

      {/* Horizontal bars per bucket */}
      <div className="space-y-1">
        {SPEED_BUCKETS.map((b, i) => {
          const count = buckets[i];
          const pct = (count / maxCount) * 100;
          const sharePct = total > 0 ? (count / total) * 100 : 0;
          return (
            <div key={b.label} className="flex items-center gap-2">
              <span className="text-[9px] text-muted-foreground w-9 text-right shrink-0">{b.label}</span>
              <div className="flex-1 h-2.5 bg-muted rounded-full overflow-hidden relative">
                <motion.div
                  className="h-full rounded-full"
                  style={{ backgroundColor: BUCKET_COLORS[i] }}
                  initial={{ width: 0 }}
                  animate={{ width: `${pct}%` }}
                  transition={{ delay: i * 0.05, duration: 0.4, ease: "easeOut" }}
                />
              </div>
              <span className="text-[9px] text-muted-foreground tabular-nums w-10 shrink-0 text-right">
                {sharePct.toFixed(0)}%
              </span>
            </div>
          );
        })}
      </div>

      {/* Bullet chart: avg vs max */}
      <div className="pt-2 border-t">
        <div className="flex items-center justify-between mb-1 text-[10px] text-muted-foreground">
          <span className="flex items-center gap-1">
            <Gauge className="h-3 w-3" /> Ср. vs Макс
          </span>
          <span className="tabular-nums">{Math.round(bulletMax)} км/ч</span>
        </div>
        <div className="relative h-3 bg-muted rounded-full overflow-hidden">
          <motion.div
            className="absolute inset-y-0 left-0 bg-amber-500/40 rounded-l-full"
            initial={{ width: 0 }}
            animate={{ width: `${maxPct}%` }}
            transition={{ duration: 0.5, ease: "easeOut" }}
          />
          <motion.div
            className="absolute inset-y-0 w-0.5 bg-emerald-600"
            initial={{ left: 0 }}
            animate={{ left: `${avgPct}%` }}
            transition={{ duration: 0.5, ease: "easeOut", delay: 0.1 }}
          />
        </div>
        <div className="flex items-center justify-between mt-1 text-[10px]">
          <span className="text-emerald-600 dark:text-emerald-400">ср {avgKmh.toFixed(1)} км/ч</span>
          <span className="text-amber-600 dark:text-amber-400">макс {maxKmh.toFixed(1)} км/ч</span>
        </div>
      </div>
    </div>
  );
}
