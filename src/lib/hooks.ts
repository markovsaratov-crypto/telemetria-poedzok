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
// v2.9.9: офлайн-снимок статистики для PWA-заглушки (public/offline.html)
import { saveOfflineSummary } from "./offline-summary";

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
  perDay: { date: string; count: number; points: number; durationSec: number }[];
  heatmapSessions: { startTime: string; pointCount: number }[];
  capacity: { targetLoadRpm: number; rateLimitMaxIngest: number; headroom: number };
  version: string;
}

export function useStats() {
  return useQuery({
    queryKey: ["stats"],
    queryFn: async () => {
      const data = await api.get<StatsResponse>("/api/stats");
      // v2.9.9: офлайн-снимок — обновляем после каждого успешного запроса
      saveOfflineSummary({
        version: data.version,
        totalSessions: data.totalSessions,
        totalPoints: data.totalPoints,
      });
      return data;
    },
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
}

// ===== Device leaderboard =====
export interface DeviceStat {
  deviceId: string;
  deviceName: string | null;
  sessionCount: number;
  totalPoints: number;
  totalBytes: number;
  lastActivity: string | null;
}

export function useDeviceStats() {
  return useQuery({
    queryKey: ["device-stats"],
    queryFn: () => api.get<{ devices: DeviceStat[] }>("/api/stats/devices"),
    staleTime: 60_000,
  });
}

// ===== Tags cloud =====
export interface TagStat {
  name: string;
  count: number;
}

export function useTagsStats() {
  return useQuery({
    queryKey: ["tags-stats"],
    queryFn: () =>
      api.get<{ tags: TagStat[]; total: number; totalSessions: number }>("/api/stats/tags"),
    staleTime: 60_000,
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
    queryFn: async () => {
      const data = await api.get<{ sessions: SessionListItem[]; nextCursor: string | null }>(
        "/api/sessions",
        params as Record<string, string | number | undefined>
      );
      // v2.9.9: офлайн-снимок — самая свежая поездка (список по умолчанию «сначала новые»)
      const last = data.sessions?.[0];
      if (last) {
        saveOfflineSummary({
          lastSessionAt: last.startTime,
          lastDevice: last.deviceName || last.deviceId,
        });
      }
      return data;
    },
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

// ===== Session detailed stats =====
export interface SessionStats {
  sessionId: string;
  pointCount: number;
  // FIX-C1: distance — дистанция АКТИВНОЙ поездки (§4.11); rawDistanceM — вся запись
  // (разница = дрейф GPS в хвостах стоянки до старта/после финиша)
  distance: number;
  rawDistanceM?: number;
  duration: number;
  movingTime: number;
  idleTime: number;
  // v2.9.3: спидограмма — даунсемпл ≤240 точек {t: сек от старта, v: км/ч|null, st: 0 idle/1 moving/2 gap}
  // v2.9.4: сэмплы дополнены alt (м, сглаженная) и lat/lng (5 знаков) — высотный профиль + связка с картой
  speedProfile?: Array<{ t: number; v: number | null; st: 0 | 1 | 2; alt?: number | null; lat?: number; lng?: number }>;
  // v2.9.4: есть ли высотные данные у сэмплов (иначе профиль высоты не рендерим)
  hasAltitude?: boolean;
  // v2.9 §4.6: gapTime из state machine (контрольная сумма MovingTime + IdleTime + GapTime = Duration)
  gapTime?: number;
  // v2.9 §10.0: детерминированные хэши маршрута (вычисляются в ворчере, персистятся на session)
  routeHash?: string | null;
  topologyHash?: string | null;
  avgSpeed: number | null;
  maxSpeed: number | null;
  avgAltitude: number | null;
  elevationGain: number;
  elevationLoss: number;
  bbox: { minLat: number; maxLat: number; minLon: number; maxLon: number };
  startTime: string;
  endTime: string | null;
  // v2.9: полный набор метрик методологии (62 в 8 группах + routeId)
  methodology?: {
    // Группа 1
    movingTime: number;
    idleTime: number;
    gapTime: number;
    // Группа 2
    speedP50: number | null;
    speedStdDev: number | null;
    speedDistribution: number[];
    timeInTraffic: number;
    timeAtCruise: number;
    speedVariation: number;
    // Группа 4 — поведение (включая v2.9 новые)
    harshBrakingCount: number;
    harshAccelCount: number;
    ecoScore: {
      value: number | null;
      brakingRate: number;
      accelRate: number;
      jerkRate: number;
      rating: string;
      baselineVersion: string;
      breakdown: { brakingPenalty: number; accelPenalty: number; jerkPenalty: number };
    };
    accelerationRms: number | null;
    jerkRms: number | null;
    speedConsistencyIndex: number | null;
    bearingConsistency: number | null;
    uTurnCount: number;
    turnCount: number;
    highSpeedCornering: number;
    // Группа 5
    routeEfficiency: number | null;
    avgAccuracy: number | null;
    // Группа 8
    pointDensity: number | null;
    gapCount: number;
    gapTotalDurationMs: number;
    accuracyP90: number | null;
    completenessScore: number;
    sessionReliability: {
      value: number | null;
      completenessScore: number | null;
      driftScore: number | null;
      plausibilityScore: number | null;
      rating: string;
    };
    // v2.9: служебные
    activeTrip: {
      hasActiveTrip: boolean;
      activeStartTime: number;
      activeEndTime: number;
      activeDuration: number;
      activeStartCoord: { lat: number; lon: number };
      activeEndCoord: { lat: number; lon: number };
      preTripIdle: number;
      postTripIdle: number;
      activeIdleTime: number;
    };
    motion: {
      movingTime: number;
      idleTime: number;
      gapTime: number;
      states: ("idle" | "moving" | "gap")[];
    };
  };
  route?: {
    provider: string | null;
    planDistanceM: number | null;
    planDurationSec: number | null;
    trafficFetched: boolean;
    trafficDurationSec: number | null;
    timeLostToTrafficSec: number | null;
    durationDeviationPct: number | null;
    distanceDeviationPct: number | null;
    speedDeviationPct: number | null;
  };
}

export function useSessionStats(id: string | null) {
  return useQuery({
    queryKey: ["session-stats", id],
    queryFn: () => {
      if (!id) return null;
      return api.get<SessionStats>(`/api/sessions/${id}/stats`);
    },
    enabled: !!id,
    staleTime: 30_000,
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

// ===== Session search =====
export interface SearchResultItem {
  id: string;
  deviceId: string;
  deviceName: string | null;
  startTime: string;
  endTime: string | null;
  pointCount: number;
  payloadBytes: number;
  status: string;
  notes: string | null;
  tags: string | null;
  matchFields: string[];
}

export function useSessionSearch(query: string) {
  return useQuery({
    queryKey: ["session-search", query],
    queryFn: () =>
      api.get<{ sessions: SearchResultItem[]; query: string; total: number }>(
        `/api/sessions/search?q=${encodeURIComponent(query)}`
      ),
    enabled: query.trim().length > 0,
    staleTime: 10_000,
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

// ===== Session notes/tags =====
export function useUpdateSessionNotes() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: { id: string; notes?: string; tags?: string }) =>
      api.patch<{ notes: string | null; tags: string | null }>(
        `/api/sessions/${params.id}/notes`,
        { notes: params.notes, tags: params.tags }
      ),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ["session", vars.id] });
      qc.invalidateQueries({ queryKey: ["sessions"] });
      qc.invalidateQueries({ queryKey: ["audit"] });
    },
  });
}

// ===== Bulk delete =====
export function useBulkDeleteSessions() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) =>
      api.post<{ deleted: number; errors: string[] }>("/api/sessions/bulk-delete", { ids }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sessions"] });
      qc.invalidateQueries({ queryKey: ["stats"] });
      qc.invalidateQueries({ queryKey: ["audit"] });
      qc.invalidateQueries({ queryKey: ["device-stats"] });
      qc.invalidateQueries({ queryKey: ["tags-stats"] });
    },
  });
}

