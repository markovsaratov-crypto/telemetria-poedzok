"use client";

// src/components/activity-heatmap.tsx — heatmap активности по дням (как GitHub contributions).

import * as React from "react";
import { motion } from "framer-motion";
import { CalendarDays } from "lucide-react";

interface ActivityHeatmapProps {
  sessions: Array<{ startTime: string | Date; pointCount?: number }>;
  weeks?: number; // сколько недель показывать (по умолчанию 12)
}

interface DayCell {
  date: Date;
  count: number;
  points: number;
}

export function ActivityHeatmap({ sessions, weeks = 12 }: ActivityHeatmapProps) {
  const cells = React.useMemo(() => {
    const today = new Date();
    today.setHours(23, 59, 59, 999);
    const start = new Date(today);
    start.setDate(start.getDate() - (weeks * 7 - 1) - today.getDay());

    const buckets = new Map<string, { count: number; points: number }>();
    for (const s of sessions) {
      const d = new Date(s.startTime);
      const key = d.toISOString().slice(0, 10);
      const cur = buckets.get(key) || { count: 0, points: 0 };
      cur.count += 1;
      cur.points += s.pointCount || 0;
      buckets.set(key, cur);
    }

    const out: DayCell[] = [];
    const cur = new Date(start);
    cur.setHours(0, 0, 0, 0);
    for (let i = 0; i < weeks * 7; i++) {
      const key = cur.toISOString().slice(0, 10);
      const b = buckets.get(key);
      out.push({
        date: new Date(cur),
        count: b?.count || 0,
        points: b?.points || 0,
      });
      cur.setDate(cur.getDate() + 1);
    }
    return out;
  }, [sessions, weeks]);

  const maxCount = Math.max(1, ...cells.map((c) => c.count));

  // Group by week
  const weekColumns: DayCell[][] = [];
  for (let i = 0; i < cells.length; i += 7) {
    weekColumns.push(cells.slice(i, i + 7));
  }

  const monthLabels = React.useMemo(() => {
    const labels: { weekIdx: number; label: string }[] = [];
    let lastMonth = -1;
    weekColumns.forEach((week, idx) => {
      const m = week[0].date.getMonth();
      if (m !== lastMonth) {
        labels.push({ weekIdx: idx, label: monthNames[m] });
        lastMonth = m;
      }
    });
    return labels;
  }, [weekColumns]);

  const totals = cells.reduce(
    (a, c) => ({ count: a.count + c.count, points: a.points + c.points }),
    { count: 0, points: 0 }
  );

  function levelFor(count: number) {
    if (count === 0) return 0;
    const r = count / maxCount;
    if (r >= 0.75) return 4;
    if (r >= 0.5) return 3;
    if (r >= 0.25) return 2;
    return 1;
  }

  const levelClasses = [
    "bg-muted/50",
    "bg-emerald-500/30",
    "bg-emerald-500/55",
    "bg-emerald-500/75",
    "bg-emerald-600",
  ];

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs">
        <span className="flex items-center gap-1.5 text-muted-foreground">
          <CalendarDays className="h-3.5 w-3.5 text-primary" />
          Активность за {weeks} недель
        </span>
        <span className="font-mono text-muted-foreground">
          {totals.count} сессий · {totals.points.toLocaleString("ru-RU")} точек
        </span>
      </div>
      <div className="overflow-x-auto scroll-telem pb-1">
        <div className="inline-flex flex-col gap-1 min-w-min">
          {/* Month labels */}
          <div className="flex gap-1 pl-6 text-[10px] text-muted-foreground h-3">
            {weekColumns.map((_, idx) => {
              const lbl = monthLabels.find((l) => l.weekIdx === idx);
              return (
                <div key={idx} className="w-3 text-center">
                  {lbl?.label}
                </div>
              );
            })}
          </div>
          <div className="flex gap-1">
            {/* Day labels */}
            <div className="flex flex-col gap-1 text-[9px] text-muted-foreground w-6 pr-1 text-right">
              <span className="h-3 leading-3">Пн</span>
              <span className="h-3 leading-3"></span>
              <span className="h-3 leading-3">Ср</span>
              <span className="h-3 leading-3"></span>
              <span className="h-3 leading-3">Пт</span>
              <span className="h-3 leading-3"></span>
              <span className="h-3 leading-3">Вс</span>
            </div>
            {/* Cells */}
            {weekColumns.map((week, wIdx) => (
              <div key={wIdx} className="flex flex-col gap-1">
                {week.map((cell, dIdx) => {
                  const lvl = levelFor(cell.count);
                  return (
                    <motion.div
                      key={dIdx}
                      initial={{ opacity: 0, scale: 0.5 }}
                      animate={{ opacity: 1, scale: 1 }}
                      transition={{ delay: (wIdx * 7 + dIdx) * 0.005, duration: 0.2 }}
                      whileHover={{ scale: 1.4 }}
                      title={`${cell.date.toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" })}: ${cell.count} сессий, ${cell.points} точек`}
                      className={`h-3 w-3 rounded-sm cursor-default transition-colors ${levelClasses[lvl]}`}
                    />
                  );
                })}
              </div>
            ))}
          </div>
          {/* Legend */}
          <div className="flex items-center justify-end gap-1.5 text-[10px] text-muted-foreground mt-1">
            <span>Меньше</span>
            {levelClasses.map((c, i) => (
              <div key={i} className={`h-3 w-3 rounded-sm ${c}`} />
            ))}
            <span>Больше</span>
          </div>
        </div>
      </div>
    </div>
  );
}

const monthNames = [
  "Янв",
  "Фев",
  "Мар",
  "Апр",
  "Май",
  "Июн",
  "Июл",
  "Авг",
  "Сен",
  "Окт",
  "Ноя",
  "Дек",
];
