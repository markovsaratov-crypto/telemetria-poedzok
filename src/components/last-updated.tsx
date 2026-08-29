"use client";

// src/components/last-updated.tsx — индикатор свежести данных (React Query).

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface LastUpdatedProps {
  queryKey: string;
  className?: string;
}

export function LastUpdated({ queryKey, className }: LastUpdatedProps) {
  const qc = useQueryClient();
  const [lastUpdate, setLastUpdate] = React.useState<number | null>(null);
  const [now, setNow] = React.useState(Date.now());

  // Подписка на изменения query
  React.useEffect(() => {
    const unsubscribe = qc.getQueryCache().subscribe((event) => {
      if (
        event.query.queryKey[0] === queryKey &&
        event.type === "updated"
      ) {
        setLastUpdate(Date.now());
      }
    });
    return () => unsubscribe();
  }, [qc, queryKey]);

  // Тикер для обновления "N сек назад"
  React.useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  if (!lastUpdate) return null;

  const diff = Math.max(0, Math.floor((now - lastUpdate) / 1000));
  const label = formatAgo(diff);

  const isStale = diff > 60;
  const isFresh = diff < 10;

  return (
    <div className={cn("inline-flex items-center gap-1.5 text-[10px]", className)}>
      <span
        className={cn(
          "w-1.5 h-1.5 rounded-full",
          isFresh
            ? "bg-emerald-500 animate-pulse"
            : isStale
            ? "bg-amber-500"
            : "bg-muted-foreground/50"
        )}
      />
      <span className="text-muted-foreground">
        обновлено {label}
      </span>
      <Button
        variant="ghost"
        size="sm"
        className="h-5 w-5 p-0"
        onClick={() => qc.invalidateQueries({ queryKey: [queryKey] })}
        title="Обновить"
      >
        <RefreshCw className="h-2.5 w-2.5" />
      </Button>
    </div>
  );
}

function formatAgo(sec: number): string {
  if (sec < 5) return "только что";
  if (sec < 60) return `${sec}с назад`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}м назад`;
  const h = Math.floor(m / 60);
  return `${h}ч назад`;
}
