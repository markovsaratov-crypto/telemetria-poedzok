"use client";

// src/components/sessions-list.tsx — список сессий с курсорной пагинацией, фильтрами, сортировкой, view modes.

import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Search,
  Loader2,
  ChevronRight,
  Filter,
  X,
  MapPin,
  Clock,
  Activity,
  ArrowDownUp,
  LayoutList,
  Rows3,
  HardDrive,
  Calendar,
  RefreshCw,
  Trash2,
  CheckSquare,
  Square,
} from "lucide-react";
import { toast } from "sonner";
import { useSessions, useRoutes, useBulkDeleteSessions } from "@/lib/hooks";
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

type SortKey = "date_desc" | "date_asc" | "points_desc" | "size_desc";
type ViewMode = "detailed" | "compact";

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

const SORT_LABELS: Record<SortKey, string> = {
  date_desc: "Сначала новые",
  date_asc: "Сначала старые",
  points_desc: "Больше точек",
  size_desc: "Больше объём",
};

export function SessionsList({ selectedId, onSelect }: SessionsListProps) {
  const [deviceId, setDeviceId] = React.useState("");
  const [status, setStatus] = React.useState<string>("");
  const [routeId, setRouteId] = React.useState<string>("");
  const [cursor, setCursor] = React.useState<string | undefined>(undefined);
  const [allSessions, setAllSessions] = React.useState<SessionListItem[]>([]);
  const [hasMore, setHasMore] = React.useState(false);
  const [sort, setSort] = React.useState<SortKey>("date_desc");
  const [viewMode, setViewMode] = React.useState<ViewMode>("detailed");
  const [bulkMode, setBulkMode] = React.useState(false);
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set());

  const bulkDeleteMut = useBulkDeleteSessions();

  // Применённые фильтры
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

  // Сортировка на клиенте (после загрузки)
  const sortedSessions = React.useMemo(() => {
    const arr = [...allSessions];
    arr.sort((a, b) => {
      switch (sort) {
        case "date_asc":
          return new Date(a.startTime).getTime() - new Date(b.startTime).getTime();
        case "points_desc":
          return b.pointCount - a.pointCount;
        case "size_desc":
          return b.payloadBytes - a.payloadBytes;
        default:
          return new Date(b.startTime).getTime() - new Date(a.startTime).getTime();
      }
    });
    return arr;
  }, [allSessions, sort]);

  // Группировка по дате (только для detailed view)
  const grouped = React.useMemo(() => {
    if (viewMode !== "detailed") return null;
    const groups: { label: string; items: SessionListItem[] }[] = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    for (const s of sortedSessions) {
      const d = new Date(s.startTime);
      d.setHours(0, 0, 0, 0);
      let label: string;
      if (d.getTime() === today.getTime()) label = "Сегодня";
      else if (d.getTime() === yesterday.getTime()) label = "Вчера";
      else
        label = d.toLocaleDateString("ru-RU", {
          day: "numeric",
          month: "long",
          year: d.getFullYear() === today.getFullYear() ? undefined : "numeric",
        });

      let g = groups.find((g) => g.label === label);
      if (!g) {
        g = { label, items: [] };
        groups.push(g);
      }
      g.items.push(s);
    }
    return groups;
  }, [sortedSessions, viewMode]);

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

  function toggleSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function selectAll() {
    setSelectedIds(new Set(allSessions.map((s) => s.id)));
  }

  function clearSelection() {
    setSelectedIds(new Set());
  }

  async function handleBulkDelete() {
    if (selectedIds.size === 0) return;
    if (!confirm(`Удалить ${selectedIds.size} сессий? Это soft-delete с grace period 30 дней.`)) {
      return;
    }
    try {
      const result = await bulkDeleteMut.mutateAsync(Array.from(selectedIds));
      toast.success(`Удалено: ${result.deleted}`, {
        description: result.errors.length > 0 ? `${result.errors.length} не найдено` : undefined,
      });
      clearSelection();
      setBulkMode(false);
    } catch (e) {
      toast.error("Ошибка массового удаления", { description: (e as Error).message });
    }
  }

  const activeFiltersCount =
    (applied.deviceId ? 1 : 0) + (applied.status ? 1 : 0) + (applied.routeId ? 1 : 0);

  return (
    <div className="flex flex-col h-full">
      {/* Header с count и view toggle */}
      <div className="border-b px-3 py-2 flex items-center justify-between bg-muted/30 gap-2">
        <div className="flex items-center gap-2 text-xs">
          <span className="font-medium">
            {allSessions.length > 0 ? `${allSessions.length} сессий` : "Сессии"}
          </span>
          {isFetching && (
            <Loader2 className="h-3 w-3 animate-spin text-muted-foreground" />
          )}
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={() => refetch()}
            title="Обновить"
          >
            <RefreshCw className="h-3 w-3" />
          </Button>
          <div className="flex items-center rounded-md border bg-background/50 p-0.5">
            <button
              onClick={() => setViewMode("detailed")}
              className={cn(
                "p-1 rounded transition-colors",
                viewMode === "detailed" ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground"
              )}
              title="Детальный вид"
            >
              <Rows3 className="h-3 w-3" />
            </button>
            <button
              onClick={() => setViewMode("compact")}
              className={cn(
                "p-1 rounded transition-colors",
                viewMode === "compact" ? "bg-primary/15 text-primary" : "text-muted-foreground hover:text-foreground"
              )}
              title="Компактный вид"
            >
              <LayoutList className="h-3 w-3" />
            </button>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 gap-1 text-xs"
            onClick={() => {
              setBulkMode((v) => !v);
              if (bulkMode) clearSelection();
            }}
            title={bulkMode ? "Выйти из режима выбора" : "Массовое удаление"}
          >
            {bulkMode ? (
              <>
                <X className="h-3 w-3" /> Отмена
              </>
            ) : (
              <>
                <CheckSquare className="h-3 w-3" /> Выбрать
              </>
            )}
          </Button>
        </div>
      </div>

      {/* Bulk actions bar */}
      {bulkMode && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          exit={{ opacity: 0, height: 0 }}
          className="border-b bg-amber-500/5 px-3 py-2 flex items-center justify-between gap-2"
        >
          <div className="flex items-center gap-2 text-xs">
            <span className="font-medium text-amber-700 dark:text-amber-400">
              Выбрано: {selectedIds.size}
            </span>
            <button onClick={selectAll} className="text-[10px] underline text-muted-foreground hover:text-foreground">
              все
            </button>
            <button onClick={clearSelection} className="text-[10px] underline text-muted-foreground hover:text-foreground">
              очистить
            </button>
          </div>
          <Button
            size="sm"
            variant="destructive"
            className="h-7 gap-1 text-xs"
            disabled={selectedIds.size === 0 || bulkDeleteMut.isPending}
            onClick={handleBulkDelete}
          >
            {bulkDeleteMut.isPending ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <Trash2 className="h-3 w-3" />
            )}
            Удалить ({selectedIds.size})
          </Button>
        </motion.div>
      )}

      {/* Фильтры */}
      <div className="space-y-2 border-b p-3 bg-muted/20">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
            <Filter className="h-3.5 w-3.5" /> Фильтры
            {activeFiltersCount > 0 && (
              <Badge className="text-[9px] h-4 px-1 bg-primary text-primary-foreground">
                {activeFiltersCount}
              </Badge>
            )}
          </div>
          {/* Sort */}
          <Select value={sort} onValueChange={(v) => setSort(v as SortKey)}>
            <SelectTrigger className="h-7 w-[140px] text-[10px] gap-1">
              <ArrowDownUp className="h-2.5 w-2.5" />
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(SORT_LABELS) as SortKey[]).map((k) => (
                <SelectItem key={k} value={k} className="text-xs">
                  {SORT_LABELS[k]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
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
        {activeFiltersCount > 0 && (
          <div className="flex flex-wrap gap-1.5 pt-1 items-center">
            {applied.deviceId && (
              <Badge variant="outline" className="text-[10px] gap-1">
                device: {applied.deviceId}
                <button onClick={() => setApplied((a) => ({ ...a, deviceId: undefined }))}>
                  <X className="h-2.5 w-2.5" />
                </button>
              </Badge>
            )}
            {applied.status && (
              <Badge variant="outline" className="text-[10px] gap-1">
                {STATUS_LABEL[applied.status] || applied.status}
                <button onClick={() => setApplied((a) => ({ ...a, status: undefined }))}>
                  <X className="h-2.5 w-2.5" />
                </button>
              </Badge>
            )}
            {applied.routeId && (
              <Badge variant="outline" className="text-[10px] gap-1">
                Маршрут
                <button onClick={() => setApplied((a) => ({ ...a, routeId: undefined }))}>
                  <X className="h-2.5 w-2.5" />
                </button>
              </Badge>
            )}
            <button
              onClick={resetFilters}
              className="text-[10px] text-muted-foreground hover:text-foreground underline ml-1"
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
              <Skeleton key={i} className="h-16 w-full shimmer" />
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
        ) : viewMode === "compact" ? (
          <CompactList
            sessions={sortedSessions}
            selectedId={selectedId}
            onSelect={onSelect}
            bulkMode={bulkMode}
            selectedIds={selectedIds}
            onToggleSelect={toggleSelect}
          />
        ) : (
          <DetailedList
            groups={grouped || [{ label: "", items: sortedSessions }]}
            selectedId={selectedId}
            onSelect={onSelect}
            bulkMode={bulkMode}
            selectedIds={selectedIds}
            onToggleSelect={toggleSelect}
          />
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

function DetailedList({
  groups,
  selectedId,
  onSelect,
  bulkMode,
  selectedIds,
  onToggleSelect,
}: {
  groups: { label: string; items: SessionListItem[] }[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  bulkMode?: boolean;
  selectedIds?: Set<string>;
  onToggleSelect?: (id: string) => void;
}) {
  return (
    <>
      {groups.map((group, gi) => (
        <div key={gi}>
          {group.label && (
            <div className="sticky top-0 z-10 bg-muted/60 backdrop-blur-sm px-3 py-1 text-[10px] uppercase tracking-wider text-muted-foreground font-medium border-b">
              {group.label} · {group.items.length}
            </div>
          )}
          <ul className="divide-y">
            {group.items.map((s, idx) => (
              <motion.li
                key={s.id}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: Math.min(idx * 0.015, 0.3) }}
              >
                <button
                  onClick={() => bulkMode ? (onToggleSelect?.(s.id) ?? onSelect(s.id)) : onSelect(s.id)}
                  className={cn(
                    "w-full text-left p-3 hover:bg-accent/50 transition-colors flex items-start gap-3 border-l-2",
                    selectedId === s.id
                      ? "bg-primary/10 border-primary"
                      : "border-transparent"
                  )}
                >
                  {bulkMode && (
                    <span
                      className={cn(
                        "shrink-0 mt-0.5",
                        selectedIds?.has(s.id) ? "text-primary" : "text-muted-foreground"
                      )}
                    >
                      {selectedIds?.has(s.id) ? (
                        <CheckSquare className="h-4 w-4" />
                      ) : (
                        <Square className="h-4 w-4" />
                      )}
                    </span>
                  )}
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
                      <span className="inline-flex items-center gap-1">
                        <HardDrive className="h-3 w-3" /> {fmtBytes(s.payloadBytes)}
                      </span>
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
        </div>
      ))}
    </>
  );
}

function CompactList({
  sessions,
  selectedId,
  onSelect,
}: {
  sessions: SessionListItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <ul className="divide-y">
      <AnimatePresence>
        {sessions.map((s, idx) => (
          <motion.li
            key={s.id}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: Math.min(idx * 0.01, 0.2) }}
          >
            <button
              onClick={() => onSelect(s.id)}
              className={cn(
                "w-full text-left px-3 py-1.5 hover:bg-accent/50 transition-colors flex items-center gap-2 border-l-2",
                selectedId === s.id
                  ? "bg-primary/10 border-primary"
                  : "border-transparent"
              )}
            >
              <div
                className={cn(
                  "w-1.5 h-1.5 rounded-full shrink-0",
                  s.status === "active"
                    ? "bg-emerald-500"
                    : s.status === "completed"
                    ? "bg-teal-500"
                    : "bg-muted-foreground/40"
                )}
              />
              <span className="text-xs font-medium truncate flex-1">
                {s.deviceName || s.deviceId}
              </span>
              <span className="text-[10px] text-muted-foreground font-mono shrink-0">
                {fmtNumber(s.pointCount)}т
              </span>
              <span className="text-[10px] text-muted-foreground shrink-0">
                {new Date(s.startTime).toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" })}
              </span>
            </button>
          </motion.li>
        ))}
      </AnimatePresence>
    </ul>
  );
}
