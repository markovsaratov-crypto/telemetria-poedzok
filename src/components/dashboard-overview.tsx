"use client";

// src/components/dashboard-overview.tsx — вкладка "Обзор": статистика, мини-карта, heatmap, последние сессии.

import * as React from "react";
import dynamic from "next/dynamic";
import { motion } from "framer-motion";
import {
  Activity,
  MapPin,
  Database,
  Gauge,
  Clock,
  ChevronRight,
  TrendingUp,
  Zap,
  Calendar,
  HardDrive,
  Cpu,
  ArrowUpRight,
  AlertTriangle,
} from "lucide-react";
import { useSessions, useHealth, useStats } from "@/lib/hooks";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { fmtDate, fmtBytes, fmtNumber, avgSpeed, trackDistance } from "@/lib/format";
import { ActivityHeatmap } from "./activity-heatmap";

const MapTrack = dynamic(() => import("@/components/map-track"), {
  ssr: false,
  loading: () => <div className="h-[260px] w-full rounded-lg shimmer" />,
});

interface DashboardOverviewProps {
  onOpenSession: (id: string) => void;
  onGoToSessions: () => void;
}

const STATUS_BADGE: Record<string, string> = {
  active: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30",
  completed: "bg-teal-500/15 text-teal-700 dark:text-teal-400 border-teal-500/30",
  archived: "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30",
};

