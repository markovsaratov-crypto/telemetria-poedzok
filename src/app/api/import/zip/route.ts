// POST /api/import/zip — импорт GPS-данных из ZIP архива (SensorLogger format)
import { NextRequest } from "next/server";
import { db, libsql } from "@/lib/db";
import { authorizeRequest } from "@/lib/auth";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import { inc } from "@/lib/metrics";
import { writeAudit } from "@/lib/audit";
import { randomUUID } from "crypto";
import AdmZip from "adm-zip";

function parseCSV(text: string): { headers: string[]; rows: string[][] } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return { headers: [], rows: [] };
  const sep = (lines[0].match(/;/g) || []).length > (lines[0].match(/,/g) || []).length ? ";" : ",";
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

    const fileBuffer = Buffer.from(await file.arrayBuffer());
    const zip = new AdmZip(fileBuffer);
    
    // Find Location.csv and Metadata.csv
    let locationCsv = "";
    let metadataCsv = "";
    for (const entry of zip.getEntries()) {
      const lower = entry.entryName.toLowerCase();
      if (lower === "location.csv" || (lower.startsWith("location") && lower.endsWith(".csv"))) {
        locationCsv = entry.getData().toString("utf8");
      }
      if (lower === "metadata.csv" || (lower.startsWith("metadata") && lower.endsWith(".csv"))) {
        metadataCsv = entry.getData().toString("utf8");
      }
    }

    if (!locationCsv) {
      return json({ error: "Location.csv not found in ZIP archive" }, 400, { "X-Request-Id": requestId });
    }

    // Parse metadata
    let deviceName = "ZIP Import";
    let deviceId = "zip-" + randomUUID().slice(0, 8);
    if (metadataCsv) {
      const meta = parseCSV(metadataCsv);
      if (meta.headers.length > 0 && meta.rows.length > 0) {
        const dnIdx = findCol(meta.headers, ["device name", "device_name", "devicename"]);
        const diIdx = findCol(meta.headers, ["device id", "device_id", "deviceid"]);
        if (dnIdx >= 0) deviceName = meta.rows[0][dnIdx] || deviceName;
        if (diIdx >= 0) deviceId = meta.rows[0][diIdx] || deviceId;
      }
    }

    // Parse Location.csv
    const csv = parseCSV(locationCsv);
    const iLat = findCol(csv.headers, ["latitude", "lat"]);
    const iLon = findCol(csv.headers, ["longitude", "lon", "lng"]);
    const iTime = findCol(csv.headers, ["time", "timestamp"]);
    const iSpeed = findCol(csv.headers, ["speed"]);
    const iAlt = findCol(csv.headers, ["altitude", "alt"]);
    const iAcc = findCol(csv.headers, ["horizontalaccuracy", "accuracy", "horizontal_accuracy"]);
    const iBearing = findCol(csv.headers, ["bearing", "heading", "course"]);

    if (iLat < 0 || iLon < 0) {
      return json({ error: "Location.csv must contain latitude and longitude columns" }, 400, { "X-Request-Id": requestId });
    }

    // Parse points
    const points: { lat: number; lon: number; speed: number | null; altitude: number | null; accuracy: number | null; bearing: number | null; timestamp: number }[] = [];
    for (const row of csv.rows) {
      const lat = Number(row[iLat]);
      const lon = Number(row[iLon]);
      if (isNaN(lat) || isNaN(lon)) continue;
      const ts = iTime >= 0 ? Number(row[iTime]) : Date.now();
      const timestampMs = ts > 1e15 ? Math.floor(ts / 1e6) : ts > 1e12 ? ts : ts * 1000;
      const speed = iSpeed >= 0 ? Number(row[iSpeed]) : null;
      const altitude = iAlt >= 0 ? Number(row[iAlt]) : null;
      const accuracy = iAcc >= 0 ? Number(row[iAcc]) : null;
      const bearing = iBearing >= 0 ? Number(row[iBearing]) : null;
      points.push({
        lat, lon,
        speed: speed !== null && speed >= 0 ? speed : null,
        altitude: altitude !== null && altitude >= -1000 ? altitude : null,
        accuracy: accuracy !== null && accuracy >= 0 ? accuracy : null,
        bearing: bearing !== null && bearing >= 0 ? bearing : null,
        timestamp: timestampMs,
      });
    }

    if (points.length === 0) {
      return json({ error: "No valid GPS points found" }, 400, { "X-Request-Id": requestId });
    }

    // Sort + filter gaps
    points.sort((a, b) => a.timestamp - b.timestamp);
    const filtered: typeof points = [points[0]];
    for (let i = 1; i < points.length; i++) {
      if (points[i].timestamp - points[i - 1].timestamp <= 30000) filtered.push(points[i]);
    }

    const startTime = new Date(filtered[0].timestamp);
    const endTime = new Date(filtered[filtered.length - 1].timestamp);
    const clientId = randomUUID();

    // Create session
    const session = await db.session.create({
      data: { deviceId, clientId, deviceName, startTime, endTime, pointCount: filtered.length, payloadBytes: fileBuffer.length, status: "completed" },
    });

    // Insert GPS points
    for (let i = 0; i < filtered.length; i += 100) {
      const batch = filtered.slice(i, i + 100);
      for (const p of batch) {
        await libsql.execute({
          sql: "INSERT INTO GpsPoint (id, sessionId, lat, lon, speed, altitude, accuracy, timestamp, bearing) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          args: [randomUUID(), session.id, p.lat, p.lon, p.speed, p.altitude, p.accuracy, BigInt(p.timestamp), p.bearing],
        });
      }
    }

    await db.trafficJob.create({ data: { sessionId: session.id, status: "pending" } });
    await writeAudit({ action: "session.import", targetId: session.id, targetType: "Session", actorType: "user", actorId: "owner", sessionId: session.id, metadata: { source: "zip", fileName: file.name, pointCount: filtered.length, deviceName } });
    inc("ingest_total", "Total ingest requests", 1, "zip");
    logger.info("ZIP import success", { requestId, sessionId: session.id, points: filtered.length, deviceName });

    return json({ imported: 1, sessionId: session.id, deviceId, deviceName, pointCount: filtered.length, startTime: startTime.toISOString(), endTime: endTime.toISOString() }, 200, { "X-Request-Id": requestId });
  } catch (err) {
    logger.error("ZIP import error", { requestId, error: err instanceof Error ? err.message : String(err) });
    return json({ error: "Import failed", message: err instanceof Error ? err.message : String(err) }, 500, { "X-Request-Id": requestId });
  }
}
