// POST /api/import/zip — импорт GPS-данных из ZIP архива (SensorLogger format)
import { inflateSync } from "zlib";
// Expected: multipart/form-data with file=archive.zip
// ZIP contains: Location.csv, Metadata.csv, (optional: Annotation.csv)
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { authorizeRequest } from "@/lib/auth";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import { inc } from "@/lib/metrics";
import { writeAudit } from "@/lib/audit";
import { env } from "@/lib/env";
import pLimit from "p-limit";
import { randomUUID } from "crypto";

// Minimal ZIP parser (no external dependency)
// Reads ZIP central directory to find files
interface ZipEntry {
  name: string;
  offset: number;
  size: number;
}

function parseZip(buffer: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  // Find End of Central Directory record
  let eocdOffset = -1;
  for (let i = buffer.length - 22; i >= 0; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) throw new Error("Invalid ZIP: EOCD not found");

  const cdOffset = buffer.readUInt32LE(eocdOffset + 16);
  const cdEntries = buffer.readUInt16LE(eocdOffset + 10);

  let offset = cdOffset;
  for (let i = 0; i < cdEntries; i++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
    
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraFieldLength = buffer.readUInt16LE(offset + 30);
    const fileCommentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    
    const fileName = buffer.toString("utf8", offset + 46, offset + 46 + fileNameLength);
    
    // Read local file header to get actual data offset
    const localFileNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraFieldLength = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataOffset = localHeaderOffset + 30 + localFileNameLength + localExtraFieldLength;
    
    // Check compression method (0 = stored, 8 = deflate)
    const compressionMethod = buffer.readUInt16LE(localHeaderOffset + 8);
    
    if (compressionMethod === 0) {
      // Stored (no compression)
      files.set(fileName, buffer.subarray(dataOffset, dataOffset + uncompressedSize));
    } else if (compressionMethod === 8) {
      // Deflate — use Node.js zlib
      import { inflateSync } from "zlib";
      const compressed = buffer.subarray(dataOffset, dataOffset + compressedSize);
      files.set(fileName, inflateSync(compressed));
    }
    
    offset += 46 + fileNameLength + extraFieldLength + fileCommentLength;
  }
  
  return files;
}

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
    const files = parseZip(fileBuffer);

    // Find Location.csv
    let locationFile: Buffer | null = null;
    let metadataFile: Buffer | null = null;
    for (const [name, data] of files.entries()) {
      const lower = name.toLowerCase();
      if (lower.includes("location") && lower.endsWith(".csv")) locationFile = data;
      if (lower.includes("metadata") && lower.endsWith(".csv")) metadataFile = data;
    }

    if (!locationFile) {
      return json({ error: "Location.csv not found in ZIP archive" }, 400, { "X-Request-Id": requestId });
    }

    // Parse metadata if available
    let deviceName = "ZIP Import";
    let deviceId = "zip-import-" + randomUUID().slice(0, 8);
    if (metadataFile) {
      const meta = parseCSV(metadataFile.toString("utf8"));
      if (meta.headers.length > 0 && meta.rows.length > 0) {
        const deviceNameIdx = findCol(meta.headers, ["device name", "device_name", "devicename"]);
        const deviceIdIdx = findCol(meta.headers, ["device id", "device_id", "deviceid"]);
        if (deviceNameIdx >= 0) deviceName = meta.rows[0][deviceNameIdx] || deviceName;
        if (deviceIdIdx >= 0) deviceId = meta.rows[0][deviceIdIdx] || deviceId;
      }
    }

    // Parse Location.csv
    const csv = parseCSV(locationFile.toString("utf8"));
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

    // Parse and filter points
    const points: { lat: number; lon: number; speed: number | null; altitude: number | null; accuracy: number | null; bearing: number | null; timestamp: number }[] = [];
    for (const row of csv.rows) {
      const lat = Number(row[iLat]);
      const lon = Number(row[iLon]);
      if (isNaN(lat) || isNaN(lon)) continue;
      
      const ts = iTime >= 0 ? Number(row[iTime]) : Date.now();
      // Convert nanoseconds to milliseconds if needed
      const timestampMs = ts > 1e15 ? Math.floor(ts / 1e6) : ts > 1e12 ? ts : ts * 1000;
      
      const speed = iSpeed >= 0 ? Number(row[iSpeed]) : null;
      const altitude = iAlt >= 0 ? Number(row[iAlt]) : null;
      const accuracy = iAcc >= 0 ? Number(row[iAcc]) : null;
      const bearing = iBearing >= 0 ? Number(row[iBearing]) : null;
      
      // Filter out -1 (SensorLogger null values)
      points.push({
        lat,
        lon,
        speed: speed !== null && speed >= 0 ? speed : null,
        altitude: altitude !== null && altitude >= -1000 ? altitude : null,
        accuracy: accuracy !== null && accuracy >= 0 ? accuracy : null,
        bearing: bearing !== null && bearing >= 0 ? bearing : null,
        timestamp: timestampMs,
      });
    }

    if (points.length === 0) {
      return json({ error: "No valid GPS points found in Location.csv" }, 400, { "X-Request-Id": requestId });
    }

    // Sort by timestamp
    points.sort((a, b) => a.timestamp - b.timestamp);

    // Filter gaps > 30 seconds
    const filtered: typeof points = [points[0]];
    for (let i = 1; i < points.length; i++) {
      if (points[i].timestamp - points[i - 1].timestamp <= 30000) {
        filtered.push(points[i]);
      }
    }

    const startTime = new Date(filtered[0].timestamp);
    const endTime = new Date(filtered[filtered.length - 1].timestamp);
    const payloadBytes = fileBuffer.length;
    const clientId = randomUUID();

    // Create session
    const session = await db.session.create({
      data: {
        deviceId,
        clientId,
        deviceName,
        startTime,
        endTime,
        pointCount: filtered.length,
        payloadBytes,
        status: "completed",
      },
    });

    // Insert GPS points in batches
    const writeLock = pLimit(1);
    const batchSize = 100;
    for (let i = 0; i < filtered.length; i += batchSize) {
      const batch = filtered.slice(i, i + batchSize);
      await writeLock(async () => {
        for (const p of batch) {
          await (db as any).libsql.execute({
            sql: "INSERT INTO GpsPoint (id, sessionId, lat, lon, speed, altitude, accuracy, timestamp, bearing) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            args: [randomUUID(), session.id, p.lat, p.lon, p.speed, p.altitude, p.accuracy, BigInt(p.timestamp), p.bearing],
          });
        }
      });
    }

    // Create TrafficJob
    await db.trafficJob.create({
      data: { sessionId: session.id, status: "pending" },
    });

    await writeAudit({
      action: "session.import",
      targetId: session.id,
      targetType: "Session",
      actorType: auth.via === "cookie" ? "user" : "system",
      actorId: auth.via === "cookie" ? "owner" : "api",
      sessionId: session.id,
      metadata: { source: "zip", fileName: file.name, pointCount: filtered.length, deviceName },
    });

    inc("ingest_total", "Total ingest requests", 1, "zip");

    logger.info("ZIP import success", {
      requestId,
      sessionId: session.id,
      points: filtered.length,
      deviceId,
      deviceName,
    });

    return json(
      {
        imported: 1,
        sessionId: session.id,
        deviceId,
        deviceName,
        pointCount: filtered.length,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
      },
      200,
      { "X-Request-Id": requestId }
    );
  } catch (err) {
    logger.error("ZIP import error", { requestId, error: err instanceof Error ? err.message : String(err) });
    return json({ error: "Import failed", message: err instanceof Error ? err.message : String(err) }, 500, { "X-Request-Id": requestId });
  }
}
