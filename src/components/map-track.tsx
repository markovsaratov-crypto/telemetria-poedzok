"use client";

// src/components/map-track.tsx — Leaflet карта (только client-side).
// Импортируется через next/dynamic с ssr:false из session-detail.tsx / route-planner.tsx.

import * as React from "react";
import L from "leaflet";
import { MapContainer, TileLayer, Polyline, Marker, Popup, useMap } from "react-leaflet";
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
}

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
  // no-op stub оставлен для обратной совместимости; реальный обработчик в MapEvents
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
}: MapTrackProps) {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";

  const tileUrl = isDark
    ? "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
    : "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png";
  const tileAttr = isDark
    ? '&copy; OpenStreetMap &copy; CARTO'
    : '&copy; OpenStreetMap &copy; CARTO';

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
        "rounded-lg overflow-hidden border border-border bg-muted",
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
        style={{ height: "100%", width: "100%" }}
      >
        <TileLayer url={tileUrl} attribution={tileAttr} />
        {polylinePositions.length >= 2 && (
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
              icon={makeIcon("start", "Старт")}
              interactive
            >
              <Popup>
                <div className="text-xs font-semibold text-emerald-600">
                  Старт трека
                </div>
              </Popup>
            </Marker>
            <Marker
              position={polylinePositions[polylinePositions.length - 1]}
              icon={makeIcon("end", "Финиш")}
              interactive
            >
              <Popup>
                <div className="text-xs font-semibold text-amber-500">
                  Финиш трека
                </div>
              </Popup>
            </Marker>
          </>
        )}
        {fitToPoints && fitPositions.length > 0 && (
          <FitBounds positions={fitPositions} />
        )}
        {onMapClick && <MapEvents onClick={onMapClick} />}
        {/* ClickHandler оставлен как no-op stub для совместимости */}
        <ClickHandler />
      </MapContainer>
    </div>
  );
}
