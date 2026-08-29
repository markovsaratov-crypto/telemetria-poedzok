"use client";

// src/components/map-track.tsx — Leaflet карта (только client-side).
// С layer switcher (light/dark/satellite), scale control, tooltips.

import * as React from "react";
import L from "leaflet";
import {
  MapContainer,
  TileLayer,
  Polyline,
  Marker,
  Popup,
  Tooltip,
  useMap,
  ScaleControl,
  ZoomControl,
} from "react-leaflet";
import "leaflet/dist/leaflet.css";
import { useTheme } from "next-themes";
import { cn } from "@/lib/utils";

export interface MapPoint {
  lat: number;
  lon: number;
  label?: string;
  color?: string;
}

export interface MapMarker {
  lat: number;
  lon: number;
  label?: string;
  variant?: "start" | "end" | "pin";
  // v2.9.7: цвет маркера (сравнение поездок — цвет трека сессии)
  color?: string;
  // v2.9.7: не показывать постоянную подпись на иконке (только Tooltip при hover)
  hideIconLabel?: boolean;
}

type LayerKind = "voyager" | "dark" | "satellite" | "street";

// v2.9.7: цветной трек для сравнения поездок — каждая поездка своей полилинией
export interface ColoredTrack {
  points: Array<{ lat: number; lon: number }>;
  color: string;
  label?: string;
}

// v2.9.8: тепловая карта скорости — трек, раскрашенный по скорости движения.
// Классическая телеметрическая шкала; границы бакетов в км/ч.
export interface SpeedBucket {
  maxKmh: number;
  color: string;
  label: string;
}

export const SPEED_BUCKETS: SpeedBucket[] = [
  { maxKmh: 30, color: "#10b981", label: "0–30" },   // emerald — город/стоянка
  { maxKmh: 60, color: "#65a30d", label: "30–60" },   // lime-600 — темнее 500-го: VLM отмечал сливание со светлыми тайлами
  { maxKmh: 90, color: "#eab308", label: "60–90" },   // yellow
  { maxKmh: 120, color: "#f97316", label: "90–120" }, // orange
  { maxKmh: Infinity, color: "#e11d48", label: "120+" }, // rose — быстро
];

// v2.9.9: экспортирован для спидограммы — единая шкала бакетов карты и графика
export function speedBucketFor(kmh: number): number {
  for (let i = 0; i < SPEED_BUCKETS.length; i++) {
    if (kmh <= SPEED_BUCKETS[i].maxKmh) return i;
  }
  return SPEED_BUCKETS.length - 1;
}

// Строит по точкам со скоростью набор «пробегов» на каждый бакет:
// массивы полилиний (каждая — непрерывный участок одного цвета).
// Один компонент Polyline на бакет (multi-polyline) — 5 SVG-путей вместо тысяч сегментов.
function buildSpeedRuns(
  track: Array<{ lat: number; lon: number; speed?: number | null }>
): Array<Array<Array<[number, number]>>> {
  const runs: Array<Array<Array<[number, number]>>> = SPEED_BUCKETS.map(() => []);
  let currentBucket = -1;
  let currentRun: Array<[number, number]> | null = null;
  for (let i = 1; i < track.length; i++) {
    const a = track[i - 1];
    const b = track[i];
    if (
      typeof a.lat !== "number" || typeof a.lon !== "number" ||
      typeof b.lat !== "number" || typeof b.lon !== "number"
    ) {
      currentBucket = -1;
      currentRun = null;
      continue;
    }
    // средняя скорость сегмента (м/с → км/ч); без данных — 0 (стоянка)
    const vA = a.speed != null && a.speed >= 0 ? a.speed : 0;
    const vB = b.speed != null && b.speed >= 0 ? b.speed : 0;
    const bucket = speedBucketFor(((vA + vB) / 2) * 3.6);
    if (bucket !== currentBucket || currentRun === null) {
      currentRun = [
        [a.lat, a.lon] as [number, number],
        [b.lat, b.lon] as [number, number],
      ];
      runs[bucket].push(currentRun);
      currentBucket = bucket;
    } else {
      currentRun.push([b.lat, b.lon] as [number, number]);
    }
  }
  return runs;
}

