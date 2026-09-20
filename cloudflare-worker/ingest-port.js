// cloudflare-worker/ingest-port.js — v2.39.0 (§B1, docs/OPTIMIZATION-PROPOSAL.md
// Вариант B, этап B1): ПОРТАТИВНЫЙ МОДУЛЬ EDGE-ИНЖЕСТА для d1-gateway-воркера.
//
// ЦЕЛЬ: вынести приём GPS-батчей из Render (Франкфурт) на Cloudflare edge —
// рядом и с отправителем (РФ), и с D1. Валидация + нормализация + построение
// стейтментов — зеркала канонического /api/ingest (v2.38.2) и его фильтров
// (F38/F39: единый parse-timestamp, окно ±24 ч, accuracy ≤ 100 м), чтобы
// ОДИН И ТОТ ЖЕ батч проходил одинаково по обоим путям (никакой «двойной
// семантики» — иначе переключение канала меняет записанные данные).
//
// ПОРТАТИВНОСТЬ (главное требование порта):
//   • чистый ESM-JS: НЕТ импортов из src/, НЕТ npm-зависимостей (Zod/Prisma/
//     next/server в воркере недоступны);
//   • только Web Crypto / Intl / fetch-рантайм Workers;
//   • функции ЧИСТЫЕ: генерация id и «сейчас» — injectable (opts.newId /
//     opts.now) для юнит-тестов (tests/ingest-port.test.ts);
//   • деплой: (а) отдельным файлом рядом с d1-gateway.js при деплое wrangler'ом
//     (import handleEdgeIngest from "./ingest-port.js"), либо (б) копипастой
//     содержимого файла в тело d1-gateway.js и вызовом handleEdgeIngest из
//     роутера (паттерн worker.js: однофайловый CF-редактор).
//
// БЕЗОПАСНОСТЬ:
//   • пользовательский ввод НИКОГДА не становится текстом SQL — все значения
//     связаны параметрами (?), тексты стейтментов — константы этого модуля;
//   • воркер выполняет ТОЛЬКО стейтменты, построенные buildIngestStatements —
//     эндпоинт /ingest не принимает SQL от вызывающего вовсе (в отличие от
//     /query, где действует вайтлист таблиц);
//   • авторизация: X-Gateway-Secret (секрет шлюза — вызов из приложения) ИЛИ
//     Bearer/?token= INGEST_TOKEN (прямой Push URL SensorLogger; сравнение
//     timing-safe по SHA-256-дайджестам — приём token-check.ts §6.1).
//     ПЕР-ЮЗЕРНЫЕ it_-токены/apiKey на edge НЕ поддерживаются СОЗНАТЕЛЬНО:
//     их проверка требует SESSION_SECRET + скан User (см. auth.ts F11) —
//     Render-канал /api/ingest остаётся для личных устройств пользователей;
//     /ingest edge = канал ВЛАДЕЛЬЦА (userId IS NULL, изоляция сохранена).
//   • тело запроса стримится с капом (env.EDGE_INGEST_MAX_BYTES, дефолт 1 МБ
//     > MAX_PAYLOAD_BYTES приложения 256 КБ с запасом на JSON-обёртки) —
//     chunked-запросы любой длины НЕ читаются целиком в память (урок F20).

// ——— §B1: константы-зеркала (значения из src/, имена без магии) ———
/** Максимум точек в батче (zIngestBody: points ≤ 1000). */
export const INGEST_MAX_POINTS = 1000;
/** Окно правдоподобия времени точки: ±24 ч от серверного now (F38, R7). */
export const TS_PLAUSIBILITY_MS = 24 * 60 * 60 * 1000;
/** Порог отбраковки по accuracy (F38, AUDIT B-5): > 100 м — мусор. */
export const MAX_TRUSTED_ACCURACY_M = 100;
/** Разрыв потока > 30 с — маркер gap (зеркало /api/ingest, точка СОХРАНЯЕТСЯ). */
export const GAP_MARKER_MS = 30_000;
/** Бюджет связанных параметров D1 на стейтмент (db.ts: D1_PARAM_BUDGET = 90). */
export const EDGE_PARAM_BUDGET = 90;
/** Стейтментов на один DB.batch (db.ts: D1_BATCH_STMT_CHUNK = 400, шлюз 500). */
export const EDGE_BATCH_STMT_CHUNK = 400;
/** Лимит тела /ingest (байты; default 1 МБ — с запасом к 256 КБ приложения). */
export const EDGE_INGEST_MAX_BYTES = 1_048_576;
/** clientId — UUID/cuid-подобный (zIngestBody: /^[a-zA-Z0-9_-]+$/). */
const CLIENT_ID_RE = /^[a-zA-Z0-9_-]+$/;

// ——— parse-timestamp: ПОРТ src/lib/parse-timestamp.ts (v2.38.2 F74) ———
// Форматы: сек (<1e10 → ×1000), мс (<1e13), мкс (<1e16 → /1e3), нс (≥1e16 →
// /1e6), ISO-строка; невалидное → null. Портирован 1:1 — включая ветки
// диапазонов (диапазон [1e15, 1e16) раньше давал 1970 — здесь честные µs).
/** @param {string} raw @returns {number | null} мс epoch */
export function parseTimestamp(raw) {
  const num = Number(raw);
  if (!isNaN(num) && String(raw).trim() !== "") {
    if (num >= 1e16) return Math.floor(num / 1e6); // наносекунды
    if (num >= 1e13) return Math.floor(num / 1e3); // микросекунды
    if (num >= 1e10) return num; // миллисекунды
    if (num >= 1e9) return num * 1000; // секунды → мс
    return null; // не правдоподобное число
  }
  const d = new Date(String(raw));
  return isNaN(d.getTime()) ? null : d.getTime();
}

// ——— валидация: ЗЕРКАЛО zIngestBody (validation.ts) без Zod ———
/**
 * Структурная проверка тела инжеста. Возвращает {ok:true, value} либо
 * {ok:false, error} — error-строки совместимы с ответами /api/ingest
 * (сообщения не обязаны совпадать побуквенно: контракт — код 400).
 * @param {unknown} body @returns {{ok: true, value: {deviceId: string, clientId: string, deviceName: string | null, points: Array<Record<string, unknown>>}} | {ok: false, error: string}}
 */
