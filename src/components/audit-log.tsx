"use client";

// src/components/audit-log.tsx — журнал аудита destructive-операций.

import * as React from "react";
import { motion } from "framer-motion";
import {
  ScrollText,
  Trash2,
  Download,
  Plus,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  Database,
  ChevronRight,
} from "lucide-react";
import { useAudit } from "@/lib/hooks";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { fmtDate } from "@/lib/format";
import type { AuditLogItem } from "@/lib/api-client";
import { cn } from "@/lib/utils";

const ACTION_ICONS: Record<string, React.ReactNode> = {
  "session.delete": <Trash2 className="h-3.5 w-3.5" />,
  "session.export": <Download className="h-3.5 w-3.5" />,
  "route.create": <Plus className="h-3.5 w-3.5" />,
  "route.delete": <Trash2 className="h-3.5 w-3.5" />,
  "traffic.requeue": <RotateCcw className="h-3.5 w-3.5" />,
  "backup.run": <Database className="h-3.5 w-3.5" />,
  "backup.restore": <RotateCcw className="h-3.5 w-3.5" />,
};

const ACTION_COLORS: Record<string, string> = {
  delete: "text-destructive",
  create: "text-emerald-600",
  export: "text-blue-600",
  requeue: "text-amber-600",
  backup: "text-teal-600",
  restore: "text-amber-600",
};

function actionColor(action: string): string {
  for (const [k, v] of Object.entries(ACTION_COLORS)) {
    if (action.includes(k)) return v;
  }
  return "text-muted-foreground";
}

const ACTOR_LABEL: Record<string, string> = {
  user: "Пользователь",
  system: "Система",
  "retention-cron": "Retention",
  worker: "Worker",
  "backup-cron": "Backup",
};

