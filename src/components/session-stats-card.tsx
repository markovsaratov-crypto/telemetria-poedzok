"use client";

// src/components/session-stats-card.tsx — детальная статистика сессии с расширенными метриками.
// v2.9.1: тайлы-метрики с иконками-чипами, hover-подъёмом и акцентными линиями.

import * as React from "react";
import { motion } from "framer-motion";
import {
  Route as RouteIcon,
  Clock,
  Gauge,
  TrendingUp,
  TrendingDown,
  MapPin,
  Timer,
  Coffee,
  Mountain,
  Activity,
  Scissors,
  ChartBar,
  Waves,
  Car,
  Rocket,
  Zap,
  Leaf,
  CircleAlert,
  ArrowUpToLine,
  MoveDiagonal,
  Wind,
  Fingerprint,
  CornerUpRight,
  Equal,
  Compass,
  RotateCcw,
  CarFront,
  Spline,
  Signal,
  Radar,
  Percent,
  ShieldCheck,
  Scale,
  Trophy,
  Diff,
  Sigma,
  FileText,
  TimerReset,
} from "lucide-react";
import { useSessionStats, useRouteComparison } from "@/lib/hooks";
import { SpeedProfileChart } from "@/components/speed-profile-chart";
import { AltitudeProfileChart } from "@/components/altitude-profile-chart";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { fmtNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

interface SessionStatsCardProps {
  sessionId: string;
  // v2.9.4: связка карта↔профили (десктоп-деталь) — проброс в графики
  focusIdx?: number | null; // эффективный индекс: hover > pin > клик по карте (для подсказки)
  pinnedIdx?: number | null; // закреплённая точка (клик по графику)
  mapClickIdx?: number | null; // индекс, выбранный кликом по карте
  onHoverIdx?: (idx: number | null) => void;
  onPinIdx?: (idx: number | null) => void;
}

// ——— v2.9.1: тайл метрики с иконкой-чипом и hover-подъёмом ———
function MetricTile({
  icon,
  label,
  value,
  sub,
  color,
  index = 0,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  color?: string;
  index?: number;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index * 0.02, 0.25) }}
      className={cn(
        "metric-tile group/tile relative overflow-hidden rounded-lg border bg-card/60 p-2.5 space-y-1",
        "hover:border-primary/30 hover:bg-card"
      )}
    >
      {/* акцентная линия сверху */}
      <div className="absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r from-primary/50 via-primary/15 to-transparent opacity-70" />
      <div className="flex items-center gap-1.5">
        <span className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary transition-transform group-hover/tile:scale-110">
          {icon}
        </span>
        <span className="text-[10px] text-muted-foreground truncate">{label}</span>
      </div>
      <div className={cn("text-sm font-semibold tabular-nums truncate", color || "")}>{value}</div>
      {sub && <div className="text-[9px] text-muted-foreground truncate">{sub}</div>}
    </motion.div>
  );
}

// ——— v2.9.1: заголовок секции с иконкой-чипом ———
function SectionLabel({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 mb-1.5">
      <span className="inline-flex h-5 w-5 items-center justify-center rounded-md bg-primary/10 text-primary">
        {icon}
      </span>
      <span className="text-[10px] uppercase tracking-wide font-semibold text-foreground/70">{children}</span>
      <span className="flex-1 h-px bg-gradient-to-r from-border to-transparent" />
    </div>
  );
}

