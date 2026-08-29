"use client";

// src/components/mobile/Routes/RoutesScreen.tsx
// ТЗ §2.6: Экран 4 — Маршруты (избранные + сравнение).
// v2.9.2: секция routeHash-групп с мини-картами + GPX-экспорт канонического маршрута.

import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Route as RouteIcon,
  Plus,
  Clock,
  Hash,
  Layers,
  Trophy,
  ChevronDown,
  Download,
  Loader2,
  RefreshCw,
  Navigation,
  AlertTriangle,
  TrendingDown,
  Minus,
} from "lucide-react";
import {
  useRoutes,
  useRouteGroups,
  useRouteTrend,
  useRouteHotspots,
  type RouteGroupInfo,
} from "@/lib/hooks";
import { Skeleton } from "@/components/ui/skeleton";
import { MiniMap, severityColor } from "@/components/mini-map";
import { cn } from "@/lib/utils";

interface RoutesScreenProps {
  onRouteTap?: (routeId: string) => void;
}

function fmtDur(sec: number | null | undefined): string {
  if (sec == null) return "—";
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  if (m === 0) return `${s}с`;
  return s === 0 ? `${m}м` : `${m}м ${s}с`;
}

function fmtDist(m: number | null | undefined): string {
  if (m == null) return "—";
  return m >= 1000 ? `${(m / 1000).toFixed(1)} км` : `${Math.round(m)} м`;
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("ru-RU", { day: "2-digit", month: "short" });
}

