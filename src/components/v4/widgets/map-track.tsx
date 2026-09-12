// src/components/v4/widgets/map-track.tsx — v2.10.0 R2: Leaflet MapTrack для блока 05.
// Default layer = "street" (OSM Standard tiles). Layer switcher (top-right): street/satellite/terrain/dark.
// Polyline colored by track.segments (each segment.color → Polyline).
// Gaps (>30sec) → dashed Polyline (dashArray: "5,10").
// Harsh points → CircleMarker (red braking, orange acceleration, radius 6).
// START/FINISH markers → Marker with custom L.divIcon (HTML).
// Auto-fit bounds from track.bounds via L.featureGroup(generatedLayers).getBounds().
// Legend bottom-right with 6 bucket colors + разрыв + резкое торможение.
// Dark theme-aware: при dark theme auto-switch на "dark" layer при первом монтировании.

"use client";

import * as React from "react";
import L from "leaflet";
import {
  MapContainer,
  TileLayer,
  Polyline,
  CircleMarker,
  Marker,
  Tooltip,
  useMap,
} from "react-leaflet";
import "leaflet/dist/leaflet.css";
import { useTheme } from "next-themes";
import type { TrackResponse } from "@/lib/api-client";

// === Tile layers (v2.29.0: все провайдеры — без API-ключа) ===
// v2.29.0: CARTO (basemaps.cartocdn.com) с авг 2026 требует API-ключ и отдаёт
// error-тайл «API key required» анонимным запросам → слой dark переведён на
// Esri World Dark Gray Canvas (Base + Reference-подписи, бесплатный, без ключа;
// тот же CDN server.arcgisonline.com, что и satellite). Voyager удалён по той же причине.
type LayerKind = "street" | "satellite" | "terrain" | "dark";

type TileDef = { url: string; attr: string; maxNativeZoom?: number };

const LAYERS: Record<
  LayerKind,
  { tiles: TileDef[]; maxZoom: number; label: string; emoji: string }
> = {
  // OSM Standard — free, no API key, default layer.
  street: {
    tiles: [
      {
        url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
        attr: "&copy; OpenStreetMap contributors",
      },
    ],
    label: "Street",
    emoji: "🛣",
    maxZoom: 19,
  },
  // Esri World Imagery — free satellite tiles.
  satellite: {
    tiles: [
      {
        url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
        attr: "Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics",
      },
    ],
    label: "Satellite",
    emoji: "🗺",
    maxZoom: 19,
  },
  // OpenTopoMap — free terrain tiles.
  terrain: {
    tiles: [
      {
        url: "https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png",
        attr: "&copy; OpenStreetMap contributors, SRTM | &copy; OpenTopoMap (CC-BY-SA)",
      },
    ],
    label: "Terrain",
    emoji: "🏔",
    maxZoom: 17,
  },
  // Esri World Dark Gray Canvas — free, no API key.
  // Base = тёмная подложка (нативный зум 16, дальше Leaflet апскейлит),
  // Reference = подписи городов/дорог поверх подложки.
  dark: {
    tiles: [
      {
        url: "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}",
        attr: "Tiles &copy; Esri &mdash; Esri, DeLorme, NAVTEQ, USGS, NOAA",
        maxNativeZoom: 16,
      },
      {
        url: "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}",
        attr: "",
        // v2.29.0 (MI-8): Reference тоже апскейлится с 16 — иначе на z17–20
        // подписи пропадали (404 на несуществующих нативных тайлах).
        maxNativeZoom: 16,
      },
    ],
    label: "Dark",
    emoji: "🌑",
    maxZoom: 20,
  },
};