export function validateIngestBody(body) {
  if (body == null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Body must be a JSON object" };
  }
  const b = /** @type {Record<string, unknown>} */ (body);
  if (typeof b.deviceId !== "string" || b.deviceId.length < 1 || b.deviceId.length > 64) {
    return { ok: false, error: "deviceId: required string 1..64" };
  }
  if (typeof b.clientId !== "string" || b.clientId.length < 1 || b.clientId.length > 64 || !CLIENT_ID_RE.test(b.clientId)) {
    return { ok: false, error: "clientId: required string 1..64, [A-Za-z0-9_-]" };
  }
  if (b.deviceName != null && (typeof b.deviceName !== "string" || b.deviceName.length > 128)) {
    return { ok: false, error: "deviceName: optional string ≤128" };
  }
  if (!Array.isArray(b.points) || b.points.length < 1 || b.points.length > INGEST_MAX_POINTS) {
    return { ok: false, error: `points: required array 1..${INGEST_MAX_POINTS}` };
  }
  for (let i = 0; i < b.points.length; i++) {
    const p = b.points[i];
    if (p == null || typeof p !== "object" || Array.isArray(p)) {
      return { ok: false, error: `points[${i}]: object required` };
    }
    const pt = /** @type {Record<string, unknown>} */ (p);
    const lat = pt.lat;
    if (typeof lat !== "number" || !Number.isFinite(lat) || lat < -90 || lat > 90) {
      return { ok: false, error: `points[${i}].lat: number [-90..90]` };
    }
    const lon = pt.lon;
    if (typeof lon !== "number" || !Number.isFinite(lon) || lon < -180 || lon > 180) {
      return { ok: false, error: `points[${i}].lon: number [-180..180]` };
    }
    if (pt.speed != null && (typeof pt.speed !== "number" || !Number.isFinite(pt.speed) || pt.speed < 0 || pt.speed > 83.33)) {
      return { ok: false, error: `points[${i}].speed: number [0..83.33]` };
    }
    if (pt.altitude != null && (typeof pt.altitude !== "number" || !Number.isFinite(pt.altitude))) {
      return { ok: false, error: `points[${i}].altitude: number` };
    }
    if (pt.accuracy != null && (typeof pt.accuracy !== "number" || !Number.isFinite(pt.accuracy) || pt.accuracy < 0)) {
      return { ok: false, error: `points[${i}].accuracy: number ≥0` };
    }
    // timestamp: Zod-схема допускает number; canonical-роут делает
    // String(p.timestamp) → parseTimestamp. Порт зеркалит поведение: строго
    // number (finite), строки-числа НЕ легальны в JSON-каноне приложения.
    if (typeof pt.timestamp !== "number" || !Number.isFinite(pt.timestamp)) {
      return { ok: false, error: `points[${i}].timestamp: finite number required` };
    }
    if (pt.bearing != null && (typeof pt.bearing !== "number" || !Number.isFinite(pt.bearing) || pt.bearing < 0 || pt.bearing > 360)) {
      return { ok: false, error: `points[${i}].bearing: number [0..360]` };
    }
  }
  return {
    ok: true,
    value: {
      deviceId: b.deviceId,
      clientId: b.clientId,
      deviceName: typeof b.deviceName === "string" ? b.deviceName : null,
      points: b.points,
    },
  };
}

// ——— нормализация: ЗЕРКАЛО canonical /api/ingest v2.38.2 (шаг 2) ———
/**
 * Единый парсер времени + окно ±24 ч + accuracy-фильтр + сортировка по
 * возрастанию. Точки с непарсящимся/неправдоподобным временем НЕ получают
 * «фальшивое сейчас» (D-6) — отбрасываются со счётчиком.
 * @param {Array<Record<string, unknown>>} points
 * @param {number} nowMs
 * @returns {{normalized: Array<{lat: number, lon: number, speed: number | null, altitude: number | null, accuracy: number | null, bearing: number | null, timestampMs: number}>, droppedTimestamp: number, droppedInaccurate: number}}
 */
export function normalizeIngestPoints(points, nowMs) {
  let droppedTimestamp = 0;
  let droppedInaccurate = 0;
  /** @type {Array<{lat: number, lon: number, speed: number | null, altitude: number | null, accuracy: number | null, bearing: number | null, timestampMs: number}>} */
  const normalized = [];
  for (const p of points) {
    const ts = parseTimestamp(String(p.timestamp));
    if (ts == null || Math.abs(nowMs - ts) > TS_PLAUSIBILITY_MS) {
      droppedTimestamp++;
      continue;
    }
    const acc = p.accuracy == null ? null : Number(p.accuracy);
    if (acc != null && acc > MAX_TRUSTED_ACCURACY_M) {
      droppedInaccurate++;
      continue;
    }
    normalized.push({
      lat: Number(p.lat),
      lon: Number(p.lon),
      speed: p.speed == null ? null : Number(p.speed),
      altitude: p.altitude == null ? null : Number(p.altitude),
      accuracy: acc,
      bearing: p.bearing == null ? null : Number(p.bearing),
      timestampMs: ts,
    });
  }
  normalized.sort((a, b) => a.timestampMs - b.timestampMs);
  return { normalized, droppedTimestamp, droppedInaccurate };
}

/**
 * Счёт gap-маркеров: соседние точки с разрывом > 30 с (C-10: сравнение между
 * СОСЕДНИМИ; точка-возобновление СОХРАНЯЕТСЯ — R9). Чистая функция.
 * @param {Array<{timestampMs: number}>} normalized
 * @returns {number}
 */
export function countGapMarkers(normalized) {
  let gaps = 0;
  let lastTs = null;
  for (const p of normalized) {
    if (lastTs !== null && p.timestampMs - lastTs > GAP_MARKER_MS) gaps++;
    lastTs = p.timestampMs;
  }
  return gaps;
}

// ——— TZ-день rollup (§A1.5): ключ дня инжеста в поясе оператора ———
// Зеркалит stats-rollup.ts localDayKey по СМЫСЛУ (день в zone, формат
// YYYY-MM-DD): en-CA-форметтер даёт ISO-подобную дату напрямую, без разложения
// на offset-минуты — меньше кода в порте, тот же результат для day-key.
const DAY_FMT_CACHE = new Map();
function dayFormatter(zone) {
  let f = DAY_FMT_CACHE.get(zone);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" });
    } catch {
      f = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" });
    }
    DAY_FMT_CACHE.set(zone, f);
  }
  return f;
}
/** @param {number} tsMs @param {string} [zone] @returns {string} YYYY-MM-DD */
export function rollupDayKey(tsMs, zone) {
  const z = zone || "UTC";
  return dayFormatter(z).format(new Date(tsMs));
}

// ——— идемпотентность: ЗЕРКАЛО idempotency.ts (§6.7) ———
/**
 * SELECT существующей сессии по (deviceId, clientId) в скоупе userId
 * (v2.23.0 изоляция: NULL-канал ищет только NULL). Возвращает ГОТОВЫЙ
 * стейтмент — воркер исполняет его через DB.prepare().bind().first().
 * @param {{deviceId: string, clientId: string, userId?: string | null}} q
 * @returns {{sql: string, args: unknown[]}}
 */
export function findExistingSessionStatement(q) {
  if (q.userId != null) {
    return {
      sql: "SELECT id, status, deletedAt FROM Session WHERE deviceId = ? AND clientId = ? AND userId = ? LIMIT 1",
      args: [q.deviceId, q.clientId, q.userId],
    };
  }
  return {
    sql: "SELECT id, status, deletedAt FROM Session WHERE deviceId = ? AND clientId = ? AND userId IS NULL LIMIT 1",
    args: [q.deviceId, q.clientId],
  };
}

/**
 * Надгробие для soft-deleted сессии, занимающей уникальную пару
 * (deviceId, clientId) — повторный пакет создаёт НОВУЮ сессию (§6.3),
 * история сохраняется. Зеркало idempotency.ts.
 * @param {string} sessionId @param {string} clientId
 * @returns {{sql: string, args: unknown[]}}
 */
