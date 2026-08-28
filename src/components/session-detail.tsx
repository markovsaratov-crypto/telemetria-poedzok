"use client";

// src/components/session-detail.tsx — детали поездки: карта с треком, удаление, экспорт.

import * as React from "react";
import dynamic from "next/dynamic";
import { motion } from "framer-motion";
import {
  Trash2,
  Download,
  MapPin,
  AlertCircle,
} from "lucide-react";
import { toast } from "sonner";
import { useSession, useDeleteSession } from "@/lib/hooks";
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
              <button className="inline-flex items-center gap-1 px-2.5 py-1 text-xs border rounded-md hover:bg-accent/30">
                <Download className="h-3.5 w-3.5" /> Экспорт
              </button>
            </ExportDialog>
            <ShareDialog sessionId={session.id} />
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <button className="inline-flex items-center gap-1 px-2.5 py-1 text-xs border rounded-md text-destructive hover:bg-destructive/10">
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
      <div className="p-4">
        {points.length > 0 ? (
          <MapTrack points={points} height="360px" fitToPoints />
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
            <div className="rounded-lg border p-3">
              <SpeedChart points={points} height={120} />
            </div>
            <div className="rounded-lg border p-3">
              <ElevationChart points={points} height={120} />
            </div>
          </div>
          {/* Speed histogram (horizontal bullet chart) */}
          <div className="px-4 pb-4">
            <div className="rounded-lg border p-3">
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
        <SessionStatsCard sessionId={session.id} />
      </div>
    </motion.div>
  );
}