// === START/FINISH divIcon markers (HTML, не требует внешних PNG) ===
function makeStartIcon(): L.DivIcon {
  const html = `
    <div style="position:relative;display:flex;flex-direction:column;align-items:center;">
      <div style="background:#10b981;width:18px;height:18px;border-radius:50%;border:3px solid #fff;box-shadow:0 0 0 2px #10b981,0 2px 6px rgba(0,0,0,0.35);"></div>
      <div style="margin-top:4px;background:rgba(255,255,255,0.95);color:#0f172a;font-size:10px;font-weight:700;letter-spacing:0.1em;padding:2px 6px;border-radius:3px;white-space:nowrap;box-shadow:0 1px 3px rgba(0,0,0,0.2);">СТАРТ</div>
    </div>`;
  return L.divIcon({ html, className: "telem-v4-marker", iconSize: [24, 24], iconAnchor: [12, 12] });
}

function makeFinishIcon(): L.DivIcon {
  const html = `
    <div style="position:relative;display:flex;flex-direction:column;align-items:center;">
      <div style="background:#8E2D4E;width:18px;height:18px;border-radius:50%;border:3px solid #fff;box-shadow:0 0 0 2px #8E2D4E,0 2px 6px rgba(0,0,0,0.35);"></div>
      <div style="margin-top:4px;background:rgba(255,255,255,0.95);color:#0f172a;font-size:10px;font-weight:700;letter-spacing:0.1em;padding:2px 6px;border-radius:3px;white-space:nowrap;box-shadow:0 1px 3px rgba(0,0,0,0.2);">ФИНИШ</div>
    </div>`;
  return L.divIcon({ html, className: "telem-v4-marker", iconSize: [24, 24], iconAnchor: [12, 12] });
}

// === Авто-fit bounds к точкам/сегментам/маркерам ===
function FitBounds({ track }: { track: TrackResponse }) {
  const map = useMap();
  React.useEffect(() => {
    if (!track) return;
    // Границы из track.bounds (если есть) — самого первого раза достаточно.
    if (track.bounds) {
      const [[s, w], [n, e]] = track.bounds;
      if (Number.isFinite(s) && Number.isFinite(w) && Number.isFinite(n) && Number.isFinite(e)) {
        const bounds = L.latLngBounds([s, w], [n, e]);
        if (bounds.isValid()) {
          map.fitBounds(bounds, { padding: [40, 40], maxZoom: 16 });
          return;
        }
      }
    }
    // Fallback: bounds из segment points.
    const pts: L.LatLngExpression[] = [];
    for (const seg of track.segments) {
      for (const p of seg.points) pts.push([p.lat, p.lng] as [number, number]);
    }
    if (track.markers) {
      pts.push([track.markers.start.lat, track.markers.start.lng]);
      pts.push([track.markers.finish.lat, track.markers.finish.lng]);
    }
    if (pts.length >= 2) {
      const bounds = L.latLngBounds(pts);
      if (bounds.isValid()) map.fitBounds(bounds, { padding: [40, 40], maxZoom: 16 });
    } else if (pts.length === 1) {
      map.setView(pts[0] as L.LatLngExpression, 14);
    }
  }, [track, map]);
  return null;
}

interface MapTrackProps {
  track: TrackResponse | null;
  isLoading?: boolean;
  isError?: boolean;
}

