"use client";

// src/components/mobile/SessionDetail/SessionDetailScreen.tsx
// ТЗ §2.4: Экран 2 — Детали поездки + Карта
// Header + Map (240pt) + 6 MetricTiles + 5 tabs
// v2.9.5: связка карта↔график (как на десктопе v2.9.4): тап по графику →
// пульсирующий маркер на карте; тап по карте → кросхейр на графиках.
// v2.9.5: полноэкранный экран «Карта + профили» (кнопка развернуть).
// v2.9.5: вкладка «Сегменты» — реальные данные таймлайна (движение/стоянка/разрыв)
// вместо заглушки; список стоянок с переходом к точке на карте.

import * as React from "react";
import dynamic from "next/dynamic";
import { motion } from "framer-motion";
import { ArrowLeft, MoreVertical, Maximize2, X, Clock, MapPin, AlertTriangle, Gauge, Route } from "lucide-react";
import { useSession, useSessionStats } from "@/lib/hooks";
import { MetricTile } from "../shared/MetricTile";
import { SpeedProfileChart, type SpeedProfilePointView } from "@/components/speed-profile-chart";
import { AltitudeProfileChart } from "@/components/altitude-profile-chart";
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

function fmtClock(startMs: number, tSec: number): string {
  const d = new Date(startMs + tSec * 1000);
  return d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

function fmtDur(sec: number): string {
  if (sec < 60) return `${Math.round(sec)}с`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  if (m < 60) return s === 0 ? `${m}м` : `${m}м ${s}с`;
  return `${Math.floor(m / 60)}ч ${m % 60}м`;
}

export function SessionDetailScreen({ sessionId, onBack }: SessionDetailScreenProps) {
  const [tab, setTab] = React.useState<DetailTab>("speed");
  const { data: session, isLoading } = useSession(sessionId);
  const { data: stats } = useSessionStats(sessionId);

  const points = (session as any)?.points || [];
  const profile = (stats?.speedProfile as SpeedProfilePointView[] | undefined) ?? undefined;
  const startMs = stats?.startTime ? new Date(stats.startTime).getTime() : 0;

  // v2.9.5: связка карта↔график (паритет с десктопом)
  const [pinnedIdx, setPinnedIdx] = React.useState<number | null>(null);
  const [mapClickIdx, setMapClickIdx] = React.useState<number | null>(null);
  const [mapFullscreen, setMapFullscreen] = React.useState(false);
  const mapWrapRef = React.useRef<HTMLDivElement>(null);
  // v2.9.8: режим трека — обычный / тепловая карта скорости
  const [trackMode, setTrackMode] = React.useState<"plain" | "speed">("plain");
  const hasSpeedData = points.some((p: any) => p.speed != null && p.speed >= 0);
  const speedTrack = trackMode === "speed" && hasSpeedData ? points : null;

  // точка фокуса на карте — закреплённая точка графика (или тап по карте)
  const focusSample = pinnedIdx != null && profile ? profile[pinnedIdx] : null;
  const focusPoint = focusSample?.lat != null && focusSample?.lng != null
    ? { lat: focusSample.lat, lon: focusSample.lng }
    : null;

  // тап по графику: закрепить точку + показать на карте (скролл к карте)
  const handlePin = React.useCallback((idx: number | null) => {
    setPinnedIdx(idx);
    if (idx != null) {
      setMapClickIdx(null);
      mapWrapRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, []);

  // тап по карте: ближайший сэмпл по lat/lng → кросхейр на графиках
  const handleMapClick = React.useCallback((lat: number, lon: number) => {
    if (!profile || profile.length === 0) return;
    let idx = 0;
    let best = Infinity;
    for (let i = 0; i < profile.length; i++) {
      const s = profile[i];
      if (s.lat == null || s.lng == null) continue;
      const d = (s.lat - lat) ** 2 + (s.lng - lon) ** 2;
      if (d < best) { best = d; idx = i; }
    }
    setMapClickIdx(idx);
  }, [profile]);

  const linkProps = {
    onPinIdx: handlePin,
    onHoverIdx: undefined,
    externalIdx: mapClickIdx,
    pinnedIdx,
  };

  return (
    <div className="flex flex-col h-full pb-16">
      {/* Header (56pt) */}
      <header className="sticky top-0 z-20 bg-card/95 backdrop-blur-md border-b safe-top">
        <div className="flex items-center justify-between px-2 h-14">
          <button onClick={onBack} className="flex items-center gap-1 p-2 min-w-[44px] min-h-[44px]" aria-label="Назад">
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div className="flex-1 text-center">
            <div className="text-sm font-medium truncate">
              {session ? new Date(session.startTime).toLocaleDateString("ru-RU", { day: "numeric", month: "short" }) : "Загрузка..."}
            </div>
            {stats && <div className="text-[11px] text-muted-foreground">{Math.round(stats.duration / 60)} мин</div>}
          </div>
          <button className="p-2 min-w-[44px] min-h-[44px]" aria-label="Ещё">
            <MoreVertical className="h-5 w-5 text-muted-foreground" />
          </button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto scroll-telem">
        {/* Map (240pt) — v2.9.5: кнопка развернуть + маркер фокуса */}
        <div className="relative h-[240px] bg-muted" ref={mapWrapRef}>
          {isLoading ? (
            <Skeleton className="h-full w-full shimmer" />
          ) : points.length > 0 ? (
            <MapTrack
              points={points}
              height="240px"
              fitToPoints
              focusPoint={focusPoint}
              panToFocus={pinnedIdx != null}
              onMapClick={profile && profile.length > 0 ? handleMapClick : undefined}
              speedTrack={speedTrack}
            />
          ) : (
            <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
              Нет GPS данных
            </div>
          )}
          {/* v2.9.8: компактный переключатель режима трека (иконки) */}
          {points.length > 0 && hasSpeedData && (
            <div
              className="absolute top-2 left-1/2 -translate-x-1/2 z-[1001] flex rounded-lg bg-background/95 backdrop-blur-sm border shadow-sm p-0.5"
              role="group"
              aria-label="Режим трека"
            >
              <button
                onClick={() => setTrackMode("plain")}
                className={cn(
                  "flex items-center justify-center w-9 h-9 rounded-md transition-colors min-w-[36px]",
                  trackMode === "plain"
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground active:bg-accent"
                )}
                aria-label="Обычный трек"
                title="Обычный трек"
              >
                <Route className="h-4 w-4" />
              </button>
              <button
                onClick={() => setTrackMode("speed")}
                className={cn(
                  "flex items-center justify-center w-9 h-9 rounded-md transition-colors min-w-[36px]",
                  trackMode === "speed"
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground active:bg-accent"
                )}
                aria-label="Тепловая карта скорости"
                title="Тепловая карта скорости"
              >
                <Gauge className="h-4 w-4" />
              </button>
            </div>
          )}
          {/* v2.9.5: полноэкранный режим карты */}
          {points.length > 0 && (
            <button
              onClick={() => setMapFullscreen(true)}
              className="absolute bottom-3 right-3 z-[1001] flex items-center gap-1.5 px-3 py-2 rounded-lg bg-background/95 backdrop-blur-sm border shadow-sm text-[11px] font-medium min-h-[36px]"
              aria-label="Развернуть карту"
            >
              <Maximize2 className="h-3.5 w-3.5" />
              Во весь экран
            </button>
          )}
        </div>

        {/* v2.9.5: индикатор закреплённой точки (подсказка связки) */}
        {pinnedIdx != null && profile && profile[pinnedIdx] && (
          <div className="mx-4 mt-2 flex items-center gap-2 rounded-lg border bg-primary/5 px-3 py-2 text-[11px]">
            <MapPin className="h-3.5 w-3.5 shrink-0 text-primary" />
            <span className="text-muted-foreground">Точка закреплена:</span>
            <span className="font-semibold tabular-nums">
              {startMs > 0 ? fmtClock(startMs, profile[pinnedIdx].t) : `+${fmtDur(profile[pinnedIdx].t)}`}
            </span>
            {profile[pinnedIdx].v != null && (
              <span className="tabular-nums text-muted-foreground">· {profile[pinnedIdx].v} км/ч</span>
            )}
            <button
              onClick={() => setPinnedIdx(null)}
              className="ml-auto p-1 -m-1 shrink-0"
              aria-label="Открепить точку"
            >
              <X className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
          </div>
        )}

        {/* Metric tiles (6, 3 in row) — v2.9: поля из methodology/route (были top-level в v2.7) */}
        {stats && (
          <div className="grid grid-cols-3 gap-2 p-4">
            <MetricTile label="Длительность" value={Math.round(stats.duration / 60)} unit="мин" />
            <MetricTile label="Дистанция" value={(stats.distance / 1000).toFixed(1)} unit="км" />
            <MetricTile label="Ср. скорость" value={stats.avgSpeed ? Math.round(stats.avgSpeed * 3.6) : "—"} unit="км/ч" />
            <MetricTile
              label="EcoScore"
              value={stats.methodology?.ecoScore?.value ?? "—"}
              status={
                stats.methodology?.ecoScore?.value == null ? "neutral"
                : stats.methodology.ecoScore.value! >= 80 ? "success"
                : stats.methodology.ecoScore.value! >= 60 ? "warning"
                : "error"
              }
            />
            <MetricTile
              label="Отклонение"
              value={
                stats.route?.durationDeviationPct != null
                  ? `${stats.route.durationDeviationPct > 0 ? "+" : ""}${stats.route.durationDeviationPct.toFixed(0)}%`
                  : "—"
              }
              status={Math.abs(stats.route?.durationDeviationPct ?? 0) > 10 ? "error" : "neutral"}
            />
            <MetricTile label="В пробках" value={stats.methodology?.timeInTraffic ? Math.round(stats.methodology.timeInTraffic / 60) : "—"} unit="мин" />
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
          {tab === "speed" && <SpeedTabContent points={points} stats={stats} linkProps={linkProps} />}
          {tab === "segments" && <SegmentsTabContent stats={stats} profile={profile} startMs={startMs} onFocusStop={handlePin} />}
          {tab === "deviations" && <DeviationsTabContent stats={stats} />}
          {tab === "altitude" && <AltitudeTabContent points={points} stats={stats} linkProps={linkProps} />}
          {tab === "summary" && <SummaryTabContent stats={stats} />}
        </div>
      </div>

      {/* v2.9.5: полноэкранный экран «Карта + профили» */}
      {mapFullscreen && (
        <FullscreenMapScreen
          points={points}
          stats={stats}
          onClose={() => setMapFullscreen(false)}
          pinnedIdx={pinnedIdx}
          mapClickIdx={mapClickIdx}
          onPin={handlePin}
          onMapClick={handleMapClick}
          speedTrack={speedTrack}
          trackMode={trackMode}
          onTrackModeChange={setTrackMode}
          hasSpeedData={hasSpeedData}
        />
      )}
    </div>
  );
}

// === v2.9.5: полноэкранный экран карты с профилями снизу ===
function FullscreenMapScreen({
  points,
  stats,
  onClose,
  pinnedIdx,
  mapClickIdx,
  onPin,
  onMapClick,
  speedTrack,
  trackMode,
  onTrackModeChange,
  hasSpeedData,
}: {
  points: any[];
  stats: any;
  onClose: () => void;
  pinnedIdx: number | null;
  mapClickIdx: number | null;
  onPin: (idx: number | null) => void;
  onMapClick: (lat: number, lon: number) => void;
  // v2.9.8: тепловая карта скорости — общая с основным экраном
  speedTrack: any[] | null;
  trackMode: "plain" | "speed";
  onTrackModeChange: (m: "plain" | "speed") => void;
  hasSpeedData: boolean;
}) {
  const profile = (stats?.speedProfile as SpeedProfilePointView[] | undefined) ?? undefined;
  const focusSample = pinnedIdx != null && profile ? profile[pinnedIdx] : null;
  const focusPoint = focusSample?.lat != null && focusSample?.lng != null
    ? { lat: focusSample.lat, lon: focusSample.lng }
    : null;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[60] bg-background flex flex-col safe-top"
      role="dialog"
      aria-label="Карта и профили поездки"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-2 h-14 border-b shrink-0">
        <div className="px-2 text-sm font-semibold">
          Карта · профили
          {stats && <span className="ml-2 text-[11px] font-normal text-muted-foreground">{(stats.distance / 1000).toFixed(1)} км</span>}
        </div>
        <button onClick={onClose} className="p-2 m-1 min-w-[44px] min-h-[44px] flex items-center justify-center" aria-label="Закрыть">
          <X className="h-5 w-5" />
        </button>
      </div>

      {/* Map — flex-1 */}
      <div className="flex-1 min-h-0 relative">
        <MapTrack
          points={points}
          height="100%"
          fitToPoints
          focusPoint={focusPoint}
          panToFocus={pinnedIdx != null}
          onMapClick={profile && profile.length > 0 ? onMapClick : undefined}
          speedTrack={speedTrack}
        />
        {/* v2.9.8: переключатель режима трека в полноэкранной карте */}
        {hasSpeedData && (
          <div
            className="absolute top-2 left-1/2 -translate-x-1/2 z-[1001] flex rounded-lg bg-background/95 backdrop-blur-sm border shadow-sm p-0.5"
            role="group"
            aria-label="Режим трека"
          >
            <button
              onClick={() => onTrackModeChange("plain")}
              className={cn(
                "flex items-center justify-center w-9 h-9 rounded-md transition-colors min-w-[36px]",
                trackMode === "plain"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground active:bg-accent"
              )}
              aria-label="Обычный трек"
              title="Обычный трек"
            >
              <Route className="h-4 w-4" />
            </button>
            <button
              onClick={() => onTrackModeChange("speed")}
              className={cn(
                "flex items-center justify-center w-9 h-9 rounded-md transition-colors min-w-[36px]",
                trackMode === "speed"
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground active:bg-accent"
              )}
              aria-label="Тепловая карта скорости"
              title="Тепловая карта скорости"
            >
              <Gauge className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>

      {/* Профили снизу — связаны с картой */}
      <div className="shrink-0 border-t bg-card px-3 pt-2 pb-3 space-y-2 max-h-[46vh] overflow-y-auto scroll-telem">
        {profile && profile.length >= 2 ? (
          <>
            <SpeedProfileChart
              profile={profile}
              startIso={stats?.startTime}
              avgKmh={stats?.avgSpeed != null ? stats.avgSpeed * 3.6 : null}
              maxKmh={stats?.maxSpeed != null ? stats.maxSpeed * 3.6 : null}
              height={150}
              compact
              onPinIdx={onPin}
              externalIdx={mapClickIdx}
              pinnedIdx={pinnedIdx}
            />
            {stats?.hasAltitude && (
              <AltitudeProfileChart
                profile={profile}
                startIso={stats?.startTime}
                height={120}
                compact
                onPinIdx={onPin}
                externalIdx={mapClickIdx}
                pinnedIdx={pinnedIdx}
              />
            )}
          </>
        ) : (
          <div className="text-xs text-muted-foreground py-6 text-center">Недостаточно данных</div>
        )}
      </div>
    </motion.div>
  );
}

// === Tab contents ===

function SpeedTabContent({ points, stats, linkProps }: { points: any[]; stats: any; linkProps: any }) {
  const maxSpeed = stats?.maxSpeed ? Math.round(stats.maxSpeed * 3.6) : 0;
  const avgSpeed = stats?.avgSpeed ? Math.round(stats.avgSpeed * 3.6) : 0;
  const profile = stats?.speedProfile as SpeedProfilePointView[] | undefined;

  return (
    <div className="space-y-3">
      {/* Speed metrics */}
      <div className="flex gap-4 text-xs">
        <div><span className="text-muted-foreground">Макс: </span><span className="font-bold tabular-nums">{maxSpeed} км/ч</span></div>
        <div><span className="text-muted-foreground">Сред: </span><span className="font-bold tabular-nums">{avgSpeed} км/ч</span></div>
        {stats?.methodology?.timeAtCruise != null && (
          <div><span className="text-muted-foreground">Круиз: </span><span className="font-bold tabular-nums">{Math.round(stats.methodology.timeAtCruise / 60)} мин</span></div>
        )}
      </div>
      {/* v2.9.3: спидограмма — общий компонент с таймлайном состояний и кросхейром.
          v2.9.5: связка с картой — тап по графику закрепляет точку (маркер на карте) */}
      {profile && profile.length >= 2 ? (
        <SpeedProfileChart
          profile={profile}
          startIso={stats?.startTime}
          avgKmh={stats?.avgSpeed != null ? stats.avgSpeed * 3.6 : null}
          maxKmh={stats?.maxSpeed != null ? stats.maxSpeed * 3.6 : null}
          height={150}
          compact
          {...linkProps}
        />
      ) : (
        <div className="text-xs text-muted-foreground py-8 text-center">
          Недостаточно данных о скорости
        </div>
      )}
      {/* v2.9.4: высотный профиль (сглаженный, общий компонент) под спидограммой */}
      {stats?.hasAltitude && profile && profile.length >= 2 && (
        <AltitudeProfileChart
          profile={profile}
          startIso={stats?.startTime}
          height={120}
          compact
          {...linkProps}
        />
      )}
      {/* v2.9.5: подсказка связки */}
      {profile && profile.length >= 2 && (
        <p className="text-[10px] text-muted-foreground text-center">
          Нажмите на график — точка появится на карте выше
        </p>
      )}
    </div>
  );
}

// === v2.9.5: Сегменты — реальный таймлайн движения/стоянок/разрывов (§4.6) ===
interface SegRun { st: 0 | 1 | 2; t0: number; t1: number; idx0: number; idx1: number; }

function computeRuns(profile: SpeedProfilePointView[]): SegRun[] {
  const runs: SegRun[] = [];
  let start = 0;
  for (let i = 1; i <= profile.length; i++) {
    if (i === profile.length || profile[i].st !== profile[start].st) {
      runs.push({
        st: profile[start].st,
        t0: profile[start].t,
        t1: profile[Math.min(i, profile.length - 1)].t,
        idx0: start,
        idx1: Math.min(i, profile.length - 1),
      });
      start = i;
    }
  }
  return runs;
}

function SegmentsTabContent({
  stats,
  profile,
  startMs,
  onFocusStop,
}: {
  stats: any;
  profile?: SpeedProfilePointView[];
  startMs: number;
  onFocusStop: (idx: number | null) => void;
}) {
  if (!profile || profile.length < 2) {
    return <div className="text-xs text-muted-foreground py-8 text-center">Нет данных сегментов</div>;
  }

  const runs = computeRuns(profile);
  const totalT = Math.max(profile[profile.length - 1].t, 1);
  const sumBy = (st: 0 | 1 | 2) => runs.filter(r => r.st === st).reduce((a, r) => a + (r.t1 - r.t0), 0);
  const moving = sumBy(1);
  const idle = sumBy(0);
  const gap = sumBy(2);

  // стоянки ≥ 60с — карточки с тапом → маркер на карте
  const stops = runs.filter(r => r.st === 0 && r.t1 - r.t0 >= 60);
  const gaps = runs.filter(r => r.st === 2);

  const STATE_META: Record<0 | 1 | 2, { label: string; bg: string; text: string }> = {
    1: { label: "Движение", bg: "bg-emerald-500/85", text: "text-emerald-700 dark:text-emerald-400" },
    0: { label: "Стоянка", bg: "bg-amber-400/85", text: "text-amber-700 dark:text-amber-400" },
    2: { label: "Разрыв", bg: "bg-red-500/85", text: "text-red-700 dark:text-red-400" },
  };

  return (
    <div className="space-y-4">
      {/* Сводка состояний */}
      <div className="grid grid-cols-3 gap-2">
        <div className="rounded-xl border bg-card p-2.5 text-center">
          <div className="text-lg font-bold tabular-nums leading-none">{fmtDur(moving)}</div>
          <div className="text-[10px] text-muted-foreground uppercase tracking-wide mt-1">в движении</div>
        </div>
        <div className="rounded-xl border bg-card p-2.5 text-center">
          <div className="text-lg font-bold tabular-nums leading-none">{fmtDur(idle)}</div>
          <div className="text-[10px] text-muted-foreground uppercase tracking-wide mt-1">стоянки</div>
        </div>
        <div className="rounded-xl border bg-card p-2.5 text-center">
          <div className="text-lg font-bold tabular-nums leading-none">{gap > 0 ? fmtDur(gap) : "0с"}</div>
          <div className="text-[10px] text-muted-foreground uppercase tracking-wide mt-1">разрывы</div>
        </div>
      </div>

      {/* Таймлайн-полоса (пропорционально времени) */}
      <div>
        <div className="flex items-center justify-between mb-2.5">
          <h4 className="text-xs font-semibold">Таймлайн поездки</h4>
          <div className="flex gap-2.5 text-[10px] text-muted-foreground">
            {([1, 0, 2] as const).map(st => (
              <span key={st} className="inline-flex items-center gap-1">
                <span className={cn("h-2 w-2 rounded-full", STATE_META[st].bg)} />
                {STATE_META[st].label.toLowerCase()}
              </span>
            ))}
          </div>
        </div>
        <div className="flex h-6 rounded-lg overflow-hidden border bg-muted/50">
          {runs.map((r, i) => {
            const w = ((r.t1 - r.t0) / totalT) * 100;
            if (w <= 0) return null;
            return (
              <button
                key={i}
                className={cn(STATE_META[r.st].bg, "h-full min-w-[2px] transition-opacity active:opacity-70")}
                style={{ width: `${w}%` }}
                onClick={() => onFocusStop(r.idx0)}
                aria-label={`${STATE_META[r.st].label}: ${startMs > 0 ? fmtClock(startMs, r.t0) : fmtDur(r.t0)} — ${fmtDur(r.t1 - r.t0)}`}
                title={`${STATE_META[r.st].label} · ${fmtDur(r.t1 - r.t0)}`}
              />
            );
          })}
        </div>
        <div className="flex justify-between mt-1 text-[10px] text-muted-foreground tabular-nums">
          <span>{startMs > 0 ? fmtClock(startMs, 0) : "0с"}</span>
          <span>{fmtDur(totalT)}</span>
        </div>
      </div>

      {/* Стоянки ≥ 1 мин */}
      {stops.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold mb-2 flex items-center gap-1.5">
            <Clock className="h-3.5 w-3.5 text-amber-500" />
            Стоянки ({stops.length})
          </h4>
          <div className="space-y-1.5">
            {stops.map((r, i) => (
              <button
                key={i}
                onClick={() => onFocusStop(Math.round((r.idx0 + r.idx1) / 2))}
                className="w-full flex items-center gap-3 rounded-lg border bg-card px-3 py-3 text-left active:bg-accent transition-colors"
              >
                <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-500/15 shrink-0">
                  <Clock className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                </span>
                <span className="flex-1 min-w-0">
                  <span className="block text-xs font-medium tabular-nums">
                    {startMs > 0 ? fmtClock(startMs, r.t0) : `+${fmtDur(r.t0)}`} — {startMs > 0 ? fmtClock(startMs, r.t1) : `+${fmtDur(r.t1)}`}
                  </span>
                  <span className="block text-[10px] text-muted-foreground">нажмите, чтобы увидеть место на карте</span>
                </span>
                <span className="text-sm font-bold tabular-nums text-amber-700 dark:text-amber-400 shrink-0">
                  {fmtDur(r.t1 - r.t0)}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Разрывы записи */}
      {gaps.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold mb-2 flex items-center gap-1.5">
            <AlertTriangle className="h-3.5 w-3.5 text-red-500" />
            Разрывы записи ({gaps.length})
          </h4>
          <div className="space-y-1.5">
            {gaps.map((r, i) => (
              <button
                key={i}
                onClick={() => onFocusStop(r.idx0)}
                className="w-full flex items-center gap-3 rounded-lg border bg-card px-3 py-2.5 text-left active:bg-accent transition-colors"
              >
                <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-red-500/15 shrink-0">
                  <AlertTriangle className="h-4 w-4 text-red-600 dark:text-red-400" />
                </span>
                <span className="flex-1 min-w-0 text-xs font-medium tabular-nums">
                  {startMs > 0 ? fmtClock(startMs, r.t0) : `+${fmtDur(r.t0)}`} — {startMs > 0 ? fmtClock(startMs, r.t1) : `+${fmtDur(r.t1)}`}
                </span>
                <span className="text-sm font-bold tabular-nums text-red-700 dark:text-red-400 shrink-0">
                  {fmtDur(r.t1 - r.t0)}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {stops.length === 0 && gaps.length === 0 && (
        <div className="flex items-center gap-2 rounded-lg border bg-card px-3 py-3 text-xs text-muted-foreground">
          <Gauge className="h-4 w-4 shrink-0 text-emerald-500" />
          Поездка без длительных стоянок и разрывов — равномерное движение
        </div>
      )}
    </div>
  );
}

function DeviationsTabContent({ stats }: { stats: any }) {
  const timeLost = stats?.route?.timeLostToTrafficSec ?? 0;
  return (
    <div className="space-y-3">
      {stats ? (
        <>
          <div className="flex justify-between text-xs">
            <span className="text-muted-foreground">Потери из-за пробок:</span>
            <span className="font-bold tabular-nums">{timeLost ? Math.round(timeLost / 60) : 0} мин</span>
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-muted-foreground">Точность прогноза:</span>
            <span className="font-bold tabular-nums">{stats.route?.durationDeviationPct != null ? `${stats.route.durationDeviationPct.toFixed(0)}%` : "—"}</span>
          </div>
          <div className="flex justify-between text-xs">
            <span className="text-muted-foreground">Время в пробках (&lt;10 км/ч):</span>
            <span className="font-bold tabular-nums">{stats.methodology?.timeInTraffic ? Math.round(stats.methodology.timeInTraffic / 60) : 0} мин</span>
          </div>
        </>
      ) : (
        <Skeleton className="h-20 w-full shimmer" />
      )}
    </div>
  );
}

function AltitudeTabContent({ points, stats, linkProps }: { points: any[]; stats: any; linkProps: any }) {
  const profile = stats?.speedProfile as SpeedProfilePointView[] | undefined;
  const altPoints = points.filter((p: any) => p.altitude != null);
  if (altPoints.length < 2 || !profile) {
    return <div className="text-xs text-muted-foreground py-8 text-center">Нет данных о высоте</div>;
  }
  const range = (stats?.elevationGain ?? 0) + (stats?.elevationLoss ?? 0);

  return (
    <div className="space-y-3">
      <div className="flex gap-4 text-xs">
        <div><span className="text-muted-foreground">Перепад: </span><span className="font-bold tabular-nums">{Math.round(range)} м</span></div>
        <div><span className="text-muted-foreground">Набор: </span><span className="font-bold tabular-nums">{stats?.elevationGain ? Math.round(stats.elevationGain) : "—"} м</span></div>
        <div><span className="text-muted-foreground">Снижение: </span><span className="font-bold tabular-nums">{stats?.elevationLoss ? Math.round(stats.elevationLoss) : "—"} м</span></div>
      </div>
      {/* v2.9.4: общий высотный профиль с кросхейром/тултипом вместо базового SVG.
          v2.9.5: связка с картой (тап → маркер на карте). */}
      <AltitudeProfileChart
        profile={profile}
        startIso={stats?.startTime}
        height={160}
        compact
        {...linkProps}
      />
    </div>
  );
}

function SummaryTabContent({ stats }: { stats: any }) {
  if (!stats) return <Skeleton className="h-40 w-full shimmer" />;
  const m = stats.methodology;
  const fmtMin = (s?: number | null) => (s != null && s > 0 ? `${Math.round(s / 60)} мин` : "—");
  const eco = m?.ecoScore?.value;
  const rel = m?.sessionReliability?.value;
  const groups = [
    { title: "Базовые", items: [
      { label: "Длительность", value: `${Math.round(stats.duration / 60)} мин` },
      { label: "Дистанция", value: `${(stats.distance / 1000).toFixed(2)} км` },
      { label: "Точек", value: stats.pointCount },
      { label: "В движении", value: fmtMin(stats.movingTime) },
      { label: "Стоянки", value: fmtMin(stats.idleTime) },
      { label: "Разрывы трека", value: m?.gapCount ? `${m.gapCount} (${fmtMin(m.gapTime)})` : "0" },
    ]},
    { title: "Активная поездка (v2.9)", items: [
      { label: "ActiveDuration", value: fmtMin(m?.activeTrip?.activeDuration) },
      { label: "До старта", value: fmtMin(m?.activeTrip?.preTripIdle) },
      { label: "После финиша", value: fmtMin(m?.activeTrip?.postTripIdle) },
    ]},
    { title: "Скорость", items: [
      { label: "Средняя", value: stats.avgSpeed ? `${Math.round(stats.avgSpeed * 3.6)} км/ч` : "—" },
      { label: "Максимальная", value: stats.maxSpeed ? `${Math.round(stats.maxSpeed * 3.6)} км/ч` : "—" },
      { label: "Медиана P50", value: m?.speedP50 != null ? `${Math.round(m.speedP50 * 3.6)} км/ч` : "—" },
    ]},
    { title: "Поведение (v2.9)", items: [
      { label: "EcoScore (CAP)", value: eco != null ? `${eco}/100` : "—" },
      { label: "AccelerationRMS", value: m?.accelerationRms != null ? `${m.accelerationRms.toFixed(2)} м/с²` : "—" },
      { label: "JerkRMS", value: m?.jerkRms != null ? `${m.jerkRms.toFixed(2)} м/с³` : "—" },
      { label: "Резкие торможения", value: m?.harshBrakingCount ?? 0 },
      { label: "Резкие разгоны", value: m?.harshAccelCount ?? 0 },
      { label: "Развороты / повороты", value: `${m?.uTurnCount ?? 0} / ${m?.turnCount ?? 0}` },
    ]},
    { title: "Качество (v2.9)", items: [
      { label: "SessionReliability", value: rel != null ? `${Math.round(rel * 100)}%` : "—" },
      { label: "Точность P90", value: m?.accuracyP90 != null ? `${Math.round(m.accuracyP90)} м` : "—" },
      { label: "Полнота записи", value: m?.completenessScore != null ? `${Math.round(m.completenessScore * 100)}%` : "—" },
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
