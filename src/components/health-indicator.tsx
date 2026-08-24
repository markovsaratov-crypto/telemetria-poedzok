"use client";

// src/components/health-indicator.tsx — индикатор здоровья (health endpoint).

import { useSyncExternalStore } from "react";
import { useHealth } from "@/lib/hooks";
import { cn } from "@/lib/utils";

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
    <div
      className="inline-flex items-center gap-1.5 text-xs"
      title={
        data
          ? `status: ${data.status} · db: ${data.db} · uptime: ${Math.round(data.uptime)}s · v${data.version}`
          : "health"
      }
    >
      <span
        className={cn(
          "h-2 w-2 rounded-full",
          color,
          ok && "animate-pulse"
        )}
      />
      <span className="text-muted-foreground hidden sm:inline">{label}</span>
    </div>
  );
}
