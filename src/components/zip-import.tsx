"use client";

// src/components/zip-import.tsx — импорт GPS-данных из ZIP архива (SensorLogger)
// v2.38.2 · F80: честный индикатор импорта (indeterminate «идёт загрузка и
// обработка», без фейковых процентов 10→40→100) + клиентская проверка размера
// архива до отправки (лимит сервера — 100 МБ).

import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { UploadCloud, FileArchive, CheckCircle2, XCircle, Loader2, MapPin } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api-client";
import { useQueryClient } from "@tanstack/react-query";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

// v2.38.2 · F80: тот же лимит, что MAX_ZIP_BYTES в /api/import/zip (100 МБ) —
// сервер отклонит архив только ПОСЛЕ полной загрузки, клиент проверяет сразу.
const MAX_ZIP_BYTES = 100 * 1024 * 1024;

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
    // v2.38.2 · F80: не грузим заведомо отклоняемый архив целиком (100 МБ —
    // весь трафик в пустоту): проверяем file.size до начала загрузки.
    if (f.size > MAX_ZIP_BYTES) {
      toast.error("ZIP-архив слишком большой", {
        description: `${(f.size / 1024 / 1024).toFixed(1)} МБ — лимит 100 МБ, сервер его не примет`,
      });
      return;
    }
    setFile(f);
    setResult(null);
  }

  // v2.38.2 · F80: прогресс честный — api.upload (fetch) не сообщает ход
  // отправки, поэтому проценты не показываем вообще (мгновенные 10→40→100%
  // были выдумкой): indeterminate-анимация до готового результата.
  async function handleUpload() {
    if (!file) return;
    setLoading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      // v2.38.1 (ревью F17): api.post прогонял FormData через JSON.stringify →
      // тело превращалось в "{}" + Content-Type: application/json — сервер ждал
      // multipart и падал 500 на любом архиве. Файл уходит через api.upload,
      // как в csv-import.tsx (multipart Content-Type с boundary ставит браузер).
      const res = await api.upload<ImportResult>("/api/import/zip", fd);
      setResult(res);
      toast.success("Импорт завершён", {
        description: `${res.deviceName} · ${res.pointCount} точек`,
      });
      qc.invalidateQueries({ queryKey: ["sessions"] });
      qc.invalidateQueries({ queryKey: ["stats"] });
      qc.invalidateQueries({ queryKey: ["device-stats"] });
    } catch (e) {
      // v2.40.4 (ревью M-1): 409 already_imported — это НЕ ошибка: тот же архив
      // уже импортирован, дубликат не создан. Жёлтый тост вместо красного.
      if (e instanceof ApiError && e.status === 409) {
        toast.warning("Уже импортировано", { description: (e as Error).message });
      } else {
        toast.error("Ошибка импорта", { description: (e as Error).message });
      }
    } finally {
      setLoading(false);
    }
  }

  function reset() {
    setFile(null);
    setResult(null);
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
        {/* Drop zone — v2.11.0 (U-20): клавиатурная доступность (role=button,
            Enter/Space открывают диалог выбора файла); визуал без изменений */}
        <div
          role="button"
          tabIndex={0}
          aria-label="Перетащите ZIP-архив или выберите нажатием"
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              inputRef.current?.click();
            }
          }}
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

        {/* Progress — v2.38.2 · F80: indeterminate без процентов (fetch не даёт
            хода отправки — проценты были бы выдумкой); размер архива справа */}
        {loading && file && (
          <div className="space-y-2" role="status" aria-label="Импорт в процессе">
            <div className="flex items-center justify-between text-xs">
              <span className="inline-flex items-center gap-1.5">
                <Loader2 className="h-3 w-3 animate-spin" /> Загрузка и обработка архива…
              </span>
              <span className="text-muted-foreground">
                {(file.size / 1024 / 1024).toFixed(1)} МБ
              </span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-primary/20">
              <div className="h-full w-full animate-pulse rounded-full bg-primary/70" />
            </div>
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
