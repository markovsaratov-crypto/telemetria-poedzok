"use client";

// src/components/mobile/SessionList/SessionListScreen.tsx
// ТЗ §2.3: Экран 1 — Список поездок
// Header + FilterChips + RouteSelector + SessionCard list + infinite scroll

import * as React from "react";
import { motion } from "framer-motion";
import { Search, Settings, SlidersHorizontal } from "lucide-react";
import { useSessions, useRoutes, useBatchStats } from "@/lib/hooks";
import { SessionCard } from "./SessionCard";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

type FilterChip = "today" | "yesterday" | "week" | "month" | "all";

const CHIPS: { id: FilterChip; label: string }[] = [
  { id: "today", label: "Сегодня" },
  { id: "yesterday", label: "Вчера" },
  { id: "week", label: "Неделя" },
  { id: "month", label: "Месяц" },
  { id: "all", label: "Все" },
];

interface SessionListScreenProps {
  onSessionTap: (id: string) => void;
  onSettingsTap: () => void;
}

export function SessionListScreen({ onSessionTap, onSettingsTap }: SessionListScreenProps) {
  const [chip, setChip] = React.useState<FilterChip>("all");
  const [cursor, setCursor] = React.useState<string | undefined>();
  const [allSessions, setAllSessions] = React.useState<any[]>([]);
  const [searchOpen, setSearchOpen] = React.useState(false);

  const { data, isLoading, isFetching } = useSessions({ limit: 20, cursor });
  const { data: routesData } = useRoutes();

  // Batch fetch stats for destination coordinates
  const sessionIds = React.useMemo(() => allSessions.map((s: any) => s.id), [allSessions]);
  const { data: batchStatsData } = useBatchStats(sessionIds);
  const statsMap = React.useMemo(() => {
    const m = new Map<string, any>();
    for (const s of batchStatsData?.sessions || []) m.set(s.id, s);
    return m;
  }, [batchStatsData]);

  React.useEffect(() => {
    setAllSessions([]);
    setCursor(undefined);
  }, [chip]);

  React.useEffect(() => {
    if (data?.sessions) {
      if (cursor) {
        setAllSessions(prev => [...prev, ...data.sessions]);
      } else {
        setAllSessions(data.sessions);
      }
    }
  }, [data, cursor]);

  // Filter by date chip
  const filtered = React.useMemo(() => {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterdayStart = new Date(todayStart.getTime() - 86400000);
    const weekStart = new Date(todayStart.getTime() - 7 * 86400000);
    const monthStart = new Date(todayStart.getTime() - 30 * 86400000);

    return allSessions.filter(s => {
      const d = new Date(s.startTime);
      switch (chip) {
        case "today": return d >= todayStart;
        case "yesterday": return d >= yesterdayStart && d < todayStart;
        case "week": return d >= weekStart;
        case "month": return d >= monthStart;
        default: return true;
      }
    });
  }, [allSessions, chip]);

  return (
    <div className="flex flex-col h-full pb-16">
      {/* Header (56pt) */}
      <header className="sticky top-0 z-20 bg-card/95 backdrop-blur-md border-b safe-top">
        <div className="flex items-center justify-between px-4 h-14">
          <button onClick={onSettingsTap} className="p-2 -ml-2 min-w-[44px] min-h-[44px] flex items-center justify-center">
            <Settings className="h-5 w-5 text-muted-foreground" />
          </button>
          <h1 className="text-[22px] font-bold">Поездки</h1>
          <button onClick={() => setSearchOpen(!searchOpen)} className="p-2 -mr-2 min-w-[44px] min-h-[44px] flex items-center justify-center">
            <Search className="h-5 w-5 text-muted-foreground" />
          </button>
        </div>

        {/* Filter chips */}
        <div className="flex gap-2 px-4 pb-2 overflow-x-auto no-scrollbar">
          {CHIPS.map(c => (
            <button
              key={c.id}
              onClick={() => setChip(c.id)}
              className={cn(
                "shrink-0 px-3 py-1.5 rounded-full text-xs font-medium transition-colors min-h-[36px]",
                chip === c.id
                  ? "bg-primary text-primary-foreground"
                  : "bg-transparent border border-border text-muted-foreground"
              )}
            >
              {c.label}
            </button>
          ))}
        </div>
      </header>

      {/* List */}
      <div className="flex-1 overflow-y-auto scroll-telem px-4 py-3 space-y-2">
        {isLoading ? (
          Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-[72px] w-full rounded-xl shimmer" />
          ))
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="w-16 h-16 rounded-full bg-muted/40 flex items-center justify-center mb-3">
              <Search className="h-8 w-8 text-muted-foreground/40" />
            </div>
            <p className="text-sm text-muted-foreground">Нет поездок за период</p>
            <p className="text-xs text-muted-foreground/70 mt-1">Настройте Sensor Logger для записи</p>
          </div>
        ) : (
          filtered.map((s, idx) => (
            <motion.div
              key={s.id}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: Math.min(idx * 0.03, 0.2) }}
            >
              <SessionCard
                destLat={statsMap.get(s.id)?.destLat ?? null}
                destLon={statsMap.get(s.id)?.destLon ?? null}
                fallbackName={s.deviceName || s.deviceId}
                startTime={s.startTime}
                endTime={s.endTime}
                pointCount={s.pointCount}
                distance={statsMap.get(s.id)?.distanceM}
                avgSpeed={statsMap.get(s.id)?.avgSpeedMs}
                durationMin={statsMap.get(s.id)?.durationSec ? Math.round(statsMap.get(s.id).durationSec / 60) : undefined}
                onTap={() => onSessionTap(s.id)}
              />
            </motion.div>
          ))
        )}

        {/* Load more */}
        {data?.nextCursor && !isFetching && (
          <button
            onClick={() => setCursor(data.nextCursor!)}
            className="w-full py-3 text-xs text-primary font-medium"
          >
            Загрузить ещё
          </button>
        )}
        {isFetching && !isLoading && (
          <div className="flex justify-center py-3">
            <Skeleton className="h-[72px] w-full rounded-xl shimmer" />
          </div>
        )}
      </div>
    </div>
  );
}
