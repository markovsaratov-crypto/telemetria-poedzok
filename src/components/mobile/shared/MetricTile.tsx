"use client";

// src/components/mobile/shared/MetricTile.tsx
// ТЗ §2.8: MetricTile — квадрат ~110×110pt (3 в ряд на 375px)
// Значение (24pt bold) + label (11pt muted)
// Для метрик с плановым значением — отклонение от плана в % (10pt)
// Цвет фона по статусу (зелёный/жёлтый/красный для EcoScore, отклонений)
// v2.9.4: spark — мини-спарклайн за 7 дней внизу тайла (тренд KPI)

import * as React from "react";
import { motion } from "framer-motion";
import { cn } from "@/lib/utils";

interface MetricTileProps {
  label: string;
  value: string | number | null;
  unit?: string;
  deviation?: number | null; // % отклонения от плана
  status?: "neutral" | "success" | "warning" | "error";
  onTap?: () => void;
  spark?: number[]; // v2.9.4: ряд за 7 дней — спарклайн с последней точкой
}

const STATUS_BG: Record<string, string> = {
  neutral: "bg-card",
  success: "bg-[oklch(0.95_0.05_145)] dark:bg-[oklch(0.25_0.05_145)]",
  warning: "bg-[oklch(0.95_0.05_85)] dark:bg-[oklch(0.25_0.05_85)]",
  error: "bg-[oklch(0.95_0.05_25)] dark:bg-[oklch(0.25_0.05_25)]",
};

const STATUS_TEXT: Record<string, string> = {
  neutral: "",
  success: "text-[oklch(0.45_0.15_145)]",
  warning: "text-[oklch(0.55_0.15_85)]",
  error: "text-[oklch(0.45_0.20_25)]",
};

export function MetricTile({ label, value, unit, deviation, status = "neutral", onTap, spark }: MetricTileProps) {
  const devColor = deviation != null
    ? Math.abs(deviation) <= 5 ? "text-[oklch(0.45_0.15_145)]"
    : Math.abs(deviation) <= 15 ? "text-[oklch(0.55_0.15_85)]"
    : "text-[oklch(0.45_0.20_25)]"
    : "";

  return (
    <motion.button
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      whileTap={{ scale: 0.95 }}
      onClick={onTap}
      disabled={!onTap}
      className={cn(
        "relative flex flex-col items-center justify-center rounded-xl border p-3 aspect-square",
        "min-w-[100px] min-h-[100px]",
        STATUS_BG[status],
        onTap && "cursor-pointer hover:border-primary/40"
      )}
    >
      {/* Value */}
      <div className={cn("text-3xl font-bold tabular-nums leading-none", STATUS_TEXT[status])}>
        {value ?? "—"}
        {unit && <span className="text-sm font-medium uppercase tracking-wide text-muted-foreground ml-1">{unit}</span>}
      </div>
      {/* Label — v2.9.3: uppercase-микротипографика для технического вида телеметрии */}
      <div className="text-[11px] text-muted-foreground mt-1.5 text-center leading-tight uppercase tracking-wide">
        {label}
      </div>
      {/* Deviation */}
      {deviation != null && (
        <div className={cn("text-[12px] font-medium tabular-nums mt-0.5", devColor)}>
          {deviation > 0 ? "+" : ""}{deviation.toFixed(0)}%
        </div>
      )}
      {/* v2.9.4: спарклайн за 7 дней (подпись «7 дней» на последней активной точке) */}
      {spark && spark.length >= 2 && <TileSpark data={spark} />}
    </motion.button>
  );
}

// ——— v2.9.4: мини-спарклайн 7 дней (48×16, градиентная заливка + точка «сегодня») ———
function TileSpark({ data }: { data: number[] }) {
  const W = 52;
  const H = 16;
  const max = Math.max(...data, 1);
  const x = (i: number) => (i / (data.length - 1)) * (W - 2) + 1;
  const y = (v: number) => H - 2 - (v / max) * (H - 4);
  const line = data.map((v, i) => `${i === 0 ? "M" : "L"} ${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(" ");
  const area = `${line} L ${x(data.length - 1).toFixed(1)} ${H} L ${x(0).toFixed(1)} ${H} Z`;
  const lastX = x(data.length - 1);
  const lastY = y(data[data.length - 1]);
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width={W}
      height={H}
      className="mt-1.5"
      role="img"
      aria-label="Динамика за 7 дней"
    >
      <path d={area} fill="oklch(0.55 0.18 350 / 0.12)" />
      <path d={line} fill="none" stroke="oklch(0.55 0.18 350 / 0.8)" strokeWidth="1.2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
      <circle cx={lastX} cy={lastY} r="1.8" fill="oklch(0.55 0.18 350)" />
    </svg>
  );
}