export function tombstoneSessionStatement(sessionId, clientId) {
  return {
    sql: "UPDATE Session SET clientId = ? WHERE id = ?",
    args: [`${clientId}#deleted#${String(sessionId).slice(0, 8)}`, sessionId],
  };
}

// ——— построение стейтментов: ЗЕРКАЛО $transaction инжеста ———
/**
 * Полный набор D1-стейтментов для записи батча:
 *   1. INSERT Session (status:"completed", pointCount, payloadBytes,
 *      startTime/endTime ISO-строками — конвенция Prisma+SQLite,
 *      trafficJobId проставлен СРАЗУ: на edge весь набор идёт ОДНИМ
 *      атомарным DB.batch — промежуточное «создать потом обновить»
 *      canonical-роута (3 шага внутри транзакции) здесь не нужно,
 *      конечное состояние строк идентично);
 *   2. INSERT GpsPoint — многорядно, чанками floor(90/9 колонок)=10 строк
 *      на стейтмент (бюджет параметров D1 = 90, db.ts F4; 1000 точек →
 *      100 стейтментов ≤ 500 /batch);
 *   3. INSERT TrafficJob (pending, priority 0);
 *   4. UPSERT StatsRollup-инкремента дня (§A1.5: sessions+1, points+N) —
 *      includeRollup=false отключает (воркер без rollup-таблицы).
 *
 * id точек генерируются ДО вставки (клиентские — паттерн F57: компенсация
 * частичного сбоя между группами и идемпотентный retry по unique-ключу).
 *
 * @param {{deviceId: string, clientId: string, deviceName?: string | null, userId?: string | null, normalized: Array<{lat: number, lon: number, speed: number | null, altitude: number | null, accuracy: number | null, bearing: number | null, timestampMs: number}>, payloadBytes: number, now?: number, newId?: () => string, rollupDay?: string, includeRollup?: boolean}} opts
 * @returns {{statements: Array<{sql: string, args: unknown[]}>, sessionId: string, jobId: string, pointIds: string[]}}
 */
export function buildIngestStatements(opts) {
  const now = opts.now ?? Date.now();
  const newId = opts.newId ?? (typeof crypto !== "undefined" && crypto.randomUUID ? () => crypto.randomUUID() : () => String(Math.random()));
  const sessionId = newId();
  const jobId = newId();
  const nowIso = new Date(now).toISOString();
  const pts = opts.normalized;
  const first = pts[0];
  const last = pts[pts.length - 1];

  // 1. Session — id, deviceId, clientId, deviceName, startTime, endTime,
  //    pointCount, payloadBytes, status, userId, trafficJobId, createdAt,
  //    updatedAt (13 колонок; NULL-колонки связаны как null — D1 поддерживает).
  const stmts = [
    {
      sql: `INSERT INTO Session (id, deviceId, clientId, deviceName, startTime, endTime, pointCount, payloadBytes, status, userId, trafficJobId, createdAt, updatedAt)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?, ?)`,
      args: [
        sessionId,
        opts.deviceId,
        opts.clientId,
        opts.deviceName ?? null,
        new Date(first.timestampMs).toISOString(),
        new Date(last.timestampMs).toISOString(),
        pts.length,
        opts.payloadBytes,
        opts.userId ?? null,
        jobId,
        nowIso,
        nowIso,
      ],
    },
  ];

  // 2. GpsPoint — многорядные INSERT чанками (9 колонок × 10 строк = 90
  //    параметров = бюджет). id каждой строки генерируется здесь же.
  const POINT_COLS = ["id", "sessionId", "lat", "lon", "speed", "altitude", "accuracy", "timestamp", "bearing"];
  const ph = `(${POINT_COLS.map(() => "?").join(", ")})`;
  const CH = Math.max(1, Math.floor(EDGE_PARAM_BUDGET / POINT_COLS.length)); // 10
  const pointIds = [];
  const rows = pts.map((p) => {
    const id = newId();
    pointIds.push(id);
    return [id, sessionId, p.lat, p.lon, p.speed, p.altitude, p.accuracy, p.timestampMs, p.bearing];
  });
  for (let i = 0; i < rows.length; i += CH) {
    const chunk = rows.slice(i, i + CH);
    stmts.push({
      sql: `INSERT INTO GpsPoint (${POINT_COLS.join(", ")}) VALUES ${chunk.map(() => ph).join(", ")}`,
      args: chunk.flat(),
    });
  }

  // 3. TrafficJob — задание маршрутизации (2GIS/OSRM воркер поднимет его на
  //    Render по расписанию — чтение очереди роутером Render остаётся).
  stmts.push({
    sql: `INSERT INTO TrafficJob (id, sessionId, status, attempts, priority, scheduledFor, createdAt, updatedAt)
          VALUES (?, ?, 'pending', 0, 0, ?, ?, ?)`,
    args: [jobId, sessionId, nowIso, nowIso, nowIso],
  });

  // 4. StatsRollup-инкремент (§A1.5, зеркалит bumpRollup): UPSERT-дельта
  //    sessions+1 / points+N на день старта сессии в TZ оператора.
  if (opts.includeRollup !== false) {
    const day = opts.rollupDay ?? rollupDayKey(first.timestampMs, opts.rollupZone);
    const uid = opts.userId == null ? "" : String(opts.userId);
    stmts.push({
      sql: `INSERT INTO StatsRollup (day, userId, sessions, points, distanceM, durationSec, ecoSum, ecoCount, updatedAt)
            VALUES (?, ?, 1, ?, 0, 0, 0, 0, ?)
            ON CONFLICT(day, userId) DO UPDATE SET
              sessions = sessions + excluded.sessions,
              points = points + excluded.points,
              updatedAt = excluded.updatedAt`,
      args: [day, uid, pts.length, nowIso],
    });
  }

  return { statements: stmts, sessionId, jobId, pointIds };
}

/**
 * Разбивка стейтментов на группы для DB.batch (≤400 — шлюзовой лимит 500 с
 * запасом; паттерн chunkStatements db.ts F5). Инжест ≤1000 точек = ≤103
 * стейтмента — ОДНА группа (атомарная транзакция D1); превышение (гипотетический рост лимита точек) — группы с документированной частичностью, компенсация по
 * клиентским id (F57) и идемпотентность retry (уникальный deviceId+clientId).
 * @param {Array<{sql: string, args: unknown[]}>} stmts
 * @param {number} [size]
 * @returns {Array<Array<{sql: string, args: unknown[]}>>}
 */
export function chunkStatements(stmts, size = EDGE_BATCH_STMT_CHUNK) {
  const out = [];
  for (let i = 0; i < stmts.length; i += size) out.push(stmts.slice(i, i + size));
  return out;
}

// ——— авторизация / сетевые хелперы порта (Web Crypto, без импортов) ———

/** Timing-safe сравнение секретов по SHA-256-дайджестам (token-check.ts §6.1). */
async function tokenMatches(provided, expected) {
  if (!provided || !expected) return false;
  const enc = new TextEncoder();
  const [got, want] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(provided)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  const a = new Uint8Array(got);
  const b = new Uint8Array(want);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function jsonResponse(body, status, requestId) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...(requestId ? { "x-request-id": requestId } : {}),
    },
  });
}

