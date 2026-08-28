"use client";

import "leaflet/dist/leaflet.css";
import * as React from "react";
import { MapContainer, TileLayer, CircleMarker, Popup, useMap } from "react-leaflet";
import L from "leaflet";
import { useSessions, useBatchStats } from "@/lib/hooks";
import { MapPin, Loader2, Plus, Minus, ArrowUp, ArrowDown, ArrowLeft, ArrowRight } from "lucide-react";
import { fmtDate } from "@/lib/format";

delete (L.Icon.Default.prototype as unknown as { _getIconUrl?: unknown })._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
  iconUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  shadowUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
});

interface MapScreenProps { onSessionTap: (id: string) => void; }

function FitBounds({ points }: { points: Array<[number, number]> }) {
  const map = useMap();
  React.useEffect(() => {
    if (points.length === 0) return;
    if (points.length === 1) { map.setView(points[0], 14); return; }
    map.fitBounds(L.latLngBounds(points), { padding: [40, 40] });
  }, [points, map]);
  return null;
}

function ZoomButtons() {
  const map = useMap();
  return (
    <div className="absolute top-4 right-4 z-[1000] flex flex-col gap-1">
      <button onClick={() => map.zoomIn()} className="w-10 h-10 bg-card border rounded-lg shadow-md flex items-center justify-center" aria-label="Приблизить"><Plus className="h-5 w-5" /></button>
      <button onClick={() => map.zoomOut()} className="w-10 h-10 bg-card border rounded-lg shadow-md flex items-center justify-center" aria-label="Отдалить"><Minus className="h-5 w-5" /></button>
    </div>
  );
}

function PanControls() {
  const map = useMap();
  const pan = (dx: number, dy: number) => map.panBy([dx, dy]);
  return (
    <div className="absolute bottom-4 right-4 z-[1000] flex flex-col items-center gap-1">
      <button onClick={() => pan(0, -80)} className="w-10 h-10 bg-card border rounded-lg shadow-md flex items-center justify-center" aria-label="Вверх"><ArrowUp className="h-5 w-5" /></button>
      <div className="flex gap-1">
        <button onClick={() => pan(-80, 0)} className="w-10 h-10 bg-card border rounded-lg shadow-md flex items-center justify-center" aria-label="Влево"><ArrowLeft className="h-5 w-5" /></button>
        <button onClick={() => pan(80, 0)} className="w-10 h-10 bg-card border rounded-lg shadow-md flex items-center justify-center" aria-label="Вправо"><ArrowRight className="h-5 w-5" /></button>
      </div>
      <button onClick={() => pan(0, 80)} className="w-10 h-10 bg-card border rounded-lg shadow-md flex items-center justify-center" aria-label="Вниз"><ArrowDown className="h-5 w-5" /></button>
    </div>
  );
}

export function MapScreen({ onSessionTap }: MapScreenProps) {
  const { data, isLoading } = useSessions({ limit: 100 });
  const sessions = data?.sessions || [];
  const sessionIds = React.useMemo(() => sessions.map((s: any) => s.id), [sessions]);
  const { data: batchStats } = useBatchStats(sessionIds);

  const points = React.useMemo(() => {
    const pts: Array<{ lat: number; lon: number; id: string; name: string; start: string; status: string }> = [];
    for (const s of sessions) {
      const st = (batchStats?.sessions || []).find((bs: any) => bs.sessionId === s.id);
      if (st?.startLat != null && st?.startLon != null) {
        pts.push({ lat: st.startLat, lon: st.startLon, id: s.id, name: s.deviceName || s.deviceId, start: s.startTime, status: s.status });
      }
    }
    return pts;
  }, [sessions, batchStats]);

  const allCoords: [number, number][] = points.map((p) => [p.lat, p.lon]);
  const center: [number, number] = allCoords[0] || [51.5924, 45.9606];

  if (isLoading) return (
    <div className="flex flex-col h-full">
      <header className="bg-card border-b"><div className="flex items-center gap-2 h-14 px-4"><MapPin className="h-5 w-5 text-primary" /><h1 className="text-[22px] font-bold">Карта</h1></div></header>
      <div className="flex-1 flex items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
    </div>
  );

  return (
    <div className="flex flex-col h-full">
      <header className="bg-card border-b">
        <div className="flex items-center justify-between h-14 px-4">
          <div className="flex items-center gap-2"><MapPin className="h-5 w-5 text-primary" /><h1 className="text-[22px] font-bold">Карта</h1></div>
          <span className="text-xs text-muted-foreground">{points.length} поездок</span>
        </div>
      </header>
      <div className="flex-1 relative" style={{ minHeight: "400px", height: "calc(100vh - 120px)" }}>
        {points.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-sm text-muted-foreground"><MapPin className="h-12 w-12 mb-3 opacity-30" />Нет поездок с координатами</div>
        ) : (
          <>
            <MapContainer center={center} zoom={13} className="w-full h-full" style={{ height: "100%", width: "100%" }} scrollWheelZoom={false} zoomControl={false}>
              <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution="&copy; OpenStreetMap contributors" />
              <FitBounds points={allCoords} />
              {points.map((p) => (
                <CircleMarker key={p.id} center={[p.lat, p.lon]} radius={10} pathOptions={{
                  color: p.status === "active" ? "#10b981" : p.status === "completed" ? "#14b8a6" : "#94a3b8",
                  fillColor: p.status === "active" ? "#10b981" : p.status === "completed" ? "#14b8a6" : "#94a3b8", fillOpacity: 0.7,
                }}>
                  <Popup>
                    <div className="text-xs space-y-1">
                      <div className="font-semibold">{p.name}</div>
                      <div>{fmtDate(p.start)}</div>
                      <button onClick={() => onSessionTap(p.id)} className="text-primary font-medium">Открыть →</button>
                    </div>
                  </Popup>
                </CircleMarker>
              ))}
            </MapContainer>
            <ZoomButtons />
            <PanControls />
          </>
        )}
      </div>
    </div>
  );
}
