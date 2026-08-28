"use client";

// src/components/mobile/SessionDetail/SessionDetailScreen.tsx
// ТЗ §2.4: Экран 2 — Детали поездки + Карта
// Header + Map (240pt) + 6 MetricTiles + 5 tabs

import * as React from "react";
import dynamic from "next/dynamic";
import { motion } from "framer-motion";
import { ArrowLeft, MoreVertical, Download, Trash2 } from "lucide-react";
import { useSession, useSessionStats } from "@/lib/hooks";
import { MetricTile } from "../shared/MetricTile";
const MapTrack = dynamic(() => import("@/components/map-track"), { ssr: false, loading: () => <div className="h-full flex items-center justify-center text-xs text-muted-foreground">Загрузка карты…</div> });
import { Skeleton } from "@/components/ui/skeleton";


// Leaflet removed — using MapTrack instead
import { cn } from "@/lib/utils";




type DetailTab = "speed" | "segments" | "deviations" | "altitude" | "summary";

const TABS: { id: DetailTab; label: string }[] = [
  { id: "speed", label: "Скорость" },
  { id: "segments", label: "Сегменты" },
  { id: "deviations", label: "Отклонения" },
  { id: "altitude", label: "Высота" },
  { id: "summary", label: "Сводка" },
];

interface SessionDetailScreenProps {
  sessionId: string;
  onBack: () => void;
}



export function SessionDetailScreen({ sessionId, onBack }: SessionDetailScreenProps) {
  const [tab, setTab] = React.useState<DetailTab>("speed");
  const { data: session, isLoading } = useSession(sessionId);
  const { data: stats } = useSessionStats(sessionId);

  const points = (session as any)?.points || [];

  return (
    <div className="flex flex-col h-full pb-16">
      {/* Header (56pt) */}
      <header className="sticky top-0 z-20 bg-card/95 backdrop-blur-md border-b safe-top">
        <div className="flex items-center justify-between px-2 h-14">
          <button onClick={onBack} className="flex items-center gap-1 p-2 min-w-[44px] min-h-[44px]">
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div className="flex-1 text-center">
            <div className="text-sm font-medium truncate">
              {session ? new Date(session.startTime).toLocaleDateString("ru-RU", { day: "numeric", month: "short" }) : "Загрузка..."}
            </div>
            {stats && <div className="text-[11px] text-muted-foreground">{Math.round(stats.duration / 60)} мин</div>}
          </div>
          <button className="p-2 min-w-[44px] min-h-[44px]">
            <MoreVertical className="h-5 w-5 text-muted-foreground" />
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto scroll-telem">
        {/* Map (240pt) */}
        <div className="relative h-[240px] bg-muted">
          {isLoading ? (
            <Skeleton className="h-full w-full shimmer" />
          ) : points.length > 0 ? (
            <MapTrack points={points} height="240px" fitToPoints />
          ) : (
            <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
              Нет GPS данных
            </div>
          )}
        </div>

        {/* Metric tiles (6, 3 in row) */}
        {stats && (
          <div className="grid grid-cols-3 gap-2 p-4">
            <MetricTile label="Длительность" value={Math.round(stats.duration / 60)} unit="мин" />
            <MetricTile label="Дистанция" value={(stats.distance / 1000).toFixed(1)} unit="км" />
            <MetricTile label="Ср. скорость" value={stats.avgSpeed ? Math.round(stats.avgSpeed * 3.6) : "—"} unit="км/ч" />
            <MetricTile
              label="EcoScore"
              value={stats.ecoScore ?? "—"}
              status={stats.ecoScore >= 80 ? "success" : stats.ecoScore >= 60 ? "warning" : "error"}
            />
            <MetricTile
              label="Отклонение"
              value={stats.deviation ? `${stats.deviation > 0 ? "+" : ""}${stats.deviation.toFixed(0)}%` : "—"}
              status={Math.abs(stats.deviation || 0) > 10 ? "error" : "neutral"}
            />
            <MetricTile label="В пробках" value={stats.timeInTraffic ? Math.round(stats.timeInTraffic / 60) : "—"} unit="мин" />
          </div>
        )}

        {/* Tabs (segmented control) */}
        <div className="flex gap-1 px-4 pb-2 overflow-x-auto no-scrollbar">
          {TABS.map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                "shrink-0 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors min-h-[36px]",
                tab === t.id ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"
              )}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Tab content */}
        <div className="px-4 pb-4">
          {tab === "speed" && <SpeedTabContent points={points} stats={stats} />}
          {tab === "segments" && <SegmentsTabContent />}
          {tab === "deviations" && <DeviationsTabContent stats={stats} />}
          {tab === "altitude" && <AltitudeTabContent points={points} stats={stats} />}
          {tab === "summary" && <SummaryTabContent stats={stats} />}
        </div>
      </div>
    </div>
  );
}

