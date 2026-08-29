"use client";

// src/components/session-detail.tsx — детали поездки: карта с треком, удаление, экспорт.
// v2.9.4: связка карта↔профили — hover/клик по спидограмме ставит акцентный маркер на карте,
// клик по карте двигает кросхейр графиков (общий ряд сэмплов speedProfile с lat/lng).

import * as React from "react";
import dynamic from "next/dynamic";
import { motion } from "framer-motion";
import {
  Trash2,
  Download,
  MapPin,
  AlertCircle,
  Route,
  Gauge,
} from "lucide-react";
import { toast } from "sonner";
import { useSession, useDeleteSession, useSessionStats } from "@/lib/hooks";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { ExportDialog } from "@/components/export-dialog";
import { ShareDialog } from "@/components/share-dialog";
import { SpeedChart, ElevationChart } from "@/components/speed-chart";
import { SpeedHistogram } from "@/components/speed-histogram";
import { SessionReplay } from "@/components/session-replay";
import { SessionStatsCard } from "@/components/session-stats-card";
import { fmtDate } from "@/lib/format";
import { cn } from "@/lib/utils";

const MapTrack = dynamic(() => import("@/components/map-track"), {
  ssr: false,
  loading: () => (
    <div className="h-[320px] w-full rounded-lg bg-muted animate-pulse flex items-center justify-center text-xs text-muted-foreground">
      Загрузка карты…
    </div>
  ),
});

const STATUS_LABEL: Record<string, string> = {
  active: "Активна",
  completed: "Завершена",
  archived: "Архив",
  deleted: "Удалена",
};

interface SessionDetailProps {
  sessionId: string | null;
  onClose?: () => void;
}