// ===== Session share =====
export interface ShareResult {
  token: string;
  url: string;
  expiresAt: string;
  sessionId: string;
}

export function useCreateShareLink() {
  return useMutation({
    mutationFn: (sessionId: string) =>
      api.post<ShareResult>(`/api/sessions/${sessionId}/share`),
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

// ===== Reverse geocoding =====
export function useReverseGeocode(lat: number | null, lon: number | null) {
  return useQuery({
    queryKey: ["geocode", lat, lon],
    queryFn: async () => {
      if (lat == null || lon == null) return null;
      const qs = `?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`;
      return api.get<{ address: string; cachedAt?: string; cached: boolean }>(
        `/api/geocode/reverse${qs}`
      );
    },
    enabled: lat != null && lon != null,
    staleTime: Infinity, // cached server-side
    retry: 1,
  });
}

// ===== Batch session stats (start/dest coords, distance, duration) =====
export interface BatchStatItem {
  id: string;
  deviceId: string;
  deviceName: string | null;
  startTime: string;
  endTime: string | null;
  startLat: number | null;
  startLon: number | null;
  destLat: number | null;
  destLon: number | null;
  distanceM: number;
  durationSec: number;
  pointCount: number;
  track?: { lat: number; lon: number }[]; // v2.9.6: ≤40 точек для мини-карты в списке поездок
}

export function useBatchStats(ids: string[]) {
  return useQuery({
    queryKey: ["batch-stats", ids],
    queryFn: () =>
      api.post<{ sessions: BatchStatItem[]; total: number }>("/api/sessions/batch-stats", { ids }),
    enabled: ids.length > 0,
    staleTime: 60_000,
  });
}

// ===== Aggregate stats (totalDistance, totalDuration, avgSpeed) =====
export interface AggregateStats {
  totalDistanceM: number;
  totalDistanceKm: number;
  totalDurationSec: number;
  totalDurationMin: number;
  avgSpeedMs: number | null;
  avgSpeedKmh: number | null;
  jobCount: number;
  validCount: number;
}

export function useAggregateStats() {
  return useQuery({
    queryKey: ["aggregate-stats"],
    queryFn: async () => {
      const data = await api.get<AggregateStats>("/api/stats/aggregate");
      // v2.9.9: офлайн-снимок — суммарные дистанция/длительность/средняя скорость
      saveOfflineSummary({
        totalDistanceKm: data.totalDistanceKm,
        totalDurationMin: data.totalDurationMin,
        avgSpeedKmh: data.avgSpeedKmh,
      });
      return data;
    },
    staleTime: 60_000,
  });
}

// ===== Speed distribution =====
export interface SpeedBucket {
  label: string;
  minKmh: number;
  maxKmh: number | null;
  count: number;
  percent: number;
}
export interface SpeedDistribution {
  buckets: SpeedBucket[];
  total: number;
  avgSpeedMs: number | null;
  avgSpeedKmh: number | null;
  maxSpeedMs: number;
  maxSpeedKmh: number;
  maxBucketCount: number;
}

export function useSpeedDistribution() {
  return useQuery({
    queryKey: ["speed-distribution"],
    queryFn: async () => {
      const data = await api.get<SpeedDistribution>("/api/stats/speed-distribution");
      // v2.9.9: офлайн-снимок — максимальная скорость по всем поездкам
      saveOfflineSummary({ maxSpeedKmh: data.maxSpeedKmh });
      return data;
    },
    staleTime: 60_000,
  });
}

// ===== Admin settings =====
export interface SettingItem {
  key: string;
  value: string;
  source: "db" | "env";
  updatedAt?: string;
  isSensitive: boolean;
}

export function useSettings() {
  return useQuery({
    queryKey: ["admin-settings"],
    queryFn: () => api.get<{ settings: SettingItem[] }>("/api/admin/settings"),
    staleTime: 30_000,
  });
}

export function useUpdateSetting() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (params: { key: string; value: string }) =>
      api.put<{ ok: boolean; key: string; value: string }>("/api/admin/settings", params),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin-settings"] }),
  });
}

