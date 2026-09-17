// POST /api/ingest/sensorlogger — адаптер для SensorLogger HTTP Push (iOS app).
// Принимает нативный формат SensorLogger: JSON-массив сенсорных батчей с вложенной location.
// Auth: Authorization: Bearer <INGEST_TOKEN>  ИЛИ  ?token=<INGEST_TOKEN>
// v2.23.0: ЛИЧНЫЙ инжест-токен зарегистрированного пользователя — сессии
// привязываются к его userId (изоляция данных): личный Push URL выдаётся на
// вкладке «Поездки» после регистрации.
// v2.38.1 (ревью F11): в query-string Push URL ходит ПРОИЗВОДНЫЙ it_-токен
// (HMAC от apiKey), а не сам apiKey; сырой apiKey — только Bearer-заголовок.
// Query: ?deviceId=<required>&deviceName=<optional>
// Корреляция сессий: батчи с одним deviceId в пределах 60с друг от друга = одна сессия.
import { NextRequest } from "next/server";
import { libsql, multiRowInsertChunk } from "@/lib/db";
import { payloadLimitBytes, isPayloadTooLarge } from "@/lib/payload-limit"; // v2.38.1 (ревью F20)
// v2.38.1 (ревью F11): extractBearer + resolveIngestToken — единая проверка инжест-токенов
import { extractBearer, resolveIngestToken } from "@/lib/auth";
import { env } from "@/lib/env";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import { inc } from "@/lib/metrics";
import { recordIngestAttempt, recordIngestRaw } from "@/lib/ingest-trace"; // DIAG-1: трассировка попыток; v2.10.8: сырой дамп
import { recordIngestOutcome } from "@/lib/alerts"; // v2.38.2 · F40: исходы канала в правило ingest_error_rate (§14.4)
import { trackLatency } from "@/lib/latency"; // v2.38.2 · F40: замер api_latency_p95
import { finalizeSession } from "@/lib/session-finalize"; // v2.14.0 (Ф3): shared с воркером-«жнецом»
import { joinNewSessionToTrip, extendTripOnPoints } from "@/lib/trip-grouping"; // v2.26.0 (ТЗ §7): живое вливание записи в поездку
import { parseTimestamp } from "@/lib/parse-timestamp"; // v2.16.0 (D-6): единый парсер времени
import pLimit from "p-limit";
import { randomUUID } from "crypto";

// v2.26.0 (ТЗ §12): тишина пуша = граница ЗАПИСИ — из env (было хардкодом
// 60_000). Транспортный уровень не меняется: быстрая финализация записей
// сохраняется; ПОЕЗДКИ режутся только порогом TRIP_SPLIT_SEC (trip-grouping.ts).
const SESSION_GAP_MS = () => env().SESSION_GAP_MS;
// v2.16.0 (R7): окно правдоподобия времени точки (±24 ч от серверного now):
// мусорные/будущие/доисторические таймстемпы не должны попадать в БД и метрики
const TS_PLAUSIBILITY_MS = 24 * 60 * 60 * 1000;
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
  // v2.16.0 (R7): диапазоны координат (±90/±180) — мусор не попадает в БД и метрики
  if (Math.abs(Number(lat)) > 90 || Math.abs(Number(lon)) > 180) return null;
  // Sensor Logger-маркеры «нет GPS-фикса»: lat=-1, lon=-1 (§3.3 методологии) — фильтруем
  if (Number(lat) === -1 && Number(lon) === -1) return null;

  const tsRaw = raw.time ?? raw.timestamp;
  if (tsRaw == null) return null;
  // v2.16.0 (D-6+R7): единый парсер parse-timestamp (нс/мс/сек/ISO) вместо
  // локальной копии с фолбэком Date.now() — фальшивое «сейчас» больше НЕ
  // подставляется: непарсящееся/неправдоподобное (±24ч) время → точка отброшена
  const timestampMs = parseTimestamp(String(tsRaw));
  if (timestampMs == null) return null;
  if (Math.abs(Date.now() - timestampMs) > TS_PLAUSIBILITY_MS) return null;

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