export function SessionDetail({ sessionId, onClose }: SessionDetailProps) {
  const { data: session, isLoading, error } = useSession(sessionId);
  const deleteMutation = useDeleteSession();
  const [exportOpen, setExportOpen] = React.useState(false);
  // v2.9.4: состояние связки карта↔графики
  const { data: stats } = useSessionStats(sessionId); // тот же query-кеш, что и в SessionStatsCard
  const [liveFocusIdx, setLiveFocusIdx] = React.useState<number | null>(null); // hover по графику
  const [pinnedIdx, setPinnedIdx] = React.useState<number | null>(null); // клик по графику
  const [mapClickIdx, setMapClickIdx] = React.useState<number | null>(null); // клик по карте
  const mapWrapRef = React.useRef<HTMLDivElement>(null);
  // v2.9.8: режим карты — обычный трек или тепловая карта скорости
  const [trackMode, setTrackMode] = React.useState<"plain" | "speed">("plain");

  // сброс фокуса при смене сессии
  React.useEffect(() => {
    setLiveFocusIdx(null);
    setPinnedIdx(null);
    setMapClickIdx(null);
  }, [sessionId]);

  const profile = (stats?.speedProfile ?? null) as Array<{
    t: number;
    v: number | null;
    st: 0 | 1 | 2;
    alt?: number | null;
    lat?: number;
    lng?: number;
  }> | null;

  // эффективный индекс фокуса: hover > закреплённая > клик по карте
  const focusIdx = liveFocusIdx ?? pinnedIdx ?? mapClickIdx ?? null;
  const focusSample = focusIdx != null && profile && profile[focusIdx]?.lat != null ? profile[focusIdx] : null;
  // маркер на карте: hover-точка (без пана) или закреплённая (с паном)
  const focusPoint = focusSample ? { lat: focusSample.lat as number, lon: focusSample.lng as number } : null;
  const panToFocus = pinnedIdx != null;

  // v2.9.4: клик по карте → ближайший сэмпл профиля → кросхейр на графиках
  const handleMapClick = React.useCallback(
    (lat: number, lon: number) => {
      if (!profile) return;
      let idx = 0;
      let best = Infinity;
      for (let i = 0; i < profile.length; i++) {
        const p = profile[i];
        if (p.lat == null || p.lng == null) continue;
        const d = (p.lat - lat) * (p.lat - lat) + (p.lng - lon) * (p.lng - lon);
        if (d < best) {
          best = d;
          idx = i;
        }
      }
      setMapClickIdx(idx);
      setPinnedIdx(null); // карта перезаписывает закрепление с графика
    },
    [profile]
  );

  // v2.9.4: закрепление с графика → показать карту с маркером
  const handlePin = React.useCallback(
    (idx: number | null) => {
      setPinnedIdx(idx);
      if (idx != null) {
        setMapClickIdx(null);
        mapWrapRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    },
    []
  );

  if (!sessionId) {
    return (
      <div className="h-full flex items-center justify-center p-8 text-center">
        <div className="space-y-2">
          <MapPin className="h-10 w-10 mx-auto text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">
            Выберите поездку слева, чтобы увидеть детали и трек на карте
          </p>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="p-4 space-y-3">
        <Skeleton className="h-8 w-1/2" />
        <Skeleton className="h-[320px] w-full" />
      </div>
    );
  }

  if (error || !session) {
    return (
      <div className="h-full flex items-center justify-center p-8 text-center">
        <div className="space-y-2 text-destructive">
          <AlertCircle className="h-10 w-10 mx-auto" />
          <p className="text-sm">Не удалось загрузить поездку</p>
          <p className="text-xs text-muted-foreground">
            {(error as Error)?.message || "Поездка не найдена"}
          </p>
        </div>
      </div>
    );
  }

  const points = session.points || [];
  // v2.9.8: есть ли данные о скорости (для тепловой карты трека).
  // Без useMemo: после условных return'ов хуки нельзя; проход по ≤4к точек дешёвый.
  const hasSpeedData = points.some((p) => p.speed != null && p.speed >= 0);

  return (
    <motion.div
      key={sessionId}
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      className="flex flex-col h-full overflow-y-auto scroll-telem"
    >
      {/* Header */}
      <div className="border-b p-4 space-y-2 bg-card">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0 space-y-1">
            <h2 className="text-lg font-semibold truncate">
              {session.deviceName || session.deviceId}
            </h2>
            <p className="text-xs text-muted-foreground font-mono truncate">
              {session.id}
            </p>
            <p className="text-[10px] text-muted-foreground">
              {fmtDate(session.startTime)}
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Badge variant="outline" className="text-xs">
              {STATUS_LABEL[session.status] || session.status}
            </Badge>
            <ExportDialog
              sessionId={session.id}
              pointCount={session.pointCount}
              open={exportOpen}
              onOpenChange={setExportOpen}
            >
              <button className="btn-soft">
                <Download className="h-3.5 w-3.5" /> Экспорт
              </button>
            </ExportDialog>
            <ShareDialog sessionId={session.id} />
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <button className="btn-soft text-destructive hover:border-destructive/40 hover:bg-destructive/10">
                  <Trash2 className="h-3.5 w-3.5" /> Удалить
                </button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Удалить поездку?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Поездка будет помечена как удалённая (soft-delete). Через grace-период (30 дней) данные
                    будут окончательно удалены. Это действие можно отменить администратором до истечения срока.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Отмена</AlertDialogCancel>
                  <AlertDialogAction
                    className="bg-destructive text-white hover:bg-destructive/90"
                    onClick={async () => {
                      try {
                        await deleteMutation.mutateAsync(session.id);
                        toast.success("Поездка помечена как удалённая");
                        onClose?.();
                      } catch (e) {
                        toast.error("Ошибка удаления", {
                          description: (e as Error).message,
                        });
                      }
                    }}
                  >
                    Удалить
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>
      </div>

      {/* Карта */}
      <div className="p-4" ref={mapWrapRef}>
        {points.length > 0 ? (
          <>
            {/* v2.9.8: переключатель режима трека — обычный / тепловая карта скорости */}
            {hasSpeedData && (
              <div className="flex items-center justify-end gap-1 mb-2" role="group" aria-label="Режим отображения трека">
                <button
                  onClick={() => setTrackMode("plain")}
                  className={cn(
                    "flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium rounded-md border transition-colors",
                    trackMode === "plain"
                      ? "bg-primary text-primary-foreground border-primary"
                      : "text-muted-foreground hover:text-foreground hover:bg-accent"
                  )}
                  title="Обычный трек"
                >
                  <Route className="h-3 w-3" /> Трек
                </button>
                <button
                  onClick={() => setTrackMode("speed")}
                  className={cn(
                    "flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-medium rounded-md border transition-colors",
                    trackMode === "speed"
                      ? "bg-primary text-primary-foreground border-primary"
                      : "text-muted-foreground hover:text-foreground hover:bg-accent"
                  )}
                  title="Тепловая карта скорости — цвет трека по скорости"
                >
                  <Gauge className="h-3 w-3" /> Скорость
                </button>
              </div>
            )}
            <MapTrack
              points={points}
              height="360px"
              fitToPoints
              focusPoint={focusPoint}
              panToFocus={panToFocus}
              onMapClick={profile ? handleMapClick : undefined}
              speedTrack={trackMode === "speed" && hasSpeedData ? points : null}
            />
          </>
        ) : (
          <div className="h-[200px] rounded-lg bg-muted flex items-center justify-center text-sm text-muted-foreground">
            <MapPin className="h-5 w-5 mr-2" /> В поездке нет GPS-точек
          </div>
        )}
      </div>

      {/* Графики скорости и высоты */}
      {points.length > 1 && (
        <>
          <div className="px-4 pb-4 grid grid-cols-1 lg:grid-cols-2 gap-3">
            <div className="rounded-lg border p-3 elev-1 bg-card">
              <SpeedChart points={points} height={120} />
            </div>
            <div className="rounded-lg border p-3 elev-1 bg-card">
              <ElevationChart points={points} height={120} />
            </div>
          </div>
          {/* Speed histogram (horizontal bullet chart) */}
          <div className="px-4 pb-4">
            <div className="rounded-lg border p-3 elev-1 bg-card">
              <SpeedHistogram points={points} height={100} />
            </div>
          </div>
          {/* Session replay */}
          <div className="px-4 pb-4">
            <SessionReplay points={points} />
          </div>
        </>
      )}

      {/* Детальная статистика */}
      <div className="px-4 pb-6">
        <SessionStatsCard
          sessionId={session.id}
          focusIdx={focusIdx}
          pinnedIdx={pinnedIdx}
          mapClickIdx={mapClickIdx}
          onHoverIdx={setLiveFocusIdx}
          onPinIdx={handlePin}
        />
      </div>
    </motion.div>
  );
}
