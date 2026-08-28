"use client";

// src/components/speed-histogram.tsx — horizontal bullet chart of speed distribution.

import * as React from "react";
import { motion } from "framer-motion";
import { BarChart3, Gauge } from "lucide-react";

interface SpeedHistogramProps {
  points: Array<{ speed?: number | null }>;
  height?: number;
}

const BUCKETS = [
  { label: "0-10", min: 0, max: 10, color: "oklch(0.596 0.145 162)" },
  { label: "10-20", min: 10, max: 20, color: "oklch(0.6 0.118 184)" },
  { label: "20-30", min: 20, max: 30, color: "oklch(0.7 0.13 150)" },
  { label: "30-40", min: 30, max: 40, color: "oklch(0.828 0.189 84)" },
  { label: "40-60", min: 40, max: 60, color: "oklch(0.769 0.188 70)" },
  { label: "60-80", min: 60, max: 80, color: "oklch(0.645 0.246 16)" },
  { label: "80+", min: 80, max: Infinity, color: "oklch(0.55 0.18 40)" },
];

export function SpeedHistogram({ points, height = 100 }: SpeedHistogramProps) {
  const { buckets, total, avgKmh, maxKmh } = React.useMemo(() => {
    const counts = BUCKETS.map(() => 0);
    let total = 0;
    let speedSum = 0;
    let maxMs = 0;
    for (const p of points) {
      if (p.speed == null || p.speed < 0) continue;
      const kmh = p.speed * 3.6; // m/s → km/h
      speedSum += p.speed;
      if (p.speed > maxMs) maxMs = p.speed;
      for (let i = 0; i < BUCKETS.length; i++) {
        if (kmh >= BUCKETS[i].min && kmh < BUCKETS[i].max) {
          counts[i]++;
          total++;
          break;
        }
      }
    }
    const avgMs = total > 0 ? speedSum / total : 0;
    return {
      buckets: counts,
      total,
      avgKmh: avgMs * 3.6,
      maxKmh: maxMs * 3.6,
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
          {total} точек · пик: <span className="text-primary font-semibold">{BUCKETS[dominantIdx].label} км/ч</span>
        </span>
      </div>

      {/* Horizontal bars per bucket */}
      <div className="space-y-1">
        {BUCKETS.map((b, i) => {
          const count = buckets[i];
          const pct = (count / maxCount) * 100;
          const sharePct = total > 0 ? (count / total) * 100 : 0;
          return (
            <div key={i} className="flex items-center gap-2">
              <span className="text-[9px] text-muted-foreground w-9 text-right shrink-0">{b.label}</span>
              <div className="flex-1 h-2.5 bg-muted rounded-full overflow-hidden relative">
                <motion.div
                  className="h-full rounded-full"
                  style={{ backgroundColor: b.color }}
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
