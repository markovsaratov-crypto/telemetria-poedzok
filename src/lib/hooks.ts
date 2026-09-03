// src/lib/hooks.ts — React Query хуки для серверного состояния.
// Все хуки используют api-client (credentials:"include").

"use client";

import {
  useQuery,
  useMutation,
  useQueryClient,
  UseQueryOptions,
  type QueryClient,
} from "@tanstack/react-query";
import {
  api,
  type SessionListItem,
  type SessionDetail,
  type BackupItem,
  type HealthResponse,
  type ExportSyncResponse,
  type ExportAsyncResponse,
  type ExportPollResponse,
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

// ===== v2.11.0 (U-17): RU-расшифровки исходов инжеста и статусов для UI =====
// INGEST_OUTCOME_RU зеркалит одноимённую константу из src/lib/ingest-trace.ts:
// тот файл — серверный (импортирует @libsql-клиент и создаёт соединение в
// module scope), его нельзя тянуть в «use client»-бандл — браузерный чанк
// упадёт при загрузке. Синхронизировать при изменении набора исходов.
export const INGEST_OUTCOME_RU: Record<string, string> = {
  accepted: "точки приняты",
  empty: "пустой батч (test push)",
  no_gps: "нет GPS-точек в батче",
  dropped_all: "все точки отброшены (точность > 100 м)",
  invalid: "невалидный формат (400)",
  duplicate: "дубль (идемпотентность)",
};

// v2.11.0 (U-15): RU-подписи статусов (сессии/бэкапы) — с fallback на исходное значение.
export const SESSION_STATUS_RU: Record<string, string> = {
  completed: "завершена",
  recording: "идёт запись",
  processing: "в обработке",
};
export const BACKUP_STATUS_RU: Record<string, string> = {
  completed: "завершён",
  failed: "ошибка",
  running: "выполняется",
  pending: "в очереди",
  dead: "мёртвая",
};

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
  // v2.18.0: perDay удалён вместе с серверным полем (0 потребителей)
  heatmapSessions: { startTime: string; pointCount: number }[];
  capacity: { targetLoadRpm: number; rateLimitMaxIngest: number; headroom: number };
  version: string;
  // DIAG-1: трассировка попыток инжеста (переживает рестарты — Setting в БД)
  ingestTrace?: {
    last: {
      at: string;
      route: "sensorlogger" | "ingest";
      deviceId: string | null;
      outcome: "accepted" | "empty" | "no_gps" | "dropped_all" | "invalid" | "duplicate";
      points: number;
      dropped: number;
      bytes: number | null;
      // v2.10.7: образец структуры payload для нераспознанных батчей
      sample?: string | null;
    } | null;
    recent: Array<{
      at: string;
      route: string;
      deviceId: string | null;
      outcome: string;
      points: number;
      dropped: number;
      bytes: number | null;
      sample?: string | null;
    }>;
    updatedAt: string | null;
  } | null;
  // v2.10.8: полный дамп последнего нераспознанного батча — только при
  // запросе с ?ingestRaw=1 (кнопка «полный дамп» в L1)
  ingestRaw?: {
    at: string;
    deviceId: string | null;
    route: string;
    outcome: string;
    bytes: number;
    truncated: boolean;
    body: string;
  } | null;
}

