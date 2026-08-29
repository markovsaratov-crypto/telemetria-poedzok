// src/lib/export.ts — генерация GPX 1.1 / KML 2.2 / JSON (§4.11)
// P2-фикс: @prisma/client генерируется только для типов; чтобы не зависеть от prisma generate,
// описываем структурные типы вручную (совместимы со строками из db-обёртки)
export interface GpsPoint {
  id?: string;
  sessionId?: string;
  timestamp: number | bigint;
  lat: number;
  lon: number;
  altitude?: number | null;
  speed?: number | null;
  bearing?: number | null;
  accuracy?: number | null;
}

export interface SessionBase {
  id: string;
  deviceId: string;
  clientId?: string | null;
  startTime: number | string;
  endTime?: number | string | null;
  status?: string;
  [key: string]: unknown;
}

export interface SessionWithPoints extends SessionBase {
  gpsPoints: GpsPoint[];
}

function fmtIso(ms: number): string {
  return new Date(ms).toISOString();
}

export function toGPX(session: SessionWithPoints): string {
  const pts = session.gpsPoints
    .map((p) => {
      const t = Number(p.timestamp);
      const attrs = [
        `<trkpt lat="${p.lat}" lon="${p.lon}">`,
        `  <time>${fmtIso(t)}</time>`,
        p.altitude != null ? `  <ele>${p.altitude}</ele>` : "", // P1-8: было p.ele (всегда undefined → ele не писался)
        p.speed != null ? `  <extensions><speed>${p.speed}</speed></extensions>` : "",
        `</trkpt>`,
      ].filter(Boolean);
      return attrs.join("\n");
    })
    .join("\n");
  // P1-8: startTime из обёртки приходит числом (эпоха мс) — toISOString() на числе падал (500 на GPX)
  const startIso = fmtIso(Number(session.startTime));
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Telemetria v2.9" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <name>Сессия ${session.deviceId} — ${startIso}</name>
    <time>${startIso}</time>
  </metadata>
  <trk>
    <name>${session.deviceId}</name>
    <trkseg>
${pts}
    </trkseg>
  </trk>
</gpx>`;
}

export function toKML(session: SessionWithPoints): string {
  const coords = session.gpsPoints
    .map((p) => `${p.lon},${p.lat},${p.altitude ?? 0}`)
    .join(" ");
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>Сессия ${session.deviceId}</name>
    <Placemark>
      <name>GPS Track</name>
      <LineString>
        <coordinates>${coords}</coordinates>
      </LineString>
    </Placemark>
  </Document>
</kml>`;
}

export function toJSON(session: SessionWithPoints): string {
  return JSON.stringify(
    {
      sessionId: session.id,
      deviceId: session.deviceId,
      startTime: session.startTime,
      endTime: session.endTime,
      pointCount: session.pointCount,
      status: session.status,
      points: session.gpsPoints.map((p) => ({
        lat: p.lat,
        lon: p.lon,
        speed: p.speed,
        altitude: p.altitude,
        accuracy: p.accuracy,
        bearing: p.bearing,
        timestamp: Number(p.timestamp),
      })),
    },
    null,
    2
  );
}

export function generateExport(session: SessionWithPoints, format: "gpx" | "kml" | "json"): { content: string; mime: string; ext: string } {
  if (format === "gpx") return { content: toGPX(session), mime: "application/gpx+xml", ext: "gpx" };
  if (format === "kml") return { content: toKML(session), mime: "application/vnd.google-earth.kml+xml", ext: "kml" };
  return { content: toJSON(session), mime: "application/json", ext: "json" };
}
