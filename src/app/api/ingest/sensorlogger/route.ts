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
import { recordIngestAttempt, recordIngestRaw } from "@/lib/ingest-trace"; // DIAG-1: трассировка попыток; v2.10.8: сырой дамп
import { finalizeSession } from "@/lib/session-finalize"; // v2.14.0 (Ф3): shared с воркером-«жнецом»
import pLimit from "p-limit";
import { randomUUID } from "crypto";

const SESSION_GAP_MS = 60_000; // 60с gap = новая сессия
// v2.11.0 (АУДИТ C-14): сериализация корреляции+вставки — без неё параллельные
// батчи одного девайса видят «нет активной сессии» одновременно → дубли recording-сессий.
const ingestWriteLock = pLimit(1);
// v2.11.0 (АУДИТ C-21): deviceId/deviceName из query валидируются (раньше — любая
// длина/символы прямиком в БД и в диагностику)
const DEVICE_ID_RE = /^[A-Za-z0-9_.:\- ]{1,64}$/;
const DEVICE_NAME_RE = /^[^\n\r]{1,128}$/;

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
// v2.10.8 (кейс 01.09 08:40): реальный формат приложения — корневой объект
// {messageId, sessionId, deviceId, payload:[{name:"accelerometer", time, values}]},
// где каждая запись = сенсор, координаты лежат в values location-записи.
// «payload» теперь ищется первым; добавлены readings/sensors/measurements.
// Возвращает null, если подходящего массива не найдено (→ sample-диагностика).
const ARRAY_KEYS = [
  "payload",
  "points",
  "data",
  "records",
  "readings",
  "sensors",
  "measurements",
  "samples",
  "locations",
  "entries",
  "batches",
] as const;

// v2.10.8: именованная запись Sensor Logger: {name:"location", time, values:{…}}.
// values → контейнер location (extractPoint уже понимает latitude/lat/lon/lng
// внутри location/coords/position/gps), остальные поля записи — плоский fallback.
function normalizeItem(item: unknown): RawPoint {
  if (item && typeof item === "object" && !Array.isArray(item)) {
    const r = item as Record<string, unknown>;
    if (typeof r.name === "string" && r.values && typeof r.values === "object" && !Array.isArray(r.values)) {
      return {
        ...(r as RawPoint),
        time: (r.time ?? r.timestamp) as number | string | undefined,
        location: r.values as RawLocation,
      };
    }
  }
  return item as RawPoint;
}

function extractItems(body: unknown): RawPoint[] | null {
  if (Array.isArray(body)) return body.map(normalizeItem);
  if (body && typeof body === "object") {
    const obj = body as Record<string, unknown>;
    for (const key of ARRAY_KEYS) {
      const v = obj[key];
      if (Array.isArray(v)) {
        // явно пустой батч ({"points":[]}) → outcome «empty», не «no_gps»
        if (v.length === 0) return [];
        // batches может быть массивом массивов — flatten один уровень
        if (Array.isArray(v[0])) {
          return (v as unknown[][]).flat().map(normalizeItem);
        }
        return v.map(normalizeItem);
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
        if (Array.isArray(v) && v.length > 0) return v.map(normalizeItem);
      }
    }
    return [body as RawPoint];
  }
  return null;
}

// v2.10.7: образец структуры payload для нераспознанных батчей — показывает,
// под какими ключами лежат данные. Обрезаем до 300 символов, приватные данные
// владельца в его же диагностике — приемлемо; полные координаты не светим.
// v2.10.8: для формата {payload:[{name,time,values}]} показывает ГИСТОГРАММУ
// сенсоров (accelerometer×200, location×1, …) — сразу видно, был ли в батче
// location вообще (кейс 01.09: 10 батчей no_gps — а был ли включён GPS?).
const LOCATION_NAMES = ["location", "gps", "position", "coords", "coordinates", "latitude"];

