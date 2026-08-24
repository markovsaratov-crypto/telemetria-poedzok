"use client";

// src/components/dashboard-overview.tsx — вкладка "Обзор": статистика, мини-карта, последние сессии.

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
} from "lucide-react";
import { useSessions, useHealth } from "@/lib/hooks";
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

const MapTrack = dynamic(() => import("@/components/map-track"), {
  ssr: false,
  loading: () => (
    <div className="h-[260px] w-full rounded-lg bg-muted animate-pulse" />
  ),
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
  const sessions = data?.sessions || [];

  // Агрегаты
  const stats = React.useMemo(() => {
    const total = sessions.length;
    const points = sessions.reduce((a, s) => a + s.pointCount, 0);
    const bytes = sessions.reduce((a, s) => a + s.payloadBytes, 0);
    return { total, points, bytes };
  }, [sessions]);

  return (
    <div className="space-y-4">
      {/* Stats grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          icon={<Database className="h-4 w-4" />}
          label="Сессий (недавние)"
          value={isLoading ? null : fmtNumber(stats.total)}
          color="emerald"
        />
        <StatCard
          icon={<Activity className="h-4 w-4" />}
          label="Точек GPS"
          value={isLoading ? null : fmtNumber(stats.points)}
          color="teal"
        />
        <StatCard
          icon={<Gauge className="h-4 w-4" />}
          label="Объём данных"
          value={isLoading ? null : fmtBytes(stats.bytes)}
          color="amber"
        />
        <StatCard
          icon={<TrendingUp className="h-4 w-4" />}
          label="Uptime"
          value={health ? `${Math.round(health.uptime / 60)} мин` : null}
          color="zinc"
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Mini map (последняя сессия) */}
        <Card className="lg:col-span-2">
          <CardHeader>
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
              <div className="h-[260px] rounded-lg bg-muted flex items-center justify-center text-sm text-muted-foreground">
                <MapPin className="h-6 w-6 mr-2 opacity-30" /> Нет данных
              </div>
            )}
          </CardContent>
        </Card>

        {/* Recent sessions */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                <Clock className="h-4 w-4 text-primary" /> Последние
              </CardTitle>
              <Button size="sm" variant="ghost" onClick={onGoToSessions}>
                Все <ChevronRight className="h-3 w-3" />
              </Button>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {isLoading ? (
              <div className="p-3 space-y-2">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            ) : sessions.length === 0 ? (
              <div className="p-6 text-center text-sm text-muted-foreground">
                Сессий пока нет
              </div>
            ) : (
              <ul className="divide-y max-h-[280px] overflow-y-auto scroll-telem">
                {sessions.map((s, idx) => (
                  <motion.li
                    key={s.id}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: idx * 0.04 }}
                  >
                    <button
                      onClick={() => onOpenSession(s.id)}
                      className="w-full text-left p-3 hover:bg-accent/40 transition-colors"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-medium truncate">
                          {s.deviceName || s.deviceId}
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
                      </div>
                    </button>
                  </motion.li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
  color,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | null;
  color: "emerald" | "teal" | "amber" | "zinc";
}) {
  const colors = {
    emerald: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
    teal: "bg-teal-500/10 text-teal-700 dark:text-teal-400",
    amber: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
    zinc: "bg-zinc-500/10 text-zinc-700 dark:text-zinc-400",
  };
  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      className="rounded-xl border bg-card p-4 space-y-2"
    >
      <div className={`inline-flex p-1.5 rounded-lg ${colors[color]}`}>{icon}</div>
      <div className="space-y-0.5">
        <div className="text-xs text-muted-foreground">{label}</div>
        <div className="text-xl font-semibold tabular-nums">
          {value === null ? <Skeleton className="h-5 w-16" /> : value}
        </div>
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
  // Локальный запрос за точками (через api клиент)
  const [points, setPoints] = React.useState<
    Array<{ lat: number; lon: number }> | null
  >(null);
  const [speed, setSpeed] = React.useState<number | null>(null);
  const [dist, setDist] = React.useState<number>(0);

  React.useEffect(() => {
    let cancelled = false;
    setPoints(null);
    import("@/lib/api-client").then(({ api }) => {
      api
        .get<{ points: Array<{ lat: number; lon: number; speed?: number | null }> }>(
          `/api/sessions/${sessionId}`
        )
        .then((res) => {
          if (cancelled) return;
          const pts = (res.points || []).map((p) => ({ lat: p.lat, lon: p.lon }));
          setPoints(pts);
          setSpeed(avgSpeed(res.points));
          setDist(trackDistance(pts));
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
    return <Skeleton className="h-[260px] w-full rounded-lg" />;
  }
  if (points.length === 0) {
    return (
      <div className="h-[260px] rounded-lg bg-muted flex items-center justify-center text-sm text-muted-foreground">
        Нет GPS-точек
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <MapTrack points={points} height="260px" fitToPoints />
      <div className="flex items-center gap-4 text-xs">
        <div>
          <span className="text-muted-foreground">Ср. скорость: </span>
          <span className="font-medium">
            {speed != null ? `${fmtNumber(speed, 1)} км/ч` : "—"}
          </span>
        </div>
        <div>
          <span className="text-muted-foreground">Дистанция: </span>
          <span className="font-medium">
            {dist > 0 ? `${fmtNumber(dist / 1000, 2)} км` : "—"}
          </span>
        </div>
        <Button size="sm" variant="outline" onClick={onOpen} className="ml-auto">
          Подробнее <ChevronRight className="h-3 w-3" />
        </Button>
      </div>
    </div>
  );
}