// === Tab contents ===

function SpeedTabContent({ points, stats }: { points: any[]; stats: any }) {
  // Downsample for performance
  const sampled = points.length > 500 ? points.filter((_, i) => i % Math.ceil(points.length / 500) === 0) : points;
  const maxSpeed = stats?.maxSpeed ? Math.round(stats.maxSpeed * 3.6) : 0;
  const avgSpeed = stats?.avgSpeed ? Math.round(stats.avgSpeed * 3.6) : 0;

  return (
    <div className="space-y-3">
      {/* Speed metrics */}
      <div className="flex gap-4 text-xs">
        <div><span className="text-muted-foreground">Макс: </span><span className="font-bold tabular-nums">{maxSpeed} км/ч</span></div>
        <div><span className="text-muted-foreground">Сред: </span><span className="font-bold tabular-nums">{avgSpeed} км/ч</span></div>
      </div>
      {/* Speed chart (SVG) */}
      {sampled.length > 1 && (
        <svg viewBox="0 0 100 40" className="w-full h-[180px]" preserveAspectRatio="none">
          <defs>
            <linearGradient id="speedGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="oklch(0.55 0.18 350)" stopOpacity="0.4" />
              <stop offset="100%" stopColor="oklch(0.55 0.18 350)" stopOpacity="0" />
            </linearGradient>
          </defs>
          <motion.path
            d={(() => {
              const maxS = Math.max(...sampled.map(p => (p.speed || 0) * 3.6), 1);
              return sampled.map((p, i) => {
                const x = (i / (sampled.length - 1)) * 100;
                const y = 40 - ((p.speed || 0) * 3.6 / maxS) * 35;
                return `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
              }).join(" ") + ` L 100 40 L 0 40 Z`;
            })()}
            fill="url(#speedGrad)"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
          />
          <motion.path
            d={(() => {
              const maxS = Math.max(...sampled.map(p => (p.speed || 0) * 3.6), 1);
              return sampled.map((p, i) => {
                const x = (i / (sampled.length - 1)) * 100;
                const y = 40 - ((p.speed || 0) * 3.6 / maxS) * 35;
                return `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
              }).join(" ");
            })()}
            fill="none"
            stroke="oklch(0.55 0.18 350)"
            strokeWidth="0.8"
            initial={{ pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{ duration: 0.5 }}
          />
        </svg>
      )}
    </div>
  );
}

function SegmentsTabContent() {
  return (
    <div className="text-xs text-muted-foreground py-8 text-center">
      Сегментный анализ будет доступен после построения маршрута
    </div>
  );
}

function DeviationsTabContent({ stats }: { stats: any }) {
  return (
    <div className="space-y-3">
      {stats ? (
        <>
          <div className="flex justify-between text-xs">
            <span className="text-muted-foreground">Потери из-за пробок:</span>
            <span className="font-bold tabular-nums">{stats.timeInTraffic ? Math.round(stats.timeInTraffic / 60) : 0} мин</span>
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-muted-foreground">Точность прогноза:</span>
            <span className="font-bold tabular-nums">{stats.deviation ? `${stats.deviation.toFixed(0)}%` : "—"}</span>
          </div>
        </>
      ) : (
        <Skeleton className="h-20 w-full shimmer" />
      )}
    </div>
  );
}

function AltitudeTabContent({ points, stats }: { points: any[]; stats: any }) {
  const altPoints = points.filter(p => p.altitude != null);
  if (altPoints.length < 2) {
    return <div className="text-xs text-muted-foreground py-8 text-center">Нет данных о высоте</div>;
  }
  const sampled = altPoints.length > 500 ? altPoints.filter((_, i) => i % Math.ceil(altPoints.length / 500) === 0) : altPoints;
  const alts = sampled.map(p => p.altitude);
  const minAlt = Math.min(...alts);
  const maxAlt = Math.max(...alts);
  const range = maxAlt - minAlt || 1;

  return (
    <div className="space-y-3">
      <div className="flex gap-4 text-xs">
        <div><span className="text-muted-foreground">Перепад: </span><span className="font-bold tabular-nums">{Math.round(range)} м</span></div>
        <div><span className="text-muted-foreground">Набор: </span><span className="font-bold tabular-nums">{stats?.elevationGain ? Math.round(stats.elevationGain) : "—"} м</span></div>
      </div>
      <svg viewBox="0 0 100 30" className="w-full h-[120px]" preserveAspectRatio="none">
        <motion.path
          d={sampled.map((p, i) => {
            const x = (i / (sampled.length - 1)) * 100;
            const y = 30 - ((p.altitude - minAlt) / range) * 25;
            return `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
          }).join(" ") + ` L 100 30 L 0 30 Z`}
          fill="oklch(0.70 0.15 85 / 0.2)"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
        />
        <motion.path
          d={sampled.map((p, i) => {
            const x = (i / (sampled.length - 1)) * 100;
            const y = 30 - ((p.altitude - minAlt) / range) * 25;
            return `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
          }).join(" ")}
          fill="none"
          stroke="oklch(0.70 0.15 85)"
          strokeWidth="0.8"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 0.5 }}
        />
      </svg>
    </div>
  );
}

