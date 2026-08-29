// src/lib/api-client.ts — fetch wrapper с cookie auth + обработка ошибок.
// Все запросы идут с credentials:"include" для проброса __Host-telem_session cookie.
// 401 → выставляем auth-флаг через callback (page.tsx слушает), 429 → toast, 500 → toast с requestId.

import { toast } from "sonner";

export class ApiError extends Error {
  status: number;
  requestId?: string;
  body?: unknown;
  constructor(message: string, status: number, requestId?: string, body?: unknown) {
    super(message);
    this.status = status;
    this.requestId = requestId;
    this.body = body;
  }
}

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(cb: () => void) {
  onUnauthorized = cb;
}

interface FetchOpts extends RequestInit {
  // query параметры
  query?: Record<string, string | number | undefined | null>;
  // если true — не бросать ошибку, вернуть response целиком (для не-JSON ответов)
  raw?: boolean;
  // ожидаемый тип ответа
  expect?: "json" | "text" | "blob" | "none";
}

function buildUrl(path: string, query?: FetchOpts["query"]): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === "") continue;
    params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

async function parseBody(res: Response, expect: FetchOpts["expect"]): Promise<unknown> {
  if (expect === "none" || res.status === 204) return null;
  const ct = res.headers.get("content-type") || "";
  if (expect === "blob" || ct.includes("application/octet-stream")) {
    return await res.blob();
  }
  if (expect === "text" || !ct.includes("application/json")) {
    return await res.text();
  }
  const txt = await res.text();
  if (!txt) return null;
  try {
    return JSON.parse(txt);
  } catch {
    return txt;
  }
}

export async function apiFetch<T = unknown>(
  path: string,
  opts: FetchOpts = {}
): Promise<T> {
  const { query, raw, expect = "json", headers, ...rest } = opts;
  const url = buildUrl(path, query);

  let res: Response;
  try {
    res = await fetch(url, {
      ...rest,
      headers: {
        Accept: "application/json",
        ...(headers || {}),
      },
      credentials: "include",
    });
  } catch (err) {
    toast.error("Сеть недоступна", {
      description: err instanceof Error ? err.message : "Не удалось связаться с сервером",
    });
    throw new ApiError("Network error", 0);
  }

  const requestId = res.headers.get("x-request-id") || undefined;

  // 401: auth lost — but don't trigger handler for /api/auth/me (expected before login)
  if (res.status === 401) {
    if (!url.includes("/api/auth/me") && onUnauthorized) {
      onUnauthorized();
    }
    const body = (await parseBody(res, expect)) as { error?: string } | null;
    throw new ApiError(body?.error || "Требуется авторизация", 401, requestId, body);
  }

  // 429: rate limit
  if (res.status === 429) {
    const body = (await parseBody(res, expect)) as { error?: string; retryAfter?: number } | null;
    const retryAfter = body?.retryAfter || Number(res.headers.get("retry-after")) || 60;
    toast.error("Слишком много запросов", {
      description: `Повторите через ${retryAfter} сек.`,
    });
    throw new ApiError(body?.error || "Rate limit exceeded", 429, requestId, body);
  }

  // 5xx
  if (res.status >= 500) {
    const body = (await parseBody(res, expect)) as { error?: string } | null;
    toast.error("Ошибка сервера", {
      description: requestId ? `Request ID: ${requestId}` : body?.error || "Внутренняя ошибка",
    });
    throw new ApiError(body?.error || "Internal Server Error", res.status, requestId, body);
  }

  if (raw) return res as unknown as T;

  // 4xx (не 401/429)
  if (res.status >= 400 && res.status < 500) {
    const body = await parseBody(res, expect);
    throw new ApiError(
      (body as { error?: string })?.error || `HTTP ${res.status}`,
      res.status,
      requestId,
      body
    );
  }

  const data = await parseBody(res, expect);
  return data as T;
}

