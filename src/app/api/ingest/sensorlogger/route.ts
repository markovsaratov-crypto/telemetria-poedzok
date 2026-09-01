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
import { recordIngestAttempt } from "@/lib/ingest-trace"; // DIAG-1: трассировка попыток
import { randomUUID } from "crypto";

const SESSION_GAP_MS = 60_000; // 60с gap = новая сессия

interface RawLocation {
  latitude?: number;
  longitude?: number;
  lat?: number;
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

interface RawPoint {
  time?: number | string;
  timestamp?: number | string;
  // v2.10.7: альтернативные контейнеры — приложения кладут координаты
  // не только в location (SensorLogger-клоны: coords/position/gps)
  location?: RawLocation;
  coords?: RawLocation;
  position?: RawLocation;
  gps?: RawLocation;
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
  // v2.10.7: контейнер координат — любой из известных (location/coords/position/gps)
  const loc: RawLocation = raw.location ?? raw.coords ?? raw.position ?? raw.gps ?? {};
  const lat = raw.latitude ?? raw.lat ?? loc.latitude ?? loc.lat;
  const lon = raw.longitude ?? raw.lon ?? raw.lng ?? loc.longitude ?? loc.lon ?? loc.lng;
  if (lat == null || lon == null || isNaN(Number(lat)) || isNaN(Number(lon))) return null;
  // Sensor Logger-маркеры «нет GPS-фикса»: lat=-1, lon=-1 (§3.3 методологии) — фильтруем
  if (Number(lat) === -1 && Number(lon) === -1) return null;

  const tsRaw = raw.time ?? raw.timestamp;
  if (tsRaw == null) return null;
  // v2.10.7: ISO-строки («2026-09-01T07:53:26.490Z») раньше давали NaN → Date.now()
  let timestampMs: number;
  if (typeof tsRaw === "string" && tsRaw.length >= 10) {
    const iso = Date.parse(tsRaw);
    timestampMs = isNaN(iso) ? Date.now() : iso;
  } else {
    const ts = Number(tsRaw);
    // нс → мс, мс → мс, с → мс
    timestampMs = ts > 1e15 ? Math.floor(ts / 1e6) : ts > 1e12 ? ts : ts > 1e9 ? ts * 1000 : Date.now();
  }

  const speed = raw.speed ?? loc.speed ?? null;
  const altitude = raw.altitude ?? loc.altitude ?? null;
  const accuracy = raw.horizontalAccuracy ?? raw.accuracy ?? loc.horizontalAccuracy ?? loc.accuracy ?? null;
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

// v2.10.7: извлечение массива точек из тела запроса. Кроме корневого массива и
// {points:[]}, некоторые сборки SensorLogger кладут батч под data/records/samples/
// locations/entries/batches — или сенсоры по типам: {data:{location:[...]}}.
// Возвращает null, если подходящего массива не найдено (→ sample-диагностика).
const ARRAY_KEYS = ["points", "data", "records", "samples", "locations", "entries", "batches"] as const;

function extractItems(body: unknown): RawPoint[] | null {
  if (Array.isArray(body)) return body as RawPoint[];
  if (body && typeof body === "object") {
    const obj = body as Record<string, unknown>;
    for (const key of ARRAY_KEYS) {
      const v = obj[key];
      if (Array.isArray(v)) {
        // явно пустой батч ({"points":[]}) → outcome «empty», не «no_gps»
        if (v.length === 0) return [];
        // batches может быть массивом массивов — flatten один уровень
        if (Array.isArray(v[0])) {
          return (v as unknown[][]).flat() as RawPoint[];
        }
        return v as RawPoint[];
      }
    }
    // {data:{location:[...], accelerometer:[...]}} — сенсоры по типам.
    // Вложенный контейнер часто в ед. числе (location/gps/position/coords),
    // поэтому список шире, чем ARRAY_KEYS верхнего уровня.
    const data = obj.data;
    if (data && typeof data === "object" && !Array.isArray(data)) {
      const nested = data as Record<string, unknown>;
      for (const key of [...ARRAY_KEYS, "location", "gps", "position", "coords"] as const) {
        const v = nested[key];
        if (Array.isArray(v) && v.length > 0) return v as RawPoint[];
      }
    }
    return [body as RawPoint];
  }
  return null;
}

// v2.10.7: образец структуры payload для нераспознанных батчей — показывает,
// под какими ключами лежат данные. Обрезаем до 300 символов, приватные данные
// владельца в его же диагностике — приемлемо; полные координаты не светим.
function describePayloadShape(body: unknown): string {
  try {
    const brief = (x: unknown, n: number): string => {
      const s = JSON.stringify(x);
      return s.length > n ? s.slice(0, n) + "…" : s;
    };
    if (Array.isArray(body)) {
      const first = body[0];
      const keys =
        first && typeof first === "object" ? Object.keys(first as object).join(",") : typeof first;
      return `массив[${body.length}], keys=[${keys}], first=${brief(first, 240)}`;
    }
    if (body && typeof body === "object") {
      const keys = Object.keys(body as object).join(",");
      return `объект, keys=[${keys}], ${brief(body, 240)}`;
    }
    return `${typeof body}: ${brief(body, 120)}`;
  } catch {
    return "не удалось сериализовать";
  }
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

    // 3. Parse body — массив (SensorLogger) или объект с массивом точек в известном контейнере
    const body = await request.json().catch(() => null);
    if (!body) {
      return json({ error: "Invalid JSON body" }, 400, { "X-Request-Id": requestId });
    }
    // v2.10.7: extractItems ищет массив точек в известных контейнерах (points/data/
    // records/samples/locations/entries/batches, {data:{location:[...]}})
    const items = extractItems(body);
    if (!items || items.length === 0) {
      // SensorLogger "Test Push" шлёт пустой/минимальный body — считаем тест успешным
      // DIAG-1: «тихий успех» для приложения — трассируем, чтобы отличить от реальной отправки
      recordIngestAttempt({
        at: new Date().toISOString(), route: "sensorlogger", deviceId,
        outcome: "empty", points: 0, dropped: 0,
        bytes: Buffer.byteLength(JSON.stringify(body ?? null)),
        // v2.10.7: образец структуры — в админке L1 видно, что именно прислало приложение
        sample: describePayloadShape(body),
      });
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
      // Нет GPS-данных в батче, но формат валидный — считаем тестом.
      // DIAG-1: главный источник «приложение отправляет успешно, а поездок нет» —
      // батч приходит без location (или все точки отфильтрованы по accuracy).
      recordIngestAttempt({
        at: new Date().toISOString(), route: "sensorlogger", deviceId,
        outcome: droppedInaccurate > 0 ? "dropped_all" : "no_gps",
        points: 0, dropped: droppedInaccurate,
        bytes: Buffer.byteLength(JSON.stringify(body)),
        // v2.10.7: образец структуры батча — видно, ПОД КАКИМИ ключами лежат данные,
        // если парсер не угадал формат приложения (кейс 01.09: 5×28КБ no_gps)
        sample: describePayloadShape(body),
      });
      return json(
        {
          ok: true,
          test: true,
          message: "No GPS points extracted from batch (missing location data). Push test passed.",
          deviceId,
          deviceName,
          payloadShape: describePayloadShape(body),
        },
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
    recordIngestAttempt({
      at: new Date().toISOString(), route: "sensorlogger", deviceId,
      outcome: "accepted", points: points.length, dropped: droppedInaccurate,
      bytes: payloadBytes,
    });
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
