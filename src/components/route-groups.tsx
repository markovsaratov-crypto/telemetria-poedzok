"use client";

// src/components/route-groups.tsx — v2.9 §10: группы маршрутов по routeHash.
// Показывает концептуально одинаковые поездки, сгруппированные детерминированным
// routeHash (§10.0), с агрегатами ActiveDuration (§10.1/§10.2), Theil-Sen-трендом (§10.5)
// и HotspotSegments P75 < 0.5 (§10.6).

import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Layers,
  TrendingDown,
  TrendingUp,
  Minus,
  Hash,
  Clock,
  Trophy,
  AlertTriangle,
  ChevronDown,
  Loader2,
  RefreshCw,
  Gauge,
  Route as RouteIcon,
} from "lucide-react";
import {
  useRouteGroups,
  useRouteTrend,
  useRouteHotspots,
  type RouteGroupInfo,
} from "@/lib/hooks";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

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

// === Спарклайн истории activeDuration (без библиотек — чистый SVG) ===
function DurationSparkline({ history }: { history: { date: string; activeDurationSec: number }[] }) {
  if (history.length < 2) return null;
  const w = 160;
  const h = 36;
  const durations = history.map((h2) => h2.activeDurationSec);
  const min = Math.min(...durations);
  const max = Math.max(...durations);
  const range = max - min || 1;
  const pts = history.map((hh, i) => {
    const x = (i / (history.length - 1)) * (w - 6) + 3;
    const y = h - 4 - ((hh.activeDurationSec - min) / range) * (h - 10);
    return `${x},${y}`;
  });
  const improving = history[history.length - 1].activeDurationSec <= history[0].activeDurationSec;
  return (
    <svg width={w} height={h} className="shrink-0" role="img" aria-label="История длительности поездок">
      <polyline
        points={pts.join(" ")}
        fill="none"
        stroke={improving ? "oklch(0.65 0.15 145)" : "oklch(0.62 0.19 25)"}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {history.map((hh, i) => {
        const [x, y] = pts[i].split(",").map(Number);
        return <circle key={i} cx={x} cy={y} r="2" className="fill-background" stroke="currentColor" strokeWidth="1" />;
      })}
    </svg>
  );
}

