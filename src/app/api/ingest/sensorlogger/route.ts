// POST /api/ingest/sensorlogger — адаптер для SensorLogger HTTP Push (iOS app).
// Принимает нативный формат SensorLogger: JSON-массив сенсорных батчей с вложенной location.
// Auth: Authorization: Bearer <INGEST_TOKEN>  ИЛИ  ?token=<INGEST_TOKEN>
// Query: ?deviceId=<required>&deviceName=<optional>
// Корреляция сессий: батчи с одним deviceId в пределах 60с друг от друга = одна сессия.
import { NextRequest } from "next/server";
import { libsql } from "@/lib/db";
import { extractBearer } from "@/lib/auth";
import { tokenMatches } from "@/lib/token-check"; // AUDIT B-16: timing-safe сравнение
import { env } from "@/lib/env";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import { inc } from "@/lib/metrics";
import { randomUUID } from "crypto";

const SESSION_GAP_MS = 60_000; // 60с gap = новая сессия

interface RawPoint {
  time?: number;
  timestamp?: number;
  location?: {
    latitude?: number;
    longitude?: number;
    speed?: number;
    altitude?: number;
    horizontalAccuracy?: number;
    verticalAccuracy?: number;
    course?: number;
    bearing?: number;
    heading?: number;
  };
  // Плоские fallback-поля
  latitude?: number;
  lat?: number;
  longitude?: number;
  lon?: number;
  lng?: number;
  speed?: number;
  altitude?: number;
  horizontalAccuracy?: number;
  accuracy?: number;
  course?: number;
  bearing?: number;
  heading?: number;
}

interface NormalizedPoint {
  lat: number;
  lon: number;
  speed: number | null;
  altitude: number | null;
  accuracy: number | null;
  bearing: number | null;
  timestampMs: number;
}

function extractPoint(raw: RawPoint): NormalizedPoint | null {
  const loc = raw.location || {};
  const lat = raw.latitude ?? raw.lat ?? loc.latitude;
  const lon = raw.longitude ?? raw.lon ?? raw.lng ?? loc.longitude;
  if (lat == null || lon == null || isNaN(Number(lat)) || isNaN(Number(lon))) return null;

  const tsRaw = raw.time ?? raw.timestamp;
  if (tsRaw == null) return null;
  const ts = Number(tsRaw);
  // нс → мс, мс → мс, с → мс
  const timestampMs = ts > 1e15 ? Math.floor(ts / 1e6) : ts > 1e12 ? ts : ts > 1e9 ? ts * 1000 : Date.now();

  const speed = raw.speed ?? loc.speed ?? null;
  const altitude = raw.altitude ?? loc.altitude ?? null;
  const accuracy = raw.horizontalAccuracy ?? raw.accuracy ?? loc.horizontalAccuracy ?? null;
  const bearing = raw.course ?? raw.bearing ?? raw.heading ?? loc.course ?? loc.bearing ?? loc.heading ?? null;

  return {
    lat: Number(lat),
    lon: Number(lon),
    speed: speed != null && Number(speed) >= 0 ? Number(speed) : null,
    altitude: altitude != null && Number(altitude) >= -1000 ? Number(altitude) : null,
    accuracy: accuracy != null && Number(accuracy) >= 0 ? Number(accuracy) : null,
    bearing: bearing != null && Number(bearing) >= 0 && Number(bearing) <= 360 ? Number(bearing) : null,
    timestampMs,
  };
}

async function createRecordingSession(deviceId: string, deviceName: string, firstTsMs: number): Promise<string> {
  const id = randomUUID();
  const now = new Date().toISOString();
  const startTime = new Date(firstTsMs).toISOString();
  await libsql.execute({
    sql: `INSERT INTO Session (id, deviceId, clientId, deviceName, startTime, endTime, pointCount, payloadBytes, status, createdAt, updatedAt)
          VALUES (?, ?, ?, ?, ?, ?, 0, 0, 'recording', ?, ?)`,
    args: [id, deviceId, randomUUID(), deviceName, startTime, startTime, now, now],
  });
  return id;
}