/** Чтение тела с капом: content-length И фактические байты (урок F20 —
 *  chunked без заголовка не должен читаться целиком). Возвращает null → 413. */
async function readBodyCapped(request, maxBytes) {
  const declared = Number(request.headers.get("content-length") || "0");
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  const reader = request.body?.getReader();
  if (!reader) {
    // тела нет (GET/пустой POST) — читаем текстом ( пустая строка → 400 JSON)
    const t = await request.text().catch(() => "");
    return t.length > maxBytes ? null : t;
  }
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    joined.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(joined);
}

// ——— ГОТОВЫЙ ЭНДПОИНТ: монтируется в d1-gateway-воркер ———
// Интеграция (два способа, см. шапку): добавить в роутер d1-gateway.js ветку
//   if (url.pathname === "/ingest" && request.method === "POST")
//     return await handleEdgeIngest(request, env);
// NB для wrangler-деплоя: ALLOWED_TABLES шлюза НЕ задействован — стейтменты
// фиксированы этим модулем; StatsRollup добавьте в ALLOWED_TABLES только если
// /query тоже должен видеть таблицу (для /ingest не требуется).
//
// Контракт ответов = /api/ingest (клиент SensorLogger не отличает каналы):
//   201 {sessionId, pointsAccepted, dropped:{timestamp,accuracy}, gapMarkers, trafficJobId, duplicate:false}
//   200 {sessionId, duplicate:true} — идемпотентный повтор
//   401/405/413/400/500 — зеркала формулировок канонического роута.
/**
 * @param {Request} request
 * @param {{DB: D1Database, GATEWAY_SECRET?: string, INGEST_TOKEN?: string, EDGE_INGEST_MAX_BYTES?: number, EDGE_INGEST_ROLLUP_ENABLED?: string, TELEMAT_TIMEZONE?: string}} env
 * @returns {Promise<Response>}
 */
export async function handleEdgeIngest(request, env) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    if (request.method !== "POST") {
      return jsonResponse({ error: "Method not allowed" }, 405, requestId);
    }

    // ——— авторизация: X-Gateway-Secret (приложение) ИЛИ INGEST_TOKEN
    // (SensorLogger Push). it_/apiKey → 401 с честной причиной (личный
    // канал — на Render; см. шапку БЕЗОПАСНОСТЬ).
    const url = new URL(request.url);
    const bearer = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "") || null;
    const queryToken = url.searchParams.get("token");
    const gwSecret = env.GATEWAY_SECRET || null;
    const ingestToken = env.INGEST_TOKEN || null;
    const viaSecret = gwSecret ? await tokenMatches(request.headers.get("x-gateway-secret"), gwSecret) : false;
    const viaIngest =
      (bearer && ingestToken && (await tokenMatches(bearer, ingestToken))) ||
      (queryToken && ingestToken && (await tokenMatches(queryToken, ingestToken)));
    if (!viaSecret && !viaIngest) {
      return jsonResponse(
        {
          error: "Unauthorized",
          reason: ingestToken
            ? "Bearer INGEST_TOKEN / ?token= (SensorLogger) or X-Gateway-Secret required; per-user it_/apiKey — use Render /api/ingest"
            : "X-Gateway-Secret required (INGEST_TOKEN not configured on worker)",
        },
        401,
        requestId
      );
    }

    // ——— тело с капом (F20) → JSON → валидация (zIngestBody-зеркало)
    const maxBytes = env.EDGE_INGEST_MAX_BYTES || EDGE_INGEST_MAX_BYTES;
    const raw = await readBodyCapped(request, maxBytes);
    if (raw == null) {
      return jsonResponse({ error: "Payload too large", limit: maxBytes }, 413, requestId);
    }
    let body = null;
    try {
      body = JSON.parse(raw);
    } catch {
      body = null; // невалидный JSON → валидационная 400 (семантика роута)
    }
    const parsed = validateIngestBody(body);
    if (!parsed.ok) {
      return jsonResponse({ error: "Validation failed", details: parsed.error }, 400, requestId);
    }
    const { deviceId, clientId, deviceName, points } = parsed.value;

    // ——— идемпотентность (§6.7): пара (deviceId, clientId) канала владельца
    // (userId IS NULL — edge-канал только глобальный, см. шапку).
    const lookup = findExistingSessionStatement({ deviceId, clientId, userId: null });
    const existing = await env.DB.prepare(lookup.sql).bind(...lookup.args).first();
    if (existing && !existing.deletedAt) {
      return jsonResponse({ sessionId: String(existing.id), duplicate: true }, 200, requestId);
    }
    if (existing && existing.deletedAt) {
      // надгробие: soft-deleted занимает уникальную пару — освобождаем
      const tomb = tombstoneSessionStatement(String(existing.id), clientId);
      await env.DB.prepare(tomb.sql).bind(...tomb.args).run();
    }

    // ——— нормализация + фильтры (F38/F39) → пусто = честная 400
    const nowMs = Date.now();
    const { normalized, droppedTimestamp, droppedInaccurate } = normalizeIngestPoints(points, nowMs);
    if (normalized.length === 0) {
      return jsonResponse(
        {
          error: "All points rejected by input filters",
          dropped: { timestamp: droppedTimestamp, accuracy: droppedInaccurate },
          plausibilityWindowHours: TS_PLAUSIBILITY_MS / (60 * 60 * 1000),
          maxAccuracyM: MAX_TRUSTED_ACCURACY_M,
        },
        400,
        requestId
      );
    }
    const gapMarkers = countGapMarkers(normalized);

    // ——— стейтменты → атомарные группы DB.batch
    const includeRollup = (env.EDGE_INGEST_ROLLUP_ENABLED || "true") === "true";
    const built = buildIngestStatements({
      deviceId,
      clientId,
      deviceName,
      userId: null,
      normalized,
      payloadBytes: raw.length,
      now: nowMs,
      rollupDay: includeRollup ? rollupDayKey(normalized[0].timestampMs, env.TELEMAT_TIMEZONE || "UTC") : undefined,
      includeRollup,
    });
    const groups = chunkStatements(built.statements);
    for (const group of groups) {
      await env.DB.batch(group.map((s) => env.DB.prepare(s.sql).bind(...s.args)));
    }

    return jsonResponse(
      {
        sessionId: built.sessionId,
        pointsAccepted: normalized.length,
        dropped: { timestamp: droppedTimestamp, accuracy: droppedInaccurate },
        gapMarkers,
        trafficJobId: built.jobId,
        duplicate: false,
      },
      201,
      requestId
    );
  } catch (err) {
    // идемпотентность-гонка (два ретрая впритык): unique(deviceId, clientId)
    // → повторная проверка, честный duplicate (зеркало B-6 canonical-роута)
    try {
      const bodyRace = await request.clone().json().catch(() => null);
      if (bodyRace && typeof bodyRace.deviceId === "string" && typeof bodyRace.clientId === "string") {
        const lookup = findExistingSessionStatement({ deviceId: bodyRace.deviceId, clientId: bodyRace.clientId, userId: null });
        const raced = await env.DB.prepare(lookup.sql).bind(...lookup.args).first();
        if (raced && !raced.deletedAt) {
          return jsonResponse({ sessionId: String(raced.id), duplicate: true }, 200, requestId);
        }
      }
    } catch {
      // анализ гонки не удался — падаем в общую 500 ниже
    }
    return jsonResponse({ error: "Internal Server Error" }, 500, requestId);
  }
}

