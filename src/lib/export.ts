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

// v2.11.0 (АУДИТ C-11): startTime бывает ISO-строкой (все сессии sensorlogger) —
// Number(ISO) = NaN → toISOString() падал → 500 на GPX/KML. Теперь оба формата.
function startTimeMs(startTime: number | string): number {
  return typeof startTime === "number" ? startTime : Date.parse(String(startTime));
}

// v2.11.0 (АУДИТ C-31): XML-экранирование значений в GPX/KML — deviceId с &/</>
// раньше давал невалидный XML.
function xmlEsc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
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
  // P1-8 + v2.11.0: startTime — число (эпоха мс) ИЛИ ISO-строка
  const startIso = fmtIso(startTimeMs(session.startTime));
  const devEsc = xmlEsc(session.deviceId);
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Telemetria v2.11" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <name>Сессия ${devEsc} — ${startIso}</name>
    <time>${startIso}</time>
  </metadata>
  <trk>
    <name>${devEsc}</name>
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
    <name>Сессия ${xmlEsc(session.deviceId)}</name>
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
