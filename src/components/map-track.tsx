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
}

type LayerKind = "voyager" | "dark" | "satellite" | "street";

interface MapTrackProps {
  points?: Array<{ lat: number; lon: number }>;
  markers?: MapMarker[];
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
function makeIcon(variant: "start" | "end" | "pin", label?: string): L.DivIcon {
  const colorMap: Record<string, string> = {
    start: "#10b981", // emerald-500
    end: "#f59e0b", // amber-500
    pin: "#0d9488", // teal-600
  };
  const color = colorMap[variant];
  const html = `
    <div style="position:relative;display:flex;flex-direction:column;align-items:center;">
      <div style="
        background:${color};
        width:18px;height:18px;border-radius:50%;
        border:3px solid #fff;
        box-shadow:0 0 0 2px ${color},0 2px 6px rgba(0,0,0,0.35);
      "></div>
      ${
        label
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

  const fitPositions = React.useMemo(() => {
    const arr: Array<[number, number]> = [...polylinePositions];
    for (const m of markers) {
      arr.push([m.lat, m.lon]);
    }
    return arr;
  }, [polylinePositions, markers]);

  const hasContent = polylinePositions.length > 0 || markers.length > 0;
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
        {polylinePositions.length >= 2 && (
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
            icon={makeIcon(m.variant || "pin", m.label)}
            interactive={!!m.label}
          >
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
    </div>
  );
}