// v2.23.0: userId — привязка сессии к владельцу инжест-канала (null = владелец сервера)
// v2.26.0 (ТЗ §7 «поздние данные»): новая запись сразу вливается в существующую
// поездку устройства, если её первая точка < TRIP_SPLIT_SEC от последней точки
// поездки (решение ДО вставки точек, под тем же writeLock). Полный пересчёт
// состава выполнит финализация; здесь — навигационное tripId + живой span.
// v2.35.0: вливание ПОЛНОГО состава (sessionIds/sessionCount/паузы) — карточка
// «Поездок» сразу показывает «2 записи» и живые статы всего потока.
async function createRecordingSession(deviceId: string, deviceName: string, firstTsMs: number, userId: string | null): Promise<string> {
  const id = randomUUID();
  const now = new Date().toISOString();
  const startTime = new Date(firstTsMs).toISOString();
  await libsql.execute({
    sql: `INSERT INTO Session (id, deviceId, clientId, deviceName, startTime, endTime, pointCount, payloadBytes, status, createdAt, updatedAt${userId ? ", userId" : ""})
          VALUES (?, ?, ?, ?, ?, ?, 0, 0, 'recording', ?, ?${userId ? ", ?" : ""})`,
    args: userId
      ? [id, deviceId, randomUUID(), deviceName, startTime, startTime, now, now, userId]
      : [id, deviceId, randomUUID(), deviceName, startTime, startTime, now, now],
  });
  const tripId = await joinNewSessionToTrip(deviceId, id, firstTsMs);
  if (tripId) {
    await libsql
      .execute({ sql: `UPDATE Session SET tripId = ? WHERE id = ?`, args: [tripId, id] })
      .catch(() => null);
  }
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
    // v2.38.1 (ревью F11): единая проверка (auth.ts, timing-safe — AUDIT B-16):
    // глобальный INGEST_TOKEN (Bearer/?token=, канал владельца) / производный
    // it_-токен (Bearer/?token=, SensorLogger Push URL) / сырой per-user apiKey
    // — ТОЛЬКО Bearer-заголовок. Раньше сырой apiKey принимался из ?token= и
    // утекал в access-логи CDN/Render. Ротация apiKey автоматически ротирует
    // it_-токен (HMAC от apiKey). Глобальный INGEST_TOKEN остаётся каналом
    // владельца (userId IS NULL).
    const ingestAuth = await resolveIngestToken(bearer, queryToken);
    const ingestUserId = ingestAuth.ok ? ingestAuth.userId : null;
    if (!ingestAuth.ok) {
      // v2.38.2 · F40: по образцу canonical-роута — 401 НЕ полнит знаменатель
      // ingest_error_rate (только счётчик ingest_unauthorized_total в гейте)
      return json(
        { error: `Unauthorized: ${ingestAuth.reason}` },
        401,
        { "X-Request-Id": requestId }
      );
    }

    // 2. deviceId из query (обязательный) + валидация (C-21)
    const deviceId = url.searchParams.get("deviceId");
    if (!deviceId) {
      recordIngestOutcome(false); // v2.38.2 · F40: 400 валидации зажигает ingest_error_rate
      return json(
        { error: "deviceId query param required. Example: ?deviceId=iphone-15-pro" },
        400,
        { "X-Request-Id": requestId }
      );
    }
    if (!DEVICE_ID_RE.test(deviceId)) {
      recordIngestOutcome(false); // v2.38.2 · F40: 400 валидации зажигает ingest_error_rate
      return json(
        { error: "Invalid deviceId: 1-64 chars, letters/digits/dots/dashes/colons/spaces only" },
        400,
        { "X-Request-Id": requestId }
      );
    }
    const deviceNameRaw = url.searchParams.get("deviceName") || "SensorLogger";
    const deviceName = DEVICE_NAME_RE.test(deviceNameRaw) ? deviceNameRaw.slice(0, 128) : "SensorLogger";

    // 3. Parse body — массив (SensorLogger) или объект с массивом точек в известном контейнере
    // v2.38.1 (ревью F20): РЕАЛЬНАЯ проверка размера тела — ПОСЛЕ чтения, ДО
    // json.parse. Прежняя схема полагалась на Content-Length в proxy —
    // Transfer-Encoding: chunked обходил гард, и request.json() парсил в память
    // тело любого размера (один запрос на сотни МБ → OOM инстанса 512 МБ).
    const rawBody = await request.text().catch(() => "");
    const payloadBytes = Buffer.byteLength(rawBody);
    if (isPayloadTooLarge(payloadBytes)) {
      recordIngestOutcome(false); // v2.38.2 · F40: 413 участвует в ingest_error_rate (как в canonical-роуте)
      return json({ error: "Payload too large", limit: payloadLimitBytes() }, 413, { "X-Request-Id": requestId });
    }
    // v2.38.1 (F20): диагностические дампы пишут СЫРОЕ тело (точнее
    // ресериализации распарсенного объекта), payloadBytes — истинные байты.
    const bodyStr = rawBody;
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      body = null;
    }
    if (!body) {
      recordIngestOutcome(false); // v2.38.2 · F40: 400 невалидного JSON зажигает ingest_error_rate
      return json({ error: "Invalid JSON body" }, 400, { "X-Request-Id": requestId });
    }

    // v2.11.0 (АУДИТ C-14): идемпотентность по messageId — HTTP-ретрай приложения
    // больше не создаёт дубликаты точек. Sensor Logger шлёт уникальный messageId на батч.
    // v2.16.0 (R2): проверка — только ЧТЕНИЕ (быстрая отдача дубликата), сама запись
    // IngestMessage перенесена ПОСЛЕ успешной вставки точек ВНУТРИ writeLock — раньше
    // строка писалась ДО точек: сбой вставки точек → ретрай батча видел «уже
    // обработано» → батч ТЕРЯЛСЯ навсегда при ответе «duplicate: true».
    const msgId =
      body && typeof body === "object" && !Array.isArray(body)
        ? (body as Record<string, unknown>).messageId
        : undefined;
    let duplicate = false;
    if (msgId != null && (typeof msgId === "number" || typeof msgId === "string")) {
      try {
        const seen = await libsql.execute({
          sql: `SELECT 1 FROM IngestMessage WHERE deviceId = ? AND messageId = ? LIMIT 1`,
          args: [deviceId, String(msgId)],
        });
        if (seen.rows.length > 0) duplicate = true;
      } catch {
        // Таблицы нет (старая БД) — идемпотентность недоступна, продолжаем без неё
      }
    }
    if (duplicate) {
      // v2.38.2 · F40: дубль — успешный исход для ingest_error_rate + трейс
      // (как в canonical-роуте): раньше этот return-путь был невидим для алерта
      // и не попадал в ingest-трейс админки. Счётчик ingest_duplicate_total
      // (scope="sensorlogger") уже существовал — сохранён.
      inc("ingest_duplicate_total", "Duplicate ingest (messageId idempotency)", 1, "sensorlogger");
      recordIngestOutcome(true);
      recordIngestAttempt({
        at: new Date().toISOString(), route: "sensorlogger", deviceId,
        outcome: "duplicate", points: 0, dropped: 0, bytes: null,
      });
      trackLatency(request);
      return json(
        { ok: true, duplicate: true, message: "Batch already processed (messageId seen)", deviceId, deviceName },
        200,
        { "X-Request-Id": requestId }
      );
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
      // v2.38.2 · F40: Test Push — успешный 2xx исход (виден в знаменателе rate)
      recordIngestOutcome(true);
      trackLatency(request);
      return json({ ok: true, test: true, message: "SensorLogger push test passed. Ready to receive GPS data.", deviceId, deviceName }, 200, { "X-Request-Id": requestId });
    }

    // v2.38.1 (ревью F20): жёсткий потолок числа записей батча — компактный JSON
    // может нести десятки тысяч точек в рамках 256 КБ; обработка такого батча
    // (сортировка + вставка + trip-логика под writeLock) блокирует event-loop
    // и сериализует инжест остальных устройств. Сверху — 5000 записей.
    const MAX_BATCH_ITEMS = 5000;
    if (items.length > MAX_BATCH_ITEMS) {
      recordIngestAttempt({
        at: new Date().toISOString(), route: "sensorlogger", deviceId,
        outcome: "invalid", points: items.length, dropped: 0,
        bytes: payloadBytes,
      });
      recordIngestOutcome(false); // v2.38.2 · F40: 413 валидации участвует в ingest_error_rate
      return json(
        { error: "Too many points in batch", limit: MAX_BATCH_ITEMS, received: items.length },
        413,
        { "X-Request-Id": requestId }
      );
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
      // v2.38.2 · F40: валидный батч без GPS — 2xx успех для rate (как HTTP-исход)
      recordIngestOutcome(true);
      trackLatency(request);
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
    // v2.16.0 (R4): гэп считается по GPS-времени (endTime сессии vs первая точка
    // батча), а НЕ по серверному wall-clock (Session.updatedAt) — 61-секундный
    // сетевой затык или офлайн-буфер больше НЕ режут непрерывную поездку на куски.
    // v2.16.0 (R11): endTime/startTime — монотонные (MAX/MIN), поздний
    // не-по-порядку батч не двигает границы записи назад.
    const outcome = await ingestWriteLock(async () => {
      // v2.29.0 (MI-6 кодревью): ПОВТОРНАЯ проверка messageId ВНУТРИ writeLock.
      // Быстрая проверка снаружи (выше) — read-only; два ПАРАЛЛЕЛЬНЫХ ретрая
      // одного батча оба проходили её (строки ledger ещё нет), оба входили
      // в lock друг за другом и задваивали точки. Здесь — уже сериализовано:
      // первый вставил ledger-строку, второй видит её и тихо отдаёт duplicate.
      if (msgId != null && (typeof msgId === "number" || typeof msgId === "string")) {
        try {
          const seenAgain = await libsql.execute({
            sql: `SELECT 1 FROM IngestMessage WHERE deviceId = ? AND messageId = ? LIMIT 1`,
            args: [deviceId, String(msgId)],
          });
          if (seenAgain.rows.length > 0) {
            return { sessionId: null, isNewSession: false, duplicate: true };
          }
        } catch {
          // таблицы нет (старая БД) — продолжаем без идемпотентности
        }
      }
      const now = Date.now();
      // v2.23.0: корреляция ТОЛЬКО в рамках владельца канала (userId) — батчи
      // двух пользователей с одинаковым deviceId не склеиваются в общую сессию
      const recent = await libsql.execute({
        sql: `SELECT id, startTime, endTime, updatedAt FROM Session
              WHERE deviceId = ? AND status = 'recording' AND deletedAt IS NULL
              ${ingestUserId ? "AND userId = ?" : "AND userId IS NULL"}
              ORDER BY updatedAt DESC LIMIT 1`,
        args: ingestUserId ? [deviceId, ingestUserId] : [deviceId],
      });

      let sessionId: string;
      let isNewSession = false;
      let sessionStartMs = NaN;
      let sessionEndMs = NaN;

      if (recent.rows.length > 0) {
        const row = recent.rows[0] as Record<string, unknown>;
        sessionStartMs = new Date(String(row.startTime)).getTime();
        sessionEndMs = row.endTime != null ? new Date(String(row.endTime)).getTime() : NaN;
        const firstBatchTs = points[0].timestampMs;
        // нет endTime (пустая запись) → fallback на старую семантику wall-clock
        const gapMs = Number.isFinite(sessionEndMs)
          ? firstBatchTs - sessionEndMs
          : now - new Date(String(row.updatedAt)).getTime();
        if (gapMs < SESSION_GAP_MS()) {
          // Продолжаем ту же сессию (в т.ч. поздние батчи с отрицательным гэпом —
          // они хронологически принадлежат этой записи)
          sessionId = String(row.id);
        } else {
          // Гэп > 60с ПО GPS-ВРЕМЕНИ — финализируем старую, создаём новую.
          // v2.16.0 (QA-фикс): границы СТАРОЙ сессии не должны примешиваться
          // к UPDATE новой (раньше min/max смешивал startTime/endTime предыдущей
          // записи с точками новой — startTime новой уезжал назад).
          await finalizeSession(String(row.id));
          sessionId = await createRecordingSession(deviceId, deviceName, firstBatchTs, ingestUserId);
          sessionStartMs = NaN;
          sessionEndMs = NaN;
          isNewSession = true;
        }
      } else {
        sessionId = await createRecordingSession(deviceId, deviceName, points[0].timestampMs, ingestUserId);
        isNewSession = true;
      }

      // 6. Вставка GPS-точек — v2.11.0 (C-16): многорядный INSERT чанками
      // вместо построчных (было ~50-100 мс HTTPS-раундтрипа на КАЖДУЮ точку).
      // v2.38.1 (ревью F4): прежний чанк 50×9 = 450 плейсхолдеров — эра Turso
      // (комментарий про «лимит SQLite 999»); на D1 (лимит ≤100 связанных
      // параметров) любой батч с ≥12 location-точками падал «too many SQL
      // variables» → 500, точки не вставлены, ledger не записан — ломалась
      // офлайн-буферизация SensorLogger. Размер чанка теперь — единый расчёт
      // multiRowInsertChunk из db.ts (D1: 10 строк × 9 колонок = 90 параметров;
      // libsql: 100 строк — в лимите 999). Поведение ledger/идемпотентности
      // не менялось (порядок и аргументы INSERT те же).
      const CH = multiRowInsertChunk(9);
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

      // 7. Обновляем session: endTime/startTime — МОНОТОННО (MAX/MIN),
      // pointCount, payloadBytes, updatedAt
      const lastTs = points[points.length - 1].timestampMs;
      const firstTs = points[0].timestampMs;
      const newStart = Number.isFinite(sessionStartMs) ? Math.min(sessionStartMs, firstTs) : firstTs;
      const newEnd = Number.isFinite(sessionEndMs) ? Math.max(sessionEndMs, lastTs) : lastTs;
      await libsql.execute({
        sql: `UPDATE Session
              SET startTime = ?, endTime = ?, pointCount = pointCount + ?, payloadBytes = payloadBytes + ?, updatedAt = ?
              WHERE id = ?`,
        args: [new Date(newStart).toISOString(), new Date(newEnd).toISOString(), points.length, payloadBytes, new Date().toISOString(), sessionId],
      });
      // v2.26.0 (ТЗ §7): живое расширение окна поездки последней точкой батча
      // (сессия привязана — поездка «дышит» вместе с записью; состав/кэши — при
      // финализации). Под тем же writeLock; сбой — не роняет инжест.
      await extendTripOnPoints(sessionId, lastTs);
      // v2.16.0 (R2): идемпотентность-запись — ПОСЛЕ успешной вставки точек
      // (atomic INSERT OR IGNORE — защита и от межинстансовых гонок)
      if (msgId != null && (typeof msgId === "number" || typeof msgId === "string")) {
        try {
          await libsql.execute({
            sql: `INSERT OR IGNORE INTO IngestMessage (deviceId, messageId, firstSeenAt) VALUES (?, ?, ?)`,
            args: [deviceId, String(msgId), new Date().toISOString()],
          });
        } catch {
          // нет таблицы на старых БД — не фатально
        }
      }
      return { sessionId, isNewSession, duplicate: false };
    });
    const { sessionId, isNewSession } = outcome;
    if (outcome.duplicate) {
      // Дубль, замеченный под lock (гонка двух ретраев) — точки НЕ вставлены.
      // v2.38.2 · F40: второй return-путь дубля — тоже в ingest_error_rate/трейс
      inc("ingest_duplicate_total", "Duplicate ingest (messageId idempotency)", 1, "sensorlogger");
      recordIngestOutcome(true);
      recordIngestAttempt({
        at: new Date().toISOString(), route: "sensorlogger", deviceId,
        outcome: "duplicate", points: 0, dropped: 0, bytes: null,
      });
      trackLatency(request);
      return json(
        { ok: true, duplicate: true, message: "Batch already processed (messageId seen)", deviceId, deviceName },
        200,
        { "X-Request-Id": requestId }
      );
    }

    inc("ingest_total", "Total ingest requests", 1, "sensorlogger");
    recordIngestAttempt({
      at: new Date().toISOString(), route: "sensorlogger", deviceId,
      outcome: "accepted", points: points.length, dropped: droppedInaccurate,
      bytes: payloadBytes,
    });
    recordIngestOutcome(true); // v2.38.2 · F40: успех в знаменателе ingest_error_rate
    trackLatency(request); // v2.38.2 · F40: p95 инжест-канала (§14.4)
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
    recordIngestOutcome(false); // v2.38.2 · F40: 5xx зажигает ingest_error_rate (как в canonical-роуте)
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
  // v2.38.1 (ревью F11): та же единая проверка, что и в POST — it_-токен из
  // Push URL должен проходить и тестовый GET
  const ingestAuth = await resolveIngestToken(bearer, queryToken);
  if (!ingestAuth.ok) {
    return json({ ok: false, error: "Unauthorized" }, 401);
  }
  return json({
    ok: true,
    endpoint: "/api/ingest/sensorlogger",
    method: "POST",
    format: "JSON array of { time, location: { latitude, longitude, speed, altitude, horizontalAccuracy, course } }",
    auth: "Authorization: Bearer <INGEST_TOKEN or it_ ingest token> OR ?token=<same>",
    requiredParams: ["deviceId"],
    optionalParams: ["deviceName"],
  });
}
