"use client";

// src/components/mobile/shared/SpeedColoredTrack.tsx
// ТЗ §2.4: GPS-трек — цветная полилиния по скорости
// Розовый 0-20, Жёлтый 20-60, Оранжевый 60-100, Зелёный 100+

import * as React from "react";

// Lazy load Polyline to avoid SSR window issues
const Polyline = React.lazy(() => import("react-leaflet").then(m => ({ default: m.Polyline })));

interface SpeedPoint {
  lat: number;
  lon: number;
  speed?: number | null;
}

function speedToColor(speedKmh: number): string {
  if (speedKmh < 20) return "oklch(0.70 0.20 350)";
  if (speedKmh < 60) return "oklch(0.80 0.15 85)";
  if (speedKmh < 100) return "oklch(0.70 0.17 50)";
  return "oklch(0.65 0.18 145)";
}

export function SpeedColoredTrack({ points, weight = 5 }: { points: SpeedPoint[]; weight?: number }) {
  const segments = React.useMemo(() => {
    if (points.length < 2) return [];
    const segs: { positions: [number, number][]; color: string }[] = [];
    for (let i = 0; i < points.length - 1; i++) {
      const p1 = points[i];
      const p2 = points[i + 1];
      const speed = (p1.speed ?? 0) * 3.6;
      segs.push({
        positions: [[p1.lat, p1.lon], [p2.lat, p2.lon]],
        color: speedToColor(speed),
      });
    }
    return segs;
  }, [points]);

  return (
    <React.Suspense fallback={null}>
      {segments.map((seg, i) => (
        <Polyline
          key={i}
          positions={seg.positions}
          pathOptions={{ color: seg.color, weight, opacity: 0.9, lineJoin: "round", lineCap: "round" }}
        />
      ))}
    </React.Suspense>
  );
}

export { speedToColor };
