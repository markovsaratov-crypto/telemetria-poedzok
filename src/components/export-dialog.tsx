"use client";

// src/components/export-dialog.tsx — экспорт GPX/KML/JSON.
// Маленькие сессии → sync (data URL), большие (>5000 точек) → async (poll /api/exports/[jobId]).

import * as React from "react";
import { motion } from "framer-motion";
import { Download, FileCode, FileText, FileJson, Loader2, CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useExportSession, usePollExport } from "@/lib/hooks";
import { fmtBytes } from "@/lib/format";
import { cn } from "@/lib/utils";

const FORMATS = [
  {
    id: "gpx" as const,
    name: "GPX",
    desc: "GPS Exchange Format — стандарт для навигаторов и карт",
    icon: FileCode,
    mime: "application/gpx+xml",
  },
  {
    id: "kml" as const,
    name: "KML",
    desc: "Keyhole Markup Language — Google Earth",
    icon: FileText,
    mime: "application/vnd.google-earth.kml+xml",
  },
  {
    id: "json" as const,
    name: "JSON",
    desc: "Полный дамп точек в JSON",
    icon: FileJson,
    mime: "application/json",
  },
];

interface ExportDialogProps {
  sessionId: string;
  pointCount: number;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  children?: React.ReactNode;
}

export function ExportDialog({
  sessionId,
  pointCount,
  open,
  onOpenChange,
  children,
}: ExportDialogProps) {
  const [format, setFormat] = React.useState<"gpx" | "kml" | "json">("gpx");
  const [jobId, setJobId] = React.useState<string | null>(null);
  const exportMutation = useExportSession();
  const poll = usePollExport(jobId);

  const isAsync = pointCount > 5000;
  const isPolling = !!jobId && poll.data?.status !== "completed" && poll.data?.status !== "failed" && poll.data?.status !== "dead"; // v2.18.0: dead — терминальное

  React.useEffect(() => {
    if (!open) {
      setJobId(null);
      setFormat("gpx");
    }
  }, [open]);

  async function handleExport() {
    try {
      const res = await exportMutation.mutateAsync({ sessionId, format });
      if ("jobId" in res && res.jobId) {
        // async path
        setJobId(res.jobId);
        toast.info("Экспорт поставлен в очередь", {
          description: `Больших объём: ${pointCount} точек. Опрашиваем статус…`,
        });
      } else if ("url" in res && res.url) {
        // sync path — сразу качаем
        triggerDownload(res.url, res.filename);
        toast.success("Экспорт готов", {
          description: `${res.filename} (${fmtBytes(res.size)})`,
        });
        onOpenChange(false);
      }
    } catch (e) {
      toast.error("Ошибка экспорта", { description: (e as Error).message });
    }
  }

  // Если poll завершён — предлагаем скачать
  React.useEffect(() => {
    if (poll.data?.status === "completed" && poll.data.url) {
      toast.success("Экспорт завершён", {
        description: "Файл готов к скачиванию",
      });
    }
    if (poll.data?.status === "failed" || (poll.error && jobId)) {
      toast.error("Экспорт не удался", {
        description: (poll.error as Error)?.message || "Задача завершилась с ошибкой",
      });
    }
  }, [poll.data?.status, poll.error, jobId]);

  function handleDownloadAsync() {
    if (poll.data?.url) {
      // /api/exports/[jobId]/download — relative path с cookie
      const url = poll.data.url;
      // Открываем в новой вкладке — fetch с credentials, blob, object URL
      fetch(url, { credentials: "include" })
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.blob();
        })
        .then((blob) => {
          const objUrl = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = objUrl;
          a.download = `session-${sessionId}.${format}`;
          document.body.appendChild(a);
          a.click();
          a.remove();
          URL.revokeObjectURL(objUrl);
        })
        .catch((e) => toast.error("Не удалось скачать", { description: e.message }));
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {children && <DialogTrigger asChild>{children}</DialogTrigger>}
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Download className="h-5 w-5 text-primary" />
            Экспорт сессии
          </DialogTitle>
          <DialogDescription>
            {pointCount.toLocaleString("ru-RU")} точек ·{" "}
            {isAsync ? (
              <span className="text-amber-600 font-medium">асинхронный режим (&gt;5000 точек)</span>
            ) : (
              <span className="text-emerald-600 font-medium">синхронный режим</span>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <Label>Формат</Label>
          <div className="grid grid-cols-3 gap-2">
            {FORMATS.map((f) => {
              const Icon = f.icon;
              const active = format === f.id;
              return (
                <button
                  key={f.id}
                  onClick={() => setFormat(f.id)}
                  className={cn(
                    "flex flex-col items-center gap-1 p-3 rounded-lg border-2 transition-all",
                    active
                      ? "border-primary bg-primary/5"
                      : "border-border hover:border-primary/40 hover:bg-muted/50"
                  )}
                >
                  <Icon
                    className={cn(
                      "h-5 w-5",
                      active ? "text-primary" : "text-muted-foreground"
                    )}
                  />
                  <span
                    className={cn(
                      "text-xs font-medium",
                      active ? "text-primary" : ""
                    )}
                  >
                    {f.name}
                  </span>
                </button>
              );
            })}
          </div>
          <p className="text-xs text-muted-foreground">
            {FORMATS.find((f) => f.id === format)?.desc}
          </p>
        </div>

        {isPolling && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="rounded-lg bg-muted/60 p-3 flex items-center gap-3"
          >
            <Loader2 className="h-4 w-4 animate-spin text-primary" />
            <div className="flex-1 text-xs">
              <div className="font-medium">Опрос статуса экспорта…</div>
              <div className="text-muted-foreground">
                Статус: {poll.data?.status || "ожидание"}
              </div>
            </div>
          </motion.div>
        )}

        {poll.data?.status === "completed" && (
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="rounded-lg bg-emerald-500/10 border border-emerald-500/30 p-3 flex items-center gap-3"
          >
            <CheckCircle2 className="h-5 w-5 text-emerald-600" />
            <div className="flex-1 text-xs">
              <div className="font-medium text-emerald-700 dark:text-emerald-400">
                Экспорт готов
              </div>
              <div className="text-muted-foreground">
                {poll.data.fileSize ? fmtBytes(poll.data.fileSize) : "размер неизвестен"}
                {poll.data.expiresAt && ` · до ${new Date(poll.data.expiresAt).toLocaleString("ru-RU")}`}
              </div>
            </div>
            <Button size="sm" onClick={handleDownloadAsync}>
              <Download className="h-3.5 w-3.5" /> Скачать
            </Button>
          </motion.div>
        )}

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isPolling}
          >
            Закрыть
          </Button>
          {!isPolling && poll.data?.status !== "completed" && (
            <Button
              onClick={handleExport}
              disabled={exportMutation.isPending}
            >
              {exportMutation.isPending ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Генерация…
                </>
              ) : (
                <>
                  <Download className="h-3.5 w-3.5" /> Экспортировать
                </>
              )}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function triggerDownload(dataUrl: string, filename: string) {
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}
