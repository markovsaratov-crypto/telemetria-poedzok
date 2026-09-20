"use client";

// src/app/shared/[token]/shared-view.tsx — клиентский островок публичной
// share-страницы (P1-9). v2.38.1 (ревью F21/F23): данные приходят ПРОПСОМ из
// серверной обёртки page.tsx (клиентский fetch /api/share удалён — страница
// не грузит трек дважды), Math.min/max — циклами вместо спреда, рендер
// обёрнут в ErrorBoundary (данные недоверенного размера).

import * as React from "react";
import { Activity, Calendar, Timer, Route as RouteIcon, Gauge } from "lucide-react";

// P2-14: канонический гаверсинус — src/lib/geo.ts (была локальная копия)
import { plausibleIntervalM } from "@/lib/geo";
import { ErrorBoundary } from "@/components/error-boundary";

export interface SharedPoint {
  lat: number;
  lon: number;
  speed: number | null;
  altitude: number | null;
  timestamp: number;
}

export interface SharedPayload {
  sessionId: string;
  deviceId: string;
  deviceName?: string | null;
  startTime: number | string;
  endTime: number | string;
  pointCount: number;
  points: SharedPoint[];
  expiresAt: string;
  // FIX-C3: серверные KPI по активной части (§4.11) — считаются в /api/share
  distanceM?: number;
  rawDistanceM?: number;
  activeDurationSec?: number;
  preTripIdleSec?: number;
  postTripIdleSec?: number;
  hasActiveTrip?: boolean;
  maxSpeedMs?: number;
}

/** Состояние, вычисленное серверной обёрткой (page.tsx): payload или ошибка резолва */
export type SharedState =
  | { kind: "ok"; data: SharedPayload }
  | { kind: "error"; message: string };

function fmtDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return "—";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.round(sec % 60);
  return h > 0 ? `${h} ч ${m} мин` : m > 0 ? `${m} мин ${s} с` : `${s} с`;
}

// AUDIT B-3: ISO-строка ИЛИ epoch-миллисекунды → мс. Некорректное → NaN (покажется «—»).
function toMs(v: number | string): number {
  if (typeof v === "number") return v;
  const n = Number(v);
  if (Number.isFinite(n) && v.trim() !== "") return n;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : NaN;
}

// AUDIT B-3: русская локаль — десятичная запятая (было «2.53 км»).
function fmtNum(n: number, digits = 2): string {
  return Number.isFinite(n) ? n.toFixed(digits).replace(".", ",") : "—";
}

// v2.38.1 (ревью F21): Math.min(...arr)/Math.max(...arr) спредом падает
// RangeError при >65–125K аргументов (Safari/V8) на больших треках —
// белый экран без error boundary. Цикл не ограничен длиной массива.
function minOf(nums: number[]): number {
  let m = nums.length > 0 ? nums[0] : NaN;
  for (let i = 1; i < nums.length; i++) if (nums[i] < m) m = nums[i];
  return m;
}

function maxOf(nums: number[]): number {
  let m = nums.length > 0 ? nums[0] : NaN;
  for (let i = 1; i < nums.length; i++) if (nums[i] > m) m = nums[i];
  return m;
}

export function SharedView({ state }: { state: SharedState }) {
  if (state.kind === "error") {
    return (
      <Shell>
        <h1 className="text-lg font-semibold">Поездка недоступна</h1>
        <p className="text-sm text-muted-foreground">{state.message}</p>
      </Shell>
    );
  }

  // v2.38.1 (ревью F21): рендер недоверенного payload — под error boundary:
  // любое исключение (битые числа, неожиданные формы) вместо белого экрана
  // даёт карточку «Не удалось отобразить поездку» с перезагрузкой.
  return (
    <ErrorBoundary fallbackTitle="Не удалось отобразить поездку">
      <SharedTripContent data={state.data} />
    </ErrorBoundary>
  );
}

