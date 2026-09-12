// src/lib/trip-hooks.ts — v2.26.0 (ТЗ «Поездка не рвётся», §10/§11): React Query
// хуки ПОЕЗДОК. Зеркалируют паттерн записей (hooks.ts / v2.17.0 батч-статс):
//   useTrips()            — лёгкий список /api/trips (кэш-агрегаты карточек);
//   useTripsStatsBatch()  — полные статы ≤50 поездок ОДНИМ /api/trips/batch,
//                           ответ сеется в per-trip кэш ["trip-stats", id];
//   useTripStats(id)      — полная статистика поездки (раскрытая карточка).
// TRIP_ENABLED=false → список пуст (disabled: true), UI переключается на
// записи (expand-фаза §13 ТЗ — регрессионно безопасный переход).
"use client";

import { useQuery, useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { api, type TripListItem, type TripStats } from "./api-client";

export interface TripsListResponse {
  trips: TripListItem[];
  disabled?: boolean;
}

interface TripsBatchResponse {
  stats: TripStats[];
  missing: string[];
  disabled?: boolean;
}

export function useTrips(params?: { limit?: number }) {
  return useQuery<TripsListResponse>({
    queryKey: ["trips", "list", params?.limit ?? 50],
    queryFn: () => api.get<TripsListResponse>("/api/trips", { limit: params?.limit ?? 50 }),
    staleTime: 30_000, // как useSessions: живое обновление вкладки — 30с poll
    refetchInterval: 30_000,
    retry: 1,
  });
}

export async function fetchTripsStatsBatch(ids: string[]): Promise<TripsBatchResponse> {
  if (ids.length === 0) return { stats: [], missing: [] };
  return api.get<TripsBatchResponse>("/api/trips/batch", { ids: ids.join(",") });
}

/** Сеяние батч-ответа в per-trip кэш (паттерн seedSessionsStatsFromBatch). */
export function seedTripsStatsFromBatch(qc: QueryClient, stats: TripStats[]): void {
  for (const s of stats) {
    qc.setQueryData(["trip-stats", s.tripId], s);
  }
}

export function useTripsStatsBatch(ids: string[]) {
  const qc = useQueryClient();
  const idsKey = ids.join(",");
  return useQuery<TripsBatchResponse>({
    queryKey: ["trips-stats-batch", idsKey],
    queryFn: async () => {
      const res = await fetchTripsStatsBatch(idsKey ? idsKey.split(",") : []);
      if (res.stats?.length) seedTripsStatsFromBatch(qc, res.stats);
      return res;
    },
    enabled: ids.length > 0,
    staleTime: 30_000, // TTL сервера
    retry: 1,
  });
}

export function useTripStats(id: string | null, opts?: { live?: boolean }) {
  return useQuery<TripStats | null>({
    queryKey: ["trip-stats", id],
    queryFn: () => {
      if (!id) return null;
      return api.get<TripStats>(`/api/trips/${id}`);
    },
    enabled: !!id,
    staleTime: opts?.live ? 15_000 : 60_000, // идущая поездка — как записи (Ф2)
    refetchInterval: opts?.live ? 15_000 : undefined,
    retry: 1,
  });
}

export interface DeleteTripResponse {
  ok: boolean;
  deletedSessions: number;
  gracePeriodDays: number;
}

/**
 * v2.30.0: удаление поездки пользователем (DELETE /api/trips/[id]).
 * Инвалидация — все производные поверхности: списки поездок/записей,
 * per-trip/per-session статы, период-агрегаты «Аналитики», рекорд скорости —
 * цифры вкладок остаются согласованными после удаления.
 */
export function useDeleteTrip() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (tripId: string) => api.delete<DeleteTripResponse>(`/api/trips/${tripId}`),
    onSuccess: () => {
      for (const key of [
        ["trips"],
        ["trips-stats-batch"],
        ["trip-stats"],
        ["sessions"],
        ["sessions-batch"],
        ["session-stats"],
        ["stats-batch"],
        ["v4", "period-aggregate"],
        ["v4", "speed-record"],
      ]) {
        qc.invalidateQueries({ queryKey: key });
      }
    },
  });
}
