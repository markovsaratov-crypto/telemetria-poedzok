// POST /api/import/zip — импорт GPS-данных из ZIP архива (SensorLogger format)
import { NextRequest } from "next/server";
import { db, isD1QuotaError, libsql } from "@/lib/db";
import { authorizeRequest } from "@/lib/auth";
import { dataScopeFor } from "@/lib/scope";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import { inc } from "@/lib/metrics";
import { writeAudit } from "@/lib/audit";
import { randomUUID } from "crypto";
import { parseTimestamp } from "@/lib/parse-timestamp"; // v2.11.0 (C-12): ISO-время в CSV
import { parseCsvRecords } from "@/lib/csv-records"; // v2.38.2 (ревью F49): RFC-4180-парсер — кавычки, ""-экранирование, разделители внутри кавычек
import { MAX_TRUSTED_ACCURACY_M } from "@/lib/kpi"; // v2.38.2 (ревью F45): единый порог точности точек (100 м)
import { z } from "zod"; // v2.38.2 (ревью F45): валидация deviceId/deviceName из Metadata.csv
import AdmZip from "adm-zip";
import { assignTripOnSessionFinalize } from "@/lib/trip-grouping"; // v2.26.0 (ТЗ §7): поездки после импорта

// v2.38.2 (ревью F49): наивный parseCSV (split(sep) без кавычек) заменён
// общим RFC-4180-парсером csv-records.ts (паритет с CSV-импортом): запятые в
// device name / кавычках больше не сдвигают колонки.

