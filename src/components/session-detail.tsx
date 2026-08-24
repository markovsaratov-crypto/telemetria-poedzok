"use client";

// src/components/session-detail.tsx — детали сессии: карта с треком, метаданные, удаление, экспорт.

import * as React from "react";
import dynamic from "next/dynamic";
import { motion } from "framer-motion";
import {
  Trash2,
  Download,
  Clock,
  Activity,
  HardDrive,
  Gauge,
  Route as RouteIcon,
  MapPin,
  AlertCircle,
} from "lucide-react";
import { toast } from "sonner";
import { useSession, useDeleteSession } from "@/lib/hooks";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
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
import { SessionNotes } from "@/components/session-notes";
import { SessionReplay } from "@/components/session-replay";
import { SessionStatsCard } from "@/components/session-stats-card";
import { fmtDate, fmtDuration, fmtBytes, fmtNumber, avgSpeed, trackDistance } from "@/lib/format";

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

  if (!sessionId) {
    return (
      <div className="h-full flex items-center justify-center p-8 text-center">
        <div className="space-y-2">
          <MapPin className="h-10 w-10 mx-auto text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">
            Выберите сессию слева, чтобы увидеть детали и трек на карте
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
        <div className="grid grid-cols-2 gap-2">
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
        </div>
      </div>
    );
  }

  if (error || !session) {
    return (
      <div className="h-full flex items-center justify-center p-8 text-center">
        <div className="space-y-2 text-destructive">
          <AlertCircle className="h-10 w-10 mx-auto" />
          <p className="text-sm">Не удалось загрузить сессию</p>
          <p className="text-xs text-muted-foreground">
            {(error as Error)?.message || "Сессия не найдена"}
          </p>
        </div>
      </div>
    );
  }

  const points = session.points || [];
  const durationMs =
    session.startTime && session.endTime
      ? new Date(session.endTime).getTime() - new Date(session.startTime).getTime()
      : null;
  const speed = avgSpeed(points);
  const distance = trackDistance(points);
  const trafficStatus =
    (session.traffic?.status as string) ||
    (session.traffic?.trafficFetched ? "completed" : "pending");

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
              <Button size="sm" variant="outline">
                <Download className="h-3.5 w-3.5" /> Экспорт
              </Button>
            </ExportDialog>
            <ShareDialog sessionId={session.id} />
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button size="sm" variant="outline" className="text-destructive hover:bg-destructive/10">
                  <Trash2 className="h-3.5 w-3.5" /> Удалить
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Удалить сессию?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Сессия будет помечена как удалённая (soft-delete). Через grace-период (30 дней) данные
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
                        toast.success("Сессия помечена как удалённая");
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
      <div className="p-4">
        {points.length > 0 ? (
          <MapTrack points={points} height="360px" fitToPoints />
        ) : (
          <div className="h-[200px] rounded-lg bg-muted flex items-center justify-center text-sm text-muted-foreground">
            <MapPin className="h-5 w-5 mr-2" /> В сессии нет GPS-точек
          </div>
        )}
      </div>

      {/* Графики скорости и высоты */}
      {points.length > 1 && (
        <>
          <div className="px-4 pb-4 grid grid-cols-1 lg:grid-cols-2 gap-3">
            <Card>
              <CardContent className="p-3">
                <SpeedChart points={points} height={120} />
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-3">
                <ElevationChart points={points} height={120} />
              </CardContent>
            </Card>
          </div>
          {/* Speed histogram */}
          <div className="px-4 pb-4">
            <Card>
              <CardContent className="p-3">
                <SpeedHistogram points={points} height={100} />
              </CardContent>
            </Card>
          </div>
          {/* Session replay */}
          <div className="px-4 pb-4">
            <SessionReplay points={points} />
          </div>
        </>
      )}

      {/* Метрики */}
      <div className="px-4 pb-4 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
        <MetricCard
          icon={<Clock className="h-4 w-4" />}
          label="Начало"
          value={fmtDate(session.startTime)}
        />
        <MetricCard
          icon={<Clock className="h-4 w-4" />}
          label="Длительность"
          value={fmtDuration(durationMs)}
        />
        <MetricCard
          icon={<Activity className="h-4 w-4" />}
          label="Точек"
          value={fmtNumber(session.pointCount)}
        />
        <MetricCard
          icon={<Gauge className="h-4 w-4" />}
          label="Ср. скорость"
          value={speed != null ? `${fmtNumber(speed, 1)} км/ч` : "—"}
        />
        <MetricCard
          icon={<RouteIcon className="h-4 w-4" />}
          label="Дистанция"
          value={distance > 0 ? `${fmtNumber(distance / 1000, 2)} км` : "—"}
        />
        <MetricCard
          icon={<HardDrive className="h-4 w-4" />}
          label="Размер"
          value={fmtBytes(session.payloadBytes)}
        />
        <MetricCard
          icon={<Activity className="h-4 w-4" />}
          label="Пробки"
          value={
            trafficStatus === "completed"
              ? "Готово"
              : trafficStatus === "pending"
              ? "В очереди"
              : trafficStatus === "failed"
              ? "Ошибка"
              : trafficStatus === "running"
              ? "Обработка"
              : trafficStatus
          }
        />
        <MetricCard
          icon={<MapPin className="h-4 w-4" />}
          label="Маршрут"
          value={session.route?.name || "—"}
        />
      </div>

      {/* Детальная статистика */}
      <div className="px-4 pb-4">
        <SessionStatsCard sessionId={session.id} />
      </div>

      {/* Заметки и теги */}
      <div className="px-4 pb-4">
        <SessionNotes
          sessionId={session.id}
          initialNotes={session.notes}
          initialTags={session.tags}
        />
      </div>

      {/* Точки (превью первые/последние) */}
      {points.length > 0 && (
        <div className="px-4 pb-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Точки трека</CardTitle>
              <CardDescription className="text-xs">
                Всего {fmtNumber(points.length)} точек. Показаны первые 5 и последние 5.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="overflow-x-auto scroll-telem">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-muted-foreground border-b">
                      <th className="py-1.5 pr-3">#</th>
                      <th className="py-1.5 pr-3">Широта</th>
                      <th className="py-1.5 pr-3">Долгота</th>
                      <th className="py-1.5 pr-3">Скорость</th>
                      <th className="py-1.5 pr-3">Высота</th>
                      <th className="py-1.5 pr-3">Время</th>
                    </tr>
                  </thead>
                  <tbody className="font-mono">
                    {points.slice(0, 5).map((p, i) => (
                      <tr key={`f-${i}`} className="border-b border-border/40">
                        <td className="py-1.5 pr-3 text-muted-foreground">{i + 1}</td>
                        <td className="py-1.5 pr-3">{p.lat.toFixed(6)}</td>
                        <td className="py-1.5 pr-3">{p.lon.toFixed(6)}</td>
                        <td className="py-1.5 pr-3">
                          {p.speed != null ? `${(p.speed * 3.6).toFixed(1)} км/ч` : "—"}
                        </td>
                        <td className="py-1.5 pr-3">{p.altitude != null ? `${p.altitude.toFixed(0)} м` : "—"}</td>
                        <td className="py-1.5 pr-3">
                          {new Date(p.timestamp).toLocaleTimeString("ru-RU")}
                        </td>
                      </tr>
                    ))}
                    {points.length > 10 && (
                      <tr>
                        <td colSpan={6} className="py-2 text-center text-muted-foreground">
                          … {fmtNumber(points.length - 10)} точек …
                        </td>
                      </tr>
                    )}
                    {points.length > 5 &&
                      points.slice(-5).map((p, i) => (
                        <tr key={`l-${i}`} className="border-b border-border/40">
                          <td className="py-1.5 pr-3 text-muted-foreground">
                            {points.length - 5 + i + 1}
                          </td>
                          <td className="py-1.5 pr-3">{p.lat.toFixed(6)}</td>
                          <td className="py-1.5 pr-3">{p.lon.toFixed(6)}</td>
                          <td className="py-1.5 pr-3">
                            {p.speed != null ? `${(p.speed * 3.6).toFixed(1)} км/ч` : "—"}
                          </td>
                          <td className="py-1.5 pr-3">{p.altitude != null ? `${p.altitude.toFixed(0)} м` : "—"}</td>
                          <td className="py-1.5 pr-3">
                            {new Date(p.timestamp).toLocaleTimeString("ru-RU")}
                          </td>
                        </tr>
                      ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </motion.div>
  );
}

function MetricCard({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <div className="rounded-lg border bg-card p-3 space-y-1">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {icon}
        <span className="truncate">{label}</span>
      </div>
      <div className="text-sm font-medium truncate">{value}</div>
    </div>
  );
}
