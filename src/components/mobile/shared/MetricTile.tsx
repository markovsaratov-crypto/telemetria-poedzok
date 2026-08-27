"use client";

// src/components/mobile/shared/MetricTile.tsx
// ТЗ §2.8: MetricTile — квадрат ~110×110pt (3 в ряд на 375px)
// Значение (24pt bold) + label (11pt muted)
// Для метрик с плановым значением — отклонение от плана в % (10pt)
// Цвет фона по статусу (зелёный/жёлтый/красный для EcoScore, отклонений)

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

export function MetricTile({ label, value, unit, deviation, status = "neutral", onTap }: MetricTileProps) {
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
        {unit && <span className="text-sm font-normal text-muted-foreground ml-0.5">{unit}</span>}
      </div>
      {/* Label */}
      <div className="text-[13px] text-muted-foreground mt-1.5 text-center leading-tight">
        {label}
      </div>
      {/* Deviation */}
      {deviation != null && (
        <div className={cn("text-[12px] font-medium tabular-nums mt-0.5", devColor)}>
          {deviation > 0 ? "+" : ""}{deviation.toFixed(0)}%
        </div>
      )}
    </motion.button>
  );
}
