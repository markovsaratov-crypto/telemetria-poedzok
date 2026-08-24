"use client";

// src/components/traffic-jobs-card.tsx — таблица TrafficJob для admin panel.
// Показывает pending/running/failed/dead задачи с возможностью requeue.

import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Zap,
  RefreshCw,
  Clock,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Loader2,
  Activity,
} from "lucide-react";
import { toast } from "sonner";
import { useAdminJobs, useRequeueJob } from "@/lib/hooks";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { fmtDate, fmtNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

const STATUS_FILTERS = [
  { value: undefined, label: "Все" },
  { value: "pending", label: "В очереди" },
  { value: "running", label: "Обработка" },
  { value: "failed", label: "Ошибка" },
  { value: "dead", label: "Dead" },
  { value: "completed", label: "Готово" },
] as const;

const STATUS_META: Record<
  string,
  { icon: React.ReactNode; color: string; badge: string }
> = {
  pending: {
    icon: <Clock className="h-3 w-3" />,
    color: "text-amber-600 dark:text-amber-400",
    badge: "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30",
  },
  running: {
    icon: <Loader2 className="h-3 w-3 animate-spin" />,
    color: "text-teal-600 dark:text-teal-400",
    badge: "bg-teal-500/15 text-teal-700 dark:text-teal-400 border-teal-500/30",
  },
  failed: {
    icon: <AlertTriangle className="h-3 w-3" />,
    color: "text-red-600 dark:text-red-400",
    badge: "bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30",
  },
  dead: {
    icon: <XCircle className="h-3 w-3" />,
    color: "text-red-700 dark:text-red-500",
    badge: "bg-red-700/15 text-red-700 dark:text-red-500 border-red-700/40",
  },
  completed: {
    icon: <CheckCircle2 className="h-3 w-3" />,
    color: "text-emerald-600 dark:text-emerald-400",
    badge: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30",
  },
};

export function TrafficJobsCard() {
  const [statusFilter, setStatusFilter] = React.useState<string | undefined>(undefined);
  const { data, isLoading, isFetching, refetch } = useAdminJobs(statusFilter);
  const requeueMut = useRequeueJob();

  const jobs = data?.jobs || [];
  const summary = data?.summary || {};

  async function handleRequeue(jobId: string) {
    try {
      await requeueMut.mutateAsync(jobId);
      toast.success("Задача перезапущена", { description: jobId.slice(0, 12) + "…" });
      refetch();
    } catch (e) {
      toast.error("Ошибка requeue", { description: (e as Error).message });
    }
  }

  const total = Object.values(summary).reduce((a, b) => a + b, 0);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Zap className="h-4 w-4 text-primary" />
              TrafficJob очередь
            </CardTitle>
            <CardDescription className="text-xs">
              Задачи получения пробок · {total} всего
            </CardDescription>
          </div>
          <Button size="sm" variant="ghost" onClick={() => refetch()} disabled={isFetching} className="h-7">
            <RefreshCw className={cn("h-3 w-3", isFetching && "animate-spin")} />
          </Button>
        </div>
        {/* Status summary chips */}
        <div className="flex flex-wrap gap-1.5 mt-2">
          {Object.entries(summary).map(([status, count]) => {
            const meta = STATUS_META[status];
            return (
              <button
                key={status}
                onClick={() => setStatusFilter(statusFilter === status ? undefined : status)}
                className={cn(
                  "px-2 py-0.5 rounded-md border text-[10px] flex items-center gap-1 transition-all",
                  statusFilter === status
                    ? "bg-primary/10 border-primary/50"
                    : "bg-background/50 hover:bg-accent"
                )}
              >
                {meta?.icon}
                <span className="font-medium">{status}</span>
                <span className="font-mono">{count}</span>
              </button>
            );
          })}
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className="max-h-[360px] overflow-y-auto scroll-telem">
          {isLoading ? (
            <div className="p-3 space-y-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-12 w-full shimmer" />
              ))}
            </div>
          ) : jobs.length === 0 ? (
            <div className="p-6 text-center text-sm text-muted-foreground">
              <Activity className="h-8 w-8 mx-auto mb-2 opacity-30" />
              {statusFilter ? `Нет задач со статусом "${statusFilter}"` : "Нет задач"}
            </div>
          ) : (
            <ul className="divide-y">
              <AnimatePresence>
                {jobs.map((job, idx) => {
                  const meta = STATUS_META[job.status] || STATUS_META.pending;
                  return (
                    <motion.li
                      key={job.id}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0, height: 0 }}
                      transition={{ delay: Math.min(idx * 0.02, 0.2) }}
                      className="p-3 hover:bg-accent/30 transition-colors"
                    >
                      <div className="flex items-start gap-2">
                        <div className={cn("mt-0.5", meta.color)}>{meta.icon}</div>
                        <div className="flex-1 min-w-0 space-y-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-xs font-mono truncate">
                              {job.session?.deviceId || "—"}
                            </span>
                            <Badge variant="outline" className={cn("text-[9px]", meta.badge)}>
                              {job.status}
                            </Badge>
                            <span className="text-[10px] text-muted-foreground">
                              attempts: {job.attempts}
                            </span>
                          </div>
                          <div className="text-[10px] text-muted-foreground flex items-center gap-2 flex-wrap">
                            <span>создан: {fmtDate(job.createdAt)}</span>
                            {job.lockedBy && (
                              <span className="font-mono">
                                locked: {job.lockedBy.slice(0, 12)}
                              </span>
                            )}
                            {job.scheduledFor && new Date(job.scheduledFor) > new Date() && (
                              <span className="text-amber-600 dark:text-amber-400">
                                отложено до {fmtDate(job.scheduledFor)}
                              </span>
                            )}
                          </div>
                          {job.error && (
                            <div className="text-[10px] text-red-600 dark:text-red-400 font-mono truncate">
                              {job.error}
                            </div>
                          )}
                        </div>
                        {(job.status === "dead" || job.status === "failed") && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-6 text-[10px]"
                            disabled={requeueMut.isPending}
                            onClick={() => handleRequeue(job.id)}
                          >
                            <RefreshCw className="h-2.5 w-2.5" /> Requeue
                          </Button>
                        )}
                      </div>
                    </motion.li>
                  );
                })}
              </AnimatePresence>
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
