"use client";

// src/components/mini-map.tsx — общая SVG мини-карта полилинии маршрута (v2.9.2).
// Используется desktop-компонентом route-groups и мобильным экраном Routes.
// Эйвангулярная проекция с поправкой cos(lat) — точна на городских масштабах.
// Никаких внешних картографических библиотек — только SVG + геометрия.

import * as React from "react";
import { MapPin } from "lucide-react";
import { cn } from "@/lib/utils";

export interface MiniMapPoint {
  lat: number;
  lon: number;
}

export interface HotspotOverlay {
  a: MiniMapPoint | null;
  b: MiniMapPoint | null;
  p75: number;
  segmentId: string;
}

// Цвет severity-подсветки сегмента по P75 (методология §10.6)
export function severityColor(p75: number): string {
  if (p75 < 0.25) return "oklch(0.55 0.20 25)"; // тяжёлая пробка — красный
  if (p75 < 0.4) return "oklch(0.70 0.15 60)"; // средняя — оранжевый
  return "oklch(0.75 0.15 95)"; // лёгкая — жёлтый
}

export interface MiniMapProps {
  points: MiniMapPoint[] | null | undefined;
  hotspots?: HotspotOverlay[];
  height?: number;
  className?: string;
  showMarkers?: boolean;
  ariaLabel?: string;
}

export function MiniMap({
  points,
  hotspots,
  height = 96,
  className,
  showMarkers = true,
  ariaLabel = "Мини-карта маршрута",
}: MiniMapProps) {
  const gradId = React.useId().replace(/[^a-zA-Z0-9]/g, "");
  if (!points || points.length < 2) {
    return (
      <div
        className={cn(
          "flex items-center justify-center rounded-lg border border-dashed bg-muted/30 text-muted-foreground/60",
          className
        )}
        style={{ height }}
        aria-label={ariaLabel}
        role="img"
      >
        <MapPin className="h-4 w-4" />
      </div>
    );
  }

  const lats = points.map((p) => p.lat);
  const lons = points.map((p) => p.lon);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLon = Math.min(...lons);
  const maxLon = Math.max(...lons);
  const latSpan = maxLat - minLat || 1e-6;
  const lonSpan = maxLon - minLon || 1e-6;
  const kx = Math.cos(((minLat + maxLat) / 2) * (Math.PI / 180));
  const xSpan = Math.max(lonSpan * kx, 1e-6);
  const ySpan = Math.max(latSpan, 1e-6);

  const W = 200;
  const H = 100;
  const pad = 10;
  const scale = Math.min((W - pad * 2) / xSpan, (H - pad * 2) / ySpan);
  const offX = (W - pad * 2 - xSpan * scale) / 2;
  const offY = (H - pad * 2 - ySpan * scale) / 2;
  const project = (p: MiniMapPoint): [number, number] => [
    pad + offX + (p.lon - minLon) * kx * scale,
    H - pad - offY - (p.lat - minLat) * scale,
  ];

  const pts = points.map(project);
  const path = pts.map(([x, y], i) => `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const [sx, sy] = pts[0];
  const [ex, ey] = pts[pts.length - 1];

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className={cn("w-full rounded-lg border bg-card ring-1 ring-inset ring-border/50", className)}
      style={{ height }}
      preserveAspectRatio="xMidYMid meet"
      role="img"
      aria-label={ariaLabel}
    >
      <defs>
        <linearGradient id={`mmg-${gradId}`} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="oklch(0.62 0.19 350)" />
          <stop offset="100%" stopColor="oklch(0.72 0.14 320)" />
        </linearGradient>
        <pattern id={`mmdot-${gradId}`} width="14" height="14" patternUnits="userSpaceOnUse">
          <circle cx="1.2" cy="1.2" r="0.9" className="fill-foreground" opacity="0.07" />
        </pattern>
      </defs>
      <rect x="0" y="0" width={W} height={H} fill={`url(#mmdot-${gradId})`} />
      <path
        d={path}
        fill="none"
        stroke={`url(#mmg-${gradId})`}
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.9"
      />
      {hotspots?.map((h) => {
        if (!h.a || !h.b) return null;
        const [ax, ay] = project(h.a);
        const [bx, by] = project(h.b);
        return (
          <line
            key={h.segmentId}
            x1={ax}
            y1={ay}
            x2={bx}
            y2={by}
            stroke={severityColor(h.p75)}
            strokeWidth="4.5"
            strokeLinecap="round"
            opacity="0.85"
          />
        );
      })}
      {showMarkers && (
        <>
          <circle cx={sx} cy={sy} r="4" fill="oklch(0.60 0.15 145)" stroke="white" strokeWidth="1.5" />
          <circle cx={ex} cy={ey} r="4" fill="oklch(0.55 0.20 25)" stroke="white" strokeWidth="1.5" />
        </>
      )}
    </svg>
  );
}
