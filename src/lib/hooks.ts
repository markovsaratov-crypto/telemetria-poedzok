// src/lib/hooks.ts — React Query хуки для серверного состояния.
// Все хуки используют api-client (credentials:"include").

"use client";

import {
  useQuery,
  useMutation,
  useQueryClient,
  UseQueryOptions,
} from "@tanstack/react-query";
import {
  api,
  type SessionListItem,
  type SessionDetail,
  type RouteItem,
  type AuditLogItem,
  type BackupItem,
  type HealthResponse,
  type ExportSyncResponse,
  type ExportAsyncResponse,
  type ExportPollResponse,
  type PlanResponse,
} from "./api-client";

// ===== Auth =====
export function useAuth() {
  return useQuery({
    queryKey: ["auth", "me"],
    queryFn: () =>
      api.get<{ authenticated: boolean; expiresAt?: string } | null>(
        "/api/auth/me",
        undefined,
        { expect: "json" }
      ).catch((e) => {
        if (e?.status === 401) return { authenticated: false as const };
        throw e;
      }),
    staleTime: 60_000,
    retry: false,
  });
}

// ===== Health =====
export function useHealth() {
  return useQuery({
    queryKey: ["health"],
    queryFn: () => api.get<HealthResponse>("/health"),
    refetchInterval: 30_000,
    staleTime: 15_000,
    retry: 1,
  });
}

// ===== Aggregate stats (dashboard overview) =====
export interface StatsResponse {
  totalSessions: number;
  totalPoints: number;
  totalRoutes: number;
  totalTrafficJobs: number;
  deadJobs: number;
  pendingJobs: number;
  todaySessions: number;
  totalPayloadBytes: number;
  perDay: { date: string; count: number; points: number }[];
  heatmapSessions: { startTime: string; pointCount: number }[];
  capacity: { targetLoadRpm: number; rateLimitMaxIngest: number; headroom: number };
  version: string;
}

export function useStats() {
  return useQuery({
    queryKey: ["stats"],
    queryFn: () => api.get<StatsResponse>("/api/stats"),
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
}

// ===== Sessions list =====
export interface SessionsQuery {
  limit?: number;
  cursor?: string;
  olderThan?: string;
  before?: string;
  routeId?: string;
  status?: string;
  deviceId?: string;
}

export function useSessions(params: SessionsQuery) {
  return useQuery({
    queryKey: ["sessions", params],
    queryFn: () =>
      api.get<{ sessions: SessionListItem[]; nextCursor: string | null }>(
        "/api/sessions",
        params as Record<string, string | number | undefined>
      ),
    staleTime: 15_000,
  });
}

export function useSession(id: string | null) {
  return useQuery({
    queryKey: ["session", id],
    queryFn: () => {
      if (!id) return null;
      return api.get<SessionDetail>(`/api/sessions/${id}`);
    },
    enabled: !!id,
    staleTime: 10_000,
  });
}

// ===== Batch sessions (for compare) =====
export interface BatchSession {
  id: string;
  deviceId: string;
  deviceName: string | null;
  startTime: string;
  endTime: string | null;
  pointCount: number;
  payloadBytes: number;
  status: string;
  gpsPoints: Array<{ lat: number; lon: number; speed: number | null; altitude: number | null; timestamp: number }>;
}

export function useBatchSessions(ids: string[]) {
  return useQuery({
    queryKey: ["sessions-batch", ids],
    queryFn: () =>
      api.post<{ sessions: BatchSession[] }>("/api/sessions/batch", { ids }),
    enabled: ids.length > 0,
    staleTime: 30_000,
  });
}

export function useDeleteSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/api/sessions/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sessions"] });
      qc.invalidateQueries({ queryKey: ["audit"] });
    },
  });
}

// ===== Routes =====
export function useRoutes() {
  return useQuery({
    queryKey: ["routes"],
    queryFn: () => api.get<{ routes: RouteItem[] }>("/api/routes"),
    staleTime: 30_000,
  });
}