// v2.38.2 (ревью F45): deviceId/deviceName из Metadata.csv валидируются
// (раньше — первая строка CSV любой длины/символов прямиком в БД и UI).
// Паттерны — паритет с инжестом: DEVICE_ID_RE/DEVICE_NAME_RE в
// sensorlogger-роуте и zIngestBody (deviceId ≤64, deviceName ≤128).
const DEVICE_ID_RE = /^[A-Za-z0-9_.:\- ]{1,64}$/;
const zZipImportMeta = z.object({
  deviceId: z.string().regex(DEVICE_ID_RE, "deviceId must be 1-64 chars of [A-Za-z0-9_.:- ] and space"),
  deviceName: z.string().regex(/^[^\n\r]{1,128}$/, "deviceName must be 1-128 chars without line breaks"),
});

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
      const meta = parseCsvRecords(metadataCsv);
      if (meta.headers.length > 0 && meta.rows.length > 0) {
        const dnIdx = findCol(meta.headers, ["device name", "device_name", "devicename"]);
        const diIdx = findCol(meta.headers, ["device id", "device_id", "deviceid"]);
        if (dnIdx >= 0) deviceName = meta.rows[0][dnIdx] || deviceName;
        if (diIdx >= 0) deviceId = meta.rows[0][diIdx] || deviceId;
      }
    }
    // v2.38.2 (ревью F45): zod-валидация значений из Metadata.csv (дефолты
    // "zip-…"/"ZIP Import" проходят всегда; мусор из файла — честный 400)
    const metaCheck = zZipImportMeta.safeParse({ deviceId, deviceName });
    if (!metaCheck.success) {
      return json(
        { error: "Invalid deviceId/deviceName in Metadata.csv", details: metaCheck.error.flatten().fieldErrors },
        400,
        { "X-Request-Id": requestId }
      );
    }

    // Parse Location.csv
    const csv = parseCsvRecords(locationCsv);
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
    // v2.38.2 (ревью F45): фильтры паритета с инжестом (sensorlogger/канонич.):
    // диапазон координат ±90/±180 (как CSV-импорт, MI-7) и accuracy ≤100 м
    // (AUDIT B-5, MAX_TRUSTED_ACCURACY_M) — мусорные координаты и точки
    // точностью 400–585 м больше не пишутся в БД; счётчик — в ответ.
    let droppedInaccurate = 0;
    const points: { lat: number; lon: number; speed: number | null; altitude: number | null; accuracy: number | null; bearing: number | null; timestamp: number }[] = [];
    for (const row of csv.rows) {
      const lat = Number(row[iLat]);
      const lon = Number(row[iLon]);
      if (isNaN(lat) || isNaN(lon)) continue;
      if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;
      // v2.11.0 (АУДИТ C-12): parseTimestamp понимает и ISO-строки, и числа
      // (SensorLogger Location.csv шлёт ISO). NaN больше не роняет импорт 500-й.
      // v2.38.2: рваная строка короче заголовка (нет ячейки) → skip, не 500
      const ts = iTime >= 0 ? (row[iTime] != null ? parseTimestamp(row[iTime]) : null) : Date.now();
      if (ts == null) continue; // непарсящееся время — пропускаем точку
      const timestampMs = ts;
      const speed = iSpeed >= 0 ? Number(row[iSpeed]) : null;
      const altitude = iAlt >= 0 ? Number(row[iAlt]) : null;
      const accuracy = iAcc >= 0 ? Number(row[iAcc]) : null;
      // v2.38.2 (ревью F45): точка с accuracy > 100 м отбрасывается (B-5)
      if (accuracy !== null && accuracy > MAX_TRUSTED_ACCURACY_M) {
        droppedInaccurate++;
        continue;
      }
      const bearing = iBearing >= 0 ? Number(row[iBearing]) : null;
      points.push({
        lat, lon,
        speed: speed !== null && speed >= 0 ? speed : null,
        altitude: altitude !== null && altitude >= -1000 ? altitude : null,
        accuracy: accuracy !== null && accuracy >= 0 ? accuracy : null,
        // v2.38.2 (ревью F45): bearing ограничен [0, 360] — паритет с
        // sensorlogger/zIngestBody (раньше >360 писался в БД как есть)
        bearing: bearing !== null && bearing >= 0 && bearing <= 360 ? bearing : null,
        timestamp: timestampMs,
      });
    }

    if (points.length === 0) {
      return json({ error: "No valid GPS points found" }, 400, { "X-Request-Id": requestId });
    }
    if (droppedInaccurate > 0) {
      logger.warn("ZIP import: dropped inaccurate points", {
        requestId, dropped: droppedInaccurate, received: csv.rows.length,
      });
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
    // оставлял «висячую» сессию без точек.
    // v2.40.2 (инцидент 18.09): финальный `UPDATE Session SET trafficJobId…`
    // УДАЛЁН — транзакция теперь ЧИСТЫЕ INSERT'ы: id джоба генерируется ДО
    // сессии и пишется в её строку сразу. Причина: UPDATE на D1 читает строки
    // (поиск по id), и при исчерпанной дневной квоте чтений free tier весь
    // импорт падал «Import failed» на последнем стейтменте, хотя сам батч
    // INSERT'ов (rowsRead = 0) квотой не ограничен. Атомарность не изменилась:
    // /batch шлюза — одна D1-транзакция на чанк, все стейтменты в одном чанке.
    // v2.19.0: tx — честный DbTx (выводится сигнатурой $transaction; было `: any`)
    // v2.23.0: изоляция данных — импорт привязывается к импортёру (role=user);
    // владелец (userId null) — «хозяйские» данные, как раньше
    const importerScope = dataScopeFor(auth);
    const importerUserId = importerScope.mode === "own" ? importerScope.userId : null;
    const trafficJobId = randomUUID();
    const session = await db.$transaction(async (tx) => {
      const s = await tx.session.create({
        data: { deviceId, clientId, deviceName, startTime, endTime, pointCount: filtered.length, payloadBytes: fileBuffer.length, status: "completed", trafficJobId, ...(importerUserId ? { userId: importerUserId } : {}) },
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
      const job = await tx.trafficJob.create({ data: { id: trafficJobId, sessionId: s.id, status: "pending" } });
      // v2.19.0: id из TxModelApi — unknown → честный string (эхо возвращает наш trafficJobId)
      return { s, job };
    });
    // v2.19.0: noImplicitAny — id транзакционного результата unknown → String()
    const sessionId = String(session.s.id);
    // v2.26.0 (ТЗ §7): импорт создаёт completed-запись — назначаем поездки
    // устройства (канонический пересчёт затронутой цепочки; non-fatal)
    await assignTripOnSessionFinalize(sessionId);
    // v2.40.2: аудит — non-fatal: INSERT не зависит от квоты чтений, но любой
    // его сбой больше НЕ отдаёт 500 после УЖЕ закоммиченного импорта (раньше
    // ответ «Import failed» при записанных данных провоцировал повторную
    // загрузку и путаницу с дубликатами).
    await writeAudit({ action: "session.import", targetId: sessionId, targetType: "Session", actorType: "user", actorId: "owner", sessionId, metadata: { source: "zip", fileName: file.name, pointCount: filtered.length, deviceName } }).catch((auditErr) => {
      logger.warn("ZIP import: audit write failed (non-fatal, import already committed)", { requestId, sessionId, error: auditErr instanceof Error ? auditErr.message : String(auditErr) });
    });
    inc("ingest_total", "Total ingest requests", 1, "zip");
    logger.info("ZIP import success", { requestId, sessionId, points: filtered.length, deviceName });

    return json(
      { imported: 1, sessionId: session.s.id, deviceId, deviceName, pointCount: filtered.length, dropped: { inaccurate: droppedInaccurate }, startTime: startTime.toISOString(), endTime: endTime.toISOString() },
      200,
      { "X-Request-Id": requestId }
    );
  } catch (err) {
    // v2.40.2: дневная квота D1 (free tier) — честный 429 вместо 500: клиент
    // понимает, что это временно (сброс в 00:00 UTC), и не ретраит бесполезно.
    if (isD1QuotaError(err)) {
      logger.warn("ZIP import blocked by D1 daily quota", { requestId, error: err instanceof Error ? err.message : String(err) });
      return json(
        { error: "Дневная квота D1 исчерпана — чтения заблокированы до 00:00 UTC. Импорт попробуйте после сброса или сообщите владельцу (upgrade D1).", code: "d1_quota_exhausted", requestId },
        429,
        { "X-Request-Id": requestId, "Retry-After": String(secondsUntilUtcMidnight()) }
      );
    }
    logger.error("ZIP import error", { requestId, error: err instanceof Error ? err.message : String(err) });
    // v2.11.0 (АУДИТ C-30): наружу — requestId, детали — в логах
    return json({ error: "Import failed", requestId }, 500, { "X-Request-Id": requestId });
  }
}

// v2.40.2: секунды до полуночи UTC — для Retry-After при 429 по квоте D1
function secondsUntilUtcMidnight(): number {
  const now = new Date();
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0);
  return Math.max(60, Math.round((midnight - now.getTime()) / 1000));
}