// ════════════════════════════════════════════════════════════════════════
// v2.40.9 (Pack C §P2): EDGE-ПОРТ SensorLogger-КАНАЛА (/api/ingest/sensorlogger)
// ════════════════════════════════════════════════════════════════════════
//
// ЦЕЛЬ (план Pack C, владелец подтвердил «pack c делай полностью»): Push URL
// SensorLogger меняет ТОЛЬКО ХОСТ (push.poedzok.fun → d1-gateway…), путь
// /api/ingest/sensorlogger, ?token=it_… и ?deviceId=phone остаются как есть.
// Телефон мимо Render: латентность −50%+ (edge рядом с РФ и D1), прокси-тело
// не жжёт CPU инстанса, канал живёт при сне инстанса (cron-tick всё равно
// будит Render каждую минуту — исполнители конвейера остаются на месте).
//
// ЗЕРКАЛО /api/ingest/sensorlogger v2.40.8 (портируются ДОСЛОВНО):
//   • нативный формат: массив / {payload|points|data|records|…} / именованные
//     записи {name,time,values} / вложенный {data:{location:[…]}} — весь
//     экстрактор контейнеров (v2.10.7/v2.10.8) с гистограммой для диагностики;
//   • фильтры: parseTimestamp (магнитуда F74), ±24 ч, accuracy ≤ 100 м,
//     lat/lon диапазоны, маркер «нет фиксa» (-1,-1), speed/altitude/bearing
//     диапазоны — зеркала extractPoint;
//   • идемпотентность IngestMessage(deviceId, messageId): быстрая проверка
//     ДО вставки + запись ПОСЛЕ успешной вставки точек (R2) + повторная
//     проверка под «локом» (MI-6: в воркере роль lock'а играет атомарный
//     INSERT…WHERE NOT EXISTS создания сессии — гонка параллельных ретраев
//     разрешается в duplicate);
//   • корреляция сессий по ГЕПСУ GPS-времени (R4: endTime vs первая точка
//     батча, fallback updatedAt wall-clock; гэп ≥ SESSION_GAP_MS → НОВАЯ
//     сессия), границы startTime/endTime монотонные MIN/MAX (R11);
//   • многорядные INSERT точек чанками floor(90/9)=10 (F4);
//   • rollup-инкремент дня последней точки (§A1.5);
//   • паритет ответов: 201/200-new-batch/200-duplicate/200-test/400/413/500.
//
// ЧЕСТНЫЕ ОТЛИЧИЯ (документированные, не «тихая семантика»):
//   1) ФИНАЛИЗАЦИЯ старой сессии при гэпе НЕ вызывается на edge (весь
//      finalize-конвейер — поездки/кэши/traffic-jobs — живёт в приложении):
//      сессия остаётся recording и закрывается жнецом приложения ≤ ~10 мин
//      (worker-tick */1; порог max(10 мин, SESSION_GAP_MS×10), F8). Дата
//      ложится мгновенно, поездка/кэши появляются с задержкой финализации.
//   2) ЖИВОЕ tripId/extendTripOnPoints не выполняются (v2.26/v2.35-логика
//      приложения) — состав поездки досчитает финализация (как для любых
//      «поздних данных»).
//   3) Инжест-трейс/метрики/алерт-исходы (ingest-trace.ts, F40) — только в
//      консоль-логе воркера (JSON-строка, как cron-логи); _AlertState-канал
//      приложения остаётся за Render-каналом.
//
// БЕЗОПАСНОСТЬ (паритет F11/token-check):
//   • авторизация: X-Gateway-Secret (приложение) / глобальный INGEST_TOKEN
//     (Bearer/?token=, канал владельца userId NULL) / per-user it_-токен —
//     верификация HMAC-SHA256(SESSION_SECRET, "<apiKey>:ingest") по
//     User-таблице (первый SELECT ~1-2 строки; результат кэшируется KV на
//     10 минут по sha256-префиксу токена — БЕЗ хранения apiKey в KV);
//   • timing-safe сравнения — дайджесты SHA-256 (tokenMatches выше);
//   • SQL только параметризованный, тексты — константы модуля.

// ——— §P2: it_-токен (порт token-check.ts F11) ———
/** Формат: it_<32 hex> — производный ingest-only токен (НЕ apiKey). */
export const IT_TOKEN_RE = /^it_[0-9a-f]{32}$/;

/** Первые 32 hex(HMAC-SHA256(sessionSecret, "<apiKey>:ingest")) → it_-токен. */
export async function deriveItToken(sessionSecret, apiKey) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(sessionSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(`${apiKey}:ingest`));
  const hex = Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
  return `it_${hex.slice(0, 32)}`;
}

/** hex sha256 (для KV-ключа кэша верификации). */
async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

const IT_CACHE_TTL_SEC = 600; // 10 мин: ротация apiKey отзывает токен с ≤10-мин окном

/**
 * Верификация it_-токена → userId | null. Позитивный результат кэшируется
 * в KV по sha256-префиксу токена (в KV не попадает ни apiKey, ни сам токен);
 * негативы НЕ кэшируются (brute-force не получает бесплатную память).
 * User-таблица маленькая (single-owner) — один SELECT на промахе кэша.
 */
export async function verifyEdgeItToken(env, token) {
  if (!IT_TOKEN_RE.test(String(token))) return null;
  if (!env.SESSION_SECRET) return null; // it_-канал не настроен (секрет не задан)
  const cacheKey = `edgeit:${(await sha256Hex(String(token))).slice(0, 24)}`;
  let cached = null;
  try {
    if (env.KV && typeof env.KV.get === "function") {
      cached = await env.KV.get(cacheKey, "text");
    }
  } catch { /* KV сбой — прямая верификация */ }
  if (cached && /^[A-Za-z0-9_-]{1,64}$/.test(cached)) return cached; // userId
  const rows = await env.DB.prepare("SELECT id, apiKey FROM User").all();
  for (const u of (rows.results ?? [])) {
    const expected = await deriveItToken(env.SESSION_SECRET, String(u.apiKey));
    if (await tokenMatches(String(token), expected)) {
      try {
        if (env.KV && typeof env.KV.put === "function") {
          await env.KV.put(cacheKey, String(u.id), { expirationTtl: IT_CACHE_TTL_SEC });
        }
      } catch { /* кэш не критичен */ }
      return String(u.id);
    }
  }
  return null;
}

// ——— §P2: экстрактор нативного формата (порт route.ts v2.10.7/8) ———
const DEVICE_ID_RE = /^[A-Za-z0-9_.:\- ]{1,64}$/;
const DEVICE_NAME_RE = /^[^\n\r]{1,128}$/;
const MAX_BATCH_ITEMS = 5000;
const MAX_POINT_ACCURACY_M = 100; // AUDIT B-5 (зеркало; = MAX_TRUSTED_ACCURACY_M)
const ARRAY_KEYS = [
  "payload", "points", "data", "records", "readings", "sensors",
  "measurements", "samples", "locations", "entries", "batches",
];
const LOCATION_NAMES = ["location", "gps", "position", "coords", "coordinates", "latitude"];

