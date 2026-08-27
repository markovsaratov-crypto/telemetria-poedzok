// POST /api/ingest/sensorlogger — адаптер для SensorLogger HTTP Push (iOS/Android app).
// Документация формата: https://github.com/tszheichoi/awesome-sensor-logger/blob/main/PUSHING.md
//
// Тело запроса (нативный формат SensorLogger):
//   {
//     "messageId": 0,
//     "sessionId": "identifier",      ← ID записи на устройстве
//     "deviceId": "identifier",        ← ID устройства
//     "userId": "identifier" (optional),
//     "payload": [
//       { "name": "location", "time": 1698501145514000000,
//         "values": { "latitude": 51.54, "longitude": 46.0, "speed": 12.5,
//                     "altitude": 80, "bearing": 180, "horizontalAccuracy": 5 } },
//       { "name": "accelerometer", "time": ..., "values": { "x":..., "y":..., "z":... } },
//       ...
//     ]
//   }
//
// Auth: Authorization: Bearer <INGEST_TOKEN>  ИЛИ  ?token=<INGEST_TOKEN>
// Батчи с одним (deviceId, sessionId) = одна сессия в БД.
import { NextRequest } from "next/server";
import { libsql } from "@/lib/db";
import { extractBearer } from "@/lib/auth";
import { env } from "@/lib/env";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import { inc } from "@/lib/metrics";
import { randomUUID } from "crypto";

interface LocationValues {
  latitude?: number;
  longitude?: number;
  speed?: number;
  altitude?: number;
  altitudeAboveMeanSeaLevel?: number;
  bearing?: number;
  heading?: number;
  course?: number;
  horizontalAccuracy?: number;
  verticalAccuracy?: number;
  speedAccuracy?: number;
  bearingAccuracy?: number;
}

interface SensorPayloadItem {
  name?: string;
  time?: number;
  timestamp?: number;
  values?: LocationValues & Record<string, unknown>;
  // Плоский fallback (не стандарт, но перестраховка)
  latitude?: number;
  longitude?: number;
  lat?: number;
  lon?: number;
  lng?: number;
  speed?: number;
  altitude?: number;
  bearing?: number;
  heading?: number;
  course?: number;
  horizontalAccuracy?: number;
  accuracy?: number;
}

