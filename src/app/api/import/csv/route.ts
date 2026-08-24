// POST /api/import/csv — импорт GPS-сессий из CSV (auto-detect columns).
// Ожидаемые колонки (case-insensitive, любым разделителем , или ;): lat, lon, speed, altitude, accuracy, timestamp, bearing, device_id, client_id, device_name.
// timestamp может быть: epoch ms, epoch ns, ISO8601.
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { authorizeRequest } from "@/lib/auth";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import { inc } from "@/lib/metrics";
import pLimit from "p-limit";
import { randomUUID } from "crypto";

const writeLock = pLimit(1);

function parseCSV(text: string): { headers: string[]; rows: string[][] } {
  // Определяем разделитель: ; если больше ; чем ,
  const semiCount = (text.match(/;/g) || []).length;
  const commaCount = (text.match(/,/g) || []).length;
  const sep = semiCount > commaCount ? ";" : ",";
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { headers: [], rows: [] };
  const headers = lines[0].split(sep).map((h) => h.trim().toLowerCase().replace(/["']/g, ""));
  const rows = lines.slice(1).map((l) => l.split(sep).map((c) => c.trim().replace(/["']/g, "")));
  return { headers, rows };
}

function findCol(headers: string[], names: string[]): number {
  for (const n of names) {
    const i = headers.findIndex((h) => h === n || h.includes(n));
    if (i >= 0) return i;
  }
  return -1;
}

function parseTimestamp(raw: string): number {
  const num = Number(raw);
  if (!isNaN(num)) {
    // Если > 1e15 — наносекунды
    if (num > 1e15) return Math.floor(num / 1e6);
    if (num > 1e12) return num; // ms
    if (num > 1e9) return num * 1000; // sec → ms
    return Date.now();
  }
  const d = new Date(raw);
  return isNaN(d.getTime()) ? Date.now() : d.getTime();
}

export async function POST(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const auth = await authorizeRequest(request, "api");
    if (!auth.ok) return json({ error: auth.reason }, 401, { "X-Request-Id": requestId });

    const formData = await request.formData();
    const file = formData.get("file");
    if (!file || !(file instanceof File)) {
      return json({ error: "file required (multipart/form-data)" }, 400, { "X-Request-Id": requestId });
    }
    const text = await file.text();
    const { headers, rows } = parseCSV(text);

    if (headers.length === 0) {
      return json({ error: "Empty CSV" }, 400, { "X-Request-Id": requestId });
    }

    const iLat = findCol(headers, ["lat", "latitude"]);
    const iLon = findCol(headers, ["lon", "lng", "longitude"]);
    const iSpeed = findCol(headers, ["speed"]);
    const iAlt = findCol(headers, ["alt", "altitude", "elevation"]);
    const iAcc = findCol(headers, ["acc", "accuracy"]);
    const iTs = findCol(headers, ["ts", "timestamp", "time", "date"]);
    const iBearing = findCol(headers, ["bearing", "heading", "course"]);
    const iDevice = findCol(headers, ["device_id", "deviceid", "device"]);
    const iClient = findCol(headers, ["client_id", "clientid", "client"]);
    const iDeviceName = findCol(headers, ["device_name", "name"]);

    if (iLat < 0 || iLon < 0) {
      return json({ error: "CSV must contain lat and lon columns" }, 400, { "X-Request-Id": requestId });
    }

    // Группируем по deviceId (или по clientId если есть)
    const groups = new Map<string, { deviceId: string; clientId: string; deviceName?: string; points: { lat: number; lon: number; speed?: number; altitude?: number; accuracy?: number; timestamp: number; bearing?: number }[] }>();

    for (const row of rows) {
      const lat = Number(row[iLat]);
      const lon = Number(row[iLon]);
      if (isNaN(lat) || isNaN(lon)) continue;
      const deviceId = iDevice >= 0 ? row[iDevice] || "csv-import" : "csv-import";
      const clientId = iClient >= 0 && row[iClient] ? row[iClient] : randomUUID();
      const key = `${deviceId}:${clientId}`;
      if (!groups.has(key)) {
        groups.set(key, { deviceId, clientId, deviceName: iDeviceName >= 0 ? row[iDeviceName] : undefined, points: [] });
      }
      groups.get(key)!.points.push({
        lat,
        lon,
        speed: iSpeed >= 0 ? Number(row[iSpeed]) || undefined : undefined,
        altitude: iAlt >= 0 ? Number(row[iAlt]) || undefined : undefined,
        accuracy: iAcc >= 0 ? Number(row[iAcc]) || undefined : undefined,
        timestamp: iTs >= 0 ? parseTimestamp(row[iTs]) : Date.now(),
        bearing: iBearing >= 0 ? Number(row[iBearing]) || undefined : undefined,
      });
    }

    const imported: { id: string; deviceId: string; points: number }[] = [];
    const errors: { deviceId: string; error: string }[] = [];

    for (const [, g] of groups) {
      try {
        g.points.sort((a, b) => a.timestamp - b.timestamp);
        const startTime = new Date(g.points[0].timestamp);
        const endTime = new Date(g.points[g.points.length - 1].timestamp);

        const session = await writeLock(async () => {
          return db.$transaction(async (tx) => {
            const s = await tx.session.create({
              data: {
                deviceId: g.deviceId,
                clientId: g.clientId,
                deviceName: g.deviceName,
                startTime,
                endTime,
                pointCount: g.points.length,
                payloadBytes: Buffer.byteLength(JSON.stringify(g.points)),
                status: "completed",
              },
            });
            await tx.gpsPoint.createMany({
              data: g.points.map((p) => ({
                sessionId: s.id,
                lat: p.lat,
                lon: p.lon,
                speed: p.speed ?? null,
                altitude: p.altitude ?? null,
                accuracy: p.accuracy ?? null,
                bearing: p.bearing ?? null,
                timestamp: BigInt(p.timestamp),
              })),
            });
            const job = await tx.trafficJob.create({
              data: { sessionId: s.id, status: "pending" },
            });
            await tx.session.update({ where: { id: s.id }, data: { trafficJobId: job.id } });
            return s;
          });
        });
        imported.push({ id: session.id, deviceId: session.deviceId, points: g.points.length });
        inc("ingest_total", "Total ingest requests", 1, "csv");
      } catch (err) {
        errors.push({ deviceId: g.deviceId, error: err instanceof Error ? err.message : String(err) });
      }
    }

    return json({ imported: imported.length, sessions: imported, errors }, 200, { "X-Request-Id": requestId });
  } catch (err) {
    logger.error("CSV import error", { requestId, error: err instanceof Error ? err.message : String(err) });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}
