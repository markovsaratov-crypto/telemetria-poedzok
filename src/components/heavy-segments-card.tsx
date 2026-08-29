"use client";

// src/components/heavy-segments-card.tsx — v2.9.6
// Дашборд-виджет «Тяжёлые участки»: агрегация худших P75-хотспотов (§10.6)
// по всем routeHash-группам. Мини-карта каждой группы с severity-подсветкой
// топ-3 самых тяжёлых сегментов + сводка и переход на вкладку «Маршруты».

import * as React from "react";
import { motion } from "framer-motion";
import { AlertTriangle, ArrowRight } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { MiniMap, severityColor, type HotspotOverlay } from "@/components/mini-map";
import { useHeavySegments } from "@/lib/hooks";

interface HeavySegmentsCardProps {
  onGoToRoutes: () => void;
}

export function HeavySegmentsCard({ onGoToRoutes }: HeavySegmentsCardProps) {
  const { data, isLoading } = useHeavySegments();

  // Не показываем виджет без данных (нет групп / нет хотспотов)
  if (!isLoading && (!data || data.groups.length === 0 || data.totalHotspotSegments === 0)) {
    return null;
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 text-primary" /> Тяжёлые участки
        </CardTitle>
        <CardDescription>
          {data
            ? `${data.groupCount} ${plural(data.groupCount, "маршрут", "маршрута", "маршрутов")} · ${data.totalHotspotSegments} ${plural(data.totalHotspotSegments, "сегмент", "сегмента", "сегментов")} с P75 &lt; 0.5`
            : "P75-хотспоты по всем маршрутам"}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading || !data ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-[120px] rounded-lg shimmer" />
            ))}
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
              {data.groups.slice(0, 4).map((g, i) => {
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
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: Math.min(i * 0.05, 0.2) }}
                    onClick={onGoToRoutes}
                    className="group text-left space-y-1.5"
                    aria-label={`Маршрут ${g.routeHash.slice(0, 8)}: ${g.hotspotCount} тяжёлых сегментов`}
                  >
                    <MiniMap
                      points={g.polylineSample}
                      hotspots={hotspots}
                      height={96}
                      ariaLabel={`Мини-карта маршрута ${g.routeHash.slice(0, 8)}`}
                    />
                    <div className="flex items-center justify-between gap-1.5 px-0.5">
                      <span className="text-[11px] text-muted-foreground truncate">
                        {g.routeHash.slice(0, 8)} · {g.sessionCount}{" "}
                        {plural(g.sessionCount, "поездка", "поездки", "поездок")}
                      </span>
                      {worst && (
                        <span
                          className="shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded-md text-white"
                          style={{ backgroundColor: severityColor(worst.p75) }}
                        >
                          P75 {worst.p75.toFixed(2)}
                        </span>
                      )}
                    </div>
                  </motion.button>
                );
              })}
            </div>

            {/* Легенда severity + сводка */}
            <div className="flex flex-wrap items-center justify-between gap-2 mt-4">
              <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
                <span className="flex items-center gap-1.5">
                  <span className="inline-block h-2 w-4 rounded-sm" style={{ backgroundColor: severityColor(0.1) }} />
                  тяжёлая &lt; 0.25
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="inline-block h-2 w-4 rounded-sm" style={{ backgroundColor: severityColor(0.3) }} />
                  средняя &lt; 0.4
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="inline-block h-2 w-4 rounded-sm" style={{ backgroundColor: severityColor(0.5) }} />
                  лёгкая ≥ 0.4
                </span>
              </div>
              <button
                onClick={onGoToRoutes}
                className="flex items-center gap-1 text-xs font-medium text-primary hover:underline"
              >
                Все маршруты <ArrowRight className="h-3.5 w-3.5" />
              </button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
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