interface MapTrackProps {
  points?: Array<{ lat: number; lon: number }>;
  markers?: MapMarker[];
  // v2.9.7: несколько цветных треков на одной карте (сравнение поездок).
  // Если задан — обычный points-трек не рисуется.
  tracks?: ColoredTrack[];
  // v2.9.8: тепловая карта скорости — трек по бакетам скорости (км/ч).
  // Если задан — рисуется вместо обычного points-трека (+ легенда шкалы).
  speedTrack?: Array<{ lat: number; lon: number; speed?: number | null }> | null;
  height?: string;
  className?: string;
  interactive?: boolean;
  fitToPoints?: boolean;
  onMapClick?: (lat: number, lon: number) => void;
  center?: [number, number];
  zoom?: number;
  showLayerSwitcher?: boolean;
  // v2.9.4: связка карта↔график — акцентный маркер точки с профиля (hover/pin)
  focusPoint?: { lat: number; lon: number } | null;
  // v2.9.4: панорамировать карту к focusPoint при его смене (режим закрепления)
  panToFocus?: boolean;
}

const LAYERS: Record<LayerKind, { url: string; attr: string; label: string; maxZoom?: number }> = {
  voyager: {
    url: "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
    attr: '&copy; OpenStreetMap &copy; CARTO',
    label: "Voyager",
    maxZoom: 20,
  },
  dark: {
    url: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
    attr: '&copy; OpenStreetMap &copy; CARTO',
    label: "Dark",
    maxZoom: 20,
  },
  satellite: {
    url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    attr: "Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics",
    label: "Satellite",
    maxZoom: 19,
  },
  street: {
    url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    attr: '&copy; OpenStreetMap contributors',
    label: "Street",
    maxZoom: 19,
  },
};