export function useCreateRoute() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: {
      name: string;
      description?: string;
      startLat: number;
      startLon: number;
      endLat: number;
      endLon: number;
    }) => api.post<{ route: RouteItem }>("/api/routes", body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["routes"] }),
  });
}

export function useUpdateRoute() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      patch,
    }: {
      id: string;
      patch: Partial<{
        name: string;
        description: string;
        startLat: number;
        startLon: number;
        endLat: number;
        endLon: number;
      }>;
    }) => api.patch<{ route: RouteItem }>(`/api/routes/${id}`, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["routes"] }),
  });
}

export function useDeleteRoute() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/api/routes/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["routes"] }),
  });
}

// ===== Plan =====
export function usePlan() {
  return useMutation({
    mutationFn: (body: {
      startLat: number;
      startLon: number;
      endLat: number;
      endLon: number;
      sessionId?: string;
    }) => api.post<PlanResponse>("/api/plan", body),
  });
}

// ===== Export =====
export function useExportSession() {
  return useMutation({
    mutationFn: ({
      sessionId,
      format,
    }: {
      sessionId: string;
      format: "gpx" | "kml" | "json";
    }) =>
      api.post<ExportSyncResponse | ExportAsyncResponse>(
        `/api/sessions/${sessionId}/export`,
        { format }
      ),
  });
}

export function usePollExport(jobId: string | null) {
  return useQuery({
    queryKey: ["export", jobId],
    queryFn: () => api.get<ExportPollResponse>(`/api/exports/${jobId}`),
    enabled: !!jobId,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data) return 1500;
      if (data.status === "completed" || data.status === "failed") return false;
      return 1500;
    },
  });
}

// ===== Audit =====
export interface AuditQuery {
  limit?: number;
  cursor?: string;
  action?: string;
  actorType?: string;
  targetType?: string;
}

export function useAudit(params: AuditQuery) {
  return useQuery({
    queryKey: ["audit", params],
    queryFn: () =>
      api.get<{ logs: AuditLogItem[]; nextCursor: string | null }>(
        "/api/audit",
        params as Record<string, string | number | undefined>
      ),
    staleTime: 10_000,
  });
}

// ===== Backups =====
export function useBackups() {
  return useQuery({
    queryKey: ["backups"],
    queryFn: () => api.get<{ backups: BackupItem[] }>("/api/admin/backup"),
    staleTime: 30_000,
  });
}

// ===== Admin TrafficJobs =====
export interface AdminJobItem {
  id: string;
  sessionId: string;
  status: string;
  attempts: number;
  lockedBy: string | null;
  lockedAt: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
  scheduledFor: string;
  session: { deviceId: string; startTime: string } | null;
}
export interface AdminJobsResponse {
  jobs: AdminJobItem[];
  summary: Record<string, number>;
  total: number;
}

export function useAdminJobs(status?: string) {
  return useQuery({
    queryKey: ["admin-jobs", status],
    queryFn: () => {
      const qs = status ? `?status=${encodeURIComponent(status)}` : "";
      return api.get<AdminJobsResponse>(`/api/admin/jobs${qs}`);
    },
    refetchInterval: 15_000,
    staleTime: 10_000,
  });
}

export function useCreateBackup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.post<{ backupId: string; status: string; checksum?: string; fileSize?: number }>(
        "/api/admin/backup"
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["backups"] }),
  });
}

export function useRequeueJob() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (jobId: string) =>
      api.post<{ ok: boolean; jobId: string; status: string }>(
        "/api/admin/requeue",
        { jobId }
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["audit"] }),
  });
}

// ===== Metrics =====
export function useMetrics(opts?: UseQueryOptions<string>) {
  return useQuery({
    queryKey: ["metrics"],
    queryFn: async () => {
      const res = await fetch("/api/metrics", { credentials: "include" });
      return res.text();
    },
    staleTime: 30_000,
    refetchInterval: 60_000,
    ...opts,
  });
}
