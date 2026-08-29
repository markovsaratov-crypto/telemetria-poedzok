"use client";

// src/components/route-groups.tsx — v2.9 §10: группы маршрутов по routeHash.
// Показывает концептуально одинаковые поездки, сгруппированные детерминированным
// routeHash (§10.0), с агрегатами ActiveDuration (§10.1/§10.2), Theil-Sen-трендом (§10.5)
// и HotspotSegments P75 < 0.5 (§10.6).
// v2.9.1: SVG мини-карта полилинии группы (severity-подсветка хотспотов) + GPX-экспорт.

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
  Download,
  MapPin,
  Flag,
  Navigation,
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

// === SVG мини-карта полилинии маршрута (экспоненциальная проекция, без библиотек) ===
interface MiniMapPoint {
  lat: number;
  lon: number;
}

interface HotspotOverlay {
  a: MiniMapPoint | null;
  b: MiniMapPoint | null;
  p75: number;
  segmentId: string;
}

function severityColor(p75: number): string {
  if (p75 < 0.25) return "oklch(0.55 0.20 25)";
  if (p75 < 0.4) return "oklch(0.70 0.15 60)";
  return "oklch(0.75 0.15 95)";
}

function MiniMap({
  points,
  hotspots,
  height = 96,
  className,
  showMarkers = true,
  ariaLabel = "Мини-карта маршрута",
}: {
  points: MiniMapPoint[] | null | undefined;
  hotspots?: HotspotOverlay[];
  height?: number;
  className?: string;
  showMarkers?: boolean;
  ariaLabel?: string;
}) {
  const gradId = React.useId().replace(/[^a-zA-Z0-9]/g, "");
  if (!points || points.length < 2) {
    return (
      <div
        className={cn(
          "flex items-center justify-center rounded-lg border border-dashed bg-muted/30 text-muted-foreground/60",
          className
        )}
        style={{ height }}
        aria-label={ariaLabel}
        role="img"
      >
        <MapPin className="h-4 w-4" />
      </div>
    );
  }

  // Эйвангулярная проекция с поправкой cos(lat) — точна на городских масштабах
  const lats = points.map((p) => p.lat);
  const lons = points.map((p) => p.lon);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLon = Math.min(...lons);
  const maxLon = Math.max(...lons);
  const latSpan = maxLat - minLat || 1e-6;
  const lonSpan = maxLon - minLon || 1e-6;
  const kx = Math.cos(((minLat + maxLat) / 2) * (Math.PI / 180));
  const xSpan = Math.max(lonSpan * kx, 1e-6);
  const ySpan = Math.max(latSpan, 1e-6);

  const W = 200;
  const H = 100;
  const pad = 10;
  const scale = Math.min((W - pad * 2) / xSpan, (H - pad * 2) / ySpan);
  const offX = (W - pad * 2 - xSpan * scale) / 2;
  const offY = (H - pad * 2 - ySpan * scale) / 2;
  const project = (p: MiniMapPoint): [number, number] => [
    pad + offX + (p.lon - minLon) * kx * scale,
    H - pad - offY - (p.lat - minLat) * scale,
  ];

  const pts = points.map(project);
  const path = pts.map(([x, y], i) => `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const [sx, sy] = pts[0];
  const [ex, ey] = pts[pts.length - 1];

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className={cn("w-full rounded-lg border bg-card ring-1 ring-inset ring-border/50", className)}
      style={{ height }}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={ariaLabel}
    >
      <defs>
        <linearGradient id={`mmg-${gradId}`} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="oklch(0.62 0.19 350)" />
          <stop offset="100%" stopColor="oklch(0.72 0.14 320)" />
        </linearGradient>
        <pattern id={`mmdot-${gradId}`} width="14" height="14" patternUnits="userSpaceOnUse">
          <circle cx="1.2" cy="1.2" r="0.9" className="fill-foreground" opacity="0.07" />
        </pattern>
      </defs>
      {/* фон-сетка */}
      <rect x="0" y="0" width={W} height={H} fill={`url(#mmdot-${gradId})`} />
      {/* трек */}
      <path
        d={path}
        fill="none"
        stroke={`url(#mmg-${gradId})`}
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.9"
      />
      {/* severity-подсветка хотспотов (§10.6) */}
      {hotspots?.map((h) => {
        if (!h.a || !h.b) return null;
        const [ax, ay] = project(h.a);
        const [bx, by] = project(h.b);
        return (
          <line
            key={h.segmentId}
            x1={ax}
            y1={ay}
            x2={bx}
            y2={by}
            stroke={severityColor(h.p75)}
            strokeWidth="4.5"
            strokeLinecap="round"
            opacity="0.85"
          />
        );
      })}
      {/* маркеры старт/финиш */}
      {showMarkers && (
        <>
          <circle cx={sx} cy={sy} r="4" fill="oklch(0.60 0.15 145)" stroke="white" strokeWidth="1.5" />
          <circle cx={ex} cy={ey} r="4" fill="oklch(0.55 0.20 25)" stroke="white" strokeWidth="1.5" />
        </>
      )}
    </svg>
  );
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

// === Заголовок секции с иконкой-чипом ===
function SectionTitle({
  icon,
  children,
  tone = "primary",
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
  tone?: "primary" | "amber";
}) {
  return (
    <h4 className="text-xs font-semibold flex items-center gap-1.5">
      <span
        className={cn(
          "inline-flex h-5 w-5 items-center justify-center rounded-md",
          tone === "primary" ? "bg-primary/10 text-primary" : "bg-amber-500/15 text-amber-600 dark:text-amber-400"
        )}
      >
        {icon}
      </span>
      {children}
    </h4>
  );
}

// === Расширенная детализация группы ===
function GroupDetail({ group }: { group: RouteGroupInfo }) {
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

  // Бакеты выездов по времени суток (8x3ч) — обычный массив длины 8
  const bucketCounts = React.useMemo(() => {
    const counts = new Array<number>(8).fill(0);
    for (const h of trend?.history ?? []) {
      const hour = new Date(h.date).getHours();
      const b = Math.floor(hour / 3);
      if (b >= 0 && b < 8) counts[b]++;
    }
    return counts;
  }, [trend]);
  const maxTraffic = Math.max(1, ...bucketCounts);

  // Хотспоты с геометрией — для подсветки на мини-карте
  const hotspotOverlays: HotspotOverlay[] = React.useMemo(
    () => (hotspots?.hotspots ?? []).map((h) => ({ a: h.a ?? null, b: h.b ?? null, p75: h.p75, segmentId: h.segmentId })),
    [hotspots]
  );

  return (
    <div className="mt-3 space-y-4 rounded-lg border bg-gradient-to-b from-muted/30 to-transparent p-3">
      {/* Мини-карта канонического маршрута + легенда + GPX */}
      <div>
        <div className="flex items-center justify-between gap-2 flex-wrap mb-2">
          <SectionTitle icon={<Navigation className="h-3 w-3" />}>Канонический маршрут группы</SectionTitle>
          <Button
            size="sm"
            variant="outline"
            className="h-6 text-[10px] gap-1"
            onClick={downloadGpx}
            disabled={gpxState === "loading"}
            title="Скачать GPX-трек канонического маршрута"
          >
            {gpxState === "loading" ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Download className="h-3 w-3" />
            )}
            GPX
          </Button>
        </div>
        {hotspotsQ.isLoading ? (
          <Skeleton className="h-24 w-full shimmer" />
        ) : (
          <div className="space-y-1.5">
            <MiniMap
              points={hotspots?.polylineSample}
              hotspots={hotspotOverlays}
              height={104}
              ariaLabel={`Канонический маршрут группы ${group.routeHash}: красные/жёлтые сегменты — хронические пробки`}
            />
            <div className="flex items-center justify-between gap-2 flex-wrap text-[9px] text-muted-foreground">
              <span className="inline-flex items-center gap-1">
                <span className="inline-block h-2 w-2 rounded-full" style={{ background: "oklch(0.60 0.15 145)" }} />
                старт
                <span className="inline-block h-2 w-2 rounded-full ml-1" style={{ background: "oklch(0.55 0.20 25)" }} />
                финиш
              </span>
              {hotspotOverlays.some((h) => h.a && h.b) && (
                <span className="inline-flex items-center gap-1">
                  <span className="inline-block h-2 w-2 rounded-sm" style={{ background: severityColor(0.2) }} />
                  тяжёлая пробка
                  <span className="inline-block h-2 w-2 rounded-sm ml-1" style={{ background: severityColor(0.45) }} />
                  лёгкая
                </span>
              )}
              {gpxState === "error" && <span className="text-destructive">Ошибка выгрузки GPX</span>}
            </div>
          </div>
        )}
      </div>

      {/* Theil-Sen тренд + история */}
      <div>
        <div className="flex items-center justify-between gap-2 flex-wrap mb-2">
          <SectionTitle icon={<Gauge className="h-3 w-3" />}>Тренд времени (Theil-Sen §10.5)</SectionTitle>
          {trend?.trend && <TrendBadge rating={trend.trend.rating} slope={trend.trend.slope} />}
        </div>
        {trendQ.isLoading ? (
          <Skeleton className="h-10 w-full shimmer" />
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
        <div className="mb-2">
          <SectionTitle icon={<AlertTriangle className="h-3 w-3" />} tone="amber">
            Хронически пробочные участки (P75 &lt; 0.5, §10.6)
          </SectionTitle>
        </div>
        {hotspotsQ.isLoading ? (
          <Skeleton className="h-10 w-full shimmer" />
        ) : hotspots && hotspots.hotspotCount > 0 ? (
          <div className="space-y-1.5">
            {hotspots.hotspots.slice(0, 6).map((h) => (
              <div key={h.segmentId} className="flex items-center gap-2 text-[11px]">
                <Badge variant="outline" className="font-mono text-[9px] w-14 justify-center">
                  {h.segmentId}
                </Badge>
                <div
                  className="flex-1 h-2 rounded-full bg-muted overflow-hidden"
                  role="progressbar"
                  aria-valuenow={h.p75}
                  aria-valuemin={0}
                  aria-valuemax={1}
                  aria-label={`Сегмент ${h.segmentId}: P75 ${h.p75.toFixed(2)}`}
                >
                  <div
                    className={cn(
                      "h-full rounded-full transition-all duration-500",
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
          <div className="mb-2">
            <SectionTitle icon={<Clock className="h-3 w-3" />}>Выезды по времени суток (§10.3)</SectionTitle>
          </div>
          <div className="flex items-end gap-1 h-16" role="img" aria-label="Распределение выездов по времени суток">
            {["0–3", "3–6", "6–9", "9–12", "12–15", "15–18", "18–21", "21–24"].map((label, i) => {
              const count = bucketCounts[i];
              return (
                <div key={label} className="flex-1 flex flex-col items-center gap-0.5" title={`${label} ч: ${count} выездов`}>
                  {count > 0 && (
                    <span className="text-[9px] font-semibold tabular-nums text-primary leading-none">{count}</span>
                  )}
                  <div
                    className={cn(
                      "w-full rounded-t-sm transition-all duration-300",
                      count > 0
                        ? "bg-gradient-to-t from-primary/40 to-primary/80"
                        : "bg-muted"
                    )}
                    style={{ height: `${Math.max(4, (count / maxTraffic) * 36)}px` }}
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
      className={cn(
        "group/card rounded-xl border bg-card/60 elev-1 transition-all duration-200",
        "hover:elev-2 hover:border-primary/40 hover:-translate-y-px"
      )}
    >
      <button
        className="w-full text-left p-3"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary ring-1 ring-inset ring-primary/20">
                <Hash className="h-3.5 w-3.5" />
              </span>
              <span className="font-mono text-xs font-medium select-all">{group.routeHash}</span>
              {group.topologyHash && (
                <Badge variant="outline" className="text-[9px] font-mono">
                  topo:{group.topologyHash}
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="inline-flex items-center gap-1 rounded-md bg-muted/60 px-1.5 py-0.5 text-[11px] text-foreground/80">
                <Layers className="h-3 w-3 text-primary/70" />
                {group.sessionCount} {group.sessionCount === 1 ? "поездка" : group.sessionCount < 5 ? "поездки" : "поездок"}
              </span>
              {group.avgActiveDurationSec != null && (
                <span className="inline-flex items-center gap-1 rounded-md bg-muted/60 px-1.5 py-0.5 text-[11px] text-foreground/80">
                  <Clock className="h-3 w-3 text-teal-500/80" />
                  ср {fmtDur(group.avgActiveDurationSec)}
                </span>
              )}
              {group.bestActiveDurationSec != null && (
                <span className="inline-flex items-center gap-1 rounded-md bg-emerald-500/10 px-1.5 py-0.5 text-[11px] text-emerald-700 dark:text-emerald-400">
                  <Trophy className="h-3 w-3" />
                  лучш. {fmtDur(group.bestActiveDurationSec)}
                </span>
              )}
              {group.avgDistanceM != null && (
                <span className="inline-flex items-center gap-1 rounded-md bg-muted/60 px-1.5 py-0.5 text-[11px] text-foreground/80">
                  <RouteIcon className="h-3 w-3 text-amber-500/80" />
                  {fmtDist(group.avgDistanceM)}
                </span>
              )}
            </div>
            <div className="text-[10px] text-muted-foreground flex items-center gap-2 flex-wrap">
              <span className="inline-flex items-center gap-1">
                <Flag className="h-2.5 w-2.5" />
                {fmtDate(group.firstSeen)} — {fmtDate(group.lastSeen)}
              </span>
              <span>·</span>
              <span className="truncate max-w-[180px]">{group.deviceIds.join(", ")}</span>
            </div>
          </div>
          {/* Мини-карта-превью маршрута */}
          <div className="w-28 shrink-0 hidden sm:block">
            <MiniMap
              points={group.polylineSample}
              height={64}
              showMarkers
              className="group-hover/card:ring-primary/30 transition-all"
              ariaLabel={`Форма маршрута группы ${group.routeHash}`}
            />
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
            <div className="px-3 pb-3">
              <GroupDetail group={group} />
            </div>
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
    <Card className="elev-1">
      <CardHeader>
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <span className="inline-flex h-6 w-6 items-center justify-center rounded-lg bg-primary/10 text-primary ring-1 ring-inset ring-primary/20">
                <Layers className="h-4 w-4" />
              </span>
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
              <Skeleton key={i} className="h-24 w-full shimmer" />
            ))}
          </div>
        ) : isError ? (
          <div className="text-center py-6 text-sm text-muted-foreground">
            Не удалось загрузить группы маршрутов
          </div>
        ) : groups.length === 0 ? (
          <div className="text-center py-8 text-sm text-muted-foreground rounded-xl border border-dashed bg-gradient-to-b from-primary/[0.03] to-transparent">
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