interface SensorLoggerBody {
  messageId?: number;
  sessionId?: string;
  deviceId?: string;
  userId?: string;
  payload?: SensorPayloadItem[];
  // Fallback на случай если кто-то шлёт чистый массив
  points?: SensorPayloadItem[];
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

function extractPoint(item: SensorPayloadItem): NormalizedPoint | null {
  // Только location-сенсор несёт GPS-координаты. Пропускаем accelerometer/gyro/etc.
  if (item.name && item.name !== "location") return null;

  const v = item.values || {};
  const lat = item.latitude ?? item.lat ?? v.latitude;
  const lon = item.longitude ?? item.lon ?? v.lng ?? v.longitude;
  if (lat == null || lon == null || isNaN(Number(lat)) || isNaN(Number(lon))) return null;

  const tsRaw = item.time ?? item.timestamp;
  if (tsRaw == null) return null;
  const ts = Number(tsRaw);
  // SensorLogger всегда шлёт time в наносекундах UTC. Но для устойчивости:
  const timestampMs = ts > 1e15 ? Math.floor(ts / 1e6) : ts > 1e12 ? ts : ts > 1e9 ? ts * 1000 : Date.now();

  const speed = item.speed ?? v.speed ?? null;
  const altitude = item.altitude ?? v.altitude ?? v.altitudeAboveMeanSeaLevel ?? null;
  const accuracy = item.horizontalAccuracy ?? item.accuracy ?? v.horizontalAccuracy ?? null;
  const bearing = item.bearing ?? item.heading ?? item.course ?? v.bearing ?? v.heading ?? v.course ?? null;

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

async function createRecordingSession(deviceId: string, deviceName: string, clientId: string, firstTsMs: number): Promise<string> {
  const id = randomUUID();
  const now = new Date().toISOString();
  const startTime = new Date(firstTsMs).toISOString();
  await libsql.execute({
    sql: `INSERT INTO Session (id, deviceId, clientId, deviceName, startTime, endTime, pointCount, payloadBytes, status, createdAt, updatedAt)
          VALUES (?, ?, ?, ?, ?, ?, 0, 0, 'recording', ?, ?)`,
    args: [id, deviceId, clientId, deviceName, startTime, startTime, now, now],
  });
  return id;
}

async function finalizeSession(sessionId: string): Promise<void> {
  const now = new Date().toISOString();
  await libsql.execute({
    sql: `UPDATE Session SET status = 'completed', updatedAt = ? WHERE id = ? AND status = 'recording'`,
    args: [now, sessionId],
  });
  const jobId = randomUUID();
  await libsql.execute({
    sql: `INSERT INTO TrafficJob (id, sessionId, status, priority, attempts, createdAt, updatedAt)
          VALUES (?, ?, 'pending', 0, 0, ?, ?)`,
    args: [jobId, sessionId, now, now],
  }).catch(() => null);
  await libsql.execute({
    sql: `UPDATE Session SET trafficJobId = ?, updatedAt = ? WHERE id = ? AND trafficJobId IS NULL`,
    args: [jobId, now, sessionId],
  }).catch(() => null);
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
    const tokenOk =
      (bearer && bearer === e.INGEST_TOKEN) ||
      (queryToken && queryToken === e.INGEST_TOKEN);
    if (!tokenOk) {
      return json(
        { error: "Unauthorized: invalid or missing INGEST_TOKEN. Use Authorization: Bearer <token> or ?token=<token>" },
        401,
        { "X-Request-Id": requestId }
      );
    }

    // 2. Parse body
    const body = await request.json().catch(() => null) as SensorLoggerBody | SensorPayloadItem[] | null;
    if (!body) {
      return json({ error: "Invalid JSON body" }, 400, { "X-Request-Id": requestId });
    }

    // Нормализуем к единому виду: либо body.payload, либо body.points, либо сам body — массив
    let items: SensorPayloadItem[];
    let slDeviceId: string | undefined;
    let slSessionId: string | undefined;
    let slMessageId: number | undefined;

    if (Array.isArray(body)) {
      // Чистый массив точек (не стандарт SensorLogger, но поддержка)
      items = body;
    } else {
      items = body.payload ?? body.points ?? [];
      slDeviceId = body.deviceId;
      slSessionId = body.sessionId;
      slMessageId = body.messageId;
    }

    if (items.length === 0) {
      // SensorLogger "Test Push" шлёт пустой/минимальный body
      return json(
        { ok: true, test: true, message: "SensorLogger push test passed. Ready to receive GPS data." },
        200,
        { "X-Request-Id": requestId }
      );
    }

    // 3. Нормализация точек (фильтруем только location-сенсор)
    const points = items
      .map(extractPoint)
      .filter((p): p is NormalizedPoint => p !== null);
    if (points.length === 0) {
      // Батч без location-данных (только accelerometer/gyro и т.п.) — отвечаем 200, ничего не пишем
      return json(
        { ok: true, accepted: 0, message: "No location readings in payload (only non-GPS sensors). Nothing to ingest.", deviceId: slDeviceId, sessionId: slSessionId },
        200,
        { "X-Request-Id": requestId }
      );
    }
    points.sort((a, b) => a.timestampMs - b.timestampMs);

    // 4. deviceId: из тела SensorLogger, или из query, или fallback
    const deviceId = slDeviceId || url.searchParams.get("deviceId") || "sensorlogger-unknown";
    const deviceName = url.searchParams.get("deviceName") || "SensorLogger";
    const clientId = slSessionId || randomUUID(); // clientId в нашей схеме = sessionId SensorLogger

    // 5. Корреляция сессий: ищем активную recording-сессию для (deviceId, clientId)
    const recent = await libsql.execute({
      sql: `SELECT id, updatedAt FROM Session
            WHERE deviceId = ? AND clientId = ? AND status = 'recording' AND deletedAt IS NULL
            ORDER BY updatedAt DESC LIMIT 1`,
      args: [deviceId, clientId],
    });

    let sessionId: string;
    let isNewSession = false;

    if (recent.rows.length > 0) {
      const row = recent.rows[0] as Record<string, unknown>;
      sessionId = row.id as string;
    } else {
      sessionId = await createRecordingSession(deviceId, deviceName, clientId, points[0].timestampMs);
      isNewSession = true;
    }

    // 6. Вставка GPS-точек
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
      slDeviceId: deviceId,
      slSessionId: clientId,
      slMessageId,
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

// GET — для проверки "Test Push" в SensorLogger
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const queryToken = url.searchParams.get("token");
  const bearer = extractBearer(request);
  const e = env();
  const tokenOk =
    (bearer && bearer === e.INGEST_TOKEN) ||
    (queryToken && queryToken === e.INGEST_TOKEN);
  if (!tokenOk) {
    return json({ ok: false, error: "Unauthorized" }, 401);
  }
  return json({
    ok: true,
    endpoint: "/api/ingest/sensorlogger",
    method: "POST",
    format: "SensorLogger native: { messageId, sessionId, deviceId, payload: [{ name:'location', time, values:{latitude,longitude,speed,altitude,bearing,horizontalAccuracy} }] }",
    auth: "Authorization: Bearer <INGEST_TOKEN> OR ?token=<INGEST_TOKEN>",
    note: "deviceId is taken from request body. No query params required.",
  });
}
