"use client";

// src/components/admin-panel.tsx — backup, restore, requeue dead TrafficJob.

import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Database,
  Download,
  RotateCcw,
  ShieldCheck,
  Loader2,
  RefreshCw,
  HardDrive,
  Hash,
  CheckCircle2,
  AlertCircle,
} from "lucide-react";
import { toast } from "sonner";
import {
  useBackups,
  useCreateBackup,
  useRequeueJob,
} from "@/lib/hooks";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { fmtDate, fmtBytes } from "@/lib/format";
import { cn } from "@/lib/utils";

export function AdminPanel() {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <BackupsCard />
      <RequeueCard />
    </div>
  );
}

function BackupsCard() {
  const { data, isLoading, isFetching, refetch } = useBackups();
  const createMut = useCreateBackup();

  async function handleCreate() {
    try {
      const res = await createMut.mutateAsync();
      toast.success("Backup создан", {
        description: `${res.backupId.slice(0, 12)}… · ${
          res.fileSize ? fmtBytes(res.fileSize) : "—"
        }`,
      });
    } catch (e) {
      toast.error("Ошибка backup", { description: (e as Error).message });
    }
  }

  const backups = data?.backups || [];

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Database className="h-4 w-4 text-primary" />
              Резервные копии
            </CardTitle>
            <CardDescription className="text-xs">
              Логический дамп БД. Лимит 1/час (rate-limit на ADMIN_TOKEN).
            </CardDescription>
          </div>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => refetch()}
            disabled={isFetching}
          >
            <RefreshCw className={cn("h-3.5 w-3.5", isFetching && "animate-spin")} />
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <Button onClick={handleCreate} disabled={createMut.isPending} className="w-full">
          {createMut.isPending ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" /> Создание дампа…
            </>
          ) : (
            <>
              <Database className="h-4 w-4" /> Создать backup
            </>
          )}
        </Button>

        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        ) : backups.length === 0 ? (
          <div className="text-center py-8 text-sm text-muted-foreground">
            <Database className="h-8 w-8 mx-auto mb-2 opacity-30" />
            Пока нет backup'ов
          </div>
        ) : (
          <div className="max-h-80 overflow-y-auto scroll-telem -mx-2">
            <ul className="space-y-1.5 px-2">
              <AnimatePresence>
                {backups.map((b) => (
                  <motion.li
                    key={b.id}
                    layout
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, x: -8 }}
                    className="rounded-lg border p-2.5 text-xs space-y-1"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-[10px] text-muted-foreground truncate">
                        {b.id}
                      </span>
                      <Badge
                        variant="outline"
                        className={cn(
                          "text-[10px]",
                          b.status === "completed"
                            ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                            : b.status === "failed"
                            ? "bg-destructive/10 text-destructive"
                            : "bg-amber-500/10 text-amber-700 dark:text-amber-400"
                        )}
                      >
                        {b.status === "completed" ? (
                          <CheckCircle2 className="h-2.5 w-2.5 mr-1" />
                        ) : b.status === "failed" ? (
                          <AlertCircle className="h-2.5 w-2.5 mr-1" />
                        ) : null}
                        {b.status}
                      </Badge>
                    </div>
                    <div className="flex items-center gap-3 text-[11px] text-muted-foreground flex-wrap">
                      <span className="inline-flex items-center gap-1">
                        <HardDrive className="h-3 w-3" />
                        {b.fileSize ? fmtBytes(b.fileSize) : "—"}
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <Hash className="h-3 w-3" />
                        {b.checksum ? b.checksum.slice(0, 12) : "—"}
                      </span>
                      <span>{fmtDate(b.createdAt)}</span>
                    </div>
                    {b.error && (
                      <div className="text-[10px] text-destructive font-mono">
                        {b.error}
                      </div>
                    )}
                  </motion.li>
                ))}
              </AnimatePresence>
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function RequeueCard() {
  const [jobId, setJobId] = React.useState("");
  const requeueMut = useRequeueJob();

  async function handleRequeue() {
    if (!jobId.trim()) {
      toast.error("Введите Job ID");
      return;
    }
    try {
      const res = await requeueMut.mutateAsync(jobId.trim());
      toast.success("Задача перезапущена", {
        description: `${res.jobId.slice(0, 12)}… → ${res.status}`,
      });
      setJobId("");
    } catch (e) {
      toast.error("Ошибка requeue", { description: (e as Error).message });
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <RotateCcw className="h-4 w-4 text-primary" />
          Requeue TrafficJob
        </CardTitle>
        <CardDescription className="text-xs">
          Перезапуск «мёртвых» (dead/failed) задач получения пробок.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="job-id" className="text-xs">
            Job ID
          </Label>
          <Input
            id="job-id"
            value={jobId}
            onChange={(e) => setJobId(e.target.value)}
            placeholder="cmt73676l0000rhh6nqzgjpab"
            className="font-mono text-xs"
            onKeyDown={(e) => {
              if (e.key === "Enter") handleRequeue();
            }}
          />
        </div>
        <Button
          onClick={handleRequeue}
          disabled={requeueMut.isPending || !jobId.trim()}
          className="w-full"
        >
          {requeueMut.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <RotateCcw className="h-4 w-4" />
          )}
          Перезапустить
        </Button>
        <div className="rounded-lg bg-muted/40 p-3 text-xs space-y-1">
          <div className="flex items-center gap-1.5 font-medium">
            <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />
            Защита
          </div>
          <p className="text-muted-foreground">
            Requeue доступен только для задач в статусе <code>dead</code> или{" "}
            <code>failed</code>. Атомарное обнуление attempts и lockedBy. Лимит 10/мин.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
