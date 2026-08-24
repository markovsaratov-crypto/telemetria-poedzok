"use client";

// src/components/health-indicator.tsx — индикатор здоровья с popover деталей.

import * as React from "react";
import { useSyncExternalStore } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useHealth } from "@/lib/hooks";
import { cn } from "@/lib/utils";
import { Activity, Database, Server, Clock, GitBranch } from "lucide-react";

const emptySubscribe = () => () => {};
function useMounted(): boolean {
  return useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false
  );
}

export function HealthIndicator() {
  const { data, isLoading, isError } = useHealth();
  const mounted = useMounted();
  const [open, setOpen] = React.useState(false);

  const ok = data?.status === "ok" && data?.db === "ok";
  const degraded = data?.status === "degraded" || data?.db === "degraded";

  const color = !mounted || isLoading
    ? "bg-muted-foreground/40"
    : isError
    ? "bg-red-500"
    : ok
    ? "bg-emerald-500"
    : "bg-amber-500";

  const label = !mounted || isLoading
    ? "—"
    : isError
    ? "offline"
    : ok
    ? "ok"
    : "degraded";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className="inline-flex items-center gap-1.5 text-xs px-2 py-1 rounded-md hover:bg-accent transition-colors"
          title="Состояние системы"
        >
          <span className="relative">
            <span className={cn("block h-2 w-2 rounded-full", color)} />
            {ok && (
              <span
                className={cn("absolute inset-0 rounded-full pulse-dot", color)}
                style={{ background: "currentColor" }}
              />
            )}
          </span>
          <span className="text-muted-foreground hidden sm:inline">{label}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-3" align="end">
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-xs font-medium border-b pb-2">
            <Activity className="h-3.5 w-3.5 text-primary" />
            Состояние системы
          </div>
          {data ? (
            <>
              <HealthRow icon={<Activity className="h-3 w-3" />} label="Статус" value={data.status} ok={data.status === "ok"} />
              <HealthRow icon={<Database className="h-3 w-3" />} label="База данных" value={data.db} ok={data.db === "ok"} />
              <HealthRow icon={<Server className="h-3 w-3" />} label="Worker" value={data.worker} ok={data.worker === "ok"} />
              <HealthRow
                icon={<Clock className="h-3 w-3" />}
                label="Uptime"
                value={`${Math.round(data.uptime / 60)} мин`}
              />
              <HealthRow
                icon={<GitBranch className="h-3 w-3" />}
                label="Версия"
                value={`v${data.version}`}
              />
              {data.circuits && Object.keys(data.circuits).length > 0 && (
                <div className="border-t pt-2 space-y-1">
                  <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    Circuit breakers
                  </div>
                  {Object.entries(data.circuits).map(([name, state]) => (
                    <div key={name} className="flex items-center justify-between text-[11px]">
                      <span className="font-mono">{name}</span>
                      <span
                        className={cn(
                          "px-1.5 py-0.5 rounded text-[9px]",
                          state.state === "closed"
                            ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400"
                            : "bg-amber-500/15 text-amber-700 dark:text-amber-400"
                        )}
                      >
                        {state.state}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              {data.rateLimiter && (
                <div className="border-t pt-2 text-[10px] text-muted-foreground">
                  Rate limiter: {data.rateLimiter.backend} ({data.rateLimiter.buckets} buckets)
                </div>
              )}
            </>
          ) : (
            <div className="text-xs text-muted-foreground">
              {isError ? "Сервер недоступен" : "Загрузка…"}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function HealthRow({
  icon,
  label,
  value,
  ok,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  ok?: boolean;
}) {
  return (
    <div className="flex items-center justify-between text-[11px]">
      <span className="flex items-center gap-1.5 text-muted-foreground">
        {icon}
        {label}
      </span>
      <span
        className={cn(
          "font-mono font-medium",
          ok === true && "text-emerald-600 dark:text-emerald-400",
          ok === false && "text-amber-600 dark:text-amber-400"
        )}
      >
        {value}
      </span>
    </div>
  );
}
