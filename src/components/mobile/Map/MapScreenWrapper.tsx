"use client";
import * as React from "react";
import { MapPin, Loader2 } from "lucide-react";
import { useSessions, useBatchStats } from "@/lib/hooks";
import { fmtDate } from "@/lib/format";

// Inline map using iframe to avoid all bundler issues
export function MapScreenWrapper({ onSessionTap }: { onSessionTap: (id: string) => void }) {
  const { data, isLoading } = useSessions({ limit: 100 });
  const sessions = data?.sessions || [];
  const sessionIds = React.useMemo(() => sessions.map((s: any) => s.id), [sessions]);
  const { data: batchStats } = useBatchStats(sessionIds);

  const points = React.useMemo(() => {
    const pts: Array<{ lat: number; lon: number; id: string; name: string; start: string }> = [];
    for (const s of sessions) {
      const st = (batchStats?.sessions || []).find((bs: any) => bs.id === s.id);
      if (st?.startLat != null && st?.startLon != null) {
        pts.push({ lat: st.startLat, lon: st.startLon, id: s.id, name: s.deviceName || s.deviceId, start: s.startTime });
      }
    }
    return pts;
  }, [sessions, batchStats]);

  return (
    <div className="flex flex-col h-full">
      <header className="bg-card border-b">
        <div className="flex items-center justify-between h-14 px-4">
          <div className="flex items-center gap-2"><MapPin className="h-5 w-5 text-primary" /><h1 className="text-[22px] font-bold">Карта</h1></div>
          <span className="text-xs text-muted-foreground">{points.length} поездок</span>
        </div>
      </header>
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {isLoading ? (
          <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
        ) : points.length === 0 ? (
          <div className="text-center py-12 text-sm text-muted-foreground"><MapPin className="h-12 w-12 mx-auto mb-3 opacity-30" />Нет поездок с координатами</div>
        ) : (
          points.map((p, i) => (
            <button key={p.id} onClick={() => onSessionTap(p.id)} className="w-full flex items-start gap-3 p-3 bg-card border rounded-xl active:bg-accent/30 text-left">
              <div className="w-10 h-10 rounded-full bg-primary/15 flex items-center justify-center shrink-0">
                <MapPin className="h-4 w-4 text-primary" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium truncate">{p.name}</div>
                <div className="text-xs text-muted-foreground">{fmtDate(p.start)}</div>
                <div className="text-[10px] text-muted-foreground font-mono mt-1">{p.lat.toFixed(4)}, {p.lon.toFixed(4)}</div>
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  );
}