function describeNamedRecords(items: unknown[], prefix: string): string {
  const hist = new Map<string, number>();
  for (const it of items) {
    const name =
      it && typeof it === "object" && typeof (it as Record<string, unknown>).name === "string"
        ? ((it as Record<string, unknown>).name as string)
        : "(без name)";
    hist.set(name, (hist.get(name) ?? 0) + 1);
  }
  const histStr = [...hist.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([n, c]) => `${n}×${c}`)
    .join(", ");
  const locRecord = items.find((it) => {
    if (!it || typeof it !== "object") return false;
    const r = it as Record<string, unknown>;
    const n = r.name;
    return typeof n === "string" && LOCATION_NAMES.some((ln) => n.toLowerCase().includes(ln));
  });
  const locStr = locRecord
    ? ` · ${JSON.stringify(locRecord).slice(0, 200)}`
    : " · location-записей НЕТ (включите GPS/Location в списке сенсоров приложения)";
  return `${prefix}[${items.length}] сенсоры: ${histStr}${locStr}`;
}

function describePayloadShape(body: unknown): string {
  try {
    const brief = (x: unknown, n: number): string => {
      const s = JSON.stringify(x);
      return s.length > n ? s.slice(0, n) + "…" : s;
    };
    // v2.10.8: находим массив внутри тела (payload/points/…), описываем его
    const findArray = (o: Record<string, unknown>): unknown[] | null => {
      for (const key of ARRAY_KEYS) {
        const v = o[key];
        if (Array.isArray(v)) return v;
      }
      return null;
    };
    if (Array.isArray(body)) {
      if (body.length > 0 && body[0] && typeof body[0] === "object" && "name" in (body[0] as object) && "values" in (body[0] as object)) {
        return describeNamedRecords(body, "массив");
      }
      const first = body[0];
      const keys =
        first && typeof first === "object" ? Object.keys(first as object).join(",") : typeof first;
      return `массив[${body.length}], keys=[${keys}], first=${brief(first, 240)}`;
    }
    if (body && typeof body === "object") {
      const obj = body as Record<string, unknown>;
      const arr = findArray(obj);
      if (arr && arr.length > 0 && arr[0] && typeof arr[0] === "object" && "name" in (arr[0] as object) && "values" in (arr[0] as object)) {
        return describeNamedRecords(arr, "объект, payload-массив");
      }
      const keys = Object.keys(obj).join(",");
      return `объект, keys=[${keys}], ${brief(obj, 240)}`;
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

// v2.11.0 (АУДИТ C-9): финализация + TrafficJob — с v2.14.0 (Ф3) в src/lib/session-finalize.ts
// (общая с воркером-«жнецом» зависших recording-сессий), здесь — только вызов.

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

    // 2. deviceId из query (обязательный) + валидация (C-21)
    const deviceId = url.searchParams.get("deviceId");
    if (!deviceId) {
      return json(
        { error: "deviceId query param required. Example: ?deviceId=iphone-15-pro" },
        400,
        { "X-Request-Id": requestId }
      );
    }
    if (!DEVICE_ID_RE.test(deviceId)) {
      return json(
        { error: "Invalid deviceId: 1-64 chars, letters/digits/dots/dashes/colons/spaces only" },
        400,
        { "X-Request-Id": requestId }
      );
    }
    const deviceNameRaw = url.searchParams.get("deviceName") || "SensorLogger";
    const deviceName = DEVICE_NAME_RE.test(deviceNameRaw) ? deviceNameRaw.slice(0, 128) : "SensorLogger";

    // 3. Parse body — массив (SensorLogger) или объект с массивом точек в известном контейнере
    const body = await request.json().catch(() => null);
    if (!body) {
      return json({ error: "Invalid JSON body" }, 400, { "X-Request-Id": requestId });
    }
    const bodyStr = JSON.stringify(body);
    const payloadBytes = Buffer.byteLength(bodyStr);

    // v2.11.0 (АУДИТ C-14): идемпотентность по messageId — HTTP-ретрай приложения
    // больше не создаёт дубликаты точек. Sensor Logger шлёт уникальный messageId на батч.
    const msgId =
      body && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>).messageId
        : undefined;
    if (msgId != null && (typeof msgId === "number" || typeof msgId === "string")) {
      try {
        const dupe = await libsql.execute({
          sql: `INSERT OR IGNORE INTO IngestMessage (deviceId, messageId, firstSeenAt) VALUES (?, ?, ?)`,
          args: [deviceId, String(msgId), new Date().toISOString()],
        });
        if (dupe.rowsAffected === 0) {
          inc("ingest_duplicate_total", "Duplicate ingest (messageId idempotency)", 1, "sensorlogger");
          return json(
            { ok: true, duplicate: true, message: "Batch already processed (messageId seen)", deviceId, deviceName },
            200,
            { "X-Request-Id": requestId }
          );
        }
      } catch {
        // Таблицы нет (старая БД) — идемпотентность недоступна, продолжаем без неё
      }
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
        bytes: Buffer.byteLength(bodyStr),
        // v2.10.7: образец структуры — в админке L1 видно, что именно прислало приложение
        sample: describePayloadShape(body),
      });
      // v2.10.8: полный дамп для точечного расширения парсера (см. ingest-trace.ts)
      recordIngestRaw(
        { at: new Date().toISOString(), route: "sensorlogger", deviceId, outcome: "empty" },
        bodyStr,
      );
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
        bytes: Buffer.byteLength(bodyStr),
        // v2.10.7: образец структуры батча — видно, ПОД КАКИМИ ключами лежат данные,
        // если парсер не угадал формат приложения (кейс 01.09: 10×28КБ no_gps)
        sample: describePayloadShape(body),
      });
      // v2.10.8: полный дамп нераспознанного батча — для анализа парсером (см. ingest-trace.ts).
      // Гистограмма в sample сразу покажет, есть ли location-записи вообще.
      if (droppedInaccurate === 0) {
        recordIngestRaw(
          { at: new Date().toISOString(), route: "sensorlogger", deviceId, outcome: "no_gps" },
          bodyStr,
        );
      }
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

    // 5. Корреляция сессий + вставка — под writeLock (C-14): параллельные батчи
    // одного девайса больше не создают дубли recording-сессий.
    const outcome = await ingestWriteLock(async () => {
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
        const lastUpdatedAt = new Date(String(row.updatedAt)).getTime();
        if (now - lastUpdatedAt < SESSION_GAP_MS) {
          // Продолжаем ту же сессию
          sessionId = String(row.id);
        } else {
          // Прошло > 60с — финализируем старую, создаём новую
          await finalizeSession(String(row.id));
          sessionId = await createRecordingSession(deviceId, deviceName, points[0].timestampMs);
          isNewSession = true;
        }
      } else {
        sessionId = await createRecordingSession(deviceId, deviceName, points[0].timestampMs);
        isNewSession = true;
      }

      // 6. Вставка GPS-точек — v2.11.0 (C-16): многорядный INSERT чанками по 50
      // вместо построчных (было ~50-100 мс HTTPS-раундтрипа на КАЖДУЮ точку).
      const CH = 50;
      for (let i = 0; i < points.length; i += CH) {
        const chunk = points.slice(i, i + CH);
        const placeholders = chunk.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?)").join(", ");
        const args = chunk.flatMap((p) => [
          randomUUID(), sessionId, p.lat, p.lon, p.speed, p.altitude, p.accuracy, BigInt(p.timestampMs), p.bearing,
        ]);
        await libsql.execute({
          sql: `INSERT INTO GpsPoint (id, sessionId, lat, lon, speed, altitude, accuracy, timestamp, bearing) VALUES ${placeholders}`,
          args: args as never[],
        });
      }

      // 7. Обновляем session: endTime, pointCount, payloadBytes, updatedAt
      const lastTs = points[points.length - 1].timestampMs;
      await libsql.execute({
        sql: `UPDATE Session
              SET endTime = ?, pointCount = pointCount + ?, payloadBytes = payloadBytes + ?, updatedAt = ?
              WHERE id = ?`,
        args: [new Date(lastTs).toISOString(), points.length, payloadBytes, new Date().toISOString(), sessionId],
      });
      return { sessionId, isNewSession };
    });
    const { sessionId, isNewSession } = outcome;

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
    // v2.11.0 (АУДИТ C-30): наружу — только requestId, детали (SQL/пути) — в логах
    return json(
      { error: "Internal Server Error", requestId },
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