// ===== GitHub backups =====
export interface GitHubBackupItem {
  backupId: string;
  releaseId: number;
  tagName: string;
  name: string;
  createdAt: string;
  assetUrl: string;
  assetSize: number;
  checksum: string | null;
}

export function useGitHubBackups() {
  return useQuery({
    queryKey: ["github-backups"],
    queryFn: () =>
      api.get<{ configured: boolean; backups: GitHubBackupItem[]; message?: string }>(
        "/api/admin/backup/github"
      ),
    staleTime: 30_000,
    retry: 1,
  });
}

export function useCreateGitHubBackup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.post<{
        backupId: string;
        releaseId: number;
        releaseUrl: string;
        assetUrl: string;
        assetSize: number;
        checksum: string;
      }>("/api/admin/backup/github"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["github-backups"] }),
  });
}

// ===== v2.9 §10: routeHash-группы и сравнительные метрики =====
export interface RouteGroupInfo {
  routeHash: string;
  topologyHash: string | null;
  sessionCount: number;
  firstSeen: string;
  lastSeen: string;
  avgActiveDurationSec: number | null;
  bestActiveDurationSec: number | null;
  worstActiveDurationSec: number | null;
  stdDevActiveDurationSec: number | null;
  avgDistanceM: number | null;
  startCoord: { lat: number; lon: number } | null;
  endCoord: { lat: number; lon: number } | null;
  deviceIds: string[];
  sessionIds: string[];
  polylineSample: { lat: number; lon: number }[] | null;
}

