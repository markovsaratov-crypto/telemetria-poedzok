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
  Server,
  Cpu,
  Zap,
  Activity,
  GitBranch,
} from "lucide-react";
import { toast } from "sonner";
import {
  useBackups,
  useCreateBackup,
  useRequeueJob,
  useHealth,
  useStats,
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
import { fmtDate, fmtBytes, fmtNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import { SettingsCard } from "@/components/settings-card";
import { GitHubBackupCard } from "@/components/github-backup-card";

export function AdminPanel() {
  return (
    <div className="space-y-4">
      <SystemInfoCard />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <BackupsCard />
        <RequeueCard />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <SettingsCard />
        <GitHubBackupCard />
      </div>
    </div>
  );
}

function SystemInfoCard() {
  const { data: health } = useHealth();
  const { data: stats } = useStats();

  const items = [
    {
      icon: <Activity className="h-3.5 w-3.5" />,
      label: "Статус системы",
      value: health?.status === "ok" ? "OK" : health?.status || "—",
      color: health?.status === "ok" ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400",
    },
    {
      icon: <Cpu className="h-3.5 w-3.5" />,
      label: "БД",
      value: health?.db === "ok" ? "OK" : health?.db || "—",
      color: health?.db === "ok" ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400",
    },
    {
      icon: <Server className="h-3.5 w-3.5" />,
      label: "Worker",
      value: health?.worker === "ok" ? "OK" : health?.worker || "—",
      color: health?.worker === "ok" ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400",
    },
    {
      icon: <Activity className="h-3.5 w-3.5" />,
      label: "Uptime",
      value: health ? `${Math.round(health.uptime / 60)} мин` : "—",
    },
    {
      icon: <GitBranch className="h-3.5 w-3.5" />,
      label: "Версия",
      value: health?.version || "—",
    },
    {
      icon: <Database className="h-3.5 w-3.5" />,
      label: "Сессий (всего)",
      value: stats ? fmtNumber(stats.totalSessions) : "—",
    },
    {
      icon: <HardDrive className="h-3.5 w-3.5" />,
      label: "GPS-точек (всего)",
      value: stats ? fmtNumber(stats.totalPoints) : "—",
    },
    {
      icon: <Hash className="h-3.5 w-3.5" />,
      label: "TrafficJob dead",
      value: stats ? String(stats.deadJobs) : "—",
      color: (stats?.deadJobs ?? 0) > 0 ? "text-red-600 dark:text-red-400" : "",
    },
    {
      icon: <Zap className="h-3.5 w-3.5" />,
      label: "Rate limit (ingest)",
      value: stats ? `${stats.capacity.rateLimitMaxIngest}/мин` : "—",
    },
    {
      icon: <Zap className="h-3.5 w-3.5" />,
      label: "Target load",
      value: stats ? `${stats.capacity.targetLoadRpm} сесс/мин` : "—",
    },
  ];

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <Server className="h-4 w-4 text-primary" />
          Системная информация
        </CardTitle>
        <CardDescription className="text-xs">
          Текущее состояние серверов и базы данных
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          {items.map((it, i) => (
            <motion.div
              key={i}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.03 }}
              className="rounded-lg border bg-card/50 p-2.5 space-y-1"
            >
              <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                {it.icon}
                <span className="truncate">{it.label}</span>
              </div>
              <div className={cn("text-sm font-semibold tabular-nums truncate", it.color || "")}>
                {it.value}
              </div>
            </motion.div>
          ))}
        </div>
      </CardContent>
    </Card>
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
