"use client";

// src/components/sessions-list.tsx — список сессий с курсорной пагинацией и фильтрами.

import * as React from "react";
import { motion } from "framer-motion";
import {
  Search,
  Loader2,
  ChevronRight,
  Filter,
  X,
  MapPin,
  Clock,
  Activity,
} from "lucide-react";
import { useSessions, useRoutes } from "@/lib/hooks";
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
import { fmtDate, fmtBytes, fmtNumber } from "@/lib/format";
import type { SessionListItem } from "@/lib/api-client";
import { cn } from "@/lib/utils";

interface SessionsListProps {
  selectedId: string | null;
  onSelect: (id: string) => void;
}

const STATUS_LABEL: Record<string, string> = {
  active: "Активна",
  completed: "Завершена",
  archived: "Архив",
  deleted: "Удалена",
};

const STATUS_BADGE: Record<string, string> = {
  active: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30",
  completed: "bg-teal-500/15 text-teal-700 dark:text-teal-400 border-teal-500/30",
  archived: "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30",
  deleted: "bg-red-500/15 text-red-700 dark:text-red-400 border-red-500/30",
};

export function SessionsList({ selectedId, onSelect }: SessionsListProps) {
  const [deviceId, setDeviceId] = React.useState("");
  const [status, setStatus] = React.useState<string>("");
  const [routeId, setRouteId] = React.useState<string>("");
  const [cursor, setCursor] = React.useState<string | undefined>(undefined);
  const [allSessions, setAllSessions] = React.useState<SessionListItem[]>([]);
  const [hasMore, setHasMore] = React.useState(false);

  // Применённые фильтры (после нажатия "Применить")
  const [applied, setApplied] = React.useState<{
    deviceId?: string;
    status?: string;
    routeId?: string;
  }>({});

  const { data, isLoading, isFetching, refetch } = useSessions({
    limit: 20,
    cursor,
    deviceId: applied.deviceId,
    status: applied.status,
    routeId: applied.routeId,
  });

  const { data: routesData } = useRoutes();

  // Сброс при смене фильтров
  React.useEffect(() => {
    setAllSessions([]);
    setCursor(undefined);
  }, [applied]);

  React.useEffect(() => {
    if (data) {
      if (cursor) {
        setAllSessions((prev) => [...prev, ...data.sessions]);
      } else {
        setAllSessions(data.sessions);
      }
      setHasMore(!!data.nextCursor);
    }
  }, [data, cursor]);

  function applyFilters() {
    setApplied({
      deviceId: deviceId.trim() || undefined,
      status: status || undefined,
      routeId: routeId || undefined,
    });
  }

  function resetFilters() {
    setDeviceId("");
    setStatus("");
    setRouteId("");
    setApplied({});
  }

  return (
    <div className="flex flex-col h-full">
      {/* Фильтры */}
      <div className="space-y-2 border-b p-3 bg-muted/30">
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <Filter className="h-3.5 w-3.5" /> Фильтры
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-12 gap-2">
          <div className="sm:col-span-5 relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              placeholder="Device ID…"
              value={deviceId}
              onChange={(e) => setDeviceId(e.target.value)}
              className="pl-7 h-8 text-xs"
              onKeyDown={(e) => {
                if (e.key === "Enter") applyFilters();
              }}
            />
          </div>
          <Select value={status || "all"} onValueChange={(v) => setStatus(v === "all" ? "" : v)}>
            <SelectTrigger className="sm:col-span-3 h-8 text-xs">
              <SelectValue placeholder="Статус" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Все</SelectItem>
              <SelectItem value="active">Активна</SelectItem>
              <SelectItem value="completed">Завершена</SelectItem>
              <SelectItem value="archived">Архив</SelectItem>
            </SelectContent>
          </Select>
          <Select value={routeId || "all"} onValueChange={(v) => setRouteId(v === "all" ? "" : v)}>
            <SelectTrigger className="sm:col-span-3 h-8 text-xs">
              <SelectValue placeholder="Маршрут" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Все маршруты</SelectItem>
              {routesData?.routes.map((r) => (
                <SelectItem key={r.id} value={r.id}>
                  {r.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <div className="sm:col-span-1 flex gap-1">
            <Button
              size="sm"
              variant="default"
              className="h-8 w-full"
              onClick={applyFilters}
              disabled={isFetching}
            >
              OK
            </Button>
          </div>
        </div>
        {(applied.deviceId || applied.status || applied.routeId) && (
          <div className="flex flex-wrap gap-1.5 pt-1">
            {applied.deviceId && (
              <Badge variant="outline" className="text-[10px] gap-1">
                device: {applied.deviceId}
                <button
                  onClick={() => setApplied((a) => ({ ...a, deviceId: undefined }))}
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              </Badge>
            )}
            {applied.status && (
              <Badge variant="outline" className="text-[10px] gap-1">
                {STATUS_LABEL[applied.status] || applied.status}
                <button
                  onClick={() => setApplied((a) => ({ ...a, status: undefined }))}
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              </Badge>
            )}
            {applied.routeId && (
              <Badge variant="outline" className="text-[10px] gap-1">
                Маршрут
                <button
                  onClick={() => setApplied((a) => ({ ...a, routeId: undefined }))}
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              </Badge>
            )}
            <button
              onClick={resetFilters}
              className="text-[10px] text-muted-foreground hover:text-foreground underline"
            >
              сбросить всё
            </button>
          </div>
        )}
      </div>

      {/* Список */}
      <div className="flex-1 overflow-y-auto scroll-telem min-h-0">
        {isLoading && !allSessions.length ? (
          <div className="p-3 space-y-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        ) : allSessions.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">
            <MapPin className="h-8 w-8 mx-auto mb-2 opacity-30" />
            {isFetching ? "Загрузка…" : "Сессий не найдено"}
            <div className="mt-3">
              <Button variant="outline" size="sm" onClick={() => refetch()}>
                Обновить
              </Button>
            </div>
          </div>
        ) : (
          <ul className="divide-y">
            {allSessions.map((s, idx) => (
              <motion.li
                key={s.id}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: Math.min(idx * 0.015, 0.3) }}
              >
                <button
                  onClick={() => onSelect(s.id)}
                  className={cn(
                    "w-full text-left p-3 hover:bg-accent/50 transition-colors flex items-start gap-3 border-l-2",
                    selectedId === s.id
                      ? "bg-primary/10 border-primary"
                      : "border-transparent"
                  )}
                >
                  <div className="flex-1 min-w-0 space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium truncate">
                        {s.deviceName || s.deviceId}
                      </span>
                      <Badge
                        variant="outline"
                        className={cn("text-[10px]", STATUS_BADGE[s.status] || "")}
                      >
                        {STATUS_LABEL[s.status] || s.status}
                      </Badge>
                    </div>
                    <div className="flex items-center gap-3 text-[11px] text-muted-foreground flex-wrap">
                      <span className="inline-flex items-center gap-1">
                        <Clock className="h-3 w-3" /> {fmtDate(s.startTime)}
                      </span>
                      <span className="inline-flex items-center gap-1">
                        <Activity className="h-3 w-3" /> {fmtNumber(s.pointCount)} тчк
                      </span>
                      <span>{fmtBytes(s.payloadBytes)}</span>
                    </div>
                    {s.route && (
                      <div className="text-[11px] text-muted-foreground inline-flex items-center gap-1">
                        <MapPin className="h-3 w-3 text-emerald-500" /> {s.route.name}
                      </div>
                    )}
                  </div>
                  <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0 mt-1" />
                </button>
              </motion.li>
            ))}
          </ul>
        )}
        {hasMore && (
          <div className="p-3 border-t">
            <Button
              variant="outline"
              className="w-full"
              size="sm"
              disabled={isFetching}
              onClick={() => data?.nextCursor && setCursor(data.nextCursor)}
            >
              {isFetching ? (
                <>
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Загрузка…
                </>
              ) : (
                "Загрузить ещё"
              )}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
