"use client";

// src/components/route-planner.tsx — планировщик маршрута: 2 точки на карте + кнопка "Построить".

import * as React from "react";
import dynamic from "next/dynamic";
import { motion } from "framer-motion";
import {
  MapPin,
  Flag,
  Navigation,
  Loader2,
  RotateCcw,
  Route as RouteIcon,
  Save,
  Clock,
  Ruler,
} from "lucide-react";
import { toast } from "sonner";
import { usePlan, useCreateRoute } from "@/lib/hooks";
import type { PlanResponse } from "@/lib/api-client";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

const MapTrack = dynamic(() => import("@/components/map-track"), {
  ssr: false,
  loading: () => (
    <div className="h-[360px] w-full rounded-lg bg-muted animate-pulse flex items-center justify-center text-xs text-muted-foreground">
      Загрузка карты…
    </div>
  ),
});

interface LatLng {
  lat: number;
  lon: number;
}

export function RoutePlanner() {
  const [start, setStart] = React.useState<LatLng | null>(null);
  const [end, setEnd] = React.useState<LatLng | null>(null);
  const [mode, setMode] = React.useState<"start" | "end">("start");
  const [result, setResult] = React.useState<PlanResponse | null>(null);

  const planMutation = usePlan();
  const saveRouteMutation = useCreateRoute();

  function handleMapClick(lat: number, lon: number) {
    if (mode === "start") {
      setStart({ lat, lon });
      setMode("end");
      toast.success("Старт установлен", {
        description: `${lat.toFixed(5)}, ${lon.toFixed(5)}`,
      });
    } else {
      setEnd({ lat, lon });
      setMode("start");
      toast.success("Финиш установлен", {
        description: `${lat.toFixed(5)}, ${lon.toFixed(5)}`,
      });
    }
  }

  async function handlePlan() {
    if (!start || !end) {
      toast.error("Укажите обе точки маршрута");
      return;
    }
    try {
      const res = await planMutation.mutateAsync({
        startLat: start.lat,
        startLon: start.lon,
        endLat: end.lat,
        endLon: end.lon,
      });
      setResult(res);
      if (res.cached) {
        toast.success("Маршрут из кэша", {
          description: `Провайдер: ${res.route?.provider || "—"}`,
        });
      } else {
        toast.success("Маршрут построен", {
          description: res.trafficJobId
            ? "Создана задача получения пробок"
            : `Провайдер: ${res.route?.provider || "—"}`,
        });
      }
    } catch (e) {
      toast.error("Ошибка построения", { description: (e as Error).message });
    }
  }

  function reset() {
    setStart(null);
    setEnd(null);
    setResult(null);
    setMode("start");
  }

  async function handleSaveRoute() {
    if (!start || !end) return;
    const name = `Маршрут ${new Date().toLocaleString("ru-RU")}`;
    try {
      await saveRouteMutation.mutateAsync({
        name,
        description: `Из планировщика. ${start.lat.toFixed(4)},${start.lon.toFixed(4)} → ${end.lat.toFixed(4)},${end.lon.toFixed(4)}`,
        startLat: start.lat,
        startLon: start.lon,
        endLat: end.lat,
        endLon: end.lon,
      });
      toast.success("Маршрут сохранён в избранное", { description: name });
    } catch (e) {
      toast.error("Не удалось сохранить", { description: (e as Error).message });
    }
  }

  const markers = React.useMemo(() => {
    const arr: { lat: number; lon: number; label: string; variant: "start" | "end" }[] = [];
    if (start) arr.push({ lat: start.lat, lon: start.lon, label: "Старт", variant: "start" as const });
    if (end) arr.push({ lat: end.lat, lon: end.lon, label: "Финиш", variant: "end" as const });
    return arr;
  }, [start, end]);

  const routePolyline = React.useMemo(() => {
    const r = result?.route;
    if (!r) return [];
    // API возвращает polyline как [[lat, lon], ...]; поддерживаем и geometry-алиас
    const line = r.polyline || r.geometry || [];
    if (line.length >= 2) {
      return line.map(([lat, lon]) => ({ lat, lon }));
    }
    // Fallback: используем segments
    if (r.segments && r.segments.length >= 2) {
      return r.segments.map((s) => ({ lat: s.lat, lon: s.lon }));
    }
    if (start && end) {
      return [start, end];
    }
    return [];
  }, [result, start, end]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <Navigation className="h-4 w-4 text-primary" />
          Планировщик маршрута
        </CardTitle>
        <CardDescription>
          Кликните по карте, чтобы установить точки. Snap-to-grid кэш + 2ГИС → OSRM → haversine chain.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Preset маршруты */}
        <div className="flex flex-wrap gap-1.5">
          <span className="text-[10px] text-muted-foreground self-center mr-1">Пресеты:</span>
          {PRESETS.map((p) => (
            <button
              key={p.name}
              onClick={() => {
                setStart(p.start);
                setEnd(p.end);
                setResult(null);
                setMode("start");
                toast.info(`Загружен: ${p.name}`);
              }}
              className="px-2 py-1 rounded-md border bg-background/50 hover:bg-accent hover:border-primary/50 text-[10px] transition-all flex items-center gap-1"
              title={p.description}
            >
              <span className="text-emerald-500">●</span>
              <span className="text-amber-500">●</span>
              {p.name}
            </button>
          ))}
        </div>

        <MapTrack
          points={routePolyline}
          markers={markers}
          height="360px"
          interactive
          fitToPoints
          onMapClick={handleMapClick}
        />

        {/* Точки ввода */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label className="text-xs flex items-center gap-1.5">
              <MapPin className="h-3 w-3 text-emerald-500" /> Старт
            </Label>
            <div className="grid grid-cols-2 gap-1.5">
              <Input
                placeholder="lat"
                value={start?.lat.toFixed(6) ?? ""}
                readOnly
                className="h-8 text-xs font-mono"
              />
              <Input
                placeholder="lon"
                value={start?.lon.toFixed(6) ?? ""}
                readOnly
                className="h-8 text-xs font-mono"
              />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs flex items-center gap-1.5">
              <Flag className="h-3 w-3 text-amber-500" /> Финиш
            </Label>
            <div className="grid grid-cols-2 gap-1.5">
              <Input
                placeholder="lat"
                value={end?.lat.toFixed(6) ?? ""}
                readOnly
                className="h-8 text-xs font-mono"
              />
              <Input
                placeholder="lon"
                value={end?.lon.toFixed(6) ?? ""}
                readOnly
                className="h-8 text-xs font-mono"
              />
            </div>
          </div>
        </div>

        {/* Подсказка режима */}
        <div className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">Режим клика:</span>
          <button
            onClick={() => setMode("start")}
            className={cn(
              "px-2 py-0.5 rounded-full border transition-colors",
              mode === "start"
                ? "bg-emerald-500/15 text-emerald-700 border-emerald-500/40 dark:text-emerald-400"
                : "border-border text-muted-foreground hover:text-foreground"
            )}
          >
            старт
          </button>
          <button
            onClick={() => setMode("end")}
            className={cn(
              "px-2 py-0.5 rounded-full border transition-colors",
              mode === "end"
                ? "bg-amber-500/15 text-amber-700 border-amber-500/40 dark:text-amber-400"
                : "border-border text-muted-foreground hover:text-foreground"
            )}
          >
            финиш
          </button>
        </div>

        {/* Кнопки */}
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={handlePlan}
            disabled={!start || !end || planMutation.isPending}
          >
            {planMutation.isPending ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" /> Построение…
              </>
            ) : (
              <>
                <RouteIcon className="h-4 w-4" /> Построить маршрут
              </>
            )}
          </Button>
          <Button
            variant="outline"
            onClick={handleSaveRoute}
            disabled={!start || !end || saveRouteMutation.isPending}
          >
            <Save className="h-4 w-4" /> Сохранить в избранное
          </Button>
          <Button variant="ghost" onClick={reset} disabled={!start && !end}>
            <RotateCcw className="h-4 w-4" /> Сброс
          </Button>
        </div>

        {/* Результат */}
        {result && result.route && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            className="grid grid-cols-2 sm:grid-cols-4 gap-2 rounded-lg border p-3 bg-muted/30"
          >
            {(() => {
              const r = result.route!;
              const distance = r.distanceM ?? r.distance;
              const duration = r.durationSec ?? r.duration;
              return (
                <>
                  <div className="space-y-0.5">
                    <div className="text-[10px] uppercase text-muted-foreground flex items-center gap-1">
                      <Ruler className="h-3 w-3" /> Дистанция
                    </div>
                    <div className="text-sm font-semibold">
                      {distance
                        ? `${(distance / 1000).toFixed(2)} км`
                        : "—"}
                    </div>
                  </div>
                  <div className="space-y-0.5">
                    <div className="text-[10px] uppercase text-muted-foreground flex items-center gap-1">
                      <Clock className="h-3 w-3" /> Время
                    </div>
                    <div className="text-sm font-semibold">
                      {duration
                        ? `${Math.round(duration / 60)} мин`
                        : "—"}
                    </div>
                  </div>
                  <div className="space-y-0.5">
                    <div className="text-[10px] uppercase text-muted-foreground">
                      Провайдер
                    </div>
                    <Badge variant="outline" className="text-[10px]">
                      {r.provider || "—"}
                    </Badge>
                  </div>
                  <div className="space-y-0.5">
                    <div className="text-[10px] uppercase text-muted-foreground">
                      Кэш
                    </div>
                    <Badge
                      variant="outline"
                      className={cn(
                        "text-[10px]",
                        result.cached
                          ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                          : "bg-muted"
                      )}
                    >
                      {result.cached ? "HIT" : "MISS"}
                    </Badge>
                  </div>
                  {result.trafficJobId && (
                    <div className="col-span-full text-[11px] text-muted-foreground">
                      Задача пробок:{" "}
                      <code className="font-mono text-foreground">{result.trafficJobId}</code>
                    </div>
                  )}
                </>
              );
            })()}
          </motion.div>
        )}
      </CardContent>
    </Card>
  );
}

