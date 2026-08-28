"use client";

// src/app/shared/[token]/page.tsx — публичная страница шаринга поездки (P1-9).
// Раньше маршрута не существовало вовсе (404) — сценарий «поделиться поездкой» был мёртв.
// Без внешних зависимостей (карт нет) — SVG-превью трека: устойчиво и быстро.

import * as React from "react";
import { use } from "react";
import { Activity, Calendar, Timer, Route as RouteIcon, Gauge } from "lucide-react";

interface SharedPoint {
  lat: number;
  lon: number;
  speed: number | null;
  altitude: number | null;
  timestamp: number;
}

interface SharedPayload {
  sessionId: string;
  deviceId: string;
  deviceName?: string | null;
  startTime: number | string;
  endTime: number | string;
  pointCount: number;
  points: SharedPoint[];
  expiresAt: string;
}

// P2-14: канонический гаверсинус — src/lib/geo.ts (была локальная копия)
import { haversineM } from "@/lib/geo";

function fmtDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return "—";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.round(sec % 60);
  return h > 0 ? `${h} ч ${m} мин` : m > 0 ? `${m} мин ${s} с` : `${s} с`;
}

export default function SharedPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const [state, setState] = React.useState<
    | { kind: "loading" }
    | { kind: "error"; message: string }
    | { kind: "ok"; data: SharedPayload }
  >({ kind: "loading" });

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/share?token=${encodeURIComponent(token)}`);
        if (res.status === 403) {
          if (!cancelled) setState({ kind: "error", message: "Ссылка недействительна или её срок истёк." });
          return;
        }
        if (res.status === 404) {
          if (!cancelled) setState({ kind: "error", message: "Поездка не найдена или удалена." });
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as SharedPayload;
        if (!cancelled) setState({ kind: "ok", data });
      } catch {
        if (!cancelled) setState({ kind: "error", message: "Не удалось загрузить поездку. Попробуйте позже." });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (state.kind === "loading") {
    return (
      <Shell>
        <p className="text-sm text-muted-foreground">Загрузка…</p>
      </Shell>
    );
  }
  if (state.kind === "error") {
    return (
      <Shell>
        <h1 className="text-lg font-semibold">Поездка недоступна</h1>
        <p className="text-sm text-muted-foreground">{state.message}</p>
      </Shell>
    );
  }

  const { data } = state;
  const pts = data.points;
  let distance = 0;
  let maxSpeed = 0;
  for (let i = 1; i < pts.length; i++) {
    distance += haversineM(pts[i - 1].lat, pts[i - 1].lon, pts[i].lat, pts[i].lon);
    if (pts[i].speed != null) maxSpeed = Math.max(maxSpeed, pts[i].speed!);
  }
  const durationSec = Math.max(0, (Number(data.endTime) - Number(data.startTime)) / 1000);
  const avgSpeed = durationSec > 0 && distance > 0 ? distance / durationSec : null;

  // SVG-превью трека
  const lats = pts.map((p) => p.lat);
  const lons = pts.map((p) => p.lon);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLon = Math.min(...lons), maxLon = Math.max(...lons);
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
            {new Date(Number(data.startTime)).toLocaleString("ru-RU")}
            <span className="mx-1">·</span>
            действует до {new Date(data.expiresAt).toLocaleString("ru-RU")}
          </p>
        </div>

        <div className="grid grid-cols-3 gap-3">
          <Stat icon={<RouteIcon className="h-4 w-4" />} label="Дистанция" value={distance > 0 ? `${(distance / 1000).toFixed(2)} км` : "—"} />
          <Stat icon={<Timer className="h-4 w-4" />} label="Длительность" value={fmtDuration(durationSec)} />
          <Stat icon={<Gauge className="h-4 w-4" />} label="Скорость" value={avgSpeed ? `${(avgSpeed * 3.6).toFixed(1)} км/ч` : "—"} sub={maxSpeed ? `макс ${(maxSpeed * 3.6).toFixed(0)} км/ч` : undefined} />
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
          {data.pointCount} точек · телеметрия «Телеметрия поездок v2.6»
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