function SharedTripContent({ data }: { data: SharedPayload }) {
  const pts = data.points;
  // AUDIT B-3: API отдаёт startTime/endTime как ISO-строки — парсим напрямую через Date,
  // а не Number(...) (NaN → «Invalid Date»). Поддержка числовых мс оставлена для совместимости.
  const startTimeMs = toMs(data.startTime);
  const endTimeMs = toMs(data.endTime);
  const durationSec = Math.max(0, (endTimeMs - startTimeMs) / 1000);

  // FIX-C3: KPI — из серверного расчёта по активной части (согласован с админкой):
  //   дистанция — без дрейфа «хвостов», средняя — активная дистанция / активное время,
  //   макс — с фильтром GPS-выбросов. Локальный пересчёт оставлен как fallback
  //   (устаревший/кэшированный payload без новых полей).
  const activeDuration = data.activeDurationSec ?? 0;
  const tailsSec = Math.max(0, (data.preTripIdleSec ?? 0) + (data.postTripIdleSec ?? 0));
  let distance: number;
  let maxSpeed: number;
  if (data.distanceM != null) {
    distance = data.distanceM;
    maxSpeed = data.maxSpeedMs ?? 0;
  } else {
    distance = 0;
    maxSpeed = 0;
    for (let i = 1; i < pts.length; i++) {
      // v2.40.7 (N-3): fallback-дистанция — с фильтром телепортов (как серверный
      // расчёт /api/share): прыжки с v_impl > 200 км/ч не накручивают км.
      distance += plausibleIntervalM(
        pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon,
        (pts[i].timestamp - pts[i - 1].timestamp) / 1000
      );
      if (pts[i].speed != null) maxSpeed = Math.max(maxSpeed, pts[i].speed!);
    }
  }
  const avgSpeed =
    data.distanceM != null
      ? activeDuration > 0 && distance > 0
        ? distance / activeDuration
        : null
      : durationSec > 0 && distance > 0
        ? distance / durationSec
        : null;
  const rawDistance = data.rawDistanceM ?? distance;
  const driftM = Math.max(0, rawDistance - distance);

  // SVG-превью трека (точки уже прорежены сервером до ≤800 — ревью F21)
  const lats = pts.map((p) => p.lat);
  const lons = pts.map((p) => p.lon);
  const minLat = minOf(lats), maxLat = maxOf(lats);
  const minLon = minOf(lons), maxLon = maxOf(lons);
  const W = 560, H = 360, PAD = 24;
  const spanLat = Math.max(maxLat - minLat, 1e-6);
  const spanLon = Math.max(maxLon - minLon, 1e-6);
  const scale = Math.min((W - 2 * PAD) / spanLon, (H - 2 * PAD) / spanLat);
  const project = (p: SharedPoint): [number, number] => [
    W / 2 + (p.lon - (minLon + spanLon / 2)) * scale,
    H / 2 - (p.lat - (minLat + spanLat / 2)) * scale,
  ];
  const pathD = pts.length > 1 ? pts.map((p, i) => `${i === 0 ? "M" : "L"}${project(p).map((v) => v.toFixed(1)).join(",")}`).join(" ") : "";

  return (
    <Shell>
      <div className="space-y-4">
        <div>
          <h1 className="text-lg font-semibold flex items-center gap-2">
            <Activity className="h-5 w-5 text-primary" />
            Поездка {data.deviceName || data.deviceId}
          </h1>
          <p className="text-xs text-muted-foreground flex items-center gap-1.5 mt-1">
            <Calendar className="h-3.5 w-3.5" />
            {new Date(startTimeMs).toLocaleString("ru-RU")}
            <span className="mx-1">·</span>
            действует до {new Date(data.expiresAt).toLocaleString("ru-RU")}
          </p>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <Stat
            icon={<RouteIcon className="h-4 w-4" />}
            label="Дистанция"
            value={distance > 0 ? `${fmtNum(distance / 1000)} км` : "—"}
            sub={driftM > 30 ? `без хвостов · дрейф −${fmtNum(driftM / 1000, 2)} км` : undefined}
          />
          <Stat
            icon={<Timer className="h-4 w-4" />}
            label="Длительность"
            value={fmtDuration(durationSec)}
            sub={tailsSec > 30 ? `активная поездка ${fmtDuration(activeDuration)}` : undefined}
          />
          <Stat
            icon={<Gauge className="h-4 w-4" />}
            label="Скорость"
            value={avgSpeed ? `${fmtNum(avgSpeed * 3.6, 1)} км/ч` : "—"}
            sub={maxSpeed ? `макс ${fmtNum(maxSpeed * 3.6, 0)} км/ч${activeDuration > 0 ? " · по активной части" : ""}` : undefined}
          />
        </div>

        <div className="rounded-lg border bg-card/50 overflow-hidden">
          <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label="Трек поездки">
            <rect width={W} height={H} fill="transparent" />
            {pathD && (
              <>
                <path d={pathD} fill="none" stroke="currentColor" strokeOpacity="0.15" strokeWidth="10" strokeLinecap="round" strokeLinejoin="round" />
                <path d={pathD} fill="none" stroke="hsl(var(--primary))" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                {pts.length > 0 && <circle cx={project(pts[0])[0]} cy={project(pts[0])[1]} r="5" fill="hsl(var(--primary))" />}
                {pts.length > 1 && <circle cx={project(pts[pts.length - 1])[0]} cy={project(pts[pts.length - 1])[1]} r="5" fill="hsl(var(--primary))" stroke="white" strokeWidth="1.5" />}
              </>
            )}
          </svg>
        </div>
        <p className="text-[10px] text-muted-foreground">
          {data.pointCount} точек · «Телемат»
        </p>
      </div>
    </Shell>
  );
}

function Stat({ icon, label, value, sub }: { icon: React.ReactNode; label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border bg-card/50 p-3">
      <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
        {icon}
        <span>{label}</span>
      </div>
      <div className="text-sm font-semibold mt-1 tabular-nums">{value}</div>
      {sub && <div className="text-[10px] text-muted-foreground">{sub}</div>}
    </div>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen flex items-center justify-center p-4 bg-background">
      <div className="w-full max-w-2xl">{children}</div>
    </main>
  );
}