export function V4MapTrack({ track, isLoading, isError }: MapTrackProps) {
  const { resolvedTheme } = useTheme();
  const isDark = resolvedTheme === "dark";
  // v2.10.0 R2: default layer = "street" (per API track.defaultLayer).
  // При тёмной теме — auto-switch на "dark" при первом монтировании (если ещё не менял пользователь).
  const [layer, setLayer] = React.useState<LayerKind>("street");
  const [userTouched, setUserTouched] = React.useState(false);

  React.useEffect(() => {
    if (userTouched) return;
    // Track говорит, какой слой дефолтный.
    const defLayer = (track?.defaultLayer ?? "street") as LayerKind;
    if (LAYERS[defLayer]) {
      setLayer(isDark && defLayer === "street" ? "dark" : defLayer);
    } else {
      setLayer(isDark ? "dark" : "street");
    }
  }, [track, isDark, userTouched]);

  const layerDef = LAYERS[layer];
  const layerMaxZoom = layerDef.maxZoom;

  // Сегменты трека (каждый — Polyline своим цветом).
  const segments = React.useMemo(() => {
    if (!track?.segments) return [];
    return track.segments
      .filter((s) => Array.isArray(s.points) && s.points.length >= 1)
      .map((s, i) => ({
        i,
        color: s.color,
        bucket: s.bucket,
        positions: s.points.map(
          (p) => [p.lat, p.lng] as [number, number]
        ),
      }));
  }, [track]);

  // Разрывы — пунктирные полилинии между точками fromIdx и toIdx (по points[]).
  const gapPolylines = React.useMemo(() => {
    if (!track?.gaps || !track?.points) return [];
    return track.gaps
      .filter((g) => g.fromIdx >= 0 && g.toIdx < track.points.length)
      .map((g) => ({
        i: g.fromIdx,
        durationSec: g.durationSec,
        positions: [
          [track.points[g.fromIdx].lat, track.points[g.fromIdx].lng],
          [track.points[g.toIdx].lat, track.points[g.toIdx].lng],
        ] as [number, number][],
      }));
  }, [track]);

  // Harsh points → CircleMarker.
  const harshPoints = React.useMemo(() => track?.harshPoints ?? [], [track]);

  // Если нет ни одной точки — показываем placeholder.
  const isEmpty = !track || track.points.length === 0;

  return (
    <div
      className="map-wrap v4-map-wrap"
      style={{ position: "relative", height: 380, width: "100%" }}
      aria-label="Карта поездки"
    >
      {isEmpty && !isLoading && !isError ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            height: "100%",
            color: "var(--muted)",
            fontSize: 12,
            background: "var(--bg)",
          }}
        >
          Трек пустой — нет GPS-точек
        </div>
      ) : isLoading ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            height: "100%",
            color: "var(--muted)",
            fontSize: 12,
            background: "var(--bg)",
          }}
        >
          Загрузка карты…
        </div>
      ) : isError ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            height: "100%",
            color: "var(--red)",
            fontSize: 12,
            background: "var(--bg)",
          }}
        >
          Ошибка загрузки трека
        </div>
      ) : (
        <>
          <MapContainer
            center={[55.751244, 37.618423]}
            zoom={12}
            scrollWheelZoom
            style={{ height: "100%", width: "100%", background: isDark ? "#232328" : "#F7F2F5" }}
            attributionControl
            zoomControl
          >
            {/* v2.29.0: слой может состоять из нескольких тайл-слоёв (dark = подложка + подписи) */}
            {layerDef.tiles.map((t, ti) => (
              <TileLayer
                key={`tile-${layer}-${ti}`}
                url={t.url}
                attribution={t.attr}
                maxNativeZoom={t.maxNativeZoom}
                maxZoom={layerMaxZoom}
              />
            ))}
            {/* Цветовые сегменты по скорости */}
            {segments.map((seg) => (
              <Polyline
                key={`seg-${seg.i}`}
                positions={seg.positions}
                pathOptions={{
                  color: seg.color,
                  weight: 5,
                  opacity: 0.95,
                  lineJoin: "round",
                  lineCap: "round",
                }}
              />
            ))}
            {/* Разрывы — пунктир */}
            {gapPolylines.map((g) => (
              <Polyline
                key={`gap-${g.i}`}
                positions={g.positions}
                pathOptions={{
                  color: "#C99A2E",
                  weight: 3,
                  opacity: 0.85,
                  dashArray: "5,10",
                  lineCap: "round",
                }}
              >
                <Tooltip sticky>
                  Разрыв записи · {g.durationSec} сек
                </Tooltip>
              </Polyline>
            ))}
            {/* Harsh points — CircleMarker */}
            {harshPoints.map((hp, i) => (
              <CircleMarker
                key={`hp-${i}`}
                center={[hp.lat, hp.lng]}
                radius={6}
                pathOptions={{
                  color: "#fff",
                  weight: 2,
                  fillColor: hp.type === "braking" ? "#D93A3A" : "#E68A2E",
                  fillOpacity: 0.95,
                }}
              >
                <Tooltip sticky>
                  {hp.type === "braking" ? "Резкое торможение" : "Резкий разгон"}
                  <br />
                  Δv = {hp.dv} м/с² · t = {hp.t}с
                </Tooltip>
              </CircleMarker>
            ))}
            {/* START/FINISH markers */}
            {track?.markers && (
              <>
                <Marker
                  position={[track.markers.start.lat, track.markers.start.lng]}
                  icon={makeStartIcon()}
                  interactive
                >
                  <Tooltip direction="top" offset={[0, -12]} opacity={1}>
                    Старт · t={track.markers.start.t}с
                  </Tooltip>
                </Marker>
                <Marker
                  position={[track.markers.finish.lat, track.markers.finish.lng]}
                  icon={makeFinishIcon()}
                  interactive
                >
                  <Tooltip direction="top" offset={[0, -12]} opacity={1}>
                    Финиш · t={track.markers.finish.t}с
                  </Tooltip>
                </Marker>
              </>
            )}
            {/* Auto-fit bounds */}
            {track && <FitBounds track={track} />}
          </MapContainer>

          {/* Layer switcher (top-right) */}
          <div
            style={{
              position: "absolute",
              top: 10,
              right: 10,
              zIndex: 1000,
              display: "flex",
              gap: 2,
              background: "rgba(255,255,255,0.95)",
              border: "1px solid var(--line)",
              borderRadius: 6,
              padding: 2,
              boxShadow: "0 2px 8px rgba(0,0,0,0.12)",
            }}
          >
            {(Object.keys(LAYERS) as LayerKind[]).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => {
                  setUserTouched(true);
                  setLayer(k);
                }}
                title={`Слой: ${LAYERS[k].label}`}
                style={{
                  padding: "4px 8px",
                  fontSize: 11,
                  fontWeight: 600,
                  border: "none",
                  borderRadius: 4,
                  cursor: "pointer",
                  background: layer === k ? "#8E2D4E" : "transparent",
                  color: layer === k ? "#fff" : "var(--text)",
                  transition: "0.15s",
                }}
              >
                <span style={{ marginRight: 4 }}>{LAYERS[k].emoji}</span>
                {LAYERS[k].label}
              </button>
            ))}
          </div>

          {/* Legend (bottom-right) */}
          {track?.legend && track.legend.length > 0 && (
            <div
              style={{
                position: "absolute",
                bottom: 10,
                right: 10,
                zIndex: 1000,
                background: "rgba(255,255,255,0.95)",
                border: "1px solid var(--line)",
                borderRadius: 6,
                padding: "6px 10px",
                boxShadow: "0 2px 8px rgba(0,0,0,0.12)",
                display: "flex",
                gap: 10,
                alignItems: "center",
                flexWrap: "wrap",
                maxWidth: "calc(100% - 20px)",
                fontSize: 10.5,
                color: "var(--muted)",
              }}
            >
              {track.legend.map((b, i) => (
                <span key={i} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                  <span
                    style={{
                      width: 10,
                      height: 10,
                      borderRadius: 2,
                      background: b.color,
                      display: "inline-block",
                    }}
                  />
                  {b.label}
                </span>
              ))}
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                <span
                  style={{
                    width: 20,
                    height: 0,
                    borderTop: "3px dashed #C99A2E",
                    display: "inline-block",
                  }}
                />
                разрыв
              </span>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background: "#D93A3A",
                    display: "inline-block",
                  }}
                />
                резкое торможение
              </span>
              {track?.points && (
                <span style={{ color: "var(--faint)" }}>
                  · {track.points.length} точек · {track.segments.length} сегментов
                </span>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export default V4MapTrack;