export function useRouteGroups() {
  return useQuery({
    queryKey: ["route-groups"],
    queryFn: () => api.get<{ groups: RouteGroupInfo[]; total: number }>("/api/routes/grouped"),
    staleTime: 60_000,
  });
}

// ===== v2.9.6: Тяжёлые участки — агрегация худших P75-хотспотов по всем группам =====
export interface HeavySegmentHotspot {
  segmentId: string;
  p75: number;
  a: { lat: number; lon: number } | null;
  b: { lat: number; lon: number } | null;
}

export interface HeavySegmentGroup {
  routeHash: string;
  sessionCount: number;
  totalSegments: number;
  hotspotCount: number;
  avgDistanceM: number | null;
  lastSeen: string;
  polylineSample: { lat: number; lon: number }[];
  worstHotspots: HeavySegmentHotspot[];
}

export interface HeavySegmentsData {
  groups: HeavySegmentGroup[];
  groupCount: number;
  groupsSkipped: number;
  totalHotspotSegments: number;
  worstP75: number | null;
}

export function useHeavySegments() {
  return useQuery({
    queryKey: ["heavy-segments"],
    queryFn: () => api.get<HeavySegmentsData>("/api/routes/heavy-segments"),
    staleTime: 120_000,
    retry: 1,
  });
}

export interface RouteComparisonData {
  sessionId: string;
  routeHash: string;
  groupSize: number;
  stats: {
    avg: number | null;
    best: number | null;
    worst: number | null;
    stdDev: number | null;
    eligibleCount: number;
    totalCount: number;
  };
  sessionActiveDurationSec: number;
  rank: number | null;
  percentile: number | null;
  vsAvgPct: number | null;
  trafficPattern: { bucket: number; label: string; avgActiveDurationSec: number | null; sessionCount: number }[];
  dayOfWeekPattern: { dow: number; label: string; avgActiveDurationSec: number | null; sessionCount: number }[];
  trend: {
    slope: number | null;
    intercept: number | null;
    ci95: [number, number] | null;
    rating: "improving" | "stable" | "degrading" | "insufficient_data";
    sampleSize: number;
    method: string;
  };
  history: { sessionId: string; date: string; activeDurationSec: number; deviceId: string }[];
}

export function useRouteComparison(sessionId: string | null) {
  return useQuery({
    queryKey: ["route-comparison", sessionId],
    queryFn: () => api.get<RouteComparisonData>(`/api/sessions/${sessionId}/route-comparison`),
    enabled: !!sessionId,
    staleTime: 60_000,
    retry: false,
  });
}

export interface RouteTrendData {
  routeId: string;
  groupSize: number;
  trend: RouteComparisonData["trend"];
  stats: RouteComparisonData["stats"];
  history: RouteComparisonData["history"];
  // v2.10.1: paterns для блока 10 аналитики (Частые маршруты) — без них UI пришлось бы
  // тянуть /api/sessions/[id]/route-comparison для каждой группы отдельно.
  trafficPattern?: RouteComparisonData["trafficPattern"];
  dayOfWeekPattern?: RouteComparisonData["dayOfWeekPattern"];
}

export function useRouteTrend(routeHash: string | null) {
  return useQuery({
    queryKey: ["route-trend", routeHash],
    queryFn: () => api.get<RouteTrendData>(`/api/routes/${routeHash}/trend`),
    enabled: !!routeHash,
    staleTime: 60_000,
    retry: false,
  });
}

export interface RouteHotspotsData {
  routeId: string;
  groupSize: number;
  totalSegments: number;
  hotspotCount: number;
  hotspots: {
    segmentId: string;
    p75: number;
    p25: number;
    worstSeverity: number;
    congestedSessionCount: number;
    totalSessionCount: number;
    a?: { lat: number; lon: number } | null;
    b?: { lat: number; lon: number } | null;
  }[];
  polylineSample: { lat: number; lon: number }[];
}

export function useRouteHotspots(routeHash: string | null) {
  return useQuery({
    queryKey: ["route-hotspots", routeHash],
    queryFn: () => api.get<RouteHotspotsData>(`/api/routes/${routeHash}/hotspots`),
    enabled: !!routeHash,
    staleTime: 60_000,
    retry: false,
  });
}