// Кастомные иконки (без внешних PNG — используем divIcon с CSS).
function makeIcon(
  variant: "start" | "end" | "pin",
  label?: string,
  colorOverride?: string,
  hideIconLabel?: boolean
): L.DivIcon {
  const colorMap: Record<string, string> = {
    start: "#10b981", // emerald-500
    end: "#f59e0b", // amber-500
    pin: "#0d9488", // teal-600
  };
  const color = colorOverride || colorMap[variant];
  // v2.9.7 (стайлинг-раунд 8): подпись только если явно не скрыта —
  // постоянные подписи перекрывали друг друга при нескольких треках
  const showLabel = label && !hideIconLabel;
  const html = `
    <div style="position:relative;display:flex;flex-direction:column;align-items:center;">
      <div style="
        background:${color};
        width:18px;height:18px;border-radius:50%;
        border:3px solid #fff;
        box-shadow:0 0 0 2px ${color},0 2px 6px rgba(0,0,0,0.35);
      "></div>
      ${
        showLabel
          ? `<div style="
        margin-top:4px;
        background:rgba(255,255,255,0.95);
        color:#0f172a;
        font-size:11px;font-weight:600;
        padding:2px 6px;border-radius:4px;
        white-space:nowrap;
        box-shadow:0 1px 3px rgba(0,0,0,0.2);
      ">${label}</div>`
          : ""
      }
    </div>`;
  return L.divIcon({
    html,
    className: "telem-marker",
    iconSize: [24, 24],
    iconAnchor: [12, 12],
  });
}

// v2.9.4: акцентный маркер точки с профиля (связка карта↔график).
// divIcon с CSS-пульсацией — заметен на любом слое, отличается от старт/финиш.
function makeFocusIcon(): L.DivIcon {
  const html = `
    <div class="telem-focus-marker" style="position:relative;width:20px;height:20px;">
      <div style="
        position:absolute;inset:2px;border-radius:50%;
        background:#e5484d;
        border:2.5px solid #fff;
        box-shadow:0 0 0 2px rgba(229,72,77,0.35),0 2px 6px rgba(0,0,0,0.4);
      "></div>
      <div style="
        position:absolute;inset:0;border-radius:50%;
        border:2px solid rgba(229,72,77,0.65);
        animation:telemFocusPulse 1.6s ease-out infinite;
      "></div>
    </div>`;
  return L.divIcon({ html, className: "telem-marker", iconSize: [20, 20], iconAnchor: [10, 10] });
}

// v2.9.4: панорамирование к точке фокуса (только при явном изменении — не на каждый hover)
function PanToFocus({ focus }: { focus: { lat: number; lon: number } | null }) {
  const map = useMap();
  React.useEffect(() => {
    if (!focus) return;
    const targetZoom = Math.max(map.getZoom(), 14);
    map.setView([focus.lat, focus.lon], targetZoom, { animate: true, duration: 0.6 });
  }, [focus, map]);
  return null;
}

// Компонент для авто-подгонки bounds к точкам/маркерам.
function FitBounds({
  positions,
}: {
  positions: Array<[number, number]>;
}) {
  const map = useMap();
  React.useEffect(() => {
    if (positions.length === 0) return;
    if (positions.length === 1) {
      map.setView(positions[0], 14, { animate: true });
      return;
    }
    const bounds = L.latLngBounds(positions);
    map.fitBounds(bounds, { padding: [40, 40], maxZoom: 16 });
  }, [positions, map]);
  return null;
}

// Компонент для перехвата кликов по карте.
function ClickHandler({
  onClick,
}: {
  onClick?: (lat: number, lon: number) => void;
}) {
  void onClick;
  return null;
}

function MapEvents({
  onClick,
}: {
  onClick?: (lat: number, lon: number) => void;
}) {
  const map = useMap();
  React.useEffect(() => {
    if (!onClick) return;
    const handler = (e: L.LeafletMouseEvent) => onClick(e.latlng.lat, e.latlng.lng);
    map.on("click", handler);
    return () => {
      map.off("click", handler);
    };
  }, [map, onClick]);
  return null;
}

export default function MapTrack({
  points = [],
  markers = [],
  tracks,
  height = "320px",
  className,
  interactive = true,
  fitToPoints = true,
  onMapClick,
  center = [55.751244, 37.618423], // Москва по умолчанию
  zoom = 12,
  showLayerSwitcher = true,
  focusPoint = null,
  panToFocus = false,
  speedTrack = null,
}: MapTrackProps) {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  const [layer, setLayer] = React.useState<LayerKind>(isDark ? "dark" : "voyager");

  React.useEffect(() => {
    if (showLayerSwitcher) setLayer(isDark ? "dark" : "voyager");
  }, [isDark, showLayerSwitcher]);

  const tileUrl = LAYERS[layer].url;
  const tileAttr = LAYERS[layer].attr;
  const tileMaxZoom = LAYERS[layer].maxZoom || 19;

  const polylinePositions: Array<[number, number]> = React.useMemo(
    () => points.filter((p) => typeof p.lat === "number" && typeof p.lon === "number")
      .map((p) => [p.lat, p.lon] as [number, number]),
    [points]
  );

  // v2.9.7: цветные треки для сравнения (каждая поездка — свой цвет)
  const coloredTracks = React.useMemo(
    () =>
      (tracks || [])
        .map((t) => ({
          ...t,
          positions: t.points
            .filter((p) => typeof p.lat === "number" && typeof p.lon === "number")
            .map((p) => [p.lat, p.lon] as [number, number]),
        }))
        .filter((t) => t.positions.length >= 2),
    [tracks]
  );

  // v2.9.8: пробеги по бакетам скорости для тепловой карты
  const speedRuns = React.useMemo(
    () => (speedTrack && speedTrack.length >= 2 ? buildSpeedRuns(speedTrack) : null),
    [speedTrack]
  );
  const speedRunsTotal = React.useMemo(
    () => (speedRuns ? speedRuns.reduce((a, r) => a + r.length, 0) : 0),
    [speedRuns]
  );

  const fitPositions = React.useMemo(() => {
    const arr: Array<[number, number]> = [...polylinePositions];
    for (const t of coloredTracks) {
      arr.push(...t.positions);
    }
    for (const m of markers) {
      arr.push([m.lat, m.lon]);
    }
    return arr;
  }, [polylinePositions, coloredTracks, markers]);

  const hasContent = polylinePositions.length > 0 || markers.length > 0 || coloredTracks.length > 0;
  const effectiveCenter: [number, number] =
    hasContent && fitPositions.length > 0
      ? fitPositions[fitPositions.length - 1]
      : center;

  return (
    <div
      className={cn(
        "rounded-lg overflow-hidden border border-border bg-muted relative",
        className
      )}
      style={{ height, width: "100%" }}
    >
      <MapContainer
        center={effectiveCenter}
        zoom={zoom}
        scrollWheelZoom={interactive}
        dragging={interactive}
        doubleClickZoom={interactive}
        attributionControl
        zoomControl={false}
        style={{ height: "100%", width: "100%" }}
      >
        <TileLayer url={tileUrl} attribution={tileAttr} maxZoom={tileMaxZoom} />
        <ZoomControl position="topright" />
        <ScaleControl position="bottomleft" imperial={false} metric={true} />
        {coloredTracks.length > 0
          ? // v2.9.7: сравнение поездок — каждая своей полилинией + glow;
            // стайлинг-раунд 8: чередование solid/dashed для различимости
            // при цветовой слепоте (Deuteranopia) + белая окантовка
            coloredTracks.map((t, i) => (
              <React.Fragment key={`track-${i}`}>
                {/* Касинг — белая окантовка под цветной линией для контраста с картой */}
                <Polyline
                  positions={t.positions}
                  pathOptions={{
                    color: "#ffffff",
                    weight: 7,
                    opacity: 0.55,
                    lineJoin: "round",
                    lineCap: "round",
                  }}
                />
                <Polyline
                  positions={t.positions}
                  pathOptions={{
                    color: t.color,
                    weight: 4,
                    opacity: 0.95,
                    lineJoin: "round",
                    lineCap: "round",
                    ...(i % 2 === 1 ? { dashArray: "10 7" } : {}),
                  }}
                />
                <Polyline
                  positions={t.positions}
                  pathOptions={{
                    color: t.color,
                    weight: 10,
                    opacity: 0.14,
                    lineJoin: "round",
                    lineCap: "round",
                  }}
                />
              </React.Fragment>
            ))
          : speedRuns && speedRunsTotal > 0
          ? // v2.9.8: тепловая карта скорости — белый касинг по всему треку,
            // затем одна multi-polyline на каждый бакет (5 цветов);
            // стайлинг-раунд 9: касинг плотнее (0.65) — цветные сегменты
            // не сливаются со светлыми тайлами, линия толще (5) для читаемости
            <>
              <Polyline
                positions={polylinePositions}
                pathOptions={{
                  color: "#ffffff",
                  weight: 8,
                  opacity: 0.65,
                  lineJoin: "round",
                  lineCap: "round",
                }}
              />
              {SPEED_BUCKETS.map((b, i) =>
                speedRuns[i].length > 0 ? (
                  <Polyline
                    key={`speed-${i}`}
                    positions={speedRuns[i]}
                    pathOptions={{
                      color: b.color,
                      weight: 5,
                      opacity: 0.95,
                      lineJoin: "round",
                      lineCap: "round",
                    }}
                  />
                ) : null
              )}
            </>
          : polylinePositions.length >= 2 && (
          <>
            <Polyline
              positions={polylinePositions}
              pathOptions={{
                color: isDark ? "#34d399" : "#059669",
                weight: 4,
                opacity: 0.9,
                lineJoin: "round",
                lineCap: "round",
              }}
            />
            {/* Glow effect под линией */}
            <Polyline
              positions={polylinePositions}
              pathOptions={{
                color: isDark ? "#34d399" : "#059669",
                weight: 10,
                opacity: 0.15,
                lineJoin: "round",
                lineCap: "round",
              }}
            />
          </>
        )}
        {markers.map((m, i) => (
          <Marker
            key={`${m.lat}-${m.lon}-${i}`}
            position={[m.lat, m.lon]}
            icon={makeIcon(m.variant || "pin", m.label, m.color, m.hideIconLabel)}
            interactive={!!m.label}
          >
            {m.label && <Tooltip direction="top" offset={[0, -12]} opacity={1}><span className="text-[10px] font-medium">{m.label}</span></Tooltip>}
            {m.label && (
              <Popup>
                <div className="text-xs">{m.label}</div>
              </Popup>
            )}
          </Marker>
        ))}
        {/* Старт/финиш из points */}
        {polylinePositions.length >= 2 && (
          <>
            <Marker
              position={polylinePositions[0]}
              icon={makeIcon("start")}
              interactive
            >
              <Tooltip direction="top" offset={[0, -12]} opacity={1}>
                <span className="text-[10px] font-medium">
                  Старт · {polylinePositions[0][0].toFixed(5)}, {polylinePositions[0][1].toFixed(5)}
                </span>
              </Tooltip>
              <Popup>
                <div className="text-xs font-semibold text-emerald-600">
                  Старт трека
                </div>
                <div className="text-[10px] font-mono text-muted-foreground mt-1">
                  {polylinePositions[0][0].toFixed(6)}, {polylinePositions[0][1].toFixed(6)}
                </div>
              </Popup>
            </Marker>
            <Marker
              position={polylinePositions[polylinePositions.length - 1]}
              icon={makeIcon("end")}
              interactive
            >
              <Tooltip direction="top" offset={[0, -12]} opacity={1}>
                <span className="text-[10px] font-medium">
                  Финиш · {polylinePositions[polylinePositions.length - 1][0].toFixed(5)}, {polylinePositions[polylinePositions.length - 1][1].toFixed(5)}
                </span>
              </Tooltip>
              <Popup>
                <div className="text-xs font-semibold text-amber-500">
                  Финиш трека
                </div>
                <div className="text-[10px] font-mono text-muted-foreground mt-1">
                  {polylinePositions[polylinePositions.length - 1][0].toFixed(6)}, {polylinePositions[polylinePositions.length - 1][1].toFixed(6)}
                </div>
              </Popup>
            </Marker>
          </>
        )}
        {fitToPoints && fitPositions.length > 0 && (
          <FitBounds positions={fitPositions} />
        )}
        {/* v2.9.4: точка фокуса с профиля (связка карта↔график) */}
        {focusPoint && (
          <>
            <Marker position={[focusPoint.lat, focusPoint.lon]} icon={makeFocusIcon()} interactive={false} zIndexOffset={1000} />
            {panToFocus && <PanToFocus focus={focusPoint} />}
          </>
        )}
        {onMapClick && <MapEvents onClick={onMapClick} />}
        <ClickHandler />
      </MapContainer>

      {/* Layer switcher overlay */}
      {showLayerSwitcher && (
        <div className="absolute top-2 left-2 z-[1000] bg-background/95 backdrop-blur-sm border rounded-md shadow-sm p-0.5 flex gap-0.5">
          {(Object.keys(LAYERS) as LayerKind[]).map((k) => (
            <button
              key={k}
              onClick={() => setLayer(k)}
              className={cn(
                "px-2 py-1 text-[10px] font-medium rounded transition-colors",
                layer === k
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:text-foreground hover:bg-accent"
              )}
              title={`Слой: ${LAYERS[k].label}`}
            >
              {LAYERS[k].label}
            </button>
          ))}
        </div>
      )}

      {/* v2.9.8: легенда шкалы скорости (тепловая карта трека).
          стайлинг-раунд 9: крупнее чипы/шрифт (VLM: «too small on mobile»),
          бейдж «км/ч» слева, тень поверх тайлов */}
      {speedRuns && speedRunsTotal > 0 && (
        <div
          className="absolute bottom-7 left-1/2 -translate-x-1/2 z-[1000] bg-background/95 backdrop-blur-sm border rounded-md shadow-md px-2.5 py-1.5 flex gap-2.5 items-center max-w-[calc(100%-12px)] flex-wrap justify-center"
          role="figure"
          aria-label="Шкала скорости на треке, км/ч"
        >
          <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wide select-none">
            км/ч
          </span>
          {SPEED_BUCKETS.map((b, i) => (
            <span
              key={`legend-${i}`}
              className={cn(
                "flex items-center gap-1 text-[11px] font-mono font-medium select-none",
                speedRuns[i].length > 0 ? "text-foreground" : "text-muted-foreground/40"
              )}
              title={`Скорость ${b.label} км/ч`}
            >
              <span
                aria-hidden
                className="inline-block h-2.5 w-4 rounded-[3px] shadow-sm"
                style={{
                  backgroundColor: b.color,
                  opacity: speedRuns[i].length > 0 ? 1 : 0.25,
                }}
              />
              {b.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
