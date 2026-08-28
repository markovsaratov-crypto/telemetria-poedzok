"use client";

// src/components/mobile/Map/MapScreen.tsx
// Mobile map screen: shows all sessions' tracks on a single Leaflet map.

import * as React from "react";
import dynamic from "next/dynamic";
import { Map as MapIcon, Loader2, Layers } from "lucide-react";
import { useSessions, useBatchStats } from "@/lib/hooks";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

// IMPORTANT: import leaflet/dist/leaflet.css at top
import "leaflet/dist/leaflet.css";

// MapTrack is loaded client-side only.
const MapTrack = dynamic(() => import("@/components/map-track"), {
  ssr: false,
  loading: () => (
    <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
      <Loader2 className="h-5 w-5 animate-spin mr-2" /> Загрузка карты…
    </div>
  ),
});

const COLORS = [
  "#10b981", // emerald
  "#0d9488", // teal
  "#f59e0b", // amber
  "#e11d48", // rose
  "#8b5cf6", // violet
  "#06b6d4", // cyan
  "#ec4899", // pink
  "#84cc16", // lime
];

interface MapScreenProps {
  onSessionTap?: (id: string) => void;
}

export function MapScreen({ onSessionTap }: MapScreenProps) {
  const [limit] = React.useState(50);
  const { data, isLoading } = useSessions({ limit });
  const sessions = data?.sessions || [];
  const sessionIds = React.useMemo(() => sessions.map((s) => s.id), [sessions]);
  const { data: batchStats } = useBatchStats(sessionIds);

  // Combine all start/dest markers
  const markers = React.useMemo(() => {
    const arr: Array<{ lat: number; lon: number; label: string; variant: "start" | "end" }> = [];
    batchStats?.sessions?.forEach((s, idx) => {
      const color = COLORS[idx % COLORS.length];
      void color;
      if (s.startLat != null && s.startLon != null) {
        arr.push({
          lat: s.startLat,
          lon: s.startLon,
          label: `Старт: ${s.deviceName || s.deviceId}`,
          variant: "start",
        });
      }
      if (s.destLat != null && s.destLon != null) {
        arr.push({
          lat: s.destLat,
          lon: s.destLon,
          label: `Финиш: ${s.deviceName || s.deviceId}`,
          variant: "end",
        });
      }
    });
    return arr;
  }, [batchStats]);

  return (
    <div className="flex flex-col h-full pb-16">
      <header className="sticky top-0 z-20 bg-card/95 backdrop-blur-md border-b safe-top h-14 flex items-center justify-between px-4">
        <h1 className="text-[22px] font-bold flex items-center gap-2">
          <MapIcon className="h-5 w-5 text-primary" /> Карта
        </h1>
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <Layers className="h-3.5 w-3.5" />
          {sessions.length} поездок
        </div>
      </header>

      <div className="flex-1 relative">
        {isLoading ? (
          <Skeleton className="h-full w-full" />
        ) : markers.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center text-center p-8">
            <MapIcon className="h-12 w-12 text-muted-foreground/30 mb-3" />
            <p className="text-sm text-muted-foreground">Нет GPS-данных</p>
            <p className="text-xs text-muted-foreground/70 mt-1">
              Создайте поездку, чтобы увидеть треки на карте
            </p>
          </div>
        ) : (
          <MapTrack
            markers={markers}
            height="100%"
            fitToPoints
            interactive
            showLayerSwitcher
          />
        )}
      </div>

      {/* Session quick-list below map */}
      {sessions.length > 0 && (
        <div className="max-h-32 overflow-y-auto scroll-telem border-t p-2 space-y-1">
          {sessions.slice(0, 8).map((s, idx) => (
            <button
              key={s.id}
              onClick={() => onSessionTap?.(s.id)}
              className={cn(
                "w-full flex items-center gap-2 p-2 rounded-lg text-left active:bg-accent/30 transition-colors"
              )}
            >
              <span
                className="w-2.5 h-2.5 rounded-full shrink-0"
                style={{ backgroundColor: COLORS[idx % COLORS.length] }}
              />
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium truncate">
                  {s.deviceName || s.deviceId}
                </div>
                <div className="text-[10px] text-muted-foreground">
                  {new Date(s.startTime).toLocaleDateString("ru-RU", {
                    day: "numeric",
                    month: "short",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </div>
              </div>
              <span className="text-[10px] text-muted-foreground shrink-0">
                {s.pointCount} тчк
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