function SummaryTabContent({ stats }: { stats: any }) {
  if (!stats) return <Skeleton className="h-40 w-full shimmer" />;
  const groups = [
    { title: "Базовые", items: [
      { label: "Длительность", value: `${Math.round(stats.duration / 60)} мин` },
      { label: "Дистанция", value: `${(stats.distance / 1000).toFixed(2)} км` },
      { label: "Точек", value: stats.pointCount },
      { label: "В движении", value: stats.movingTime ? `${Math.round(stats.movingTime / 60)} мин` : "—" },
      { label: "Стоянки", value: stats.idleTime ? `${Math.round(stats.idleTime / 60)} мин` : "—" },
    ]},
    { title: "Скорость", items: [
      { label: "Средняя", value: stats.avgSpeed ? `${Math.round(stats.avgSpeed * 3.6)} км/ч` : "—" },
      { label: "Максимальная", value: stats.maxSpeed ? `${Math.round(stats.maxSpeed * 3.6)} км/ч` : "—" },
    ]},
    { title: "География", items: [
      { label: "Набор высоты", value: stats.elevationGain ? `${Math.round(stats.elevationGain)} м` : "—" },
      { label: "Снижение", value: stats.elevationLoss ? `${Math.round(stats.elevationLoss)} м` : "—" },
      { label: "Средняя высота", value: stats.avgAltitude ? `${Math.round(stats.avgAltitude)} м` : "—" },
    ]},
  ];
  return (
    <div className="space-y-4">
      {groups.map(g => (
        <div key={g.title}>
          <h3 className="text-sm font-semibold mb-2">{g.title}</h3>
          <div className="space-y-1">
            {g.items.map(item => (
              <div key={item.label} className="flex justify-between text-xs py-1 border-b border-border/40">
                <span className="text-muted-foreground">{item.label}</span>
                <span className="font-medium tabular-nums">{item.value}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
