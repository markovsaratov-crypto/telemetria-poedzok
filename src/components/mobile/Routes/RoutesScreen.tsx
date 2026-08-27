"use client";

// src/components/mobile/Routes/RoutesScreen.tsx
// ТЗ §2.6: Экран 4 — Маршруты (избранные + сравнение)

import * as React from "react";
import { motion } from "framer-motion";
import { Route as RouteIcon, Plus, MapPin, Clock } from "lucide-react";
import { useRoutes } from "@/lib/hooks";
import { Skeleton } from "@/components/ui/skeleton";

interface RoutesScreenProps {
  onRouteTap?: (routeId: string) => void;
}

export function RoutesScreen({ onRouteTap }: RoutesScreenProps) {
  const { data, isLoading } = useRoutes();
  const routes = data?.routes || [];

  return (
    <div className="flex flex-col h-full pb-16">
      <header className="sticky top-0 z-20 bg-card/95 backdrop-blur-md border-b safe-top h-14 flex items-center justify-between px-4">
        <h1 className="text-[22px] font-bold">Маршруты</h1>
      </header>

      <div className="flex-1 overflow-y-auto scroll-telem p-4 space-y-3">
        {isLoading ? (
          Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-[110px] w-full rounded-xl shimmer" />
          ))
        ) : routes.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="w-16 h-16 rounded-full bg-muted/40 flex items-center justify-center mb-3">
              <RouteIcon className="h-8 w-8 text-muted-foreground/40" />
            </div>
            <p className="text-sm text-muted-foreground">Нет избранных маршрутов</p>
            <button className="mt-3 flex items-center gap-1 text-xs text-primary font-medium">
              <Plus className="h-3.5 w-3.5" /> Создать маршрут
            </button>
          </div>
        ) : (
          routes.map((route: any, idx: number) => (
            <motion.button
              key={route.id}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: idx * 0.05 }}
              onClick={() => onRouteTap?.(route.id)}
              className="w-full flex gap-3 p-3 bg-card border rounded-xl active:bg-accent/30 transition-colors text-left"
            >
              {/* Mini-map placeholder */}
              <div className="w-20 h-20 rounded-lg bg-muted/40 flex items-center justify-center shrink-0">
                <MapPin className="h-6 w-6 text-muted-foreground/40" />
              </div>
              {/* Info */}
              <div className="flex-1 min-w-0 space-y-1">
                <div className="text-sm font-medium truncate">{route.name}</div>
                {route.description && (
                  <div className="text-[11px] text-muted-foreground truncate">{route.description}</div>
                )}
                <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  <Clock className="h-3 w-3" />
                  {route._count?.sessions || 0} поездок
                </div>
              </div>
            </motion.button>
          ))
        )}
      </div>
    </div>
  );
}