export function SessionStatsCard({
  sessionId,
  focusIdx,
  pinnedIdx,
  mapClickIdx,
  onHoverIdx,
  onPinIdx,
}: SessionStatsCardProps) {
  const { data: stats, isLoading } = useSessionStats(sessionId);

  if (isLoading) {
    return (
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <RouteIcon className="h-4 w-4 text-primary" />
            Детальная статистика
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full shimmer" />
            ))}
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!stats) {
    return null;
  }

  // FIX-C1 (эргономика): расшифровка активной части прямо в тайлах — пользователь видит,
  // что именно «Дистанция» и «Ср. скорость» считаются без стоянок-хвостов (§4.11)
  const at = stats.methodology?.activeTrip;
  const tailsSec = at?.hasActiveTrip ? Math.max(0, at.preTripIdle + at.postTripIdle) : 0;
  const activeIdleSec = at?.hasActiveTrip ? Math.max(0, at.activeIdleTime) : 0;
  const rawDist = stats.rawDistanceM ?? stats.distance;
  const driftM = Math.max(0, rawDist - stats.distance);

  const items = [
    {
      icon: <RouteIcon className="h-3 w-3" />,
      label: "Дистанция",
      value: stats.distance > 0 ? `${fmtNumber(stats.distance / 1000, 2)} км` : "—",
      sub:
        driftM > 30
          ? `без хвостов · дрейф +${fmtNumber(driftM, 0)} м исключён`
          : `${fmtNumber(stats.distance)} м`,
      color: "text-emerald-600 dark:text-emerald-400",
    },
    {
      icon: <Clock className="h-3 w-3" />,
      label: "Длительность",
      value: formatDuration(stats.duration),
      sub: tailsSec > 30 ? `в т.ч. хвосты ${formatDuration(tailsSec)} — вне аналитики` : "общее время",
      color: "text-teal-600 dark:text-teal-400",
    },
    {
      icon: <Timer className="h-3 w-3" />,
      label: "В движении",
      value: formatDuration(stats.movingTime),
      sub: `${Math.round((stats.movingTime / (stats.duration || 1)) * 100)}% записи`,
      color: "text-emerald-600 dark:text-emerald-400",
    },
    {
      icon: <Coffee className="h-3 w-3" />,
      label: "Стоянки",
      value: formatDuration(stats.idleTime),
      sub:
        tailsSec > 30
          ? `в поездке ${formatDuration(activeIdleSec)} · хвосты ${formatDuration(tailsSec)}`
          : `${Math.round((stats.idleTime / (stats.duration || 1)) * 100)}% записи`,
      color: "text-amber-600 dark:text-amber-400",
    },
    {
      icon: <Gauge className="h-3 w-3" />,
      label: "Ср. скорость",
      value: stats.avgSpeed != null ? `${fmtNumber(stats.avgSpeed * 3.6, 1)} км/ч` : "—",
      sub: stats.avgSpeed != null ? `${fmtNumber(stats.avgSpeed, 1)} м/с · по активной части` : "нет поездки",
      color: "text-teal-600 dark:text-teal-400",
    },
    {
      icon: <Rocket className="h-3 w-3" />,
      label: "Макс. скорость",
      value: stats.maxSpeed != null && stats.maxSpeed > 0 ? `${fmtNumber(stats.maxSpeed * 3.6, 1)} км/ч` : "—",
      sub: stats.maxSpeed != null ? `${fmtNumber(stats.maxSpeed, 1)} м/с` : "",
      color: "text-rose-600 dark:text-rose-400",
    },
    {
      icon: <TrendingUp className="h-3 w-3" />,
      label: "Набор высоты",
      value: stats.elevationGain > 0 ? `${fmtNumber(stats.elevationGain)} м` : "—",
      sub: "подъём",
      color: "text-emerald-600 dark:text-emerald-400",
    },
    {
      icon: <TrendingDown className="h-3 w-3" />,
      label: "Снижение",
      value: stats.elevationLoss > 0 ? `${fmtNumber(stats.elevationLoss)} м` : "—",
      sub: "спуск",
      color: "text-amber-600 dark:text-amber-400",
    },
    {
      icon: <Mountain className="h-3 w-3" />,
      label: "Ср. высота",
      value: stats.avgAltitude != null ? `${fmtNumber(stats.avgAltitude)} м` : "—",
      sub: "над уровнем моря",
      color: "text-zinc-600 dark:text-zinc-400",
    },
    {
      icon: <MapPin className="h-3 w-3" />,
      label: "BBox",
      value: stats.bbox ? `${fmtNumber((stats.bbox.maxLat - stats.bbox.minLat) * 111, 1)}×${fmtNumber((stats.bbox.maxLon - stats.bbox.minLon) * 111, 1)} км` : "—",
      sub: "площадь покрытия",
      color: "text-muted-foreground",
    },
  ];

  return (
    <Card className="elev-1">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <span className="inline-flex h-6 w-6 items-center justify-center rounded-lg bg-primary/10 text-primary ring-1 ring-inset ring-primary/20">
            <RouteIcon className="h-4 w-4" />
          </span>
          Детальная статистика
        </CardTitle>
        <CardDescription className="text-xs flex flex-wrap items-center gap-2">
          <span>
            {stats.pointCount} точек · {fmtNumber(stats.distance / 1000, 2)} км · {formatDuration(stats.duration)}
            {at?.hasActiveTrip && tailsSec > 30 && (
              <> · активная поездка <span className="font-medium text-foreground">{formatDuration(at.activeDuration)}</span> (хвосты {formatDuration(tailsSec)})</>
            )}
          </span>
          {stats.routeHash && (
            <span className="inline-flex items-center rounded-full border bg-muted/50 px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground transition-colors hover:border-primary/40 hover:text-foreground" title={`topology: ${stats.topologyHash ?? "—"}`}>
              {stats.routeHash}
            </span>
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
          {items.map((it, i) => (
            <MetricTile key={i} icon={it.icon} label={it.label} value={it.value} sub={it.sub} color={it.color} index={i} />
          ))}
        </div>

        {/* v2.9.3: спидограмма — скорость по времени с таймлайном движения/стоянок/разрывов */}
        {/* v2.9.4: + высотный профиль (сглаженный) и связка с картой */}
        {stats.speedProfile && stats.speedProfile.length >= 2 && (
          <div className="pt-1 space-y-3">
            <div>
              <SectionLabel icon={<Gauge className="h-3 w-3" />}>Спидограмма поездки</SectionLabel>
              <SpeedProfileChart
                profile={stats.speedProfile}
                startIso={stats.startTime}
                avgKmh={stats.avgSpeed != null ? stats.avgSpeed * 3.6 : null}
                maxKmh={stats.maxSpeed != null ? stats.maxSpeed * 3.6 : null}
                height={200}
                onHoverIdx={onHoverIdx}
                onPinIdx={onPinIdx}
                externalIdx={mapClickIdx ?? null}
                pinnedIdx={pinnedIdx ?? null}
              />
            </div>
            {stats.hasAltitude && (
              <div>
                <SectionLabel icon={<Mountain className="h-3 w-3" />}>Высотный профиль</SectionLabel>
                <AltitudeProfileChart
                  profile={stats.speedProfile}
                  startIso={stats.startTime}
                  height={140}
                  onHoverIdx={onHoverIdx}
                  onPinIdx={onPinIdx}
                  externalIdx={mapClickIdx ?? null}
                  pinnedIdx={pinnedIdx ?? null}
                />
              </div>
            )}
            {/* v2.9.4: подсказка связки карта↔график */}
            {focusIdx != null && (
              <p className="text-[10px] text-muted-foreground flex items-center gap-1.5">
                <MapPin className="h-3 w-3 text-primary/70" />
                Точка синхронизирована с картой — клик по графику закрепляет маркер, клик по треку двигает кросхейр
              </p>
            )}
          </div>
        )}

        {/* v2.9: метрики методологии (62 в 8 группах + routeId) (разделы 5, 7, 8.2, 11) */}
        {stats.methodology && <MethodologyGrid m={stats.methodology} />}
        {/* P1-7: план-фактный анализ из результата ворчера */}
        {stats.route && (stats.route.planDistanceM != null || stats.route.trafficFetched) && <PlanFactBlock r={stats.route} />}
        {/* v2.9 §10: сравнение с routeHash-группой */}
        <RouteComparisonBlock sessionId={sessionId} />
      </CardContent>
    </Card>
  );
}

// ——— v2.9 §10: сравнение сессии с её routeHash-группой ———
function RouteComparisonBlock({ sessionId }: { sessionId: string }) {
  const { data: cmp, isLoading } = useRouteComparison(sessionId);
  if (isLoading) return <Skeleton className="h-16 w-full shimmer" />;
  if (!cmp || cmp.groupSize < 2) return null; // одиночная поездка — не с чем сравнивать

  const vsAvg = cmp.vsAvgPct;
  const vsAvgColor = vsAvg == null ? "" : vsAvg > 10 ? "text-red-600 dark:text-red-400" : vsAvg > 0 ? "text-amber-600 dark:text-amber-400" : "text-emerald-600 dark:text-emerald-400";
  const items = [
    { icon: <RouteIcon className="h-3 w-3" />, label: "Группа маршрута", value: `${cmp.groupSize} поездок`, sub: `routeHash ${cmp.routeHash.slice(0, 8)}…` },
    { icon: <Clock className="h-3 w-3" />, label: "Среднее время", value: formatDuration(cmp.stats.avg ?? 0), sub: `лучшее ${formatDuration(cmp.stats.best ?? 0)} · худшее ${formatDuration(cmp.stats.worst ?? 0)}` },
    { icon: <Trophy className="h-3 w-3" />, label: "Место в группе", value: cmp.rank != null ? `${cmp.rank} из ${cmp.groupSize}` : "—", sub: cmp.percentile != null ? `перцентиль ${cmp.percentile}` : "единственная" },
    { icon: <Diff className="h-3 w-3" />, label: "Δ к среднему", value: vsAvg != null ? `${vsAvg > 0 ? "+" : ""}${vsAvg}%` : "—", sub: "эта поездка vs группа", color: vsAvgColor },
    { icon: <Sigma className="h-3 w-3" />, label: "StdDev группы", value: cmp.stats.stdDev != null ? formatDuration(cmp.stats.stdDev) : "—", sub: `надёжных: ${cmp.stats.eligibleCount}/${cmp.stats.totalCount}` },
  ];
  return (
    <div>
      <SectionLabel icon={<Scale className="h-3 w-3" />}>Сравнение с маршрутом (§10)</SectionLabel>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
        {items.map((it, i) => (
          <MetricTile key={i} icon={it.icon} label={it.label} value={it.value} sub={it.sub} color={it.color} index={i} />
        ))}
      </div>
    </div>
  );
}

// ——— P1-6: блок метрик методологии (v2.9: 62 метрики в 8 группах + routeId) ———
interface MethodologyMetrics {
  // Группа 1
  movingTime: number;
  idleTime: number;
  gapTime: number;
  // Группа 2
  speedP50: number | null;
  speedStdDev: number | null;
  speedDistribution: number[];
  timeInTraffic: number;
  timeAtCruise: number;
  speedVariation: number;
  // Группа 4 — поведение (включая v2.9 новые)
  harshBrakingCount: number;
  harshAccelCount: number;
  ecoScore: { value: number | null; rating: string; baselineVersion: string };
  accelerationRms: number | null;
  jerkRms: number | null;
  speedConsistencyIndex: number | null;
  bearingConsistency: number | null;
  uTurnCount: number;
  turnCount: number;
  highSpeedCornering: number;
  // Группа 5
  routeEfficiency: number | null;
  avgAccuracy: number | null;
  // Группа 8
  pointDensity: number | null;
  gapCount: number;
  gapTotalDurationMs: number;
  accuracyP90: number | null;
  completenessScore: number;
  sessionReliability: { value: number | null; rating: string };
  // v2.9: служебные
  activeTrip: {
    hasActiveTrip: boolean;
    activeDuration: number;
    preTripIdle: number;
    postTripIdle: number;
    activeIdleTime: number;
  };
}

function ecoColor(v: number | null): string {
  if (v == null) return "text-muted-foreground";
  if (v >= 80) return "text-emerald-600 dark:text-emerald-400";
  if (v >= 60) return "text-amber-600 dark:text-amber-400";
  if (v >= 40) return "text-orange-600 dark:text-orange-400";
  return "text-red-600 dark:text-red-400";
}

function reliabilityColor(v: number | null): string {
  if (v == null) return "text-muted-foreground";
  if (v >= 0.85) return "text-emerald-600 dark:text-emerald-400";
  if (v >= 0.6) return "text-teal-600 dark:text-teal-400";
  if (v >= 0.3) return "text-amber-600 dark:text-amber-400";
  return "text-red-600 dark:text-red-400";
}

function MethodologyGrid({ m }: { m: MethodologyMetrics }) {
  const ecoVal = m.ecoScore?.value ?? null;
  const srelVal = m.sessionReliability?.value ?? null;
  const items = [
    // Группа 1 — базовые
    { icon: <Activity className="h-3 w-3" />, label: "Активная поездка", value: m.activeTrip?.hasActiveTrip ? formatDuration(m.activeTrip.activeDuration) : "нет", sub: m.activeTrip?.hasActiveTrip ? `до старта ${formatDuration(m.activeTrip.preTripIdle)} · после финиша ${formatDuration(m.activeTrip.postTripIdle)}` : "нет движения", color: m.activeTrip?.hasActiveTrip ? "text-emerald-600 dark:text-emerald-400" : "text-muted-foreground" },
    { icon: <Scissors className="h-3 w-3" />, label: "Разрывы трека", value: String(m.gapCount), sub: m.gapTime > 0 ? `потеряно ${formatDuration(m.gapTime)}` : "нет разрывов", color: m.gapCount > 0 ? "text-amber-600 dark:text-amber-400" : "" },
    // Группа 2 — скоростной анализ (по активной части)
    { icon: <ChartBar className="h-3 w-3" />, label: "Скорость P50", value: m.speedP50 != null ? `${fmtNumber(m.speedP50 * 3.6, 1)} км/ч` : "—", sub: "медиана" },
    { icon: <Waves className="h-3 w-3" />, label: "StdDev скорости", value: m.speedStdDev != null ? `${fmtNumber(m.speedStdDev * 3.6, 1)} км/ч` : "—", sub: "разброс" },
    { icon: <Car className="h-3 w-3" />, label: "В пробках", value: m.timeInTraffic > 0 ? formatDuration(m.timeInTraffic) : "—", sub: "< 10 км/ч" },
    { icon: <Rocket className="h-3 w-3" />, label: "Крейсер", value: m.timeAtCruise > 0 ? formatDuration(m.timeAtCruise) : "—", sub: "> 60 км/ч" },
    { icon: <Zap className="h-3 w-3" />, label: "Рваность", value: String(m.speedVariation), sub: "Δv > 10 км/ч/10с" },
    // Группа 4 — поведение (включая v2.9 новые)
    { icon: <Leaf className="h-3 w-3" />, label: "EcoScore (CAP)", value: ecoVal != null ? `${fmtNumber(ecoVal)}/100` : "—", sub: m.ecoScore?.rating ?? "нет данных", color: ecoColor(ecoVal) },
    { icon: <CircleAlert className="h-3 w-3" />, label: "Резкие торможения", value: String(m.harshBrakingCount), sub: "> 10 км/ч/с", color: m.harshBrakingCount > 0 ? "text-red-600 dark:text-red-400" : "" },
    { icon: <ArrowUpToLine className="h-3 w-3" />, label: "Резкие разгоны", value: String(m.harshAccelCount), sub: "> 10 км/ч/с", color: m.harshAccelCount > 0 ? "text-red-600 dark:text-red-400" : "" },
    { icon: <MoveDiagonal className="h-3 w-3" />, label: "AccelerationRMS", value: m.accelerationRms != null ? `${fmtNumber(m.accelerationRms, 3)} м/с²` : "—", sub: "интенсивность ускорений", color: m.accelerationRms != null && m.accelerationRms > 1.5 ? "text-red-600 dark:text-red-400" : "" },
    { icon: <Wind className="h-3 w-3" />, label: "JerkRMS", value: m.jerkRms != null ? `${fmtNumber(m.jerkRms, 3)} м/с³` : "—", sub: "резкость рывков", color: m.jerkRms != null && m.jerkRms > 0.5 ? "text-amber-600 dark:text-amber-400" : "" },
    { icon: <Equal className="h-3 w-3" />, label: "Равномерность", value: m.speedConsistencyIndex != null ? `${fmtNumber(m.speedConsistencyIndex * 100, 0)}%` : "—", sub: "инвариант скорости", color: m.speedConsistencyIndex != null && m.speedConsistencyIndex >= 0.8 ? "text-emerald-600 dark:text-emerald-400" : "" },
    { icon: <Compass className="h-3 w-3" />, label: "Прямолинейность", value: m.bearingConsistency != null ? `${fmtNumber(m.bearingConsistency * 100, 0)}%` : "—", sub: "по bearing" },
    { icon: <RotateCcw className="h-3 w-3" />, label: "Развороты", value: String(m.uTurnCount), sub: "Δbearing > 150°", color: m.uTurnCount > 0 ? "text-red-600 dark:text-red-400" : "" },
    { icon: <CornerUpRight className="h-3 w-3" />, label: "Повороты", value: String(m.turnCount), sub: "30° < Δb ≤ 150°" },
    { icon: <CarFront className="h-3 w-3" />, label: "High-speed cornering", value: String(m.highSpeedCornering), sub: "> 60 км/ч + Δb > 45°", color: m.highSpeedCornering > 0 ? "text-red-600 dark:text-red-400" : "" },
    // Группа 5 — география
    { icon: <Spline className="h-3 w-3" />, label: "Извилистость", value: m.routeEfficiency != null ? `${fmtNumber(m.routeEfficiency, 2)}×` : "—", sub: "факт / прямая" },
    // Группа 8 — качество данных
    { icon: <Fingerprint className="h-3 w-3" />, label: "Плотность точек", value: m.pointDensity != null ? `${fmtNumber(m.pointDensity, 1)}/мин` : "—", sub: "запись GPS" },
    { icon: <Signal className="h-3 w-3" />, label: "Точность P90", value: m.accuracyP90 != null ? `${fmtNumber(m.accuracyP90, 1)} м` : "—", sub: "худшие 10%" },
    { icon: <Percent className="h-3 w-3" />, label: "Полнота", value: `${fmtNumber(m.completenessScore * 100)}%`, sub: "запись без пропусков" },
    { icon: <Radar className="h-3 w-3" />, label: "Ср. точность GPS", value: m.avgAccuracy != null ? `${fmtNumber(m.avgAccuracy, 1)} м` : "—", sub: "среднее по записи" },
    { icon: <ShieldCheck className="h-3 w-3" />, label: "SessionReliability", value: srelVal != null ? `${fmtNumber(srelVal * 100, 1)}%` : "—", sub: m.sessionReliability?.rating ?? "нет данных", color: reliabilityColor(srelVal) },
  ];
  return (
    <div>
      <SectionLabel icon={<FileText className="h-3 w-3" />}>Метрики методологии</SectionLabel>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
        {items.map((it, i) => (
          <MetricTile key={i} icon={it.icon} label={it.label} value={it.value} sub={it.sub} color={it.color} index={i} />
        ))}
      </div>
    </div>
  );
}

// ——— P1-7: план-фактный блок ———
interface RoutePlanFact {
  provider: string | null;
  planDistanceM: number | null;
  planDurationSec: number | null;
  trafficFetched: boolean;
  trafficDurationSec: number | null;
  timeLostToTrafficSec: number | null;
  durationDeviationPct: number | null;
  distanceDeviationPct: number | null;
  speedDeviationPct: number | null;
}

function PlanFactBlock({ r }: { r: RoutePlanFact }) {
  const dev = (v: number | null) => (v == null ? "—" : `${v > 0 ? "+" : ""}${fmtNumber(v, 1)}%`);
  const devColor = (v: number | null) => (v == null ? "" : v > 10 ? "text-red-600 dark:text-red-400" : v > 0 ? "text-amber-600 dark:text-amber-400" : "text-emerald-600 dark:text-emerald-400");
  const items = [
    { icon: <RouteIcon className="h-3 w-3" />, label: "План · дистанция", value: r.planDistanceM != null ? `${fmtNumber(r.planDistanceM / 1000, 2)} км` : "—", sub: r.provider ? `провайдер: ${r.provider}` : "нет плана" },
    { icon: <TimerReset className="h-3 w-3" />, label: "План · время", value: r.planDurationSec != null ? formatDuration(r.planDurationSec) : "—", sub: r.trafficDurationSec != null ? "базовая линия 40 км/ч" : "свободный поток" },
    { icon: <Clock className="h-3 w-3" />, label: "Δ по времени", value: dev(r.durationDeviationPct), sub: "факт vs план", color: devColor(r.durationDeviationPct) },
    { icon: <RouteIcon className="h-3 w-3" />, label: "Δ по дистанции", value: dev(r.distanceDeviationPct), sub: "факт vs план", color: devColor(r.distanceDeviationPct) },
    { icon: <Gauge className="h-3 w-3" />, label: "Δ по скорости", value: dev(r.speedDeviationPct), sub: "факт vs план", color: devColor(r.speedDeviationPct) },
    { icon: <Car className="h-3 w-3" />, label: "Потери от пробок", value: r.timeLostToTrafficSec != null ? formatDuration(Math.max(r.timeLostToTrafficSec, 0)) : r.trafficFetched ? "—" : "нет данных", sub: r.trafficFetched ? "2ГИС vs базовая линия" : "трафик не запрошен" },
  ];
  return (
    <div>
      <SectionLabel icon={<Scale className="h-3 w-3" />}>План-фактный анализ</SectionLabel>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
        {items.map((it, i) => (
          <MetricTile key={i} icon={it.icon} label={it.label} value={it.value} sub={it.sub} color={it.color} index={i} />
        ))}
      </div>
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
