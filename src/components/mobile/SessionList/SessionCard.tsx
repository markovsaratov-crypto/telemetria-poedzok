"use client";

// src/components/mobile/SessionList/SessionCard.tsx
// ТЗ §2.3: Session Card (72pt, tap → экран 2)
// Строка 1: иконка-индикатор (EcoScore) + название маршрута
// Строка 2: дата, время старта → финиша, длительность
// Строка 3: дистанция · средняя скорость · отклонение от плана
// Swipe влево: действия «Экспорт GPX» / «Удалить»

import * as React from "react";
import { motion, useMotionValue, useTransform, PanInfo } from "framer-motion";
import { MapPin, Clock, Gauge, Trash2, Download, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

interface SessionCardProps {
  deviceName: string;
  startTime: string;
  endTime?: string | null;
  pointCount: number;
  distance?: number;
  avgSpeed?: number | null;
  ecoScore?: number | null;
  deviation?: number | null;
  onTap: () => void;
  onExport?: () => void;
  onDelete?: () => void;
}

export function SessionCard(props: SessionCardProps) {
  const x = useMotionValue(0);
  const [showActions, setShowActions] = React.useState(false);

  const start = new Date(props.startTime);
  const end = props.endTime ? new Date(props.endTime) : null;
  const durationMin = end ? Math.round((end.getTime() - start.getTime()) / 60000) : 0;

  const ecoColor = props.ecoScore != null
    ? props.ecoScore >= 80 ? "text-[oklch(0.45_0.15_145)]"
    : props.ecoScore >= 60 ? "text-[oklch(0.55_0.15_85)]"
    : "text-[oklch(0.45_0.20_25)]"
    : "text-muted-foreground";

  function onDragEnd(_: unknown, info: PanInfo) {
    if (info.offset.x < -60) {
      setShowActions(true);
      x.set(-140);
    } else {
      setShowActions(false);
      x.set(0);
    }
  }

  return (
    <div className="relative overflow-hidden rounded-xl">
      {/* Swipe actions */}
      <div className="absolute inset-0 flex items-center justify-end gap-2 pr-4">
        {props.onExport && (
          <button
            onClick={props.onExport}
            className="flex flex-col items-center justify-center w-16 h-full bg-[oklch(0.70_0.15_85)] text-white"
          >
            <Download className="h-5 w-5" />
            <span className="text-[10px] mt-1">GPX</span>
          </button>
        )}
        {props.onDelete && (
          <button
            onClick={props.onDelete}
            className="flex flex-col items-center justify-center w-16 h-full bg-[oklch(0.55_0.20_25)] text-white"
          >
            <Trash2 className="h-5 w-5" />
            <span className="text-[10px] mt-1">Удалить</span>
          </button>
        )}
      </div>

      {/* Card */}
      <motion.div
        drag="x"
        dragConstraints={{ left: -140, right: 0 }}
        dragElastic={0.1}
        style={{ x }}
        onDragEnd={onDragEnd}
        onClick={() => !showActions && props.onTap()}
        className="relative bg-card border rounded-xl p-4 cursor-pointer active:bg-accent/30 transition-colors"
        whileTap={{ scale: 0.98 }}
      >
        {/* Row 1: EcoScore + name */}
        <div className="flex items-center gap-2 mb-1">
          {props.ecoScore != null && (
            <span className={cn("text-xs font-bold tabular-nums", ecoColor)}>
              {props.ecoScore}
            </span>
          )}
          <span className="text-sm font-medium truncate flex-1">
            {props.deviceName}
          </span>
          <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
        </div>

        {/* Row 2: date, time, duration */}
        <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <Clock className="h-3 w-3" />
          <span>
            {start.toLocaleDateString("ru-RU", { day: "numeric", month: "short" })}
            {" · "}
            {start.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}
            {end && ` → ${end.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}`}
            {durationMin > 0 && ` · ${durationMin}м`}
          </span>
        </div>

        {/* Row 3: distance · speed · deviation */}
        <div className="flex items-center gap-3 text-[11px] text-muted-foreground mt-0.5">
          {props.distance != null && props.distance > 0 && (
            <span className="flex items-center gap-1">
              <MapPin className="h-3 w-3" />
              {(props.distance / 1000).toFixed(1)} км
            </span>
          )}
          {props.avgSpeed != null && (
            <span className="flex items-center gap-1">
              <Gauge className="h-3 w-3" />
              {Math.round(props.avgSpeed * 3.6)} км/ч
            </span>
          )}
          {props.deviation != null && (
            <span className={cn(
              "font-medium tabular-nums",
              Math.abs(props.deviation) > 10 ? "text-[oklch(0.45_0.20_25)]" : "text-[oklch(0.45_0.15_145)]"
            )}>
              {props.deviation > 0 ? "+" : ""}{props.deviation.toFixed(0)}%
            </span>
          )}
        </div>
      </motion.div>
    </div>
  );
}
