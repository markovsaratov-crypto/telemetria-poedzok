"use client";

// src/components/session-compare.tsx — сравнение до 4 поездок на одной карте.
// Выбор через multi-select из списка поездок.

import * as React from "react";
import dynamic from "next/dynamic";
import { motion, AnimatePresence } from "framer-motion";
import {
  GitCompare,
  X,
  Plus,
  Loader2,
  Clock,
  Activity,
  Route as RouteIcon,
  Gauge,
} from "lucide-react";
import { useSessions, useBatchSessions } from "@/lib/hooks";
import type { BatchSession } from "@/lib/hooks";
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

  // Подготовим данные для карты: каждую поездку как отдельную polyline с цветом
  // MapTrack принимает только один points[], поэтому используем markers approach
  // или рисуем через custom overlay. Для простоты — покажем все точки как один merged track
  // с маркерами start/end каждого цвета.

  const allPoints = React.useMemo(() => {
    const pts: Array<{ lat: number; lon: number }> = [];
    for (const s of batchSessions) {
      for (const p of s.gpsPoints) {
        pts.push({ lat: p.lat, lon: p.lon });
      }
    }
    return pts;
  }, [batchSessions]);

  const markers = React.useMemo(() => {
    const arr: Array<{ lat: number; lon: number; label: string; variant: "start" | "end" | "pin" }> = [];
    batchSessions.forEach((s, idx) => {
      if (s.gpsPoints.length === 0) return;
      const color = COLORS[idx % COLORS.length];
      arr.push({
        lat: s.gpsPoints[0].lat,
        lon: s.gpsPoints[0].lon,
        label: `${s.deviceName || s.deviceId} (старт)`,
        variant: "start",
      });
      arr.push({
        lat: s.gpsPoints[s.gpsPoints.length - 1].lat,
        lon: s.gpsPoints[s.gpsPoints.length - 1].lon,
        label: `${s.deviceName || s.deviceId} (финиш)`,
        variant: "end",
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
              Наложите до 4 поездок на одну карту для анализа
            </CardDescription>
          </div>
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
      </CardHeader>
      <CardContent className="space-y-3">
        {selectedIds.length === 0 ? (
          <div className="h-[280px] rounded-lg border border-dashed flex items-center justify-center text-sm text-muted-foreground">
            <div className="text-center space-y-2">
              <GitCompare className="h-8 w-8 mx-auto opacity-30" />
              <div>Выберите поездки для сравнения</div>
              <Button size="sm" variant="outline" onClick={() => setPickerOpen(true)}>
                <Plus className="h-3.5 w-3.5" /> Добавить поездку
              </Button>
            </div>
          </div>
        ) : (
          <>
            {isLoading ? (
              <Skeleton className="h-[400px] w-full shimmer" />
            ) : (
              <MapTrack
                points={allPoints}
                markers={markers}
                height="400px"
                fitToPoints
                interactive
              />
            )}

            {/* Сравнительная таблица */}
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

function CompareStats({ session }: { session: BatchSession }) {
  const speed = avgSpeed(session.gpsPoints.map((p) => ({ ...p, accuracy: null, bearing: null })));
  const distance = trackDistance(session.gpsPoints.map((p) => ({ lat: p.lat, lon: p.lon })));
  const duration = session.endTime
    ? (new Date(session.endTime).getTime() - new Date(session.startTime).getTime()) / 1000
    : null;

  const stats = [
    { icon: <Activity className="h-3 w-3" />, label: "Точек", value: fmtNumber(session.pointCount) },
    { icon: <Gauge className="h-3 w-3" />, label: "Ср. скор.", value: speed != null ? `${fmtNumber(speed, 1)} км/ч` : "—" },
    { icon: <RouteIcon className="h-3 w-3" />, label: "Дистанция", value: distance > 0 ? `${fmtNumber(distance / 1000, 2)} км` : "—" },
    { icon: <Clock className="h-3 w-3" />, label: "Длит.", value: duration ? formatDuration(duration) : "—" },
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
