// src/lib/batch-points.ts — v2.19.0: ОБЩИЙ загрузчик для батч-роутов
// (/api/stats/batch, /api/events/batch, /api/track/batch): разбор ?ids=,
// меты сессий + GPS-точки ЧАНКАМИ ПАРАЛЛЕЛЬНО.
//
// Зачем чанкинг: один JOIN «Session LEFT JOIN GpsPoint» на 25k строк —
// ~10–22 с на проде (однопоточный разбор + сериализация на стороне Turso).
// Точки не требуют JOIN вовсе (ключ — sessionId), поэтому список делится на
// чанки по 8 id, каждый чанк — самостоятельный SELECT, все чанки летят
// ПАРАЛЛЕЛЬНО (Promise.all) по отдельным HTTP-запросам @libsql/client.
// Серверное время сжимается до времени самого медленного чанка; меты сессий
// — отдельный крошечный IN-запрос (50 строк максимум).
//
// Паритет с прежним LEFT JOIN: сессия без точек получает пустой points[]
// (раньше — одну NULL-строку); хронология точек внутри сессии сохраняется
// (каждый id входит ровно в один чанк, внутри чанка ORDER BY timestamp ASC).

import { libsql } from "./db";

export const BATCH_MAX_IDS = 50;
export const BATCH_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// Размер чанка point-запроса: 8 id ≈ 4–5k строк на прод-данных — достаточно
// мелко для параллелизма, достаточно крупно чтобы не плодить сотни запросов.
const POINTS_CHUNK = 8;

export interface BatchPointRow {
  lat: number;
  lon: number;
  speed: number | null;
  altitude: number | null;
  accuracy: number | null;
  bearing: number | null;
  timestamp: number;
}

export interface BatchSessionData {
  id: string;
  deviceId: string;
  startTime: string;
  endTime: string | null;
  deleted: boolean;
  routeHash: string | null;
  topologyHash: string | null;
  pointCount: number | null;
  points: BatchPointRow[];
}

export type IdsParseResult =
  | { ok: true; ids: string[] }
  | { ok: false; reason: string };

/** Разбор и валидация ?ids= — единые правила для всех батч-роутов. */
export function parseBatchIds(idsRaw: string): IdsParseResult {
  // URL-decoding уже выполнен searchParams; запятая — разделитель
  const ids = [...new Set(idsRaw.split(",").map((s) => s.trim()).filter(Boolean))];
  if (ids.length === 0) {
    return { ok: false, reason: "ids required (comma-separated session ids)" };
  }
  if (ids.length > BATCH_MAX_IDS) {
    return { ok: false, reason: `max ${BATCH_MAX_IDS} ids per request` };
  }
  if (ids.some((id) => !BATCH_ID_RE.test(id))) {
    return { ok: false, reason: "invalid id format" };
  }
  return { ok: true, ids };
}

/** Ключ TTL-кэша: отсортированный ids — порядок запроса не меняет результат. */
export function batchCacheKey(ids: string[]): string {
  return [...ids].sort().join(",");
}

function toNum(v: unknown): number {
  return Number(v);
}

function toNumOrNull(v: unknown): number | null {
  return v == null ? null : Number(v);
}

/**
 * Меты сессий + точки, чанками параллельно. Возвращает Map по id, включая
 * удалённые сессии (deleted: true) — фильтрация/missing решает вызывающий.
 * Несуществующие id в Map не попадают (→ missing).
 */
export async function loadSessionsForBatch(ids: string[]): Promise<Map<string, BatchSessionData>> {
  const out = new Map<string, BatchSessionData>();

  // ——— меты: один крошечный IN-запрос (≤50 строк) ———
  const metaPh = ids.map(() => "?").join(", ");
  const metaRes = await libsql.execute({
    sql: `SELECT id, deviceId, startTime, endTime, deletedAt, routeHash, topologyHash, pointCount
          FROM Session WHERE id IN (${metaPh})`,
    args: ids,
  });
  const order: string[] = [];
  for (const row of metaRes.rows as Record<string, unknown>[]) {
    const id = String(row.id);
    out.set(id, {
      id,
      deviceId: String(row.deviceId ?? ""),
      startTime: String(row.startTime),
      endTime: row.endTime == null ? null : String(row.endTime),
      deleted: row.deletedAt != null,
      routeHash: row.routeHash == null ? null : String(row.routeHash),
      topologyHash: row.topologyHash == null ? null : String(row.topologyHash),
      pointCount: row.pointCount == null ? null : Number(row.pointCount),
      points: [],
    });
    order.push(id);
  }

  // ——— точки: чанки по 8 id, параллельно ———
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += POINTS_CHUNK) {
    chunks.push(ids.slice(i, i + POINTS_CHUNK));
  }
  const pointResults = await Promise.all(
    chunks.map((chunk) => {
      const ph = chunk.map(() => "?").join(", ");
      return libsql.execute({
        sql: `SELECT sessionId, lat, lon, speed, altitude, accuracy, bearing, timestamp
              FROM GpsPoint WHERE sessionId IN (${ph})
              ORDER BY timestamp ASC`,
        args: chunk,
      });
    }),
  );
  for (const res of pointResults) {
    for (const row of res.rows as Record<string, unknown>[]) {
      const sid = String(row.sessionId);
      const entry = out.get(sid);
      if (!entry) continue; // точка осиротевшей сессии — не запрашивалась, пропускаем
      entry.points.push({
        lat: toNum(row.lat),
        lon: toNum(row.lon),
        speed: toNumOrNull(row.speed),
        altitude: toNumOrNull(row.altitude),
        accuracy: toNumOrNull(row.accuracy),
        bearing: toNumOrNull(row.bearing),
        timestamp: toNum(row.timestamp),
      });
    }
  }

  return out;
}
