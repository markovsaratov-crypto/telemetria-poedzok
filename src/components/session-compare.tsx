"use client";

// src/components/session-compare.tsx — v2.9.7
// Сравнение до 4 поездок: каждая поездка — своя цветная полилиния на одной карте
// (MapTrack tracks-API) + сравнительная таблица метрик с подсветкой лучшего/худшего
// значения в каждой строке и Δ к первой выбранной поездке (базе сравнения).

import * as React from "react";
import dynamic from "next/dynamic";
import { motion, AnimatePresence } from "framer-motion";
import {
  GitCompare,
  X,
  Plus,
  Clock,
  Activity,
  Route as RouteIcon,
  Gauge,
  Zap,
  Crown,
  RotateCcw,
} from "lucide-react";
import { useSessions, useBatchSessions } from "@/lib/hooks";
import type { BatchSession } from "@/lib/hooks";
import type { ColoredTrack } from "@/components/map-track";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { fmtDate, fmtNumber, avgSpeed, trackDistance } from "@/lib/format";
import { cn } from "@/lib/utils";

const MapTrack = dynamic(() => import("@/components/map-track"), {
  ssr: false,
  loading: () => <div className="h-[400px] w-full rounded-lg shimmer" />,
});

const COLORS = [
  { name: "emerald", hex: "#10b981", bg: "bg-emerald-500", text: "text-emerald-600 dark:text-emerald-400", border: "border-emerald-500/40" },
  { name: "teal", hex: "#0d9488", bg: "bg-teal-500", text: "text-teal-600 dark:text-teal-400", border: "border-teal-500/40" },
  { name: "amber", hex: "#f59e0b", bg: "bg-amber-500", text: "text-amber-600 dark:text-amber-400", border: "border-amber-500/40" },
  { name: "rose", hex: "#e11d48", bg: "bg-rose-500", text: "text-rose-600 dark:text-rose-400", border: "border-rose-500/40" },
];

interface SessionMetrics {
  points: number;
  avgSpeedKmh: number | null;
  maxSpeedKmh: number | null;
  distanceKm: number;
  durationSec: number | null;
}

function computeMetrics(s: BatchSession): SessionMetrics {
  // avgSpeed() возвращает км/ч; p.speed в БД хранится в м/с (как в kpi.ts: *3.6)
  const speed = avgSpeed(s.gpsPoints.map((p) => ({ ...p, accuracy: null, bearing: null })));
  const distance = trackDistance(s.gpsPoints.map((p) => ({ lat: p.lat, lon: p.lon })));
  const duration = s.endTime
    ? (new Date(s.endTime).getTime() - new Date(s.startTime).getTime()) / 1000
    : null;
  const maxSpeed = s.gpsPoints.reduce<number | null>((acc, p) => {
    if (p.speed == null) return acc;
    return acc == null || p.speed > acc ? p.speed : acc;
  }, null);
  return {
    points: s.pointCount,
    avgSpeedKmh: speed,
    maxSpeedKmh: maxSpeed != null ? maxSpeed * 3.6 : null,
    distanceKm: distance / 1000,
    durationSec: duration,
  };
}