// === Индикатор тренда Theil-Sen ===
function TrendBadge({ rating, slope }: { rating: string; slope: number | null }) {
  if (rating === "insufficient_data") {
    return (
      <Badge variant="outline" className="text-[10px] gap-1">
        <Minus className="h-3 w-3" /> мало данных
      </Badge>
    );
  }
  if (rating === "improving") {
    return (
      <Badge className="text-[10px] gap-1 bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300 hover:bg-emerald-100">
        <TrendingDown className="h-3 w-3" /> быстрее {slope != null && `${slope.toFixed(1)}с/д`}
      </Badge>
    );
  }
  if (rating === "degrading") {
    return (
      <Badge className="text-[10px] gap-1 bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300 hover:bg-red-100">
        <TrendingUp className="h-3 w-3" /> медленнее {slope != null && `${slope.toFixed(1)}с/д`}
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="text-[10px] gap-1">
      <Minus className="h-3 w-3" /> стабильно
    </Badge>
  );
}

// === Расширенная детализация группы ===
function GroupDetail({ group }: { group: RouteGroupInfo }) {
  const trendQ = useRouteTrend(group.routeHash);
  const hotspotsQ = useRouteHotspots(group.routeHash);
  const trend = trendQ.data;
  const hotspots = hotspotsQ.data;

  const maxTraffic = Math.max(
    1,
    ...(trend?.history.reduce<{ [k: number]: number }>((acc, h) => {
      const hour = new Date(h.date).getHours();
      const b = Math.floor(hour / 3);
      acc[b] = (acc[b] || 0) + 1;
      return acc;
    }, {}) as unknown as number[]).map((v) => v ?? 0) ?? [1]
  );

  return (
    <div className="mt-3 space-y-4 rounded-lg border bg-muted/20 p-3">
      {/* Theil-Sen тренд + история */}
      <div>
        <div className="flex items-center justify-between gap-2 flex-wrap mb-2">
          <h4 className="text-xs font-semibold flex items-center gap-1.5">
            <Gauge className="h-3.5 w-3.5 text-primary" /> Тренд времени (Theil-Sen §10.5)
          </h4>
          {trend?.trend && <TrendBadge rating={trend.trend.rating} slope={trend.trend.slope} />}
        </div>
        {trendQ.isLoading ? (
          <Skeleton className="h-10 w-full" />
        ) : trend && trend.history.length > 0 ? (
          <div className="space-y-2">
            <div className="flex items-center gap-3">
              <DurationSparkline history={trend.history} />
              <div className="text-[11px] text-muted-foreground space-y-0.5">
                <div>
                  CI 95%: {trend.trend.ci95 ? `[${trend.trend.ci95[0].toFixed(1)}; ${trend.trend.ci95[1].toFixed(1)}] сек/день` : "—"}
                </div>
                <div>
                  Метод: {trend.trend.method === "bootstrap" ? "bootstrap" : "точный"}, пар: {trend.trend.sampleSize}
                </div>
                <div>
                  StdDev: {fmtDur(trend.stats.stdDev)} {trend.stats.stdDev != null && trend.stats.avg != null && (
                    <span className="text-muted-foreground/70">
                      ({Math.round((trend.stats.stdDev / trend.stats.avg) * 100)}% от среднего)
                    </span>
                  )}
                </div>
              </div>
            </div>
            {/* История поездок группы */}
            <div className="max-h-32 overflow-y-auto scroll-telem space-y-1 pr-1">
              {trend.history.map((h) => (
                <div key={h.sessionId} className="flex items-center justify-between text-[11px] py-0.5 border-b border-border/40">
                  <span className="text-muted-foreground">{fmtDate(h.date)} · {h.deviceId}</span>
                  <span className="font-medium tabular-nums">{fmtDur(h.activeDurationSec)}</span>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <p className="text-[11px] text-muted-foreground">Недостаточно данных для тренда</p>
        )}
      </div>

      {/* HotspotSegments */}
      <div>
        <h4 className="text-xs font-semibold flex items-center gap-1.5 mb-2">
          <AlertTriangle className="h-3.5 w-3.5 text-amber-500" /> Хронически пробочные участки (P75 &lt; 0.5, §10.6)
        </h4>
        {hotspotsQ.isLoading ? (
          <Skeleton className="h-10 w-full" />
        ) : hotspots && hotspots.hotspotCount > 0 ? (
          <div className="space-y-1.5">
            {hotspots.hotspots.slice(0, 6).map((h) => (
              <div key={h.segmentId} className="flex items-center gap-2 text-[11px]">
                <Badge variant="outline" className="font-mono text-[9px] w-14 justify-center">
                  {h.segmentId}
                </Badge>
                <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden" role="progressbar" aria-valuenow={h.p75} aria-valuemin={0} aria-valuemax={1}>
                  <div
                    className={cn(
                      "h-full rounded-full",
                      h.p75 < 0.25 ? "bg-red-500" : h.p75 < 0.4 ? "bg-amber-500" : "bg-yellow-400"
                    )}
                    style={{ width: `${Math.round(h.p75 * 100)}%` }}
                  />
                </div>
                <span className="tabular-nums text-muted-foreground w-24 text-right">
                  P75 {h.p75.toFixed(2)} · {h.congestedSessionCount}/{h.totalSessionCount} поездок
                </span>
              </div>
            ))}
            <p className="text-[10px] text-muted-foreground">
              Сегментов в маршруте: {hotspots.totalSegments}, пробочных: {hotspots.hotspotCount}
            </p>
          </div>
        ) : (
          <p className="text-[11px] text-muted-foreground">
            {hotspots ? "Хронических пробок не обнаружено" : "Недостаточно данных"}
          </p>
        )}
      </div>

      {/* Распределение по времени суток (упрощённое — по датам истории) */}
      {trend && trend.history.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold flex items-center gap-1.5 mb-2">
            <Clock className="h-3.5 w-3.5 text-primary" /> Выезды по времени суток (§10.3)
          </h4>
          <div className="flex items-end gap-1 h-14" role="img" aria-label="Распределение выездов по времени суток">
            {["0–3", "3–6", "6–9", "9–12", "12–15", "15–18", "18–21", "21–24"].map((label, i) => {
              const count = trend.history.filter((h) => Math.floor(new Date(h.date).getHours() / 3) === i).length;
              return (
                <div key={label} className="flex-1 flex flex-col items-center gap-0.5" title={`${label} ч: ${count} выездов`}>
                  <div
                    className={cn(
                      "w-full rounded-t-sm transition-all",
                      count > 0 ? "bg-primary/70" : "bg-muted"
                    )}
                    style={{ height: `${Math.max(4, (count / maxTraffic) * 40)}px` }}
                  />
                  <span className="text-[8px] text-muted-foreground leading-none">{label}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// === Карточка группы ===
function GroupCard({ group, index }: { group: RouteGroupInfo; index: number }) {
  const [expanded, setExpanded] = React.useState(false);
  return (
    <motion.li
      layout
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index * 0.05, 0.3) }}
      className="rounded-lg border p-3 hover:border-primary/40 transition-colors"
    >
      <button
        className="w-full text-left"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="flex items-center gap-2 flex-wrap">
              <Hash className="h-3.5 w-3.5 text-primary shrink-0" />
              <span className="font-mono text-xs font-medium select-all">{group.routeHash}</span>
              {group.topologyHash && (
                <Badge variant="outline" className="text-[9px] font-mono">
                  topo:{group.topologyHash}
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-3 text-[11px] text-muted-foreground flex-wrap">
              <span className="inline-flex items-center gap-1">
                <Layers className="h-3 w-3" />
                {group.sessionCount} {group.sessionCount === 1 ? "поездка" : group.sessionCount < 5 ? "поездки" : "поездок"}
              </span>
              {group.avgActiveDurationSec != null && (
                <span className="inline-flex items-center gap-1">
                  <Clock className="h-3 w-3" /> ср {fmtDur(group.avgActiveDurationSec)}
                </span>
              )}
              {group.bestActiveDurationSec != null && (
                <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
                  <Trophy className="h-3 w-3" /> лучш. {fmtDur(group.bestActiveDurationSec)}
                </span>
              )}
              {group.avgDistanceM != null && (
                <span className="inline-flex items-center gap-1">
                  <RouteIcon className="h-3 w-3" /> {fmtDist(group.avgDistanceM)}
                </span>
              )}
            </div>
            <div className="text-[10px] text-muted-foreground flex items-center gap-2 flex-wrap">
              <span>{fmtDate(group.firstSeen)} — {fmtDate(group.lastSeen)}</span>
              <span>·</span>
              <span className="truncate max-w-[180px]">{group.deviceIds.join(", ")}</span>
            </div>
          </div>
          <ChevronDown
            className={cn(
              "h-4 w-4 text-muted-foreground shrink-0 transition-transform",
              expanded && "rotate-180"
            )}
          />
        </div>
      </button>
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <GroupDetail group={group} />
          </motion.div>
        )}
      </AnimatePresence>
    </motion.li>
  );
}

// === Главный компонент ===
export function RouteGroups() {
  const { data, isLoading, isError, refetch, isRefetching } = useRouteGroups();
  const groups = data?.groups || [];

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Layers className="h-4 w-4 text-primary" />
              Группы маршрутов
              <Badge variant="secondary" className="text-[10px]">v2.9</Badge>
            </CardTitle>
            <CardDescription className="text-xs">
              Концептуально одинаковые поездки, сгруппированные по routeHash (§10.0) · агрегаты по ActiveDuration · Theil-Sen · P75-хотспоты
            </CardDescription>
          </div>
          <Button size="sm" variant="outline" onClick={() => refetch()} disabled={isRefetching}>
            {isRefetching ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Обновить
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-20 w-full" />
            ))}
          </div>
        ) : isError ? (
          <div className="text-center py-6 text-sm text-muted-foreground">
            Не удалось загрузить группы маршрутов
          </div>
        ) : groups.length === 0 ? (
          <div className="text-center py-8 text-sm text-muted-foreground">
            <Layers className="h-10 w-10 mx-auto mb-2 opacity-30" />
            Пока нет групп маршрутов
            <p className="text-xs mt-1">
              Группы формируются автоматически: завершите две поездки по одному маршруту
            </p>
          </div>
        ) : (
          <div className="max-h-[560px] overflow-y-auto scroll-telem -mx-2">
            <ul className="space-y-2 px-2">
              {groups.map((g, i) => (
                <GroupCard key={g.routeHash} group={g} index={i} />
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
