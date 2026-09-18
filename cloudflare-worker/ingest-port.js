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
