"use client";

// src/components/csv-import.tsx — drag & drop импорт GPS-сессий из CSV.

import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  UploadCloud,
  FileText,
  CheckCircle2,
  XCircle,
  Loader2,
  FileUp,
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
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";

interface ImportResult {
  imported: number;
  sessions: Array<{ id: string; deviceId: string; points: number }>;
  errors: Array<{ deviceId: string; error: string }>;
}

export function CsvImport() {
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
    if (!f.name.toLowerCase().endsWith(".csv") && f.type !== "text/csv") {
      toast.error("Поддерживаются только CSV-файлы");
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
      const res = await api.upload<ImportResult>("/api/import/csv", fd);
      setProgress(100);
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
    setProgress(0);
    if (inputRef.current) inputRef.current.value = "";
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <FileUp className="h-4 w-4 text-primary" />
          Импорт GPS-сессий из CSV
        </CardTitle>
        <CardDescription className="text-xs">
          Поддерживаются колонки: <code>lat, lon, speed, altitude, accuracy, timestamp, bearing, device_id, client_id, device_name</code>.
          Разделитель <code>,</code> или <code>;</code>. Timestamp: epoch ms/ns или ISO8601.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Drop zone */}
        <div
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

        {/* Прогресс */}
        {loading && (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="inline-flex items-center gap-1.5">
                <Loader2 className="h-3 w-3 animate-spin" /> Загрузка…
              </span>
              <span className="text-muted-foreground">{progress}%</span>
            </div>
            <Progress value={progress} className="h-1.5" />
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
                </div>
                <div className="text-xs text-muted-foreground">
                  Точек суммарно:{" "}
                  {result.sessions.reduce((a, s) => a + s.points, 0)}
                  {result.errors.length > 0 && ` · ошибок: ${result.errors.length}`}
                </div>
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