export function SessionCompare() {
  const [selectedIds, setSelectedIds] = React.useState<string[]>([]);
  const [pickerOpen, setPickerOpen] = React.useState(false);

  const { data: sessionsData } = useSessions({ limit: 50 });
  const allSessions = sessionsData?.sessions || [];
  const availableForPick = allSessions.filter((s) => !selectedIds.includes(s.id));

  const { data: batchData, isLoading } = useBatchSessions(selectedIds);
  const batchSessions = batchData?.sessions || [];

  function addSession(id: string) {
    if (selectedIds.length >= 4) return;
    setSelectedIds((prev) => [...prev, id]);
    setPickerOpen(false);
  }

  function removeSession(id: string) {
    setSelectedIds((prev) => prev.filter((x) => x !== id));
  }

  // v2.9.7: цветные треки — каждая поездка своей полилинией
  const tracks: ColoredTrack[] = React.useMemo(
    () =>
      batchSessions.map((s, idx) => ({
        points: s.gpsPoints.map((p) => ({ lat: p.lat, lon: p.lon })),
        color: COLORS[idx % COLORS.length].hex,
        label: s.deviceName || s.deviceId,
      })),
    [batchSessions]
  );

  const markers = React.useMemo(() => {
    const arr: Array<{
      lat: number;
      lon: number;
      label: string;
      variant: "start" | "end" | "pin";
      color?: string;
      hideIconLabel?: boolean;
    }> = [];
    batchSessions.forEach((s, idx) => {
      if (s.gpsPoints.length === 0) return;
      const color = COLORS[idx % COLORS.length].hex;
      // v2.9.7 (стайлинг-раунд 8): маркер цвета сессии, без постоянной подписи
      // (подписи перекрывались) — имя показывается в Tooltip при наведении
      arr.push({
        lat: s.gpsPoints[0].lat,
        lon: s.gpsPoints[0].lon,
        label: `${idx === 0 ? "база" : `#${idx + 1}`} · ${s.deviceName || s.deviceId} — старт`,
        variant: "start",
        color,
        hideIconLabel: true,
      });
      arr.push({
        lat: s.gpsPoints[s.gpsPoints.length - 1].lat,
        lon: s.gpsPoints[s.gpsPoints.length - 1].lon,
        label: `${idx === 0 ? "база" : `#${idx + 1}`} · ${s.deviceName || s.deviceId} — финиш`,
        variant: "end",
        color,
        hideIconLabel: true,
      });
    });
    return arr;
  }, [batchSessions]);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <GitCompare className="h-4 w-4 text-primary" />
              Сравнение поездок
            </CardTitle>
            <CardDescription className="text-xs mt-1">
              Наложите до 4 поездок на одну карту — каждая своим цветом
            </CardDescription>
          </div>
          <div className="flex items-center gap-1.5">
            {selectedIds.length > 0 && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setSelectedIds([])}
                className="gap-1.5 text-muted-foreground"
                title="Очистить выбор"
              >
                <RotateCcw className="h-3.5 w-3.5" /> Сброс
              </Button>
            )}
            <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
              <PopoverTrigger asChild>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={selectedIds.length >= 4 || availableForPick.length === 0}
                  className="gap-1.5"
                >
                  <Plus className="h-3.5 w-3.5" /> Добавить
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-80 p-0" align="end">
                <div className="border-b px-3 py-2 text-xs font-medium text-muted-foreground">
                  Выберите поездку ({selectedIds.length}/4)
                </div>
                <div className="max-h-72 overflow-y-auto scroll-telem">
                  {availableForPick.length === 0 ? (
                    <div className="p-4 text-center text-xs text-muted-foreground">
                      Нет доступных поездок
                    </div>
                  ) : (
                    availableForPick.map((s) => (
                      <button
                        key={s.id}
                        onClick={() => addSession(s.id)}
                        className="w-full text-left p-2.5 hover:bg-accent/50 transition-colors border-b last:border-b-0"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs font-medium truncate">
                            {s.deviceName || s.deviceId}
                          </span>
                          <Badge variant="outline" className="text-[9px]">
                            {fmtNumber(s.pointCount)} тчк
                          </Badge>
                        </div>
                        <div className="text-[10px] text-muted-foreground mt-0.5">
                          {fmtDate(s.startTime)}
                        </div>
                      </button>
                    ))
                  )}
                </div>
              </PopoverContent>
            </Popover>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {selectedIds.length === 0 ? (
          <div className="empty-state h-[280px] text-sm text-muted-foreground">
            <div className="text-center space-y-2">
              <GitCompare className="h-8 w-8 mx-auto opacity-30" />
              <div>Выберите поездки для сравнения</div>
              <Button size="sm" onClick={() => setPickerOpen(true)}>
                <Plus className="h-3.5 w-3.5" /> Добавить поездку
              </Button>
            </div>
          </div>
        ) : (
          <>
            {isLoading ? (
              <Skeleton className="h-[400px] w-full shimmer" />
            ) : (
              <div className="space-y-2">
                <MapTrack
                  tracks={tracks}
                  markers={markers}
                  height="400px"
                  fitToPoints
                  interactive
                />
                {/* Легенда цветов на карте */}
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 px-1">
                  {batchSessions.map((s, idx) => (
                    <span key={s.id} className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                      <span
                        className={cn("inline-block h-2 w-4 rounded-sm", idx % 2 === 1 && "[mask-image:repeating-linear-gradient(90deg,black_0_6px,transparent_6px_10px)]")}
                        style={{ backgroundColor: COLORS[idx % COLORS.length].hex }}
                      />
                      {idx === 0 ? "база" : `#${idx + 1}`} · {s.deviceName || s.deviceId}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* v2.9.7: Сравнительная таблица с Δ и подсветкой лучшего/худшего */}
            {batchSessions.length >= 2 && !isLoading && (
              <CompareTable sessions={batchSessions} />
            )}

            {/* Карточки по поездкам */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
              <AnimatePresence>
                {batchSessions.map((s, idx) => {
                  const color = COLORS[idx % COLORS.length];
                  return (
                    <motion.div
                      key={s.id}
                      initial={{ opacity: 0, scale: 0.95 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.95 }}
                      className={cn("rounded-lg border p-2.5 space-y-1.5", color.border, "bg-card")}
                    >
                      <div className="flex items-center justify-between gap-1">
                        <div className="flex items-center gap-1.5 min-w-0">
                          <span className={cn("w-2 h-2 rounded-full shrink-0", color.bg)} />
                          <span className="text-xs font-medium truncate">
                            {s.deviceName || s.deviceId}
                          </span>
                        </div>
                        <button
                          onClick={() => removeSession(s.id)}
                          className="text-muted-foreground hover:text-destructive shrink-0"
                          aria-label={`Убрать ${s.deviceName || s.deviceId} из сравнения`}
                        >
                          <X className="h-3 w-3" />
                        </button>
                      </div>
                      <CompareStats session={s} />
                    </motion.div>
                  );
                })}
              </AnimatePresence>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// === v2.9.7: таблица сравнения с Δ и подсветкой лучшего/худшего ===
function CompareTable({ sessions }: { sessions: BatchSession[] }) {
  const rows = React.useMemo(() => {
    const metrics = sessions.map(computeMetrics);
    type RowDef = {
      label: string;
      icon: React.ReactNode;
      get: (m: SessionMetrics) => number | null;
      format: (v: number) => string;
      better: "min" | "max" | null; // направление «лучшего» значения
    };
    const defs: RowDef[] = [
      {
        label: "Дистанция",
        icon: <RouteIcon className="h-3 w-3" />,
        get: (m) => (m.distanceKm > 0 ? m.distanceKm : null),
        format: (v) => `${fmtNumber(v, 2)} км`,
        better: null,
      },
      {
        label: "Длительность",
        icon: <Clock className="h-3 w-3" />,
        get: (m) => m.durationSec,
        format: (v) => formatDuration(v),
        better: "min",
      },
      {
        label: "Ср. скорость",
        icon: <Gauge className="h-3 w-3" />,
        get: (m) => m.avgSpeedKmh,
        format: (v) => `${fmtNumber(v, 1)} км/ч`,
        better: null,
      },
      {
        label: "Макс. скорость",
        icon: <Zap className="h-3 w-3" />,
        get: (m) => m.maxSpeedKmh,
        format: (v) => `${Math.round(v)} км/ч`,
        better: null,
      },
      {
        label: "Точек GPS",
        icon: <Activity className="h-3 w-3" />,
        get: (m) => m.points,
        format: (v) => fmtNumber(v),
        better: null,
      },
    ];
    return defs.map((def) => {
      const values = metrics.map(def.get);
      const valid = values.filter((v): v is number => v != null);
      let bestIdx = -1;
      let worstIdx = -1;
      if (def.better && valid.length >= 2) {
        if (def.better === "min") {
          const min = Math.min(...valid);
          const max = Math.max(...valid);
          bestIdx = values.findIndex((v) => v != null && v === min);
          if (min !== max) worstIdx = values.findIndex((v) => v != null && v === max);
        } else {
          const max = Math.max(...valid);
          const min = Math.min(...valid);
          bestIdx = values.findIndex((v) => v != null && v === max);
          if (min !== max) worstIdx = values.findIndex((v) => v != null && v === min);
        }
      }
      // Δ к базе (первой выбранной) — только если база валидна
      const base = values[0];
      const deltas = values.map((v) => (v != null && base != null && base !== 0 ? ((v - base) / base) * 100 : null));
      return { def, values, deltas, bestIdx, worstIdx };
    });
  }, [sessions]);

  return (
    <div className="rounded-lg border bg-card/60 overflow-hidden">
      <div className="overflow-x-auto scroll-telem">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b bg-muted/40">
              <th className="text-left font-medium text-muted-foreground px-3 py-2 sticky left-0 bg-muted/40 min-w-[110px]">
                Метрика
              </th>
              {sessions.map((s, idx) => (
                <th key={s.id} className="text-center font-medium px-3 py-2 min-w-[92px]">
                  <span className="inline-flex items-center gap-1.5">
                    <span
                      className="inline-block h-2 w-2 rounded-full shrink-0"
                      style={{ backgroundColor: COLORS[idx % COLORS.length].hex }}
                    />
                    <span className="truncate max-w-[110px]">{s.deviceName || s.deviceId}</span>
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(({ def, values, deltas, bestIdx, worstIdx }, ri) => (
              <tr key={def.label} className={cn("border-b last:border-b-0", ri % 2 === 1 && "bg-muted/20")}>
                <td className="px-3 py-2.5 text-muted-foreground sticky left-0 bg-inherit">
                  <span className="inline-flex items-center gap-1.5">
                    {def.icon}
                    {def.label}
                  </span>
                </td>
                {values.map((v, ci) => (
                  <td key={ci} className="px-3 py-2.5 text-center">
                    {v == null ? (
                      <span className="text-muted-foreground/50">—</span>
                    ) : (
                      <span className="inline-flex flex-col items-center gap-0.5">
                        <span
                          className={cn(
                            "font-semibold tabular-nums text-[13px]",
                            ci === bestIdx && "text-emerald-600 dark:text-emerald-400",
                            ci === worstIdx && "text-rose-600 dark:text-rose-400"
                          )}
                        >
                          {def.format(v)}
                          {ci === bestIdx && <Crown className="inline ml-1 h-3 w-3 text-emerald-500" />}
                        </span>
                        {/* Δ к базе (стайлинг-раунд 8: приглушённые пастельные тона в dark) */}
                        {ci > 0 && deltas[ci] != null && Math.abs(deltas[ci] as number) >= 0.5 ? (
                          <span
                            className={cn(
                              "text-[10px] tabular-nums",
                              (deltas[ci] as number) > 0
                                ? "text-amber-600 dark:text-amber-300/85"
                                : "text-emerald-600 dark:text-emerald-300/85"
                            )}
                          >
                            {(deltas[ci] as number) > 0 ? "+" : ""}
                            {(deltas[ci] as number).toFixed(0)}%
                          </span>
                        ) : ci > 0 ? (
                          <span className="text-[10px] text-muted-foreground/50">база</span>
                        ) : null}
                      </span>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="px-3 py-2 text-[10px] text-muted-foreground border-t bg-muted/20">
        Δ — отклонение от первой выбранной поездки (база) ·{" "}
        <span className="text-emerald-600 dark:text-emerald-400">лучшее значение</span> в строке отмечено короной · пунктирный чип в легенде = пунктирный трек на карте
      </div>
    </div>
  );
}

function CompareStats({ session }: { session: BatchSession }) {
  const m = computeMetrics(session);
  const stats = [
    { icon: <Activity className="h-3 w-3" />, label: "Точек", value: fmtNumber(m.points) },
    { icon: <Gauge className="h-3 w-3" />, label: "Ср. скор.", value: m.avgSpeedKmh != null ? `${fmtNumber(m.avgSpeedKmh, 1)} км/ч` : "—" },
    { icon: <Zap className="h-3 w-3" />, label: "Макс.", value: m.maxSpeedKmh != null ? `${Math.round(m.maxSpeedKmh)} км/ч` : "—" },
    { icon: <RouteIcon className="h-3 w-3" />, label: "Дистанция", value: m.distanceKm > 0 ? `${fmtNumber(m.distanceKm, 2)} км` : "—" },
    { icon: <Clock className="h-3 w-3" />, label: "Длит.", value: m.durationSec ? formatDuration(m.durationSec) : "—" },
  ];

  return (
    <div className="grid grid-cols-2 gap-1 text-[10px]">
      {stats.map((st, i) => (
        <div key={i} className="space-y-0.5">
          <div className="flex items-center gap-1 text-muted-foreground">
            {st.icon}
            <span className="truncate">{st.label}</span>
          </div>
          <div className="font-medium tabular-nums">{st.value}</div>
        </div>
      ))}
    </div>
  );
}

function formatDuration(sec: number): string {
  if (sec < 60) return `${Math.round(sec)}с`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}м`;
  const h = Math.floor(m / 60);
  return `${h}ч ${m % 60}м`;
}