export function DashboardOverview({
  onOpenSession,
  onGoToSessions,
}: DashboardOverviewProps) {
  const { data, isLoading } = useSessions({ limit: 5 });
  const { data: health } = useHealth();
  const { data: stats, isLoading: statsLoading } = useStats();
  const sessions = data?.sessions || [];

  // Sparkline data (7 дней)
  const perDay = stats?.perDay;
  const sparkPath = React.useMemo(() => {
    if (!perDay?.length) return null;
    const vals = perDay.map((d) => d.count);
    const max = Math.max(...vals, 1);
    const w = 100;
    const h = 28;
    return vals
      .map((v, i) => `${i === 0 ? "M" : "L"} ${(i / (vals.length - 1)) * w} ${h - (v / max) * h}`)
      .join(" ");
  }, [perDay]);

  return (
    <div className="space-y-4">
      {/* Stats grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          icon={<Database className="h-4 w-4" />}
          label="Всего сессий"
          value={statsLoading ? null : fmtNumber(stats?.totalSessions ?? 0)}
          subtitle={`+${stats?.todaySessions ?? 0} сегодня`}
          spark={sparkPath}
          color="emerald"
        />
        <StatCard
          icon={<MapPin className="h-4 w-4" />}
          label="GPS-точек"
          value={statsLoading ? null : fmtNumber(stats?.totalPoints ?? 0)}
          subtitle={`${fmtNumber(stats?.totalRoutes ?? 0)} маршрутов`}
          color="teal"
        />
        <StatCard
          icon={<HardDrive className="h-4 w-4" />}
          label="Объём данных"
          value={statsLoading ? null : fmtBytes(stats?.totalPayloadBytes ?? 0)}
          subtitle="в активных сессиях"
          color="amber"
        />
        <StatCard
          icon={<Cpu className="h-4 w-4" />}
          label="Uptime системы"
          value={health ? `${Math.round(health.uptime / 60)} мин` : null}
          subtitle={`v${health?.version ?? "2.6.0"}`}
          color="zinc"
        />
      </div>

      {/* Capacity alert / health strip */}
      {stats?.capacity && (
        <Card className="border-emerald-500/30 bg-emerald-500/5">
          <CardContent className="py-3 px-4 flex items-center gap-3 flex-wrap text-xs">
            <div className="flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400 font-medium">
              <Zap className="h-3.5 w-3.5" />
              Пропускная способность
            </div>
            <span className="text-muted-foreground">|</span>
            <span>
              Цель: <span className="font-mono font-semibold">{stats.capacity.targetLoadRpm}</span> сесс/мин
            </span>
            <span className="text-muted-foreground">·</span>
            <span>
              Rate limit: <span className="font-mono font-semibold">{stats.capacity.rateLimitMaxIngest}</span>/мин
            </span>
            <span className="text-muted-foreground">·</span>
            <span>
              Headroom:{" "}
              <span className="font-mono font-semibold text-emerald-600 dark:text-emerald-400">
                +{stats.capacity.headroom}
              </span>{" "}
              ({Math.round((stats.capacity.headroom / stats.capacity.targetLoadRpm) * 100)}%)
            </span>
            <Badge variant="outline" className="border-emerald-500/30 text-emerald-700 dark:text-emerald-400 ml-auto">
              OK
            </Badge>
          </CardContent>
        </Card>
      )}

      {/* Pending jobs alert */}
      {stats && stats.pendingJobs > 0 && (
        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
        >
          <Card className="border-amber-500/30 bg-amber-500/5">
            <CardContent className="py-3 px-4 flex items-center gap-2 text-xs">
              <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
              <span>
                В очереди Worker: <span className="font-mono font-semibold">{stats.pendingJobs}</span> TrafficJob
              </span>
              {stats.deadJobs > 0 && (
                <>
                  <span className="text-muted-foreground">·</span>
                  <span className="text-red-600 dark:text-red-400">
                    {stats.deadJobs} dead-задач требуют requeue
                  </span>
                </>
              )}
            </CardContent>
          </Card>
        </motion.div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Mini map (последняя сессия) */}
        <Card className="lg:col-span-2 overflow-hidden">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <MapPin className="h-4 w-4 text-primary" /> Последняя сессия
            </CardTitle>
            <CardDescription className="text-xs">
              {sessions[0]
                ? `${sessions[0].deviceName || sessions[0].deviceId} · ${fmtDate(sessions[0].startTime)}`
                : "Нет сессий"}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {sessions[0] ? (
              <LastSessionMap sessionId={sessions[0].id} onOpen={() => onOpenSession(sessions[0].id)} />
            ) : (
              <div className="h-[260px] rounded-lg bg-muted/40 flex items-center justify-center text-sm text-muted-foreground border border-dashed">
                <div className="text-center space-y-1">
                  <MapPin className="h-8 w-8 mx-auto opacity-30" />
                  <div>Нет сессий</div>
                  <Button size="sm" variant="outline" onClick={onGoToSessions} className="mt-2">
                    Перейти к импорту CSV
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Recent sessions */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                <Clock className="h-4 w-4 text-primary" /> Последние
              </CardTitle>
              <Button size="sm" variant="ghost" onClick={onGoToSessions} className="h-7 text-xs">
                Все <ChevronRight className="h-3 w-3" />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="p-3 space-y-2">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-12 w-full shimmer" />
                ))}
              </div>
            ) : sessions.length === 0 ? (
              <div className="p-6 text-center text-sm text-muted-foreground space-y-1">
                <Calendar className="h-6 w-6 mx-auto opacity-30" />
                <div>Сессий пока нет</div>
              </div>
            ) : (
              <ul className="divide-y max-h-[280px] overflow-y-auto scroll-telem">
                {sessions.map((s, idx) => (
                  <motion.li
                    key={s.id}
                    initial={{ opacity: 0, x: -8 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: idx * 0.04 }}
                  >
                    <button
                      onClick={() => onOpenSession(s.id)}
                      className="w-full text-left p-3 hover:bg-accent/40 transition-colors group"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-medium truncate flex items-center gap-1">
                          {s.deviceName || s.deviceId}
                          <ArrowUpRight className="h-3 w-3 opacity-0 group-hover:opacity-100 transition-opacity text-primary" />
                        </span>
                        <Badge
                          variant="outline"
                          className={`text-[10px] ${STATUS_BADGE[s.status] || ""}`}
                        >
                          {s.status}
                        </Badge>
                      </div>
                      <div className="text-[10px] text-muted-foreground flex items-center gap-2 mt-0.5">
                        <Clock className="h-2.5 w-2.5" />
                        {fmtDate(s.startTime)}
                        <span>·</span>
                        {fmtNumber(s.pointCount)} тчк
                        <span>·</span>
                        {fmtBytes(s.payloadBytes)}
                      </div>
                    </button>
                  </motion.li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Activity heatmap */}
      {stats?.heatmapSessions && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center gap-2">
              <TrendingUp className="h-4 w-4 text-primary" /> Активность
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ActivityHeatmap sessions={stats.heatmapSessions} weeks={12} />
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
  subtitle,
  spark,
  color,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | null;
  subtitle?: string;
  spark?: string | null;
  color: "emerald" | "teal" | "amber" | "zinc";
}) {
  const colors = {
    emerald: {
      bg: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
      spark: "stroke-emerald-500",
      fill: "fill-emerald-500/10",
    },
    teal: {
      bg: "bg-teal-500/10 text-teal-700 dark:text-teal-400",
      spark: "stroke-teal-500",
      fill: "fill-teal-500/10",
    },
    amber: {
      bg: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
      spark: "stroke-amber-500",
      fill: "fill-amber-500/10",
    },
    zinc: {
      bg: "bg-zinc-500/10 text-zinc-700 dark:text-zinc-400",
      spark: "stroke-zinc-500",
      fill: "fill-zinc-500/10",
    },
  };
  const c = colors[color];
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      whileHover={{ y: -2 }}
      transition={{ type: "spring", stiffness: 300, damping: 20 }}
      className="rounded-xl border bg-card p-4 space-y-2 relative overflow-hidden group"
    >
      <div className="flex items-start justify-between">
        <div className={`inline-flex p-1.5 rounded-lg ${c.bg}`}>{icon}</div>
        {spark && (
          <svg viewBox="0 0 100 28" className="w-16 h-7" preserveAspectRatio="none">
            <path d={`${spark} L 100 28 L 0 28 Z`} className={c.fill} />
            <path d={spark} className={c.spark} fill="none" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
      </div>
      <div className="space-y-0.5">
        <div className="text-xs text-muted-foreground truncate">{label}</div>
        <div className="text-xl font-semibold tabular-nums">
          {value === null ? <Skeleton className="h-5 w-16 shimmer" /> : value}
        </div>
        {subtitle && (
          <div className="text-[10px] text-muted-foreground truncate">{subtitle}</div>
        )}
      </div>
    </motion.div>
  );
}

// Подгрузка последней сессии для мини-карты.
function LastSessionMap({
  sessionId,
  onOpen,
}: {
  sessionId: string;
  onOpen: () => void;
}) {
  const [points, setPoints] = React.useState<
    Array<{ lat: number; lon: number; speed?: number | null }> | null
  >(null);
  const [meta, setMeta] = React.useState<{ speed?: number | null; dist: number; duration?: number } | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    setPoints(null);
    import("@/lib/api-client").then(({ api }) => {
      api
        .get<{
          points: Array<{ lat: number; lon: number; speed?: number | null; timestamp: number }>;
          startTime: string;
          endTime?: string | null;
        }>(`/api/sessions/${sessionId}`)
        .then((res) => {
          if (cancelled) return;
          const pts = (res.points || []).map((p) => ({ lat: p.lat, lon: p.lon, speed: p.speed }));
          setPoints(pts);
          setMeta({
            speed: avgSpeed(res.points),
            dist: trackDistance(pts),
            duration: res.endTime
              ? (new Date(res.endTime).getTime() - new Date(res.startTime).getTime()) / 1000
              : undefined,
          });
        })
        .catch(() => {
          if (!cancelled) setPoints([]);
        });
    });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  if (points === null) {
    return <Skeleton className="h-[260px] w-full rounded-lg shimmer" />;
  }
  if (points.length === 0) {
    return (
      <div className="h-[260px] rounded-lg bg-muted/40 flex items-center justify-center text-sm text-muted-foreground border border-dashed">
        Нет GPS-точек
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <MapTrack points={points} height="260px" fitToPoints />
      <div className="grid grid-cols-3 gap-3 text-xs">
        <div className="rounded-lg bg-muted/40 p-2">
          <div className="text-muted-foreground text-[10px] mb-0.5">Ср. скорость</div>
          <div className="font-semibold tabular-nums">
            {meta?.speed != null ? `${fmtNumber(meta.speed, 1)} км/ч` : "—"}
          </div>
        </div>
        <div className="rounded-lg bg-muted/40 p-2">
          <div className="text-muted-foreground text-[10px] mb-0.5">Дистанция</div>
          <div className="font-semibold tabular-nums">
            {meta && meta.dist > 0 ? `${fmtNumber(meta.dist / 1000, 2)} км` : "—"}
          </div>
        </div>
        <div className="rounded-lg bg-muted/40 p-2">
          <div className="text-muted-foreground text-[10px] mb-0.5">Длительность</div>
          <div className="font-semibold tabular-nums">
            {meta?.duration ? formatDuration(meta.duration) : "—"}
          </div>
        </div>
      </div>
      <Button size="sm" variant="outline" onClick={onOpen} className="w-full">
        Подробнее о сессии <ChevronRight className="h-3 w-3" />
      </Button>
    </div>
  );
}

function formatDuration(sec: number): string {
  if (sec < 60) return `${Math.round(sec)}с`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  if (m < 60) return `${m}м ${s}с`;
  const h = Math.floor(m / 60);
  return `${h}ч ${m % 60}м`;
}
