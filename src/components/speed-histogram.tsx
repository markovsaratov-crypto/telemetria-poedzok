"use client";

// src/components/speed-histogram.tsx — гистограмма распределения скоростей.

import * as React from "react";
import { motion } from "framer-motion";
import { BarChart3 } from "lucide-react";

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
  const buckets = React.useMemo(() => {
    const counts = BUCKETS.map(() => 0);
    let total = 0;
    for (const p of points) {
      if (p.speed == null || p.speed < 0) continue;
      const kmh = p.speed * 3.6; // m/s → km/h
      for (let i = 0; i < BUCKETS.length; i++) {
        if (kmh >= BUCKETS[i].min && kmh < BUCKETS[i].max) {
          counts[i]++;
          total++;
          break;
        }
      }
    }
    return { counts, total };
  }, [points]);

  if (buckets.total === 0) {
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

  const maxCount = Math.max(...buckets.counts, 1);
  const chartH = height - 20; // space for labels
  const barW = 100 / BUCKETS.length;

  // Find dominant bucket
  const dominantIdx = buckets.counts.indexOf(maxCount);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs">
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <BarChart3 className="h-3 w-3 text-primary" />
          Распределение скоростей
        </span>
        <span className="font-mono text-muted-foreground">
          {buckets.total} точек · пик: <span className="text-primary font-semibold">{BUCKETS[dominantIdx].label} км/ч</span>
        </span>
      </div>
      <svg
        viewBox={`0 0 100 ${height}`}
        className="w-full"
        preserveAspectRatio="none"
        style={{ height }}
      >
        {buckets.counts.map((count, i) => {
          const h = (count / maxCount) * chartH;
          const y = chartH - h;
          const x = i * barW + 1;
          const w = barW - 2;
          const pct = buckets.total > 0 ? (count / buckets.total) * 100 : 0;
          return (
            <g key={i}>
              <motion.rect
                x={x}
                y={y}
                width={w}
                height={h}
                fill={BUCKETS[i].color}
                opacity={i === dominantIdx ? 0.9 : 0.6}
                rx="0.5"
                initial={{ height: 0, y: chartH }}
                animate={{ height: h, y: y }}
                transition={{ delay: i * 0.05, duration: 0.4, ease: "easeOut" }}
              />
              {pct > 5 && (
                <text
                  x={x + w / 2}
                  y={y - 1}
                  fontSize="2.5"
                  fill="oklch(0.4 0.01 165)"
                  textAnchor="middle"
                  className="font-mono"
                >
                  {pct.toFixed(0)}%
                </text>
              )}
            </g>
          );
        })}
        {/* X-axis labels */}
        {BUCKETS.map((b, i) => (
          <text
            key={i}
            x={i * barW + barW / 2}
            y={height - 2}
            fontSize="3"
            fill="oklch(0.5 0.01 165)"
            textAnchor="middle"
            className="font-mono"
          >
            {b.label}
          </text>
        ))}
      </svg>
      <div className="flex items-center justify-between text-[9px] text-muted-foreground">
        <span>км/ч</span>
        <span>точек в диапазоне</span>
      </div>
    </div>
  );
}
