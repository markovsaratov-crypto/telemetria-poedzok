// POST /api/import/zip — импорт GPS-данных из ZIP архива (SensorLogger format)
import { NextRequest } from "next/server";
import { db, libsql } from "@/lib/db";
import { authorizeRequest } from "@/lib/auth";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import { inc } from "@/lib/metrics";
import { writeAudit } from "@/lib/audit";
import { randomUUID } from "crypto";
import { parseTimestamp } from "@/lib/parse-timestamp"; // v2.11.0 (C-12): ISO-время в CSV
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
    // AUDIT B-20: защита от zip-bomb/DoS — лимиты на размер архива, число записей
    // и суммарный распакованный объём (раньше AdmZip распаковывал всё в память).
    const MAX_ZIP_BYTES = 100 * 1024 * 1024; // 100 МБ — как раньше
    const MAX_ZIP_ENTRIES = 500;
    const MAX_UNCOMPRESSED_BYTES = 512 * 1024 * 1024; // 512 МБ суммарно
    if (fileBuffer.length > MAX_ZIP_BYTES) {
      return json({ error: "ZIP file too large" }, 413, { "X-Request-Id": requestId });
    }
    const zip = new AdmZip(fileBuffer);
    const entries = zip.getEntries();
    if (entries.length > MAX_ZIP_ENTRIES) {
      return json({ error: `Too many entries in ZIP (${entries.length} > ${MAX_ZIP_ENTRIES})` }, 400, { "X-Request-Id": requestId });
    }
    let totalUncompressed = 0;
    for (const entry of entries) {
      totalUncompressed += entry.header.size;
      if (totalUncompressed > MAX_UNCOMPRESSED_BYTES) {
        return json({ error: "ZIP uncompressed content too large (zip-bomb protection)" }, 400, { "X-Request-Id": requestId });
      }
    }

    // Find Location.csv and Metadata.csv
    // v2.18.0 (P1): проверка ФАКТИЧЕСКОГО распакованного размера. Заявленный
    // header.size контролируется отправителем независимо от inflate-потока —
    // zip-бомба с крошечным заявленным размером проходила декомпрессию без
    // ограничений. getData() уже возвращает готовый Buffer — сверяем его длину.
    let locationCsv = "";
    let metadataCsv = "";
    for (const entry of entries) {
      const lower = entry.entryName.toLowerCase();
      if (lower === "location.csv" || (lower.startsWith("location") && lower.endsWith(".csv"))) {
        const data = entry.getData();
        if (data.length > MAX_UNCOMPRESSED_BYTES) {
          return json({ error: "ZIP entry too large after decompression (zip-bomb protection)" }, 400, { "X-Request-Id": requestId });
        }
        locationCsv = data.toString("utf8");
      }
      if (lower === "metadata.csv" || (lower.startsWith("metadata") && lower.endsWith(".csv"))) {
        const data = entry.getData();
        if (data.length > 1024 * 1024) {
          return json({ error: "Metadata.csv too large after decompression" }, 400, { "X-Request-Id": requestId });
        }
        metadataCsv = data.toString("utf8");
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
      // v2.11.0 (АУДИТ C-12): parseTimestamp понимает и ISO-строки, и числа
      // (SensorLogger Location.csv шлёт ISO). NaN больше не роняет импорт 500-й.
      const ts = iTime >= 0 ? parseTimestamp(row[iTime]) : Date.now();
      if (ts == null) continue; // непарсящееся время — пропускаем точку
      const timestampMs = ts;
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

    // Sort. v2.16.0 (B13): «gap-фильтр» УДАЛЁН — раньше он выбрасывал РОВНО
    // ОДНУ точку после каждой паузы >30с (сравнение шло с предыдущей СЫРОЙ
    // точкой, а не с последней принятой): импорт терял реальные точки-возобновления.
    // Разрывы корректно детектируются в метриках (state machine §4.6), а не на входе.
    points.sort((a, b) => a.timestamp - b.timestamp);
    const filtered = points;

    const startTime = new Date(filtered[0].timestamp);
    const endTime = new Date(filtered[filtered.length - 1].timestamp);
    const clientId = randomUUID();

    // v2.16.0 (B12): сессия + точки + джоб — АТОМАРНО в одной транзакции
    // (как в CSV-импорте). Раньше сбой между create-сессии и вставкой чанка
    // оставлял «висячую» сессию без точек. tx.gpsPoint.createMany внутри
    // транзакции теперь чанкует многорядными INSERT (<999 плейсхолдеров).
    const session = await db.$transaction(async (tx: any) => {
      const s = await tx.session.create({
        data: { deviceId, clientId, deviceName, startTime, endTime, pointCount: filtered.length, payloadBytes: fileBuffer.length, status: "completed" },
      });
      await tx.gpsPoint.createMany({
        data: filtered.map((p) => ({
          sessionId: s.id,
          lat: p.lat,
          lon: p.lon,
          speed: p.speed,
          altitude: p.altitude,
          accuracy: p.accuracy,
          bearing: p.bearing,
          timestamp: BigInt(p.timestamp),
        })),
      });
      const job = await tx.trafficJob.create({ data: { sessionId: s.id, status: "pending" } });
      await tx.session.update({ where: { id: s.id }, data: { trafficJobId: job.id } });
      return s;
    });
    await writeAudit({ action: "session.import", targetId: session.id, targetType: "Session", actorType: "user", actorId: "owner", sessionId: session.id, metadata: { source: "zip", fileName: file.name, pointCount: filtered.length, deviceName } });
    inc("ingest_total", "Total ingest requests", 1, "zip");
    logger.info("ZIP import success", { requestId, sessionId: session.id, points: filtered.length, deviceName });

    return json({ imported: 1, sessionId: session.id, deviceId, deviceName, pointCount: filtered.length, startTime: startTime.toISOString(), endTime: endTime.toISOString() }, 200, { "X-Request-Id": requestId });
  } catch (err) {
    logger.error("ZIP import error", { requestId, error: err instanceof Error ? err.message : String(err) });
    // v2.11.0 (АУДИТ C-30): наружу — requestId, детали — в логах
    return json({ error: "Import failed", requestId }, 500, { "X-Request-Id": requestId });
  }
}
