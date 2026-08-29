"use client";

// src/components/speed-chart.tsx — SVG-график скорости по точкам трека.
// Без recharts: лёгкий, чистый, темизированный.

import * as React from "react";
import { motion } from "framer-motion";
import { TrendingUp, Gauge } from "lucide-react";

interface SpeedChartProps {
  points: Array<{ speed?: number | null; timestamp: number }>;
  height?: number;
}

export function SpeedChart({ points, height = 120 }: SpeedChartProps) {
  const data = React.useMemo(() => {
    // v2.9.8 fix: GpsPoint.speed хранится в м/с — переводим в км/ч (раньше подпись
    // «км/ч» показывала сырые м/с: «макс: 47.1 км/ч» вместо 169.6)
    return points
      .filter((p) => p.speed != null && p.speed >= 0)
      .map((p) => ({ t: p.timestamp, v: (p.speed as number) * 3.6 }));
  }, [points]);

  if (data.length < 2) {
    return (
      <div
        className="flex items-center justify-center text-xs text-muted-foreground gap-1.5 rounded-lg bg-muted/40"
        style={{ height }}
      >
        <Gauge className="h-3.5 w-3.5 opacity-50" />
        Недостаточно данных о скорости
      </div>
    );
  }

  const width = 600;
  const padX = 8;
  const padY = 12;
  const max = Math.max(...data.map((d) => d.v), 1);
  const min = 0;
  const tMin = data[0].t;
  const tMax = data[data.length - 1].t;
  const tRange = tMax - tMin || 1;

  const xFor = (t: number) => padX + ((t - tMin) / tRange) * (width - 2 * padX);
  const yFor = (v: number) => height - padY - ((v - min) / (max - min || 1)) * (height - 2 * padY);

  // Build smooth path
  const linePath = data
    .map((d, i) => `${i === 0 ? "M" : "L"} ${xFor(d.t).toFixed(2)} ${yFor(d.v).toFixed(2)}`)
    .join(" ");
  const areaPath =
    `${linePath} L ${xFor(data[data.length - 1].t).toFixed(2)} ${height - padY} ` +
    `L ${xFor(data[0].t).toFixed(2)} ${height - padY} Z`;

  // Avg speed
  const avg = data.reduce((a, d) => a + d.v, 0) / data.length;
  const maxSpeed = max;

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs">
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <TrendingUp className="h-3 w-3 text-primary" />
          Скорость по треку
        </span>
        <span className="font-mono">
          макс: <span className="text-primary font-semibold">{maxSpeed.toFixed(1)}</span> км/ч ·
          ср: <span className="text-primary font-semibold">{avg.toFixed(1)}</span> км/ч
        </span>
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full"
        preserveAspectRatio="none"
        style={{ height }}
      >
        <defs>
          <linearGradient id="speedArea" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="oklch(0.596 0.145 162)" stopOpacity="0.35" />
            <stop offset="100%" stopColor="oklch(0.596 0.145 162)" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="speedLine" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="oklch(0.596 0.145 162)" />
            <stop offset="100%" stopColor="oklch(0.696 0.17 184)" />
          </linearGradient>
        </defs>
        {/* Grid lines */}
        {[0.25, 0.5, 0.75].map((p) => (
          <line
            key={p}
            x1={padX}
            x2={width - padX}
            y1={padY + p * (height - 2 * padY)}
            y2={padY + p * (height - 2 * padY)}
            stroke="oklch(0.7 0.01 165 / 0.2)"
            strokeWidth="0.5"
            strokeDasharray="2 3"
          />
        ))}
        <motion.path
          d={areaPath}
          fill="url(#speedArea)"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.5 }}
        />
        <motion.path
          d={linePath}
          fill="none"
          stroke="url(#speedLine)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 0.8, ease: "easeOut" }}
        />
        {/* Max marker */}
        {(() => {
          const maxIdx = data.findIndex((d) => d.v === max);
          if (maxIdx < 0) return null;
          const d = data[maxIdx];
          return (
            <motion.circle
              cx={xFor(d.t)}
              cy={yFor(d.v)}
              r="3"
              fill="oklch(0.596 0.145 162)"
              stroke="white"
              strokeWidth="1.5"
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ delay: 0.6, type: "spring" }}
            />
          );
        })()}
      </svg>
    </div>
  );
}