/** Именованная запись {name, time, values} → плоская точка с location. */
function normalizeItem(item) {
  if (item && typeof item === "object" && !Array.isArray(item)) {
    const r = item;
    if (typeof r.name === "string" && r.values && typeof r.values === "object" && !Array.isArray(r.values)) {
      return { ...r, time: r.time ?? r.timestamp, location: r.values };
    }
  }
  return item;
}

/** Массив точек из тела: корневой массив / известные контейнеры / вложенный data. */
export function extractItems(body) {
  if (Array.isArray(body)) return body.map(normalizeItem);
  if (body && typeof body === "object") {
    const obj = body;
    for (const key of ARRAY_KEYS) {
      const v = obj[key];
      if (Array.isArray(v)) {
        if (v.length === 0) return [];
        if (Array.isArray(v[0])) return v.flat().map(normalizeItem);
        return v.map(normalizeItem);
      }
    }
    const data = obj.data;
    if (data && typeof data === "object" && !Array.isArray(data)) {
      const nested = data;
      for (const key of [...ARRAY_KEYS, "location", "gps", "position", "coords"]) {
        const v = nested[key];
        if (Array.isArray(v) && v.length > 0) return v.map(normalizeItem);
      }
    }
    return [body];
  }
  return null;
}

/** Нормализация точки (порт extractPoint): контейнеры, диапазоны, фильтры. */
export function extractPoint(raw, nowMs) {
  const loc = raw.location ?? raw.coords ?? raw.position ?? raw.gps ?? {};
  const lat = raw.latitude ?? raw.lat ?? loc.latitude ?? loc.lat;
  const lon = raw.longitude ?? raw.lon ?? raw.lng ?? loc.longitude ?? loc.lon ?? loc.lng;
  if (lat == null || lon == null || isNaN(Number(lat)) || isNaN(Number(lon))) return null;
  if (Math.abs(Number(lat)) > 90 || Math.abs(Number(lon)) > 180) return null;
  if (Number(lat) === -1 && Number(lon) === -1) return null; // «нет GPS-фикса»
  const tsRaw = raw.time ?? raw.timestamp;
  if (tsRaw == null) return null;
  const timestampMs = parseTimestamp(String(tsRaw));
  if (timestampMs == null) return null;
  if (Math.abs(nowMs - timestampMs) > TS_PLAUSIBILITY_MS) return null;
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

/** Гистограмма сенсоров батча — краткий образец структуры для лога. */
function describeItems(items) {
  const hist = new Map();
  let hasLocation = false;
  for (const it of items) {
    const name = it && typeof it === "object" && typeof it.name === "string" ? it.name : "(без name)";
    if (LOCATION_NAMES.some((ln) => name.toLowerCase().includes(ln))) hasLocation = true;
    hist.set(name, (hist.get(name) ?? 0) + 1);
  }
  const histStr = [...hist.entries()].sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n}×${c}`).join(", ");
  return `items[${items.length}] sensors: ${histStr}${hasLocation ? " · location OK" : " · location-записей НЕТ"}`;
}

// ——— §P2: стейтменты SensorLogger-конвейера (зеркало route.ts) ———

/** Последняя recording-сессия канала (userId NULL — владелец / = ? — юзер). */
function findActiveRecordingStatement(deviceId, userId) {
  if (userId != null) {
    return {
      sql: "SELECT id, startTime, endTime, updatedAt FROM Session WHERE deviceId = ? AND status = 'recording' AND deletedAt IS NULL AND userId = ? ORDER BY updatedAt DESC LIMIT 1",
      args: [deviceId, userId],
    };
  }
  return {
    sql: "SELECT id, startTime, endTime, updatedAt FROM Session WHERE deviceId = ? AND status = 'recording' AND deletedAt IS NULL AND userId IS NULL ORDER BY updatedAt DESC LIMIT 1",
    args: [deviceId],
  };
}

/**
 * Создание recording-сессии с АТОМНЫМ анти-гонкой гардом (роль writeLock C-14):
 * INSERT…SELECT…WHERE NOT EXISTS — два параллельных батча одного девайса не
 * создадут две сессии: проигравший (changes=0) перечитывает активную и
 * продолжает её (см. вызов ниже). Точки вставляются только в СУЩЕСТВУЮЩИЙ id.
 */
function createRecordingStatement(opts) {
  const userIdSql = opts.userId != null ? "userId, " : "";
  const userIdPh = opts.userId != null ? "?, " : "";
  const guard = opts.userId != null
    ? "NOT EXISTS (SELECT 1 FROM Session WHERE deviceId = ? AND status = 'recording' AND deletedAt IS NULL AND userId = ?)"
    : "NOT EXISTS (SELECT 1 FROM Session WHERE deviceId = ? AND status = 'recording' AND deletedAt IS NULL AND userId IS NULL)";
  const args = [
    opts.sessionId, opts.deviceId, opts.clientId, opts.deviceName,
    opts.startTimeIso, opts.startTimeIso, opts.nowIso, opts.nowIso,
    ...(opts.userId != null ? [opts.userId] : []),
    opts.deviceId,
    ...(opts.userId != null ? [opts.userId] : []),
  ];
  return {
    sql: `INSERT INTO Session (id, deviceId, clientId, deviceName, startTime, endTime, pointCount, payloadBytes, status, createdAt, updatedAt${opts.userId != null ? ", userId" : ""})
          SELECT ?, ?, ?, ?, ?, ?, 0, 0, 'recording', ?, ?${opts.userId != null ? ", ?" : ""}
          WHERE ${guard}`,
    args,
  };
}

/** Многорядные INSERT точек чанками 10×9 (F4). id генерируются здесь. */
function pointInsertStatements(sessionId, points, newId) {
  const POINT_COLS = ["id", "sessionId", "lat", "lon", "speed", "altitude", "accuracy", "timestamp", "bearing"];
  const ph = `(${POINT_COLS.map(() => "?").join(", ")})`;
  const CH = Math.max(1, Math.floor(EDGE_PARAM_BUDGET / POINT_COLS.length)); // 10
  const stmts = [];
  for (let i = 0; i < points.length; i += CH) {
    const chunk = points.slice(i, i + CH);
    const args = [];
    for (const p of chunk) {
      args.push(newId(), sessionId, p.lat, p.lon, p.speed, p.altitude, p.accuracy, p.timestampMs, p.bearing);
    }
    stmts.push({
      sql: `INSERT INTO GpsPoint (${POINT_COLS.join(", ")}) VALUES ${chunk.map(() => ph).join(", ")}`,
      args,
    });
  }
  return stmts;
}

// ——— §P2: ГОТОВЫЙ ЭНДПОИНТ (монтируется в d1-gateway.js ДО гейта секрета) ———
/**
 * @param {Request} request
 * @param {{DB: D1Database, KV?: KVNamespace, GATEWAY_SECRET?: string, INGEST_TOKEN?: string, SESSION_SECRET?: string, SESSION_GAP_MS?: string|number, EDGE_INGEST_MAX_BYTES?: number, EDGE_INGEST_ROLLUP_ENABLED?: string, TELEMAT_TIMEZONE?: string}} env
 * @returns {Promise<Response>}
 */
export async function handleEdgeSensorLogger(request, env) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  const startedAt = Date.now();
  try {
    const url = new URL(request.url);

    // ——— GET: тест-проба SensorLogger (паритет route.ts) ———
    if (request.method === "GET") {
      const queryToken = url.searchParams.get("token");
      const bearer = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "") || null;
      const gwSecret = env.GATEWAY_SECRET || null;
      const ingestToken = env.INGEST_TOKEN || null;
      const viaSecret = gwSecret ? await tokenMatches(request.headers.get("x-gateway-secret"), gwSecret) : false;
      const viaIngest = (bearer && ingestToken && (await tokenMatches(bearer, ingestToken))) ||
        (queryToken && ingestToken && (await tokenMatches(queryToken, ingestToken)));
      let viaIt = false;
      if (!viaSecret && !viaIngest) {
        const presented = bearer ?? queryToken;
        if (presented && IT_TOKEN_RE.test(presented)) viaIt = (await verifyEdgeItToken(env, presented)) != null;
      }
      if (!viaSecret && !viaIngest && !viaIt) {
        return jsonResponse({ ok: false, error: "Unauthorized" }, 401, requestId);
      }
      return jsonResponse({
        ok: true,
        endpoint: "/api/ingest/sensorlogger",
        method: "POST",
        edge: true,
        format: "JSON array of { time, location: { latitude, longitude, speed, altitude, horizontalAccuracy, course } }",
        auth: "Authorization: Bearer <INGEST_TOKEN or it_ ingest token> OR ?token=<same>",
        requiredParams: ["deviceId"],
        optionalParams: ["deviceName"],
      }, 200, requestId);
    }

    if (request.method !== "POST") {
      return jsonResponse({ error: "Method not allowed" }, 405, requestId);
    }

    // ——— авторизация: X-Gateway-Secret / INGEST_TOKEN (владелец) / it_ (юзер) ———
    const queryToken = url.searchParams.get("token");
    const bearer = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "") || null;
    const gwSecret = env.GATEWAY_SECRET || null;
    const ingestToken = env.INGEST_TOKEN || null;
    const viaSecret = gwSecret ? await tokenMatches(request.headers.get("x-gateway-secret"), gwSecret) : false;
    const viaIngest = (bearer && ingestToken && (await tokenMatches(bearer, ingestToken))) ||
      (queryToken && ingestToken && (await tokenMatches(queryToken, ingestToken)));
    let ingestUserId = null; // канал владельца
    if (!viaSecret && !viaIngest) {
      const presented = bearer ?? queryToken;
      if (presented && IT_TOKEN_RE.test(presented)) {
        const userId = await verifyEdgeItToken(env, presented);
        if (userId == null) {
          return jsonResponse(
            { error: "Unauthorized: Invalid it_ ingest token (edge: SESSION_SECRET/User verification failed — Render channel remains available)" },
            401,
            requestId
          );
        }
        ingestUserId = userId;
      } else {
        return jsonResponse(
          {
            error: "Unauthorized",
            reason: ingestToken
              ? "Bearer INGEST_TOKEN / ?token= (SensorLogger) or X-Gateway-Secret required; per-user apiKey — only Bearer via Render /api/ingest"
              : "X-Gateway-Secret required (INGEST_TOKEN not configured on worker)",
          },
          401,
          requestId
        );
      }
    }

    // ——— deviceId/deviceName из query (C-21) ———
    const deviceId = url.searchParams.get("deviceId");
    if (!deviceId) {
      return jsonResponse({ error: "deviceId query param required. Example: ?deviceId=iphone-15-pro" }, 400, requestId);
    }
    if (!DEVICE_ID_RE.test(deviceId)) {
      return jsonResponse({ error: "Invalid deviceId: 1-64 chars, letters/digits/dots/dashes/colons/spaces only" }, 400, requestId);
    }
    const deviceNameRaw = url.searchParams.get("deviceName") || "SensorLogger";
    const deviceName = DEVICE_NAME_RE.test(deviceNameRaw) ? deviceNameRaw.slice(0, 128) : "SensorLogger";

    // ——— тело с капом (F20) → JSON ———
    const maxBytes = env.EDGE_INGEST_MAX_BYTES || EDGE_INGEST_MAX_BYTES;
    const raw = await readBodyCapped(request, maxBytes);
    if (raw == null) {
      return jsonResponse({ error: "Payload too large", limit: maxBytes }, 413, requestId);
    }
    let body = null;
    try {
      body = JSON.parse(raw);
    } catch {
      body = null;
    }
    if (!body) {
      return jsonResponse({ error: "Invalid JSON body" }, 400, requestId);
    }

    // ——— идемпотентность IngestMessage (быстрая проверка, R2) ———
    const msgId = body && typeof body === "object" && !Array.isArray(body) ? body.messageId : undefined;
    const hasMsgId = msgId != null && (typeof msgId === "number" || typeof msgId === "string");
    if (hasMsgId) {
      try {
        const seen = await env.DB.prepare("SELECT 1 FROM IngestMessage WHERE deviceId = ? AND messageId = ? LIMIT 1")
          .bind(deviceId, String(msgId)).first();
        if (seen) {
          return jsonResponse(
            { ok: true, duplicate: true, message: "Batch already processed (messageId seen)", deviceId, deviceName },
            200,
            requestId
          );
        }
      } catch { /* таблицы нет (старая БД) — продолжаем без идемпотентности */ }
    }

    // ——— извлечение точек (нативные контейнеры) ———
    const items = extractItems(body);
    if (!items || items.length === 0) {
      console.log(JSON.stringify({ level: "info", msg: "edge sensorlogger: empty/test push", requestId, deviceId, shape: typeof body }));
      return jsonResponse(
        { ok: true, test: true, message: "SensorLogger push test passed. Ready to receive GPS data.", deviceId, deviceName },
        200,
        requestId
      );
    }
    if (items.length > MAX_BATCH_ITEMS) {
      return jsonResponse({ error: "Too many points in batch", limit: MAX_BATCH_ITEMS, received: items.length }, 413, requestId);
    }

    const nowMs = Date.now();
    let droppedInaccurate = 0;
    let droppedUnparsed = 0;
    const points = [];
    for (const item of items) {
      const p = extractPoint(item, nowMs);
      if (p == null) {
        droppedUnparsed++;
        continue;
      }
      if (p.accuracy != null && p.accuracy > MAX_POINT_ACCURACY_M) {
        droppedInaccurate++;
        continue;
      }
      points.push(p);
    }
    if (points.length === 0) {
      console.log(JSON.stringify({
        level: "info", msg: "edge sensorlogger: no GPS in batch", requestId, deviceId,
        droppedInaccurate, droppedUnparsed, sample: describeItems(items).slice(0, 300),
      }));
      return jsonResponse(
        {
          ok: true,
          test: true,
          message: "No GPS points extracted from batch (missing location data). Push test passed.",
          deviceId,
          deviceName,
          payloadShape: describeItems(items).slice(0, 300),
        },
        200,
        requestId
      );
    }
    points.sort((a, b) => a.timestampMs - b.timestampMs);

    // ——— корреляция сессий (R4: гэп по GPS-времени) ———
    const sessionGapMs = Number(env.SESSION_GAP_MS) > 0 ? Number(env.SESSION_GAP_MS) : 60_000;
    const lookup = findActiveRecordingStatement(deviceId, ingestUserId);
    const recent = await env.DB.prepare(lookup.sql).bind(...lookup.args).first();

    let sessionId = null;
    let sessionStartMs = NaN;
    let sessionEndMs = NaN;
    let isNewSession = false;

    if (recent) {
      const row = recent;
      sessionStartMs = new Date(String(row.startTime)).getTime();
      sessionEndMs = row.endTime != null ? new Date(String(row.endTime)).getTime() : NaN;
      const firstBatchTs = points[0].timestampMs;
      const gapMs = Number.isFinite(sessionEndMs)
        ? firstBatchTs - sessionEndMs
        : nowMs - new Date(String(row.updatedAt)).getTime();
      if (gapMs < sessionGapMs) {
        sessionId = String(row.id); // продолжение (в т.ч. поздние батчи)
      } else {
        // Гэп ≥ SESSION_GAP_MS → НОВАЯ сессия. Финализация старой — жнецом
        // приложения (≤ ~10 мин; см. шапку «ЧЕСТНЫЕ ОТЛИЧИЯ» п.1).
        isNewSession = true;
      }
    } else {
      isNewSession = true;
    }

    if (isNewSession) {
      const newId = crypto.randomUUID();
      const create = createRecordingStatement({
        sessionId: newId,
        deviceId,
        clientId: crypto.randomUUID(),
        deviceName,
        startTimeIso: new Date(points[0].timestampMs).toISOString(),
        nowIso: new Date(nowMs).toISOString(),
        userId: ingestUserId,
      });
      const res = await env.DB.prepare(create.sql).bind(...create.args).run();
      if ((res.meta?.changes ?? 0) > 0) {
        sessionId = newId;
      } else {
        // Гонка: параллельный батч успел создать сессию — продолжаем ЕЁ
        const again = await env.DB.prepare(lookup.sql).bind(...lookup.args).first();
        if (again) {
          sessionId = String(again.id);
          isNewSession = false;
          sessionStartMs = new Date(String(again.startTime)).getTime();
          sessionEndMs = again.endTime != null ? new Date(String(again.endTime)).getTime() : NaN;
        } else {
          // крайне редкий кейс (сессию успели закрыть между SELECT и INSERT)
          sessionId = newId; // вставим точку в созданную выше (guard прошёл бы)
        }
      }
    }

    // ——— вставка точек чанками (C-16/F4) + монотонный UPDATE сессии (R11) ———
    const newIdFn = () => crypto.randomUUID();
    const pointStmts = pointInsertStatements(sessionId, points, newIdFn);
    for (const st of pointStmts) {
      await env.DB.prepare(st.sql).bind(...st.args).run();
    }

    const lastTs = points[points.length - 1].timestampMs;
    const firstTs = points[0].timestampMs;
    const currentStart = Number.isFinite(sessionStartMs) ? Math.min(sessionStartMs, firstTs) : firstTs;
    const currentEnd = Number.isFinite(sessionEndMs) ? Math.max(sessionEndMs, lastTs) : lastTs;
    await env.DB.prepare(
      "UPDATE Session SET startTime = ?, endTime = ?, pointCount = pointCount + ?, payloadBytes = payloadBytes + ?, updatedAt = ? WHERE id = ?"
    ).bind(
      new Date(currentStart).toISOString(),
      new Date(currentEnd).toISOString(),
      points.length,
      raw.length,
      new Date(nowMs).toISOString(),
      sessionId
    ).run();

    // ——— rollup-инкремент дня последней точки (§A1.5, зеркала bumpRollup) ———
    if ((env.EDGE_INGEST_ROLLUP_ENABLED || "true") === "true") {
      try {
        const day = rollupDayKey(lastTs, env.TELEMAT_TIMEZONE || "UTC");
        const uid = ingestUserId == null ? "" : String(ingestUserId);
        await env.DB.prepare(
          `INSERT INTO StatsRollup (day, userId, sessions, points, distanceM, durationSec, ecoSum, ecoCount, updatedAt)
           VALUES (?, ?, ?, ?, 0, 0, 0, 0, ?)
           ON CONFLICT(day, userId) DO UPDATE SET
             sessions = sessions + excluded.sessions,
             points = points + excluded.points,
             updatedAt = excluded.updatedAt`
        ).bind(day, uid, isNewSession ? 1 : 0, points.length, new Date(nowMs).toISOString()).run();
      } catch { /* rollup не критичен (зеркало приложения: сбой глотается) */ }
    }

    // ——— идемпотентность-запись ПОСЛЕ вставки точек (R2/MI-6) ———
    if (hasMsgId) {
      try {
        await env.DB.prepare("INSERT OR IGNORE INTO IngestMessage (deviceId, messageId, firstSeenAt) VALUES (?, ?, ?)")
          .bind(deviceId, String(msgId), new Date(nowMs).toISOString()).run();
      } catch { /* нет таблицы на старых БД — не фатально */ }
    }

    console.log(JSON.stringify({
      level: "info",
      msg: "edge sensorlogger ingest",
      requestId,
      sessionId,
      deviceId,
      deviceName,
      points: points.length,
      dropped: { inaccurate: droppedInaccurate, unparsed: droppedUnparsed },
      newSession: isNewSession,
      userId: ingestUserId,
      durationMs: Date.now() - startedAt,
    }));

    return jsonResponse(
      {
        ok: true,
        sessionId,
        pointsAccepted: points.length,
        newSession: isNewSession,
        deviceId,
        deviceName,
        status: "recording",
        edge: true,
      },
      isNewSession ? 201 : 200,
      requestId
    );
  } catch (err) {
    // Гонка идемпотентности (двойной ретрай): повторная проверка ledger
    try {
      const raceBody = await request.clone().json().catch(() => null);
      const url = new URL(request.url);
      const deviceId = url.searchParams.get("deviceId");
      if (raceBody && typeof raceBody.messageId !== "undefined" && deviceId) {
        const seen = await env.DB.prepare("SELECT 1 FROM IngestMessage WHERE deviceId = ? AND messageId = ? LIMIT 1")
          .bind(deviceId, String(raceBody.messageId)).first();
        if (seen) {
          return jsonResponse({ ok: true, duplicate: true, message: "Batch already processed (messageId seen)", deviceId }, 200, requestId);
        }
      }
    } catch { /* анализ гонки не удался — падаем в общую 500 */ }
    console.log(JSON.stringify({ level: "error", msg: "edge sensorlogger error", requestId, error: String((err && err.message) || err) }));
    return jsonResponse({ error: "Internal Server Error", requestId }, 500, requestId);
  }
}