// Популярные пресеты маршрутов (координаты реальных городов РФ)
const PRESETS: { name: string; description: string; start: LatLng; end: LatLng }[] = [
  {
    name: "Москва → СПб",
    description: "МКАД → КАД (~700км)",
    start: { lat: 55.7558, lon: 37.6173 },
    end: { lat: 59.9343, lon: 30.3351 },
  },
  {
    name: "Москва центр",
    description: "Красная площадь → Воробьёвы горы",
    start: { lat: 55.7539, lon: 37.6208 },
    end: { lat: 55.7101, lon: 37.5411 },
  },
  {
    name: "СПб центр",
    description: "Дворцовая → Летний сад",
    start: { lat: 59.9398, lon: 30.3146 },
    end: { lat: 59.9500, lon: 30.3358 },
  },
  {
    name: "Казань → аэропорт",
    description: "Центр → Казань Intl",
    start: { lat: 55.7963, lon: 49.1088 },
    end: { lat: 55.6062, lon: 49.2787 },
  },
  {
    name: "Сочи → Адлер",
    description: "Центр → аэропорт",
    start: { lat: 43.5855, lon: 39.7231 },
    end: { lat: 43.5051, lon: 39.9088 },
  },
  {
    name: "Екатеринбург",
    description: "Центр → Ельцин-центр",
    start: { lat: 56.8389, lon: 60.6057 },
    end: { lat: 56.8410, lon: 60.6140 },
  },
];