function MobileGroupCard({ group, index }: { group: RouteGroupInfo; index: number }) {
  const [expanded, setExpanded] = React.useState(false);
  const trendQ = useRouteTrend(group.routeHash);
  const hotspotsQ = useRouteHotspots(group.routeHash);
  const trend = trendQ.data;
  const hotspots = hotspotsQ.data;
  const [gpxState, setGpxState] = React.useState<"idle" | "loading" | "error">("idle");

  const downloadGpx = React.useCallback(async () => {
    setGpxState("loading");
    try {
      const res = await fetch(`/api/routes/${group.routeHash}/gpx`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `route-${group.routeHash}.gpx`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setGpxState("idle");
    } catch {
      setGpxState("error");
    }
  }, [group.routeHash]);

  const topHotspots = (hotspots?.hotspots ?? []).slice(0, 3);

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index * 0.05, 0.3) }}
      className="rounded-xl border bg-card overflow-hidden"
    >
      <button
        className="w-full flex gap-3 p-3 active:bg-accent/30 transition-colors text-left"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
      >
        {/* Мини-карта-превью */}
        <div className="w-20 shrink-0">
          <MiniMap
            points={group.polylineSample}
            height={80}
            showMarkers
            ariaLabel={`Форма маршрута группы ${group.routeHash.slice(0, 8)}`}
          />
        </div>
        {/* Инфо */}
        <div className="flex-1 min-w-0 space-y-1">
          <div className="flex items-center gap-1.5">
            <span className="inline-flex h-5 w-5 items-center justify-center rounded-md bg-primary/10 text-primary">
              <Hash className="h-3 w-3" />
            </span>
            <span className="font-mono text-[11px] font-medium truncate select-all">{group.routeHash}</span>
          </div>
          <div className="flex flex-wrap gap-1 text-[10px]">
            <span className="inline-flex items-center gap-1 rounded-md bg-muted/60 px-1.5 py-0.5">
              <Layers className="h-2.5 w-2.5 text-primary/70" />
              {group.sessionCount}
            </span>
            {group.avgActiveDurationSec != null && (
              <span className="inline-flex items-center gap-1 rounded-md bg-muted/60 px-1.5 py-0.5">
                <Clock className="h-2.5 w-2.5 text-teal-500/80" />
                {fmtDur(group.avgActiveDurationSec)}
              </span>
            )}
            {group.bestActiveDurationSec != null && (
              <span className="inline-flex items-center gap-1 rounded-md bg-emerald-500/10 px-1.5 py-0.5 text-emerald-700 dark:text-emerald-400">
                <Trophy className="h-2.5 w-2.5" />
                {fmtDur(group.bestActiveDurationSec)}
              </span>
            )}
            {group.avgDistanceM != null && (
              <span className="inline-flex items-center gap-1 rounded-md bg-muted/60 px-1.5 py-0.5">
                {fmtDist(group.avgDistanceM)}
              </span>
            )}
          </div>
          <div className="text-[9px] text-muted-foreground flex items-center gap-1">
            {fmtDate(group.firstSeen)} — {fmtDate(group.lastSeen)}
          </div>
        </div>
        <ChevronDown className={cn("h-4 w-4 text-muted-foreground shrink-0 transition-transform", expanded && "rotate-180")} />
      </button>

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden border-t bg-gradient-to-b from-muted/20 to-transparent"
          >
            <div className="p-3 space-y-3">
              {/* Канонический маршрут + GPX */}
              <div className="flex items-center justify-between gap-2">
                <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-foreground/70">
                  <Navigation className="h-3 w-3 text-primary" />
                  Канонический маршрут
                </span>
                <button
                  className="inline-flex items-center gap-1 rounded-md border bg-card px-2 py-1 text-[10px] active:bg-accent/40"
                  onClick={downloadGpx}
                  disabled={gpxState === "loading"}
                >
                  {gpxState === "loading" ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <Download className="h-3 w-3" />
                  )}
                  GPX
                </button>
              </div>
              {hotspotsQ.isLoading ? (
                <Skeleton className="h-24 w-full shimmer" />
              ) : (
                <MiniMap
                  points={hotspots?.polylineSample}
                  hotspots={(hotspots?.hotspots ?? []).map((h) => ({ a: h.a ?? null, b: h.b ?? null, p75: h.p75, segmentId: h.segmentId }))}
                  height={104}
                  ariaLabel={`Канонический маршрут группы ${group.routeHash}`}
                />
              )}
              {gpxState === "error" && (
                <p className="text-[10px] text-destructive">Ошибка выгрузки GPX</p>
              )}

              {/* Тренд Theil-Sen */}
              {trend && (
                <div className="flex items-center justify-between text-[11px]">
                  <span className="text-muted-foreground inline-flex items-center gap-1">
                    {trend.trend.rating === "improving" ? (
                      <TrendingDown className="h-3 w-3 text-emerald-500" />
                    ) : (
                      <Minus className="h-3 w-3 text-muted-foreground" />
                    )}
                    Тренд
                  </span>
                  <span className="font-medium">
                    {trend.trend.rating === "insufficient_data" ? "мало данных" : trend.trend.rating === "improving" ? "быстрее" : trend.trend.rating === "degrading" ? "медленнее" : "стабильно"}
                  </span>
                </div>
              )}

              {/* Топ-3 хотспота */}
              {topHotspots.length > 0 && (
                <div>
                  <div className="text-[10px] font-semibold text-foreground/70 inline-flex items-center gap-1 mb-1.5">
                    <AlertTriangle className="h-3 w-3 text-amber-500" />
                    Хотспоты (P75)
                  </div>
                  <div className="space-y-1">
                    {topHotspots.map((h) => (
                      <div key={h.segmentId} className="flex items-center gap-2 text-[10px]">
                        <span className="font-mono w-10">{h.segmentId}</span>
                        <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                          <div
                            className="h-full rounded-full"
                            style={{
                              width: `${Math.round(h.p75 * 100)}%`,
                              background: severityColor(h.p75),
                            }}
                          />
                        </div>
                        <span className="tabular-nums text-muted-foreground w-10 text-right">{h.p75.toFixed(2)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

export function RoutesScreen({ onRouteTap }: RoutesScreenProps) {
  const { data, isLoading } = useRoutes();
  const routes = data?.routes || [];
  const { data: groupsData, isLoading: groupsLoading, refetch, isRefetching } = useRouteGroups();
  const groups = groupsData?.groups || [];

  return (
    <div className="flex flex-col h-full pb-16">
      <header className="sticky top-0 z-20 bg-card/95 backdrop-blur-md border-b safe-top h-14 flex items-center justify-between px-4">
        <h1 className="text-[22px] font-bold">Маршруты</h1>
        <button
          className="inline-flex items-center gap-1 rounded-md border bg-card px-2.5 py-1 text-[11px] active:bg-accent/40"
          onClick={() => refetch()}
          disabled={isRefetching}
        >
          {isRefetching ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
          Обновить
        </button>
      </header>

      <div className="flex-1 overflow-y-auto scroll-telem p-4 space-y-5">
        {/* === Группы маршрутов (routeHash) — v2.9 §10 === */}
        <section>
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-sm font-semibold inline-flex items-center gap-1.5">
              <span className="inline-flex h-5 w-5 items-center justify-center rounded-md bg-primary/10 text-primary">
                <Layers className="h-3.5 w-3.5" />
              </span>
              Группы маршрутов
              <span className="text-[10px] font-normal text-muted-foreground">v2.9</span>
            </h2>
            <a
              href="/api/routes/grouped/export?format=csv"
              className="inline-flex items-center gap-1 rounded-md border bg-card px-2 py-1 text-[10px] active:bg-accent/40"
            >
              <Download className="h-3 w-3" />
              CSV
            </a>
          </div>
          <p className="text-[10px] text-muted-foreground mb-2">
            Концептуально одинаковые поездки по routeHash (§10.0) · агрегаты по ActiveDuration · Theil-Sen · P75-хотспоты
          </p>
          {groupsLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 3 }).map((_, i) => (
                <Skeleton key={i} className="h-[110px] w-full rounded-xl shimmer" />
              ))}
            </div>
          ) : groups.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-center rounded-xl border border-dashed bg-gradient-to-b from-primary/[0.04] to-transparent">
              <Layers className="h-10 w-10 text-muted-foreground/40 mb-2" />
              <p className="text-xs text-muted-foreground">Группы появятся после 2+ поездок по одному маршруту</p>
            </div>
          ) : (
            <div className="space-y-2">
              {groups.map((g, i) => (
                <MobileGroupCard key={g.routeHash} group={g} index={i} />
              ))}
            </div>
          )}
        </section>

        {/* === Избранные маршруты (админские) === */}
        <section>
          <h2 className="text-sm font-semibold mb-2 inline-flex items-center gap-1.5">
            <span className="inline-flex h-5 w-5 items-center justify-center rounded-md bg-amber-500/15 text-amber-600 dark:text-amber-400">
              <RouteIcon className="h-3.5 w-3.5" />
            </span>
            Избранные маршруты
          </h2>
          {isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 2 }).map((_, i) => (
                <Skeleton key={i} className="h-[110px] w-full rounded-xl shimmer" />
              ))}
            </div>
          ) : routes.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-center rounded-xl border border-dashed bg-gradient-to-b from-amber-500/[0.04] to-transparent">
              <RouteIcon className="h-10 w-10 text-muted-foreground/40 mb-2" />
              <p className="text-xs text-muted-foreground">Нет избранных маршрутов</p>
              <button className="mt-2 inline-flex items-center gap-1 text-xs text-primary font-medium">
                <Plus className="h-3.5 w-3.5" /> Создать маршрут
              </button>
            </div>
          ) : (
            <div className="space-y-2">
              {routes.map((route: any, idx: number) => (
                <motion.button
                  key={route.id}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: idx * 0.05 }}
                  onClick={() => onRouteTap?.(route.id)}
                  className="w-full flex gap-3 p-3 bg-card border rounded-xl active:bg-accent/30 transition-colors text-left"
                >
                  <div className="w-16 h-16 rounded-lg bg-muted/40 flex items-center justify-center shrink-0">
                    <RouteIcon className="h-6 w-6 text-muted-foreground/40" />
                  </div>
                  <div className="flex-1 min-w-0 space-y-1">
                    <div className="text-sm font-medium truncate">{route.name}</div>
                    {route.description && (
                      <div className="text-[11px] text-muted-foreground truncate">{route.description}</div>
                    )}
                    <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                      <Clock className="h-3 w-3" />
                      {route._count?.sessions || 0} поездок
                    </div>
                  </div>
                </motion.button>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
