"use client";

// src/components/csv-import.tsx — drag & drop импорт GPS-сессий из CSV.
// v2.38.2 · F80: честный индикатор импорта (indeterminate «идёт загрузка и
// обработка», без фейковых процентов 10→40→100) + клиентская проверка размера
// файла до отправки (лимит сервера — 20 МБ).

import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  UploadCloud,
  FileText,
  CheckCircle2,
  XCircle,
  Loader2,
  FileUp,
  Download,
} from "lucide-react";
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
import { cn } from "@/lib/utils";

// v2.38.2 · F80: тот же лимит, что MAX_CSV_BYTES в /api/import/csv (20 МБ) —
// сервер отклонит файл только ПОСЛЕ полной загрузки, клиент проверяет сразу.
const MAX_CSV_BYTES = 20 * 1024 * 1024;

interface ImportResult {
  imported: number;
  sessions: Array<{ id: string; deviceId: string; points: number }>;
  errors: Array<{ deviceId: string; error: string }>;
  // v2.40.4 (ревью M-1): дубликаты (файл уже импортирован) и подсказка по квоте
  duplicates?: number;
  duplicateDevices?: string[];
  quota?: string;
  skipped?: { unparseableTimestamp?: number };
}

export function CsvImport() {
  const [dragOver, setDragOver] = React.useState(false);
  const [file, setFile] = React.useState<File | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [result, setResult] = React.useState<ImportResult | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const qc = useQueryClient();

  function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    const f = files[0];
    if (!f.name.toLowerCase().endsWith(".csv") && f.type !== "text/csv") {
      toast.error("Поддерживаются только CSV-файлы");
      return;
    }
    // v2.38.2 · F80: не грузим заведомо отклоняемый файл целиком (100% трафика —
    // в пустоту): проверяем file.size до начала загрузки, а не после.
    if (f.size > MAX_CSV_BYTES) {
      toast.error("CSV-файл слишком большой", {
        description: `${(f.size / 1024 / 1024).toFixed(1)} МБ — лимит 20 МБ, сервер его не примет`,
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
      const res = await api.upload<ImportResult>("/api/import/csv", fd);
      setResult(res);
      qc.invalidateQueries({ queryKey: ["sessions"] });
      if (res.imported > 0) {
        toast.success("Импорт завершён", {
          description: `Импортировано ${res.imported} сессий, ${
            res.sessions.reduce((a, s) => a + s.points, 0)
          } точек`,
        });
      } else {
        toast.warning("Импорт завершён без данных", {
          description: "Проверьте формат CSV-файла",
        });
      }
    } catch (e) {
      toast.error("Ошибка импорта", { description: (e as Error).message });
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
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <FileUp className="h-4 w-4 text-primary" />
              Импорт GPS-сессий из CSV
            </CardTitle>
            <CardDescription className="text-xs mt-1">
              Поддерживаются колонки: <code>lat, lon, speed, altitude, accuracy, timestamp, bearing, device_id, client_id, device_name</code>.
              Разделитель <code>,</code> или <code>;</code>. Timestamp: epoch ms/ns или ISO8601.
            </CardDescription>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={downloadSampleCSV}
            className="shrink-0 text-xs gap-1.5"
            title="Скачать пример CSV-файла"
          >
            <Download className="h-3 w-3" /> Шаблон
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Drop zone — v2.11.0 (U-20): клавиатурная доступность (role=button,
            Enter/Space открывают диалог выбора файла); визуал без изменений */}
        <div
          role="button"
          tabIndex={0}
          aria-label="Перетащите CSV-файл или выберите нажатием"
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              inputRef.current?.click();
            }
          }}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            handleFiles(e.dataTransfer.files);
          }}
          onClick={() => inputRef.current?.click()}
          className={cn(
            "border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-all",
            dragOver
              ? "border-primary bg-primary/5 scale-[1.01]"
              : "border-border hover:border-primary/40 hover:bg-muted/30"
          )}
        >
          <input
            ref={inputRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => handleFiles(e.target.files)}
          />
          <motion.div
            animate={dragOver ? { scale: 1.1 } : { scale: 1 }}
            className="inline-flex"
          >
            <UploadCloud
              className={cn(
                "h-12 w-12 mx-auto mb-3",
                dragOver ? "text-primary" : "text-muted-foreground/50"
              )}
            />
          </motion.div>
          <p className="text-sm font-medium">
            {dragOver ? "Отпустите файл здесь" : "Перетащите CSV или нажмите для выбора"}
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            Только один файл за раз
          </p>
        </div>

        {/* Выбранный файл */}
        <AnimatePresence>
          {file && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="rounded-lg border p-3 flex items-center gap-3"
            >
              <FileText className="h-5 w-5 text-primary shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">{file.name}</div>
                <div className="text-xs text-muted-foreground">
                  {(file.size / 1024).toFixed(1)} КБ
                </div>
              </div>
              {!loading && (
                <Button size="sm" variant="ghost" onClick={reset}>
                  Убрать
                </Button>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Прогресс — v2.38.2 · F80: indeterminate без процентов (fetch не даёт
            хода отправки — проценты были бы выдумкой); размер файла справа */}
        {loading && file && (
          <div className="space-y-2" role="status" aria-label="Импорт в процессе">
            <div className="flex items-center justify-between text-xs">
              <span className="inline-flex items-center gap-1.5">
                <Loader2 className="h-3 w-3 animate-spin" /> Загрузка и обработка файла…
              </span>
              <span className="text-muted-foreground">
                {file.size >= 1024 * 1024
                  ? `${(file.size / 1024 / 1024).toFixed(1)} МБ`
                  : `${(file.size / 1024).toFixed(0)} КБ`}
              </span>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-primary/20">
              <div className="h-full w-full animate-pulse rounded-full bg-primary/70" />
            </div>
          </div>
        )}

        {/* Результат */}
        {result && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            className="space-y-3"
          >
            <div
              className={cn(
                "rounded-lg border p-3 flex items-start gap-3",
                result.imported > 0
                  ? "border-emerald-500/40 bg-emerald-500/5"
                  : "border-amber-500/40 bg-amber-500/5"
              )}
            >
              {result.imported > 0 ? (
                <CheckCircle2 className="h-5 w-5 text-emerald-600 shrink-0" />
              ) : (
                <XCircle className="h-5 w-5 text-amber-600 shrink-0" />
              )}
              <div className="text-sm space-y-1">
                <div className="font-medium">
                  Импортировано {result.imported} сессий
                  {/* v2.40.4 (ревью M-1): дубликаты — в заголовок результата */}
                  {(result.duplicates ?? 0) > 0 &&
                    ` · дубликатов: ${result.duplicates}`}
                </div>
                <div className="text-xs text-muted-foreground">
                  Точек суммарно:{" "}
                  {result.sessions.reduce((a, s) => a + s.points, 0)}
                  {result.errors.length > 0 && ` · ошибок: ${result.errors.length}`}
                </div>
                {/* v2.40.2 (ревью A-8/C-8): подсказка по квоте D1 — теперь видна в UI */}
                {result.quota && (
                  <div className="text-xs text-amber-600 dark:text-amber-400">{result.quota}</div>
                )}
              </div>
            </div>

            {result.sessions.length > 0 && (
              <div className="max-h-48 overflow-y-auto scroll-telem rounded-lg border">
                <table className="w-full text-xs">
                  <thead className="bg-muted/50 sticky top-0">
                    <tr className="text-left">
                      <th className="p-2">Device ID</th>
                      <th className="p-2">Точек</th>
                      <th className="p-2">Session ID</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.sessions.map((s) => (
                      <tr key={s.id} className="border-t">
                        <td className="p-2 font-mono">{s.deviceId}</td>
                        <td className="p-2">{s.points}</td>
                        <td className="p-2 font-mono text-muted-foreground truncate max-w-[200px]">
                          {s.id}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* v2.40.4 (ревью M-1): дубликаты — отдельный нейтральный блок:
                это не ошибка, повторный импорт ничего не сломал */}
            {(result.duplicates ?? 0) > 0 && (
              <div className="rounded-lg border border-stone-400/40 bg-stone-500/5 p-2">
                <div className="text-xs font-medium text-stone-600 dark:text-stone-300">
                  Уже импортировано (дубликат не создан): {result.duplicateDevices?.join(", ")}
                </div>
              </div>
            )}

            {result.errors.length > 0 && (
              <div className="max-h-32 overflow-y-auto scroll-telem rounded-lg border border-destructive/30 bg-destructive/5">
                <div className="p-2 text-xs font-medium text-destructive">
                  Ошибки импорта:
                </div>
                <ul className="text-xs px-2 pb-2 space-y-1">
                  {result.errors.map((e, i) => (
                    <li key={i} className="font-mono text-muted-foreground">
                      <span className="text-destructive">{e.deviceId}:</span> {e.error}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </motion.div>
        )}

        {/* Кнопка */}
        {file && !loading && (
          <Button onClick={handleUpload} className="w-full" size="lg">
            <UploadCloud className="h-4 w-4" /> Импортировать
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

// Скачать пример CSV-файла с правильным форматом
function downloadSampleCSV() {
  const rows = [
    "device_id,client_id,device_name,lat,lon,speed,altitude,accuracy,timestamp,bearing",
    "demo-phone-01,,Demo Phone,55.7558,37.6173,12.5,160,5.0,1723680000000000000,45",
    "demo-phone-01,,Demo Phone,55.7560,37.6180,13.0,162,4.8,1723680003000000000,48",
    "demo-phone-01,,Demo Phone,55.7565,37.6190,14.0,165,4.5,1723680006000000000,50",
    "demo-phone-02,,Demo Phone 2,59.9343,30.3351,10.0,10,8.0,1723680000000000000,90",
    "demo-phone-02,,Demo Phone 2,59.9350,30.3360,11.0,12,7.5,1723680003000000000,95",
  ];
  const csv = rows.join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "telemetria-sample.csv";
  a.click();
  URL.revokeObjectURL(url);
  toast.success("Шаблон CSV скачан", { description: "telemetria-sample.csv" });
}