interface ElevationChartProps {
  points: Array<{ altitude?: number | null; timestamp: number; lat: number; lon: number }>;
  height?: number;
}

export function ElevationChart({ points, height = 100 }: ElevationChartProps) {
  const data = React.useMemo(() => {
    return points
      .filter((p) => p.altitude != null)
      .map((p) => ({ t: p.timestamp, v: p.altitude as number }));
  }, [points]);

  if (data.length < 2) {
    return (
      <div
        className="flex items-center justify-center text-xs text-muted-foreground gap-1.5 rounded-lg bg-muted/40"
        style={{ height }}
      >
        <Gauge className="h-3.5 w-3.5 opacity-50" />
        Нет данных о высоте
      </div>
    );
  }

  const width = 600;
  const padX = 8;
  const padY = 12;
  const max = Math.max(...data.map((d) => d.v));
  const min = Math.min(...data.map((d) => d.v));
  const range = max - min || 1;
  const tMin = data[0].t;
  const tMax = data[data.length - 1].t;
  const tRange = tMax - tMin || 1;

  const xFor = (t: number) => padX + ((t - tMin) / tRange) * (width - 2 * padX);
  const yFor = (v: number) => height - padY - ((v - min) / range) * (height - 2 * padY);

  const linePath = data
    .map((d, i) => `${i === 0 ? "M" : "L"} ${xFor(d.t).toFixed(2)} ${yFor(d.v).toFixed(2)}`)
    .join(" ");
  const areaPath =
    `${linePath} L ${xFor(data[data.length - 1].t).toFixed(2)} ${height - padY} ` +
    `L ${xFor(data[0].t).toFixed(2)} ${height - padY} Z`;

  const ascent = data.reduce((acc, d, i) => {
    if (i === 0) return 0;
    const diff = d.v - data[i - 1].v;
    return acc + (diff > 0 ? diff : 0);
  }, 0);
  const descent = data.reduce((acc, d, i) => {
    if (i === 0) return 0;
    const diff = d.v - data[i - 1].v;
    return acc + (diff < 0 ? -diff : 0);
  }, 0);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs">
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <TrendingUp className="h-3 w-3 text-amber-600 dark:text-amber-400" />
          Профиль высоты
        </span>
        <span className="font-mono">
          ↑ <span className="text-emerald-600 font-semibold">{ascent.toFixed(0)}</span> м ·
          ↓ <span className="text-amber-600 font-semibold">{descent.toFixed(0)}</span> м
        </span>
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full"
        preserveAspectRatio="none"
        style={{ height }}
      >
        <defs>
          <linearGradient id="elevArea" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="oklch(0.828 0.189 84)" stopOpacity="0.4" />
            <stop offset="100%" stopColor="oklch(0.828 0.189 84)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {[0.25, 0.5, 0.75].map((p) => (
          <line
            key={p}
            x1={padX}
            x2={width - padX}
            y1={padY + p * (height - 2 * padY)}
            y2={padY + p * (height - 2 * padY)}
            stroke="oklch(0.7 0.01 165 / 0.2)"
            strokeWidth="0.5"
            strokeDasharray="2 3"
          />
        ))}
        <motion.path
          d={areaPath}
          fill="url(#elevArea)"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.5 }}
        />
        <motion.path
          d={linePath}
          fill="none"
          stroke="oklch(0.828 0.189 84)"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 0.8, ease: "easeOut" }}
        />
      </svg>
    </div>
  );
}
