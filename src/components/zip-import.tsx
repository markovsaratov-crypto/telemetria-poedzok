"use client";

// src/components/zip-import.tsx — импорт GPS-данных из ZIP архива (SensorLogger)

import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { UploadCloud, FileArchive, CheckCircle2, XCircle, Loader2, MapPin } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import { useQueryClient } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface ImportResult {
  imported: number;
  sessionId: string;
  deviceId: string;
  deviceName: string;
  pointCount: number;
  startTime: string;
  endTime: string;
}

export function ZipImport() {
  const [dragOver, setDragOver] = React.useState(false);
  const [file, setFile] = React.useState<File | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [progress, setProgress] = React.useState(0);
  const [result, setResult] = React.useState<ImportResult | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const qc = useQueryClient();

  function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    const f = files[0];
    const isZip = f.name.toLowerCase().endsWith(".zip") || f.type === "application/zip";
    if (!isZip) {
      toast.error("Поддерживаются только ZIP-архивы");
      return;
    }
    setFile(f);
    setResult(null);
  }

  async function handleUpload() {
    if (!file) return;
    setLoading(true);
    setProgress(10);
    try {
      const fd = new FormData();
      fd.append("file", file);
      setProgress(40);
      const res = await api.post<ImportResult>("/api/import/zip", fd);
      setProgress(100);
      setResult(res);
      toast.success("Импорт завершён", {
        description: `${res.deviceName} · ${res.pointCount} точек`,
      });
      qc.invalidateQueries({ queryKey: ["sessions"] });
      qc.invalidateQueries({ queryKey: ["stats"] });
      qc.invalidateQueries({ queryKey: ["device-stats"] });
    } catch (e) {
      toast.error("Ошибка импорта", { description: (e as Error).message });
    } finally {
      setLoading(false);
    }
  }

  function reset() {
    setFile(null);
    setResult(null);
    setProgress(0);
    if (inputRef.current) inputRef.current.value = "";
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <FileArchive className="h-4 w-4 text-primary" />
          Импорт из ZIP архива
        </CardTitle>
        <CardDescription className="text-xs">
          ZIP-архив с Location.csv и Metadata.csv (SensorLogger, OpenTrack, etc.)
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Drop zone */}
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); handleFiles(e.dataTransfer.files); }}
          onClick={() => inputRef.current?.click()}
          className={cn(
            "border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-all",
            dragOver ? "border-primary bg-primary/5 scale-[1.01]" : "border-border hover:border-primary/40 hover:bg-muted/30"
          )}
        >
          <input
            ref={inputRef}
            type="file"
            accept=".zip,application/zip"
            className="hidden"
            onChange={(e) => handleFiles(e.target.files)}
          />
          <motion.div animate={dragOver ? { scale: 1.1 } : { scale: 1 }} className="inline-flex">
            <UploadCloud className={cn("h-12 w-12 mx-auto mb-3", dragOver ? "text-primary" : "text-muted-foreground/50")} />
          </motion.div>
          <p className="text-sm font-medium">
            {dragOver ? "Отпустите архив здесь" : "Перетащите ZIP или нажмите для выбора"}
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            Формат: SensorLogger (Location.csv + Metadata.csv)
          </p>
        </div>

        {/* Selected file */}
        <AnimatePresence>
          {file && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="rounded-lg border p-3 flex items-center gap-3"
            >
              <FileArchive className="h-5 w-5 text-primary shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">{file.name}</div>
                <div className="text-xs text-muted-foreground">
                  {(file.size / 1024 / 1024).toFixed(1)} МБ
                </div>
              </div>
              {!loading && (
                <Button size="sm" variant="ghost" onClick={reset}>Убрать</Button>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Progress */}
        {loading && (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="inline-flex items-center gap-1.5">
                <Loader2 className="h-3 w-3 animate-spin" /> Импорт...
              </span>
              <span className="text-muted-foreground">{progress}%</span>
            </div>
            <Progress value={progress} className="h-1.5" />
          </div>
        )}

        {/* Result */}
        {result && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            className="rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-3 space-y-2"
          >
            <div className="flex items-start gap-3">
              <CheckCircle2 className="h-5 w-5 text-emerald-600 shrink-0" />
              <div className="text-sm space-y-1">
                <div className="font-medium">Импортировано: {result.deviceName}</div>
                <div className="text-xs text-muted-foreground space-y-0.5">
                  <div className="flex items-center gap-2">
                    <MapPin className="h-3 w-3" />
                    {result.pointCount} GPS-точек
                  </div>
                  <div>Начало: {new Date(result.startTime).toLocaleString("ru-RU")}</div>
                  <div>Конец: {new Date(result.endTime).toLocaleString("ru-RU")}</div>
                </div>
              </div>
            </div>
            <Button size="sm" variant="outline" className="w-full" onClick={reset}>
              Импортировать ещё
            </Button>
          </motion.div>
        )}

        {/* Upload button */}
        {file && !loading && !result && (
          <Button onClick={handleUpload} className="w-full gap-2">
            <UploadCloud className="h-4 w-4" />
            Импортировать архив
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
