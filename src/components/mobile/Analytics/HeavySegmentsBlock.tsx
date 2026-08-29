"use client";

// src/components/mobile/Analytics/HeavySegmentsBlock.tsx — v2.9.7
// Мобильный блок «Тяжёлые участки»: горизонтальная лента мини-карт с
// severity-подсветкой худших P75-хотспотов (паритет с desktop-виджетом
// heavy-segments-card). Тап по карточке → экран «Маршруты» с раскрытием
// конкретной группы (deep-link).

import * as React from "react";
import { motion } from "framer-motion";
import { AlertTriangle, ChevronRight } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { MiniMap, severityColor, type HotspotOverlay } from "@/components/mini-map";
import { useHeavySegments } from "@/lib/hooks";

interface HeavySegmentsBlockProps {
  onGoToRoutes?: (routeHash?: string) => void;
}

export function HeavySegmentsBlock({ onGoToRoutes }: HeavySegmentsBlockProps) {
  const { data, isLoading } = useHeavySegments();

  if (isLoading) {
    return (
      <div>
        <h2 className="text-sm font-semibold mb-3 text-muted-foreground flex items-center gap-1.5">
          <AlertTriangle className="h-4 w-4" /> Тяжёлые участки
        </h2>
        <div className="flex gap-3 overflow-hidden">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="w-[140px] h-[120px] rounded-xl shrink-0 shimmer" />
          ))}
        </div>
      </div>
    );
  }

  if (!data || data.groups.length === 0 || data.totalHotspotSegments === 0) return null;

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-muted-foreground flex items-center gap-1.5">
          <AlertTriangle className="h-4 w-4" /> Тяжёлые участки
        </h2>
        <button
          onClick={() => onGoToRoutes?.(undefined)}
          className="text-[11px] font-medium text-primary active:opacity-70 flex items-center gap-0.5"
        >
          Все <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </div>
      <p className="text-[11px] text-muted-foreground mb-2.5">
        {data.groupCount} {plural(data.groupCount, "маршрут", "маршрута", "маршрутов")} ·{" "}
        {data.totalHotspotSegments}{" "}
        {plural(data.totalHotspotSegments, "сегмент", "сегмента", "сегментов")} с P75 &lt; 0.5
      </p>

      {/* Горизонтальная лента мини-карт — нативный мобильный паттерн */}
      <div className="flex gap-3 overflow-x-auto scroll-telem pb-1 -mx-4 px-4 snap-x">
        {data.groups.slice(0, 6).map((g, i) => {
          const hotspots: HotspotOverlay[] = g.worstHotspots.map((h) => ({
            a: h.a,
            b: h.b,
            p75: h.p75,
            segmentId: h.segmentId,
          }));
          const worst = g.worstHotspots[0];
          return (
            <motion.button
              key={g.routeHash}
              initial={{ opacity: 0, x: 10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: Math.min(i * 0.05, 0.25) }}
              onClick={() => onGoToRoutes?.(g.routeHash)}
              className="shrink-0 w-[148px] snap-start text-left space-y-1.5 active:scale-[0.98] transition-transform"
              aria-label={`Маршрут ${g.routeHash.slice(0, 8)}: ${g.hotspotCount} тяжёлых сегментов — перейти к маршруту`}
            >
              <div className="rounded-xl border bg-card p-1.5 space-y-1.5">
                <MiniMap
                  points={g.polylineSample}
                  hotspots={hotspots}
                  height={84}
                  ariaLabel={`Мини-карта маршрута ${g.routeHash.slice(0, 8)}`}
                />
                <div className="flex items-center justify-between gap-1 px-0.5">
                  <span className="text-[10px] font-mono text-muted-foreground truncate">
                    {g.routeHash.slice(0, 8)}
                  </span>
                  {worst && (
                    <span
                      className="shrink-0 text-[9px] font-semibold px-1.5 py-0.5 rounded-md text-white"
                      style={{ backgroundColor: severityColor(worst.p75) }}
                    >
                      P75 {worst.p75.toFixed(2)}
                    </span>
                  )}
                </div>
              </div>
            </motion.button>
          );
        })}
      </div>

      {/* Легенда severity */}
      <div className="flex items-center gap-3 mt-2.5 text-[10px] text-muted-foreground">
        <span className="flex items-center gap-1">
          <span className="inline-block h-1.5 w-3 rounded-sm" style={{ backgroundColor: severityColor(0.1) }} />
          тяжёлая &lt; 0.25
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-1.5 w-3 rounded-sm" style={{ backgroundColor: severityColor(0.3) }} />
          средняя &lt; 0.4
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-1.5 w-3 rounded-sm" style={{ backgroundColor: severityColor(0.5) }} />
          лёгкая ≥ 0.4
        </span>
      </div>
    </div>
  );
}

// Русская плюрализация
function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}