export function useStats() {
  return useQuery({
    queryKey: ["stats", new Date().getTimezoneOffset()],
    queryFn: async () => {
      // v2.16.0 (B-7): ?tzOffsetMin — «сегодня» в поясе клиента (как у батя-статс)
      const data = await api.get<StatsResponse>(`/api/stats?tzOffsetMin=${new Date().getTimezoneOffset()}`);
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
    // v2.14.0 (Ф2): живое обновление списка — опрос каждые 30с, ПОКА ВКЛАДКА
    // АКТИВНА (refetchIntervalInBackground=false по умолчанию — свёрнутая
    // вкладка не расходует батарею/трафик). Закрывает кейс «вечерняя поездка
    // не появилась»: вкладка, открытая днём, показывала дневной снапшот до
    // ручной перезагрузки (refetchOnWindowFocus был выключен ещё в v2.9).
    refetchInterval: 30_000,
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
    // v2.13.0 (Ф4): число поездок с планом в период-агрегате — знаменатель
    // для честного «мин/поездку» (§6.3 TimeSavingIndex). Одиночная сессия не проставляет.
    planTripCount?: number | null;
  };
}

export function useSessionStats(id: string | null, opts?: { live?: boolean }) {
  // v2.17.0: пока id «покрыт» свежим батчем (/api/stats/batch просеял статы в
  // кэш этим же ключом) — по сети не ходим: ни на холодной загрузке, ни при
  // перемонтировании вкладки шторм из N запросов не воспроизводится. Живые
  // записи — исключение: их статы обновляются интервалом 15с (Ф2).
  const covered =
    id != null &&
    !opts?.live &&
    Date.now() - (statsBatchCover.get(id) ?? Number.NEGATIVE_INFINITY) < STATS_BATCH_COVER_MS;
  return useQuery({
    queryKey: ["session-stats", id],
    queryFn: () => {
      if (!id) return null;
      return api.get<SessionStats>(`/api/sessions/${id}/stats`);
    },
    enabled: !!id && !covered,
    staleTime: 30_000,
    // v2.14.0 (Ф2): для идущей записи — обновление стат каждые 15с
    // (раскрывая живую карточку, видно как растут точки/дистанция;
    // для завершённых записей ничего не меняется — интервал не ставится)
    refetchInterval: opts?.live ? 15_000 : undefined,
  });
}

// ===== v2.17.0: батч-статс (GET /api/stats/batch?ids=…) =====
// Один запрос вместо N× /api/sessions/[id]/stats. Ответ — идентичный формат
// SessionStats, поэтому результат «просеивается» в кэш по тем же ключам
// ["session-stats", id], что использует useSessionStats, — все существующие
// потребители (карточки «Поездок», агрегаторы, детальный просмотр) получают
// данные мгновенно, без своего запроса.
export interface StatsBatchResponse {
  stats: SessionStats[];
  /** id, которых нет / они удалены — клиент может добрать их по одному */
  missing: string[];
}

const STATS_BATCH_MAX_IDS = 50; // лимит роута
const STATS_BATCH_COVER_MS = 5 * 60_000; // «покрытие» per-session кэша батчем
/** id → timestamp последнего успешного посева из батча */
const statsBatchCover = new Map<string, number>();

/** Стабильный строковый ключ множества id (порядок не важен). */
function idsKeyOf(ids: string[]): string {
  return Array.from(new Set(ids.filter(Boolean))).sort().join(",");
}

/**
 * Посев статов батча в кэш per-session ключей + отметка покрытия.
 * Идемпотентен; вызывается СИНХРОННО до монтирования потребителей
 * (см. комментарий в useSessionsStatsBatch — v2.17.2, фикс гонки).
 */
function seedStatsIntoCache(qc: QueryClient, stats: SessionStats[]): void {
  if (stats.length === 0) return;
  const now = Date.now();
  for (const s of stats) {
    qc.setQueryData(["session-stats", s.sessionId], s);
    statsBatchCover.set(s.sessionId, now);
  }
}

/** v2.17.2: id покрыт свежим батчем (кэш просеян, персональный запрос не нужен)? */
export function isStatsBatchCovered(id: string): boolean {
  return Date.now() - (statsBatchCover.get(id) ?? Number.NEGATIVE_INFINITY) < STATS_BATCH_COVER_MS;
}

/**
 * v2.17.2: посев из ВНЕШНЕГО батча (период-агрегат «Аналитики» получает тот же
 * /api/stats/batch, но через собственный queryFn) — «Поездки» после аналитики
 * рендерятся из кэша мгновенно.
 */
export function seedSessionsStatsFromBatch(qc: QueryClient, stats: SessionStats[]): void {
  seedStatsIntoCache(qc, stats);
}

/** Плоская функция — используется и хуком, и queryFn usePeriodStats. */
export async function fetchSessionsStatsBatch(ids: string[]): Promise<StatsBatchResponse> {
  const uniq = Array.from(new Set(ids.filter(Boolean)));
  if (uniq.length === 0) return { stats: [], missing: [] };
  // чанки по 50 — лимит роута; на практике список ≤50 и период ≤30 — один запрос
  const chunks: string[][] = [];
  for (let i = 0; i < uniq.length; i += STATS_BATCH_MAX_IDS) {
    chunks.push(uniq.slice(i, i + STATS_BATCH_MAX_IDS));
  }
  const parts = await Promise.all(
    chunks.map((c) => api.get<StatsBatchResponse>("/api/stats/batch", { ids: c.join(",") }))
  );
  return {
    stats: parts.flatMap((p) => p.stats),
    missing: parts.flatMap((p) => p.missing),
  };
}

/**
 * Батч-загрузка статов списка сессий + сидинг пер-сессионного кэша.
 * Ставится в корне вкладки («Поездки») и в корне лейаута (префетч) — один
 * ключ на множество id → один запрос на множество карточек.
 */
export function useSessionsStatsBatch(ids: string[]) {
  const qc = useQueryClient();
  // строковый ключ стабилен независимо от identity массива на каждом рендере
  const idsKey = idsKeyOf(ids);

  return useQuery({
    queryKey: ["stats-batch", idsKey],
    queryFn: async () => {
      const res = await fetchSessionsStatsBatch(idsKey ? idsKey.split(",") : []);
      // v2.17.2 (фикс гонки, прод-лог v2.17.1): посев СИНХРОННО до возврата.
      // queryFn выполняется ДО рендера детей на этих данных; посев в useEffect
      // родителя опаздывал — эффекты детей срабатывают раньше родительского,
      // useSessionStats при монтировании видел пустое покрытие и стартовал
      // поштучный запрос на каждую запись: «шторм» из N запросов
      // воспроизводился ровно в момент прилёта батча. Теперь покрытие
      // устанавливается до монтирования карточек.
      seedStatsIntoCache(qc, res.stats);
      return res;
    },
    enabled: idsKey !== "",
    staleTime: 30_000,
    retry: 1,
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
      // v2.18.0: "dead" — тоже терминальное (страховка: сервер мапит dead→failed)
      if (data.status === "completed" || data.status === "failed" || data.status === "dead") return false;
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
// v2.12.0 (Q3): хук оживлён — теперь им идентифицируются поездки по адресу
// конечной точки (требование владельца). Чтобы не завалить Nominatim пачкой
// параллельных запросов при первом рендере списка, queryFn ждёт слот в
// глобальной вежливой очереди (≤1 запрос / 700 мс). Кэш 30 дней на сервере —
// повторные открытия мгновенны.
export interface GeocodeResult {
  address: string;
  // v2.12.0 (Q3): компактная подпись («улица Ленина, 44») для заголовков
  short: string;
  cachedAt?: string;
  cached: boolean;
  error?: string;
}

let geoQueue: Array<() => void> = [];
let geoActive = false;

function acquireGeocodeSlot(): Promise<void> {
  return new Promise((resolve) => {
    geoQueue.push(resolve);
    void (async () => {
      if (geoActive) return;
      geoActive = true;
      while (geoQueue.length > 0) {
        const next = geoQueue.shift();
        if (next) next();
        await new Promise((r) => setTimeout(r, 700));
      }
      geoActive = false;
    })();
  });
}

export function useReverseGeocode(lat: number | null, lon: number | null) {
  return useQuery({
    queryKey: ["geocode", lat, lon],
    queryFn: async () => {
      if (lat == null || lon == null) return null;
      await acquireGeocodeSlot();
      const qs = `?lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`;
      return api.get<GeocodeResult>(`/api/geocode/reverse${qs}`);
    },
    enabled: lat != null && lon != null,
    staleTime: Infinity, // cached server-side
    retry: 0, // Nominatim недоступен — не долбим повторами
  });
}

// v2.12.0 (Q3): адрес конечной точки для идентификации поездки/маршрута.
// Возвращает короткую подпись и признак загрузки; при ошибке — null
// (вызывающий показывает fallback — имя устройства).
export function useDestAddress(lat: number | null | undefined, lon: number | null | undefined) {
  const q = useReverseGeocode(lat ?? null, lon ?? null);
  return {
    short: q.data?.short ?? null,
    full: q.data?.address ?? null,
    isLoading: q.isLoading,
  };
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
  releaseUrl: string;
  isDraft: boolean;
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
        draft: boolean;
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

// v2.16.0 (B-7/B-4): tz-параметр для период-запросов «сегодня» — полночь считается
// в поясе КЛИЕНТА (как getTimezoneOffset; Саратов → -240). Без этого «Сегодня»
// в аналитике/маршрутах начинался в 03:00 МСК на UTC-сервере.
function tzQuery(since?: string): string {
  const tz = new Date().getTimezoneOffset();
  const suffix = `tzOffsetMin=${tz}`;
  return since ? `period=${encodeURIComponent(since)}&${suffix}` : suffix;
}

export function useRouteGroups(period?: string) {
  return useQuery({
    // v2.12.0 (D-8): период входит в ключ — смена «Сегодня»→«30 дней» перезабирает
    // группы с сервера (?period=...), а не показывает общий список.
    queryKey: ["route-groups", period ?? "all", new Date().getTimezoneOffset()],
    queryFn: () =>
      api.get<{ groups: RouteGroupInfo[]; total: number }>(
        `/api/routes/grouped?${tzQuery(period)}`
      ),
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
  // v2.12.0 (Q3): координаты финиша — адресная идентификация маршрута
  endCoord?: { lat: number; lon: number } | null;
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

export function useHeavySegments(period?: string) {
  return useQuery({
    // v2.12.0 (D-8): тяжёлые участки уважают выбранный период (?period=...).
    queryKey: ["heavy-segments", period ?? "all", new Date().getTimezoneOffset()],
    queryFn: () =>
      api.get<HeavySegmentsData>(
        `/api/routes/heavy-segments?${tzQuery(period)}`
      ),
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

// v2.18.0: RouteHotspotsData удалён — типировал удалённый /api/routes/[id]/hotspots (v2.16.0)