async function finalizeSession(sessionId: string): Promise<void> {
  const now = new Date().toISOString();
  await libsql.execute({
    sql: `UPDATE Session SET status = 'completed', updatedAt = ? WHERE id = ? AND status = 'recording'`,
    args: [now, sessionId],
  });
  // Создаём TrafficJob для Worker (2ГИС → OSRM → haversine)
  const jobId = randomUUID();
  await libsql.execute({
    sql: `INSERT INTO TrafficJob (id, sessionId, status, priority, attempts, createdAt, updatedAt)
          VALUES (?, ?, 'pending', 0, 0, ?, ?)`,
    args: [jobId, sessionId, now, now],
  }).catch(() => {
    // TrafficJob уже мог быть создан — игнорируем дубль
  });
  await libsql.execute({
    sql: `UPDATE Session SET trafficJobId = ?, updatedAt = ? WHERE id = ? AND trafficJobId IS NULL`,
    args: [jobId, now, sessionId],
  });
  logger.info("Session finalized", { sessionId, trafficJobId: jobId });
}

export async function POST(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  const start = Date.now();
  try {
    // 1. Auth: Bearer header ИЛИ ?token= query param
    const url = new URL(request.url);
    const queryToken = url.searchParams.get("token");
    const bearer = extractBearer(request);
    const e = env();
    // AUDIT B-16: timing-safe сравнение (раньше === — утечка по времени)
    const tokenOk =
      (await tokenMatches(bearer, e.INGEST_TOKEN)) ||
      (await tokenMatches(queryToken, e.INGEST_TOKEN));
    if (!tokenOk) {
      return json(
        { error: "Unauthorized: invalid or missing INGEST_TOKEN. Use Authorization: Bearer <token> or ?token=<token>" },
        401,
        { "X-Request-Id": requestId }
      );
    }

    // 2. deviceId из query (обязательный)
    const deviceId = url.searchParams.get("deviceId");
    if (!deviceId) {
      return json(
        { error: "deviceId query param required. Example: ?deviceId=iphone-15-pro" },
        400,
        { "X-Request-Id": requestId }
      );
    }
    const deviceName = url.searchParams.get("deviceName") || "SensorLogger";

    // 3. Parse body — массив (SensorLogger) или объект с points (наш формат)
    const body = await request.json().catch(() => null);
    if (!body) {
      return json({ error: "Invalid JSON body" }, 400, { "X-Request-Id": requestId });
    }
    const items: RawPoint[] = Array.isArray(body)
      ? body
      : Array.isArray((body as { points?: unknown[] }).points)
        ? (body as { points: RawPoint[] }).points
        : [body as RawPoint];
    if (items.length === 0) {
      // SensorLogger "Test Push" шлёт пустой/минимальный body — считаем тест успешным
      return json({ ok: true, test: true, message: "SensorLogger push test passed. Ready to receive GPS data.", deviceId, deviceName }, 200, { "X-Request-Id": requestId });
    }

    // 4. Нормализация точек
    // AUDIT B-5: точки с accuracy > 100 м отбрасываются на входе — координаты
    // и скорости недостоверны (раньше мусор с accuracy 400–585 м писался в БД
    // и портил дистанцию/метрики).
    const MAX_POINT_ACCURACY_M = 100;
    let droppedInaccurate = 0;
    const points = items
      .map(extractPoint)
      .filter((p): p is NormalizedPoint => {
        if (p === null) return false;
        if (p.accuracy != null && p.accuracy > MAX_POINT_ACCURACY_M) {
          droppedInaccurate++;
          return false;
        }
        return true;
      });
    if (droppedInaccurate > 0) {
      logger.warn("SensorLogger ingest: dropped inaccurate points", {
        requestId, deviceId, dropped: droppedInaccurate, received: items.length,
      });
    }
    if (points.length === 0) {
      // Нет GPS-данных в батче, но формат валидный — считаем тестом
      return json(
        { ok: true, test: true, message: "No GPS points extracted from batch (missing location data). Push test passed.", deviceId, deviceName },
        200,
        { "X-Request-Id": requestId }
      );
    }
    points.sort((a, b) => a.timestampMs - b.timestampMs);

    // 5. Корреляция сессий: ищем активную recording-сессию для этого deviceId.
    // Gap-проверка по updatedAt (реальное время последнего батча), НЕ по endTime
    // (endTime — это время последней точки из данных, может быть в прошлом при replay/тестах).
    const now = Date.now();
    const recent = await libsql.execute({
      sql: `SELECT id, updatedAt FROM Session
            WHERE deviceId = ? AND status = 'recording' AND deletedAt IS NULL
            ORDER BY updatedAt DESC LIMIT 1`,
      args: [deviceId],
    });

    let sessionId: string;
    let isNewSession = false;

    if (recent.rows.length > 0) {
      const row = recent.rows[0] as Record<string, unknown>;
      const lastUpdatedAt = new Date(row.updatedAt as string).getTime();
      if (now - lastUpdatedAt < SESSION_GAP_MS) {
        // Продолжаем ту же сессию
        sessionId = row.id as string;
      } else {
        // Прошло > 60с — финализируем старую, создаём новую
        await finalizeSession(row.id as string);
        sessionId = await createRecordingSession(deviceId, deviceName, points[0].timestampMs);
        isNewSession = true;
      }
    } else {
      sessionId = await createRecordingSession(deviceId, deviceName, points[0].timestampMs);
      isNewSession = true;
    }

    // 6. Вставка GPS-точек (batch по 50)
    const payloadBytes = Buffer.byteLength(JSON.stringify(body));
    for (let i = 0; i < points.length; i += 50) {
      const batch = points.slice(i, i + 50);
      for (const p of batch) {
        await libsql.execute({
          sql: `INSERT INTO GpsPoint (id, sessionId, lat, lon, speed, altitude, accuracy, timestamp, bearing)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [randomUUID(), sessionId, p.lat, p.lon, p.speed, p.altitude, p.accuracy, BigInt(p.timestampMs), p.bearing],
        });
      }
    }

    // 7. Обновляем session: endTime, pointCount, payloadBytes, updatedAt
    const lastTs = points[points.length - 1].timestampMs;
    await libsql.execute({
      sql: `UPDATE Session
            SET endTime = ?, pointCount = pointCount + ?, payloadBytes = payloadBytes + ?, updatedAt = ?
            WHERE id = ?`,
      args: [new Date(lastTs).toISOString(), points.length, payloadBytes, new Date().toISOString(), sessionId],
    });

    inc("ingest_total", "Total ingest requests", 1, "sensorlogger");
    logger.info("SensorLogger ingest", {
      requestId,
      sessionId,
      deviceId,
      deviceName,
      points: points.length,
      newSession: isNewSession,
      durationMs: Date.now() - start,
    });

    return json(
      {
        ok: true,
        sessionId,
        pointsAccepted: points.length,
        newSession: isNewSession,
        deviceId,
        deviceName,
        status: "recording",
      },
      isNewSession ? 201 : 200,
      { "X-Request-Id": requestId }
    );
  } catch (err) {
    logger.error("SensorLogger ingest error", {
      requestId,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - start,
    });
    return json(
      { error: "Internal Server Error", message: err instanceof Error ? err.message : String(err) },
      500,
      { "X-Request-Id": requestId }
    );
  }
}

// GET — для проверки "Test Push" в SensorLogger (если он шлёт GET на тест)
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const queryToken = url.searchParams.get("token");
  const bearer = extractBearer(request);
  const e = env();
  // AUDIT B-16: timing-safe сравнение
  const tokenOk =
    (await tokenMatches(bearer, e.INGEST_TOKEN)) ||
    (await tokenMatches(queryToken, e.INGEST_TOKEN));
  if (!tokenOk) {
    return json({ ok: false, error: "Unauthorized" }, 401);
  }
  return json({
    ok: true,
    endpoint: "/api/ingest/sensorlogger",
    method: "POST",
    format: "JSON array of { time, location: { latitude, longitude, speed, altitude, horizontalAccuracy, course } }",
    auth: "Authorization: Bearer <INGEST_TOKEN> OR ?token=<INGEST_TOKEN>",
    requiredParams: ["deviceId"],
    optionalParams: ["deviceName"],
  });
}