export function AuditLog() {
  const [action, setAction] = React.useState("");
  const [actorType, setActorType] = React.useState("");
  const [targetType, setTargetType] = React.useState("");
  const [cursor, setCursor] = React.useState<string | undefined>(undefined);
  const [all, setAll] = React.useState<AuditLogItem[]>([]);
  const [hasMore, setHasMore] = React.useState(false);

  const [applied, setApplied] = React.useState<{
    action?: string;
    actorType?: string;
    targetType?: string;
  }>({});

  const { data, isLoading, isFetching, refetch } = useAudit({
    limit: 50,
    cursor,
    action: applied.action,
    actorType: applied.actorType,
    targetType: applied.targetType,
  });

  React.useEffect(() => {
    setAll([]);
    setCursor(undefined);
  }, [applied]);

  React.useEffect(() => {
    if (data) {
      if (cursor) {
        setAll((prev) => [...prev, ...data.logs]);
      } else {
        setAll(data.logs);
      }
      setHasMore(!!data.nextCursor);
    }
  }, [data, cursor]);

  const logs = all;

  function exportCSV() {
    const headers = ["time", "action", "targetId", "targetType", "actorType", "actorId", "sessionId", "metadata"];
    const rows = logs.map((l) => [
      new Date(l.createdAt).toISOString(),
      l.action,
      l.targetId,
      l.targetType,
      l.actorType,
      l.actorId || "",
      l.sessionId || "",
      (l.metadata || "").replace(/"/g, '""'),
    ]);
    const csv = [headers, ...rows]
      .map((r) => r.map((c) => `"${c}"`).join(","))
      .join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `audit-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <ScrollText className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold">Журнал аудита</h3>
          {logs.length > 0 && (
            <Badge variant="outline" className="text-[10px]">
              {logs.length}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={exportCSV}
            disabled={logs.length === 0}
            title="Экспорт в CSV"
            className="h-7"
          >
            <Download className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => refetch()}
            disabled={isFetching}
            className="h-7"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", isFetching && "animate-spin")} />
          </Button>
        </div>
      </div>

      {/* Фильтры */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
        <Input
          placeholder="action (напр. session.delete)"
          value={action}
          onChange={(e) => setAction(e.target.value)}
          className="h-8 text-xs"
          onKeyDown={(e) => {
            if (e.key === "Enter")
              setApplied({ action: action || undefined, actorType, targetType });
          }}
        />
        <Select
          value={actorType}
          onValueChange={(v) => {
            setActorType(v === "all" ? "" : v);
            setApplied({
              action: action || undefined,
              actorType: v === "all" ? undefined : v,
              targetType,
            });
          }}
        >
          <SelectTrigger className="h-8 text-xs">
            <SelectValue placeholder="Кто" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Все</SelectItem>
            <SelectItem value="user">Пользователь</SelectItem>
            <SelectItem value="system">Система</SelectItem>
            <SelectItem value="worker">Worker</SelectItem>
            <SelectItem value="retention-cron">Retention</SelectItem>
            <SelectItem value="backup-cron">Backup</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={targetType}
          onValueChange={(v) => {
            setTargetType(v === "all" ? "" : v);
            setApplied({
              action: action || undefined,
              actorType,
              targetType: v === "all" ? undefined : v,
            });
          }}
        >
          <SelectTrigger className="h-8 text-xs">
            <SelectValue placeholder="Объект" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Все</SelectItem>
            <SelectItem value="Session">Session</SelectItem>
            <SelectItem value="Route">Route</SelectItem>
            <SelectItem value="TrafficJob">TrafficJob</SelectItem>
            <SelectItem value="BackupJob">BackupJob</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Список */}
      <div className="rounded-lg border max-h-[480px] overflow-y-auto scroll-telem">
        {isLoading && !all.length ? (
          <div className="p-3 space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : all.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">
            <ShieldAlert className="h-8 w-8 mx-auto mb-2 opacity-30" />
            {isFetching ? "Загрузка…" : "Записей не найдено"}
          </div>
        ) : (
          <ul className="divide-y">
            {all.map((log, idx) => {
              let meta: Record<string, unknown> | null = null;
              try {
                if (log.metadata) meta = JSON.parse(log.metadata);
              } catch {
                /* ignore */
              }
              return (
                <motion.li
                  key={log.id}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: Math.min(idx * 0.01, 0.2) }}
                  className="p-3 hover:bg-muted/40 transition-colors"
                >
                  <div className="flex items-start gap-2.5">
                    <div
                      className={cn(
                        "mt-0.5 shrink-0",
                        actionColor(log.action)
                      )}
                    >
                      {ACTION_ICONS[log.action] || <ChevronRight className="h-3.5 w-3.5" />}
                    </div>
                    <div className="flex-1 min-w-0 space-y-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-xs font-medium font-mono">
                          {log.action}
                        </span>
                        <Badge variant="outline" className="text-[10px]">
                          {ACTOR_LABEL[log.actorType] || log.actorType}
                        </Badge>
                        {log.actorId && (
                          <span className="text-[10px] text-muted-foreground font-mono">
                            {log.actorId}
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-muted-foreground flex items-center gap-2 flex-wrap">
                        <span>{fmtDate(log.createdAt)}</span>
                        <span>·</span>
                        <span className="font-mono">{log.targetType}</span>
                        <span className="font-mono truncate max-w-[180px]">
                          {log.targetId}
                        </span>
                      </div>
                      {meta && (
                        <details className="text-[11px] text-muted-foreground">
                          <summary className="cursor-pointer hover:text-foreground">
                            метаданные
                          </summary>
                          <pre className="mt-1 p-2 rounded bg-muted/50 text-[10px] overflow-x-auto scroll-telem font-mono">
                            {JSON.stringify(meta, null, 2)}
                          </pre>
                        </details>
                      )}
                    </div>
                  </div>
                </motion.li>
              );
            })}
          </ul>
        )}
      </div>

      {hasMore && (
        <Button
          variant="outline"
          className="w-full"
          size="sm"
          disabled={isFetching}
          onClick={() => data?.nextCursor && setCursor(data.nextCursor)}
        >
          Загрузить ещё
        </Button>
      )}
    </div>
  );
}