// Удобные обёртки
export const api = {
  get: <T = unknown>(path: string, query?: FetchOpts["query"], opts?: FetchOpts) =>
    apiFetch<T>(path, { method: "GET", query, ...opts }),

  post: <T = unknown>(path: string, body?: unknown, opts?: FetchOpts) =>
    apiFetch<T>(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(opts?.headers || {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      ...opts,
    }),

  patch: <T = unknown>(path: string, body?: unknown, opts?: FetchOpts) =>
    apiFetch<T>(path, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", ...(opts?.headers || {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      ...opts,
    }),

  put: <T = unknown>(path: string, body?: unknown, opts?: FetchOpts) =>
    apiFetch<T>(path, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...(opts?.headers || {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      ...opts,
    }),

  delete: <T = unknown>(path: string, opts?: FetchOpts) =>
    apiFetch<T>(path, { method: "DELETE", ...opts }),

  upload: <T = unknown>(path: string, formData: FormData, opts?: FetchOpts) =>
    // НЕ ставим Content-Type — браузер выставит multipart с boundary сам
    apiFetch<T>(path, {
      method: "POST",
      body: formData,
      ...opts,
    }),
};

// ===== Типы ответов API =====
export interface SessionListItem {
  id: string;
  deviceId: string;
  deviceName?: string | null;
  startTime: string;
  endTime?: string | null;
  pointCount: number;
  payloadBytes: number;
  status: string;
  routeId?: string | null;
  route?: { id: string; name: string } | null;
}

export interface GpsPoint {
  lat: number;
  lon: number;
  speed?: number | null;
  altitude?: number | null;
  accuracy?: number | null;
  bearing?: number | null;
  timestamp: number;
}

export interface SessionDetail extends SessionListItem {
  points: GpsPoint[];
  traffic: { status?: string; trafficFetched?: boolean; [k: string]: unknown };
  route?: { id: string; name: string; description?: string | null } | null;
  notes?: string | null;
  tags?: string | null;
}

export interface RouteItem {
  id: string;
  name: string;
  description?: string | null;
  startLat: number;
  startLon: number;
  endLat: number;
  endLon: number;
  createdAt: string;
  updatedAt: string;
  _count?: { sessions: number };
}

export interface AuditLogItem {
  id: string;
  action: string;
  targetId: string;
  targetType: string;
  actorType: string;
  actorId?: string | null;
  metadata?: string | null;
  sessionId?: string | null;
  createdAt: string;
}

export interface BackupItem {
  id: string;
  status: string;
  type: string;
  filePath?: string | null;
  fileSize?: number | null;
  checksum?: string | null;
  createdAt: string;
  completedAt?: string | null;
  error?: string | null;
}

export interface HealthResponse {
  status: "ok" | "degraded";
  db: "ok" | "degraded";
  worker: "ok" | "degraded";
  circuits?: Record<string, { state: string; failures: number }>;
  rateLimiter?: { buckets: number; backend?: string };
  version: string;
  uptime: number;
  targetLoadRpm?: number;
  rateLimitMaxIngest?: number;
}

export interface ExportSyncResponse {
  url: string;
  filename: string;
  format: string;
  size: number;
}

export interface ExportAsyncResponse {
  jobId: string;
  status: string;
  async?: boolean;
}

export interface ExportPollResponse {
  status: string;
  jobId?: string;
  url?: string;
  fileSize?: number | null;
  expiresAt?: string | null;
  format?: string;
}

export interface PlanResponse {
  route?: {
    provider?: string;
    distanceM?: number;
    durationSec?: number;
    polyline?: Array<[number, number]>;
    segments?: Array<{ lat: number; lon: number }>;
    cached?: boolean;
    trafficFetched?: boolean;
    trafficUtc?: string;
    // Aliases for backwards-compat (старые версии API могли использовать distance/duration/geometry)
    distance?: number;
    duration?: number;
    geometry?: Array<[number, number]>;
    [k: string]: unknown;
  } | null;
  trafficJobId?: string | null;
  cached?: boolean;
}

// ===== v2.10.0: Типы ответов для v4 analytics (R1 Live API) =====

export interface TrackPoint {
  i: number;
  t: number; // сек от старта
  lat: number;
  lng: number;
  v: number | null; // м/с
  alt: number | null;
  brg: number | null;
  acc: number | null;
  st: 0 | 1; // 0=idle, 1=moving
}

export interface TrackSegment {
  color: string;
  bucket: string;
  points: Array<{ lat: number; lng: number }>;
  startIndex: number;
  endIndex: number;
}

export interface TrackGap {
  fromIdx: number;
  toIdx: number;
  durationSec: number;
}

export interface TrackHarshPoint {
  lat: number;
  lng: number;
  type: "braking" | "acceleration";
  dv: number;
  idx: number;
  t: number;
}

export interface TrackMarkers {
  start: { lat: number; lng: number; t: number };
  finish: { lat: number; lng: number; t: number };
}

export interface TrackResponse {
  sessionId: string;
  deviceId: string;
  startTime: string | number;
  endTime: string | number | null;
  pointCount: number;
  bounds: [[number, number], [number, number]] | null;
  points: TrackPoint[];
  segments: TrackSegment[];
  gaps: TrackGap[];
  harshPoints: TrackHarshPoint[];
  markers: TrackMarkers | null;
  defaultLayer: string;
  availableLayers: string[];
  legend: Array<{ color: string; label: string }>;
}

export interface Maneuver {
  lat: number;
  lng: number;
  t: number;
  longA: number; // м/с²
  latA: number; // м/с²
  speed: number; // км/ч
  bearing: number;
}

export interface EventsHarshEvent {
  lat: number;
  lng: number;
  type: "braking" | "acceleration";
  longA: number;
  t: number;
  speed: number;
}

export interface HscEvent {
  lat: number;
  lng: number;
  t: number;
  turnDeg: number;
  speed: number;
}

export interface GgPoint {
  x: number; // longA / g
  y: number; // latA / g
}

export interface EventsSummary {
  accelerationRMS: number; // м/с²
  jerkRMS: number; // м/с³
  harshBraking: number;
  harshAcceleration: number;
  maneuvers: number;
  hscCount: number;
}

export interface EventsResponse {
  sessionId: string;
  deviceId: string;
  maneuvers: Maneuver[];
  gg: {
    points: GgPoint[];
    rings: number[]; // [0.2, 0.4, 0.6]
  };
  harshEvents: EventsHarshEvent[];
  hscEvents: HscEvent[];
  summary: EventsSummary;
}

// Скоростной профиль точки из /api/sessions/[id]/stats (v2.9.3+)
export interface SpeedProfilePoint {
  t: number; // сек от старта
  v: number | null; // км/ч (null = нет GPS-скорости)
  st: 0 | 1 | 2; // 0=idle, 1=moving, 2=gap
  alt?: number | null;
  lat?: number;
  lng?: number;
}
