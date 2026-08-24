"use client";

// src/components/weekly-stats-chart.tsx — SVG bar chart активности по дням недели.

import * as React from "react";
import { motion } from "framer-motion";
import { BarChart3 } from "lucide-react";

interface WeeklyStatsChartProps {
  perDay: { date: string; count: number; points: number }[];
}

const DAY_LABELS = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];

export function WeeklyStatsChart({ perDay }: WeeklyStatsChartProps) {
  const data = React.useMemo(() => {
    if (!perDay || perDay.length === 0) return [];
    return perDay.map((d) => {
      const date = new Date(d.date);
      return {
        ...d,
        dayLabel: DAY_LABELS[date.getDay()],
        dateLabel: date.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" }),
      };
    });
  }, [perDay]);

  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-[120px] text-xs text-muted-foreground gap-1.5">
        <BarChart3 className="h-3.5 w-3.5 opacity-50" />
        Недостаточно данных
      </div>
    );
  }

  const maxCount = Math.max(...data.map((d) => d.count), 1);
  const maxPoints = Math.max(...data.map((d) => d.points), 1);
  const totalSessions = data.reduce((a, d) => a + d.count, 0);
  const totalPoints = data.reduce((a, d) => a + d.points, 0);

  const chartW = 100;
  const chartH = 60;
  const barW = (chartW / data.length) * 0.55;
  const gap = (chartW / data.length) * 0.45;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-xs">
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <BarChart3 className="h-3 w-3 text-primary" />
          Последние 7 дней
        </span>
        <span className="font-mono text-muted-foreground">
          <span className="text-primary font-semibold">{totalSessions}</span> сессий ·
          <span className="text-primary font-semibold"> {totalPoints}</span> точек
        </span>
      </div>

      <div className="relative">
        <svg viewBox={`0 0 ${chartW} ${chartH + 10}`} className="w-full" preserveAspectRatio="none" style={{ height: 110 }}>
          <defs>
            <linearGradient id="barSessions" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="oklch(0.596 0.145 162)" stopOpacity="0.9" />
              <stop offset="100%" stopColor="oklch(0.596 0.145 162)" stopOpacity="0.4" />
            </linearGradient>
            <linearGradient id="barPoints" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="oklch(0.696 0.17 184)" stopOpacity="0.5" />
              <stop offset="100%" stopColor="oklch(0.696 0.17 184)" stopOpacity="0.2" />
            </linearGradient>
          </defs>
          {/* Grid lines */}
          {[0.25, 0.5, 0.75].map((p) => (
            <line
              key={p}
              x1="0"
              x2={chartW}
              y1={p * chartH}
              y2={p * chartH}
              stroke="oklch(0.7 0.01 165 / 0.15)"
              strokeWidth="0.3"
              strokeDasharray="1 2"
            />
          ))}
          {/* Bars */}
          {data.map((d, i) => {
            const x = i * (barW + gap) + gap / 2;
            const sessH = (d.count / maxCount) * chartH;
            const ptsH = (d.points / maxPoints) * chartH;
            const sessY = chartH - sessH;
            const ptsY = chartH - ptsH;
            return (
              <g key={i}>
                {/* Points bar (background, teal) */}
                <motion.rect
                  x={x}
                  y={ptsY}
                  width={barW}
                  height={ptsH}
                  fill="url(#barPoints)"
                  rx="0.5"
                  initial={{ height: 0, y: chartH }}
                  animate={{ height: ptsH, y: ptsY }}
                  transition={{ delay: i * 0.05, duration: 0.4, ease: "easeOut" }}
                />
                {/* Sessions bar (foreground, emerald) */}
                <motion.rect
                  x={x}
                  y={sessY}
                  width={barW}
                  height={sessH}
                  fill="url(#barSessions)"
                  rx="0.5"
                  initial={{ height: 0, y: chartH }}
                  animate={{ height: sessH, y: sessY }}
                  transition={{ delay: i * 0.05 + 0.1, duration: 0.4, ease: "easeOut" }}
                />
              </g>
            );
          })}
        </svg>
        {/* Day labels */}
        <div className="flex justify-between mt-1 px-1">
          {data.map((d, i) => (
            <div key={i} className="text-center">
              <div className="text-[9px] font-medium text-muted-foreground">{d.dayLabel}</div>
              <div className="text-[8px] text-muted-foreground/70">{d.dateLabel}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Legend */}
      <div className="flex items-center justify-end gap-3 text-[10px]">
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-sm bg-emerald-500" /> Сессии
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-sm bg-teal-500/50" /> Точки
        </span>
      </div>
    </div>
  );
}
