// src/lib/route-comparison.ts — сравнительные метрики по routeHash-группам (методология §10.0–§10.6).
// Группировка концептуально одинаковых поездок по детерминированному routeHash (§10.0),
// агрегаты по ActiveDuration (§4.11), фильтр SessionReliability ≥ 0.6 (§10.1),
// Theil-Sen-тренд (§10.5), HotspotSegments P75 < 0.5 (§10.6).
// v2.38.1 (ревью F16/F19): производительность — чанковый добор точек (чанки по 8,
// конкурентность 4), caps на IN-списки ≤90, прореживание полилайна/точек + grid-индекс
// в computeGroupHotspots, LRU-кэш канонических полилайнов (см. локальные комментарии).
import pLimit from "p-limit";
import { libsql } from "./db";
import { sessionScopeSql, type DataScope } from "./scope";
import { pluralRu } from "./format"; // v2.16.0 (D-12): единая плюрализация
import { computeActiveTrip, computeMovingTime, type MethodologyPoint, type ActiveTrip, type MotionResult } from "./active-trip";
import {
  computeRouteTrendTheilSen,
  computeHotspotSegments,
  computeSessionReliability,
  completenessScore,
  gaps as computeGaps,
  type RouteTrendResult,
  type HotspotSegment,
} from "./metrics-methodology";
import { haversineM } from "./geo";
// v2.38.2 (ревью F68): местные час/день недели (TELEMAT_TIMEZONE) для бакетов
// §10.3/§10.4 — хелпер живёт в route-cache.ts (общий с ToD-бакетом кэша §13.4,
// лёгкий env-only импорт без db-цепочки).
import { localHour, localDow } from "./route-cache";

export interface GroupSession {
  sessionId: string;
  deviceId: string;
  startTime: number; // мс
  endTime: number | null; // мс
  activeDuration: number; // сек (§4.11)
  activeStartTime: number; // мс — для бакетирования §10.3
  distanceM: number;
  reliability: number | null; // SessionReliability 0..1 (для фильтра ≥ 0.6)
  hasActiveTrip: boolean;
}

export interface RouteGroupInfo {
  routeHash: string;
  topologyHash: string | null;
  sessionCount: number;
  firstSeen: string; // ISO
  lastSeen: string; // ISO
  avgActiveDurationSec: number | null;
  bestActiveDurationSec: number | null;
  worstActiveDurationSec: number | null;
  stdDevActiveDurationSec: number | null;
  avgDistanceM: number | null;
  startCoord: { lat: number; lon: number } | null;
  endCoord: { lat: number; lon: number } | null;
  deviceIds: string[];
  sessionIds: string[];
  // v2.9.1: прореженный полилайн активной части первой сессии группы (~24 точки) — для мини-карты в UI
  polylineSample: { lat: number; lon: number }[] | null;
}

const RELIABILITY_FLOOR = 0.6; // §10.1: в агрегат входят только сессии с SessionReliability ≥ 0.6

// ——— v2.38.1 (ревью F19): константы чанков/лимитов ———
// IN-списки D1 ≤100 параметров → чанки по 90 (запас); точки — мелкими чанками
// по 8 id (паттерн batch-points.ts: ~4–5k строк на прод-данных на чанк);
// конкурентность 4 — 8 групп heavy-segments × 4 запроса не выжигают пул шлюза.
const ID_CHUNK = 90;
const POINTS_CHUNK = 8;
const POINTS_CONCURRENCY = 4;

/** Точки сессий одним набором чанков (F19): map sessionId → точки (timestamp ASC).
 *  Каждая сессия входит ровно в один чанк → хронология внутри сессии сохраняется
 *  (тот же контракт, что loadSessionsForBatch из batch-points.ts). */
async function loadGroupPointsChunked(sessionIds: string[]): Promise<Map<string, MethodologyPoint[]>> {
  const out = new Map<string, MethodologyPoint[]>();
  if (sessionIds.length === 0) return out;
  const limit = pLimit(POINTS_CONCURRENCY);
  const chunks: string[][] = [];
  for (let i = 0; i < sessionIds.length; i += POINTS_CHUNK) chunks.push(sessionIds.slice(i, i + POINTS_CHUNK));
  await Promise.all(
    chunks.map((chunk) =>
      limit(async () => {
        const ph = chunk.map(() => "?").join(", ");
        const ptsRes = await libsql.execute({
          sql: `SELECT sessionId, lat, lon, speed, altitude, accuracy, bearing, timestamp
                FROM GpsPoint WHERE sessionId IN (${ph}) ORDER BY timestamp ASC`,
          args: chunk as never[],
        });
        for (const p of ptsRes.rows as Record<string, unknown>[]) {
          const sid = String(p.sessionId);
          const list = out.get(sid) ?? [];
          list.push({
            lat: Number(p.lat),
            lon: Number(p.lon),
            speed: p.speed == null ? null : Number(p.speed),
            altitude: p.altitude == null ? null : Number(p.altitude),
            accuracy: p.accuracy == null ? null : Number(p.accuracy),
            bearing: p.bearing == null ? null : Number(p.bearing),
            timestamp: Number(p.timestamp),
          });
          out.set(sid, list);
        }
      })
    )
  );
  return out;
}

// v2.12.0 (D-8): период-фильтр для route-агрегатов. «Месяца» больше нет —
// 4 периода согласованы с PeriodKey на клиенте.
// Возвращает ISO-строку: Session.startTime в SQLite — TEXT ISO-8601 UTC (C-4),
// аргументы-числа в libsql-фильтрах теряют строки (integer < text).
export type RoutePeriod = "today" | "week" | "d30" | "all";

export function routePeriodSinceIso(period: string | null, tzOffsetMin?: number): string | null {
  const now = Date.now();
  let since: number | null = null;
  switch (period) {
    case "today": {
      // v2.16.0 (B-4): полночь — в ЧАСОВОМ ПОЯСЕ КЛИЕНТА (tzOffsetMin, как
      // Date#getTimezoneOffset; 0 = UTC по умолчанию), ЧИСТАЯ UTC-арифметика.
      // Раньше new Date(y,m,d) брал СЕРВЕРНЫЙ пояс: на UTC-хостинге «сегодня»
      // для МСК начиналось в 03:00 — период-фильтр route-агрегатов расходился
      // с /api/stats и «батя-статс», которые считают в поясе клиента.
      const tzMs = (tzOffsetMin ?? 0) * 60_000;
      since = Math.floor((now - tzMs) / 86_400_000) * 86_400_000 + tzMs;
      break;
    }
    case "week":
      since = now - 7 * 86_400_000;
      break;
    case "d30":
      since = now - 30 * 86_400_000;
      break;
    case "all":
    default:
      since = null; // без фильтра (неизвестный параметр — как «all», обратная совместимость)
  }
  return since != null ? new Date(since).toISOString() : null;
}

// libsql-совместимый парсер дат: MIN/MAX возвращают ISO-строки, прямой SELECT — epoch int/BigInt
function toMs(v: unknown): number {
  if (v == null) return NaN;
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  const s = String(v);
  if (/^\d+$/.test(s)) return Number(s);
  return new Date(s).getTime();
}

// Загружает сессии routeHash-группы с вычислением ActiveTrip + SessionReliability (§11.6).
// GPS-точки читаются напрямую через libsql (без db-обёрток — полный контроль над выборкой).
// v2.12.0 (D-8): sinceIso — только сессии, начавшиеся не раньше (период-фильтр, ISO-строка).
// v2.23.0: scope — изоляция данных: чужие сессии в группу НЕ попадают
// (сравнение «поездка vs группа» считается только по своим поездкам).
export async function loadGroupSessions(
  routeHash: string,
  sinceIso?: string | null,
  scope?: DataScope
): Promise<GroupSession[]> {
  const sc = scope ? sessionScopeSql(scope) : { clause: "", args: [] as unknown[] };
  const sessRes = await libsql.execute({
    sql: sinceIso != null
      ? `SELECT id, deviceId, startTime, endTime FROM Session WHERE routeHash = ? AND deletedAt IS NULL AND startTime >= ?${sc.clause} ORDER BY startTime ASC`
      : `SELECT id, deviceId, startTime, endTime FROM Session WHERE routeHash = ? AND deletedAt IS NULL${sc.clause} ORDER BY startTime ASC`,
    args: (sinceIso != null ? [routeHash, sinceIso, ...sc.args] : [routeHash, ...sc.args]) as never[],
  });
  if (sessRes.rows.length === 0) return [];

  // v2.38.1 (ревью F19): точки — ОДНИМ набором чанков (по 8 id, конкурентность 4)
  // вместо N+1 последовательных SELECT (commuter-маршрут за год = сотни сессий
  // × ~200 мс RTT к D1-шлюзу = минуты; анти-паттерн, побеждённый batch-points.ts).
  // CPU-конвейер (ActiveTrip/SessionReliability) по каждой сессии — как раньше.
  const sessionIds = (sessRes.rows as Record<string, unknown>[]).map((s) => String(s.id));
  const pointsBySession = await loadGroupPointsChunked(sessionIds);

  const out: GroupSession[] = [];
  for (const row of sessRes.rows) {
    const s = row as unknown as Record<string, unknown>;
    const sessionId = String(s.id);
    const points: MethodologyPoint[] = pointsBySession.get(sessionId) ?? [];
    if (points.length < 2) continue;

    const motion = computeMovingTime(points);
    const active: ActiveTrip = computeActiveTrip(points, motion);
    if (!active.hasActiveTrip) continue;

    // Дистанция по активной части
    let distanceM = 0;
    for (let i = 1; i < points.length; i++) {
      if (points[i].timestamp < active.activeStartTime || points[i - 1].timestamp > active.activeEndTime) continue;
      distanceM += haversineM(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon);
    }

    // SessionReliability §11.6 (полный расчёт, синхронный)
    const durationSec = Math.max(1, (points[points.length - 1].timestamp - points[0].timestamp) / 1000);
    const gap = computeGaps(points);
    const cs = completenessScore(gap.totalMs, durationSec);
    const relResult = computeSessionReliability(points, cs, motion);

    out.push({
      sessionId,
      deviceId: String(s.deviceId),
      startTime: toMs(s.startTime),
      endTime: s.endTime == null ? null : toMs(s.endTime),
      activeDuration: active.activeDuration,
      activeStartTime: active.activeStartTime,
      distanceM: Math.round(distanceM),
      reliability: relResult.value,
      hasActiveTrip: true,
    });
  }
  return out;
}

// === §10.1/§10.2: RouteAvg/Best/Worst/StdDev по activeDuration ===
export interface DurationStats {
  avg: number | null;
  best: number | null;
  worst: number | null;
  stdDev: number | null;
  eligibleCount: number; // сессии с reliability ≥ 0.6
  totalCount: number;
}

export function routeDurationStats(sessions: GroupSession[]): DurationStats {
  const eligible = sessions.filter((s) => s.reliability == null || s.reliability >= RELIABILITY_FLOOR);
  const pool = eligible.length > 0 ? eligible : sessions; // если все ненадёжны — показываем все с пометкой
  const durations = pool.map((s) => s.activeDuration);
  if (durations.length === 0) {
    return { avg: null, best: null, worst: null, stdDev: null, eligibleCount: 0, totalCount: sessions.length };
  }
  const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
  const variance = durations.length > 1
    ? durations.reduce((a, b) => a + (b - avg) ** 2, 0) / (durations.length - 1)
    : 0;
  // v2.38.2 (ревью F72): best/worst — циклом, без Math.min(...durations)/
  // Math.max(...) спреда: spread на большой routeHash-группе (год commuting-маршрута
  // = сотни/тысячи сессий) роняет движок RangeError (максимум аргументов call);
  // тот же класс бага уже чинился в session-stats.ts (v2.29.0 MI-10) и
  // shared-view.tsx (v2.38.1 F21) — здесь был последний спред-occurrence.
  let best = durations[0];
  let worst = durations[0];
  for (const d of durations) {
    if (d < best) best = d;
    if (d > worst) worst = d;
  }
  return {
    avg: Math.round(avg),
    best: Math.round(best),
    worst: Math.round(worst),
    stdDev: Math.round(Math.sqrt(variance)),
    eligibleCount: eligible.length,
    totalCount: sessions.length,
  };
}

// === §10.3: RouteTrafficPattern — 8 бакетов по 3 часа (по ActiveStartTime) ===
export interface TrafficBucket {
  bucket: number; // 0..7 (0-3, 3-6, … 21-24)
  label: string; // "0–3", …
  avgActiveDurationSec: number | null;
  sessionCount: number;
}

const BUCKET_LABELS = ["0–3", "3–6", "6–9", "9–12", "12–15", "15–18", "18–21", "21–24"];

export function routeTrafficPattern(sessions: GroupSession[]): TrafficBucket[] {
  const buckets: { durations: number[] }[] = Array.from({ length: 8 }, () => ({ durations: [] }));
  for (const s of sessions) {
    // v2.38.2 (ревью F68): бакеты — по МЕСТНОМУ времени (TELEMAT_TIMEZONE,
    // дефолт Europe/Saratov — гражданские «утренний пик 6–9» и т.д.). Прежнее
    // new Date(...).getHours() брало СЕРВЕРНЫЙ пояс: на UTC-хостинге (Render)
    // пики сдвигались на 3–4 ч и расходились с локальным временем UI
    // (клиент форматирует в поясе браузера). Б-4-подход «передать tzOffsetMin
    // с клиента» для агрегатов не годится: паттерн — детерминированный агрегат
    // истории, а не граница «сегодня» — пояс фиксируется оператором в env.
    const hour = localHour(s.activeStartTime);
    buckets[Math.floor(hour / 3)].durations.push(s.activeDuration);
  }
  return buckets.map((b, i) => ({
    bucket: i,
    label: BUCKET_LABELS[i],
    avgActiveDurationSec: b.durations.length > 0 ? Math.round(b.durations.reduce((a, c) => a + c, 0) / b.durations.length) : null,
    sessionCount: b.durations.length,
  }));
}

// === §10.4: RouteDayOfWeekPattern — по дням недели (по ActiveStartTime) ===
export interface DowBucket {
  dow: number; // 1..7 (пн..вс)
  label: string;
  avgActiveDurationSec: number | null;
  sessionCount: number;
}

const DOW_LABELS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

export function routeDayOfWeekPattern(sessions: GroupSession[]): DowBucket[] {
  const buckets: { durations: number[] }[] = Array.from({ length: 7 }, () => ({ durations: [] }));
  for (const s of sessions) {
    // v2.38.2 (ревью F68): день недели — тоже местный (раньше getDay() серверного
    // пояса: поездка 00:30 МСК попадала в «воскресенье» вместо «понедельника»);
    // localDow уже возвращает 0=пн..6=вс — маппинг ниже не нужен.
    buckets[localDow(s.activeStartTime)].durations.push(s.activeDuration);
  }
  return buckets.map((b, i) => ({
    dow: i + 1,
    label: DOW_LABELS[i],
    avgActiveDurationSec: b.durations.length > 0 ? Math.round(b.durations.reduce((a, c) => a + c, 0) / b.durations.length) : null,
    sessionCount: b.durations.length,
  }));
}

// === §10.5: RouteTrend (Theil-Sen) — переиспользует реализацию metrics-methodology ===
export function routeTrend(sessions: GroupSession[]): RouteTrendResult {
  return computeRouteTrendTheilSen(
    sessions.map((s) => ({ date: new Date(s.activeStartTime), activeDurationSec: s.activeDuration }))
  );
}

// === §10.6: HotspotSegments (P75 < 0.5) ===
// Сегментная модель: канонический полилайн из последнего завершённого TrafficJob группы;
// severity сегмента в сессии = фактическая скорость сегмента / плановая скорость.
// Фактическая — из GPS-точек сессии, привязанных к сегменту (ближайший, радиус снапа ~55 м).
const SNAP_RADIUS_M = 55; // snap-to-grid ~55 м (совпадает с кэшем маршрутизации)
const PLAN_BASELINE_KMH = 40; // §3.2: базовая линия гаверсинус/40 км/ч

// Канонический полилайн группы: из последнего completed TrafficJob (сегменты маршрута),
// fallback — активная часть первой сессии (прорежено до ~40 точек).
// v2.38.1 (ревью F19): опциональный cacheKey (routeHash) — LRU-кэш: SELECT result
// + JSON.parse — самый тяжёлый шаг §10.6, а heavy-segments зовёт его ×8 групп
// каждые N секунд; ключ включает sessionCount (инвалидация при изменении состава
// группы), TTL страхует от дрейфа данных между запросами. Маленький (16 записей).
const POLYLINE_CACHE_MAX = 16;
const POLYLINE_CACHE_TTL_MS = 60_000;
const polylineCache = new Map<string, { polyline: { lat: number; lon: number }[]; planDurationSec: number | null; ts: number }>();

export async function canonicalGroupPolyline(
  sessions: GroupSession[],
  cacheKey?: string
): Promise<{ polyline: { lat: number; lon: number }[]; planDurationSec: number | null }> {
  // v2.38.1 (F19): кэш — только с явным ключом (иначе поведение как раньше)
  if (cacheKey) {
    const key = `${cacheKey}:${sessions.length}`;
    const hit = polylineCache.get(key);
    if (hit && Date.now() - hit.ts < POLYLINE_CACHE_TTL_MS) {
      // LRU-обновление позиции (Map хранит порядок вставки)
      polylineCache.delete(key);
      polylineCache.set(key, hit);
      return { polyline: hit.polyline, planDurationSec: hit.planDurationSec };
    }
  }
  let polyline: { lat: number; lon: number }[] = [];
  let planDurationSec: number | null = null;
  if (sessions.length > 0) {
    const ids = sessions.map((s) => s.sessionId);
    // v2.38.1 (ревью F19): IN-список чанками ≤90 (лимит параметров D1 ≤100:
    // >100 сессий группы → 500 всего роута). «Последний completed» выбирается
    // по updatedAt МАКСИМУМОМ по всем чанкам (прежний LIMIT 1 + глобальный
    // ORDER BY на >100 id и не исполнялся бы вовсе).
    let bestRow: { result: string | null; updatedAt: string } | null = null;
    for (let i = 0; i < ids.length; i += ID_CHUNK) {
      const chunk = ids.slice(i, i + ID_CHUNK);
      const ph = chunk.map(() => "?").join(",");
      const jobRes = await libsql.execute({
        sql: `SELECT result, updatedAt FROM TrafficJob WHERE status = 'completed' AND result IS NOT NULL AND sessionId IN (${ph}) ORDER BY updatedAt DESC`,
        args: chunk as never[],
      });
      for (const r of jobRes.rows as Record<string, unknown>[]) {
        const updatedAt = String(r.updatedAt ?? "");
        if (bestRow == null || updatedAt > bestRow.updatedAt) {
          bestRow = { result: r.result == null ? null : String(r.result), updatedAt };
        }
      }
    }
    if (bestRow != null && bestRow.result != null) {
      try {
        // v2.18.0 (P1): парсим ПОЛЕ result, а не объект Row (`String(row)` для
        // объекта libsql-строки = "[object Object]" → JSON.parse всегда бросал
        // → §10.6-дизайн TrafficJob-сегментов был мёртвым кодом до v2.18).
        const parsed = JSON.parse(bestRow.result);
        if (Array.isArray(parsed.segments)) {
          polyline = parsed.segments.map((sg: { lat: number; lon: number }) => ({ lat: Number(sg.lat), lon: Number(sg.lon) }));
        }
        if (typeof parsed.planDurationSec === "number") planDurationSec = parsed.planDurationSec;
      } catch { /* битый result — fallback ниже */ }
    }
  }

  // Fallback: полилайн из активных частей сессий (первая сессия группы)
  if (polyline.length < 2 && sessions.length > 0) {
    const ptsRes = await libsql.execute({
      sql: "SELECT lat, lon, timestamp FROM GpsPoint WHERE sessionId = ? ORDER BY timestamp ASC",
      args: [sessions[0].sessionId],
    });
    polyline = ptsRes.rows.map((r) => {
      const p = r as unknown as Record<string, unknown>;
      return { lat: Number(p.lat), lon: Number(p.lon) };
    });
    // прореживание до ~40 точек
    if (polyline.length > 40) {
      const step = Math.ceil(polyline.length / 40);
      polyline = polyline.filter((_, i) => i % step === 0 || i === polyline.length - 1);
    }
  }
  // v2.38.1 (F19): запись в LRU-кэш (только с ключом)
  if (cacheKey) {
    const key = `${cacheKey}:${sessions.length}`;
    polylineCache.set(key, { polyline, planDurationSec, ts: Date.now() });
    while (polylineCache.size > POLYLINE_CACHE_MAX) {
      const oldest = polylineCache.keys().next().value;
      if (oldest == null) break;
      polylineCache.delete(oldest);
    }
  }
  return { polyline, planDurationSec };
}

// Полилайн активной части сессии, прореженный до maxPoints (для мини-карты в списке групп).
export async function sessionPolylineSample(
  sessionId: string,
  activeStartMs: number,
  activeEndMs: number,
  maxPoints = 24
): Promise<{ lat: number; lon: number }[] | null> {
  const ptsRes = await libsql.execute({
    sql: "SELECT lat, lon, timestamp FROM GpsPoint WHERE sessionId = ? AND timestamp >= ? AND timestamp <= ? ORDER BY timestamp ASC",
    args: [sessionId, Math.round(activeStartMs), Math.round(activeEndMs)],
  });
  const pts = ptsRes.rows.map((r) => {
    const p = r as unknown as Record<string, unknown>;
    return { lat: Number(p.lat), lon: Number(p.lon) };
  });
  if (pts.length < 2) return null;
  if (pts.length <= maxPoints) return pts;
  const step = Math.ceil(pts.length / maxPoints);
  const thinned = pts.filter((_, i) => i % step === 0);
  if (thinned[thinned.length - 1] !== pts[pts.length - 1]) thinned.push(pts[pts.length - 1]);
  return thinned;
}

export interface HotspotWithGeometry extends HotspotSegment {
  // v2.9.1: геометрия сегмента для мини-карты с severity-подсветкой (§10.6)
  a: { lat: number; lon: number } | null;
  b: { lat: number; lon: number } | null;
}

// ——— v2.38.1 (ревью F16): производительность §10.6 ———
// Проблема: на каждую GPS-точку — ЛИНЕЙНЫЙ скан всех сегментов полилайна 2ГИС
// (тысячи координат ~ каждые 10 м), 3 гаверсинуса на пару: 5000 точек ×
// 2000 сегментов ≈ 30М триг-вызовов ≈ десятки секунд блокировки event loop на
// 0.1-CPU Render — инжест в том же процессе замирал, api_latency_p95 firing.
// Решение (результаты ПРИБЛИЖИТЕЛЬНО равны, см. ниже):
//   • полилайн прореживается равномерным шагом ~50 м (сегментов в ~5 раз меньше;
//     снап-радиус 55 м больше шага — точность привязки сохраняется);
//   • точки сессий прореживаются до ≤1 Гц (SensorLogger и так 1 Гц; режутся
//     только дубли офлайн-буфера SensorLogger);
//   • grid-индекс ~111×64 м: клетка → индексы сегментов (концы + середина);
//     точка проверяет свою клетку + 8 соседей. Инвариант: SNAP_RADIUS(55) <
//     минимальной стороны клетки (64 м по долготе на широте 55°) → любой
//     сегмент с вершиной ≤ 55 м гарантированно в 9 клетках точки → ФИЛЬТР НЕ
//     МЕНЯЕТ результат линейного скана (та же метрика min(a,b,mid));
//   • общий бюджет точек на группу (MAX_HOTSPOT_POINTS): экстремально большие
//     группы считают самые свежие сессии (хотспоты — витрина «здесь медленно
//     сейчас», свежесть важнее полноты истории).
const HOTSPOT_POLYLINE_STEP_M = 50;
const HOTSPOT_MAX_POINTS = 20_000;
const GRID_CELL_DEG = 0.001; // ~111×64 м — инвариант SNAP_RADIUS_M < сторона клетки

/** Равномерное прореживание полилайна: точка оставляется, когда удалилась
 *  ≥ stepM от последней оставленной; первая/последняя — всегда. */
function downsamplePolyline(polyline: { lat: number; lon: number }[], stepM: number): { lat: number; lon: number }[] {
  if (polyline.length <= 2) return polyline;
  const out: { lat: number; lon: number }[] = [polyline[0]];
  let last = polyline[0];
  for (let i = 1; i < polyline.length - 1; i++) {
    if (haversineM(last.lat, last.lon, polyline[i].lat, polyline[i].lon) >= stepM) {
      out.push(polyline[i]);
      last = polyline[i];
    }
  }
  out.push(polyline[polyline.length - 1]);
  return out;
}

/** Прореживание точек до ≤1 Гц (первая точка каждой секундной корзины; вход — timestamp ASC). */
function thinTo1Hz<T extends { timestamp: number }>(points: T[]): T[] {
  if (points.length <= 2) return points;
  const out: T[] = [points[0]];
  let lastTs = points[0].timestamp;
  for (let i = 1; i < points.length; i++) {
    if (points[i].timestamp - lastTs >= 1000) {
      out.push(points[i]);
      lastTs = points[i].timestamp;
    }
  }
  return out;
}

/** Ключ grid-клетки ~100 м (lat/lon независимо). */
function cellKey(lat: number, lon: number): string {
  return `${Math.floor(lat / GRID_CELL_DEG)},${Math.floor(lon / GRID_CELL_DEG)}`;
}

export async function computeGroupHotspots(routeHash: string, sessions: GroupSession[]): Promise<{
  hotspots: HotspotWithGeometry[];
  totalSegments: number;
  polyline: { lat: number; lon: number }[];
}> {
  // 1. Канонический полилайн — из последнего completed TrafficJob сессий группы.
  // v2.38.1 (F19): LRU-кэш по routeHash (см. canonicalGroupPolyline);
  // v2.38.1 (F16): равномерное прореживание ~50 м (сегментов в ~5 раз меньше).
  const { polyline: rawPolyline, planDurationSec } = await canonicalGroupPolyline(sessions, routeHash);
  const polyline = downsamplePolyline(rawPolyline, HOTSPOT_POLYLINE_STEP_M);
  if (polyline.length < 2) return { hotspots: [], totalSegments: 0, polyline: [] };

  // 2. Сегменты канонического полилайна: дистанция + плановая скорость
  const segs: { id: string; a: { lat: number; lon: number }; b: { lat: number; lon: number }; distanceM: number; planSpeedKmh: number }[] = [];
  let totalLen = 0;
  for (let i = 1; i < polyline.length; i++) {
    const d = haversineM(polyline[i - 1].lat, polyline[i - 1].lon, polyline[i].lat, polyline[i].lon);
    if (d < 5) continue; // джиттер-точки
    totalLen += d;
    segs.push({ id: `s${i - 1}`, a: polyline[i - 1], b: polyline[i], distanceM: d, planSpeedKmh: PLAN_BASELINE_KMH });
  }
  // Если провайдер дал план по времени — пропорционально распределить плановую скорость
  if (planDurationSec != null && planDurationSec > 0 && totalLen > 0) {
    const avgPlanKmh = (totalLen / 1000) / (planDurationSec / 3600);
    for (const sg of segs) sg.planSpeedKmh = Math.max(5, avgPlanKmh);
  }

  // v2.38.1 (F16): grid-индекс — клетка → индексы сегментов (концы + середина).
  // Сегменты после прореживания ~50 м → концы+середина покрывают клетки сегмента.
  const grid = new Map<string, number[]>();
  segs.forEach((sg, si) => {
    const mid = { lat: (sg.a.lat + sg.b.lat) / 2, lon: (sg.a.lon + sg.b.lon) / 2 };
    const keys = new Set([cellKey(sg.a.lat, sg.a.lon), cellKey(sg.b.lat, sg.b.lon), cellKey(mid.lat, mid.lon)]);
    for (const key of keys) {
      const arr = grid.get(key) || [];
      arr.push(si);
      grid.set(key, arr);
    }
  });
  // Клетки-соседи точки: своя + 8 вокруг (±1 по каждой оси). Кандидаты —
  // ОТСОРТИРОВАННЫЕ по возрастанию индекса и дедуплицированные: соседние
  // сегменты делят общую вершину → у точки бывают РАВНЫЕ метрики дистанции
  // (тай) — линейный скан (возрастание + строгий «<») разрешает тай в меньший
  // индекс; тот же порядок здесь делает результат побайтово идентичным.
  const neighborhood = (lat: number, lon: number): number[] => {
    const cLat = Math.floor(lat / GRID_CELL_DEG);
    const cLon = Math.floor(lon / GRID_CELL_DEG);
    const out = new Set<number>();
    for (let dLat = -1; dLat <= 1; dLat++) {
      for (let dLon = -1; dLon <= 1; dLon++) {
        const arr = grid.get(`${cLat + dLat},${cLon + dLon}`);
        if (arr) for (const si of arr) out.add(si);
      }
    }
    return [...out].sort((a, b) => a - b);
  };

  // v2.38.1 (F19): точки всех сессий — чанковым добором (как loadGroupSessions),
  // а НЕ N+1 последовательных SELECT (тот же анти-паттерн, ×N сессий).
  const pointsBySession = await loadGroupPointsChunked(sessions.map((s) => s.sessionId));

  // 3. Фактические скорости: GPS-точки сессий → ближайшие сегменты
  const severityHist = new Map<string, number[]>();
  let pointsBudget = HOTSPOT_MAX_POINTS; // v2.38.1 (F16): общий кап точек на группу
  // Бюджет тратится от СВЕЖИХ к старым (sessions — startTime ASC): хотспоты —
  // витрина «здесь медленно сейчас», свежесть важнее полноты истории.
  for (let si = sessions.length - 1; si >= 0; si--) {
    const s = sessions[si];
    if (pointsBudget <= 0) break;
    const points = thinTo1Hz(
      (pointsBySession.get(s.sessionId) ?? []).map((p) => ({
        lat: p.lat,
        lon: p.lon,
        speed: p.speed,
        timestamp: p.timestamp,
      }))
    );
    if (points.length < 2) continue;
    pointsBudget -= points.length;

    // Раскладываем точки по сегментам (ближайший в радиусе снапа).
    // v2.38.1 (F16): кандидаты — только сегменты 9 соседних клеток (инвариант
    // см. выше: результат идентичен линейному скану при том же наборе сегментов);
    // метрика расстояния ДОСЛОВНО прежняя (min из a/b/mid).
    const segPoints = new Map<number, { lat: number; lon: number; timestamp: number }[]>();
    for (const p of points) {
      let bestIdx = -1;
      let bestDist = Infinity;
      for (const si of neighborhood(p.lat, p.lon)) {
        const sg = segs[si];
        // расстояние точки до сегмента (приближение: до середины + до концов)
        const mid = { lat: (sg.a.lat + sg.b.lat) / 2, lon: (sg.a.lon + sg.b.lon) / 2 };
        const d = Math.min(
          haversineM(p.lat, p.lon, sg.a.lat, sg.a.lon),
          haversineM(p.lat, p.lon, sg.b.lat, sg.b.lon),
          haversineM(p.lat, p.lon, mid.lat, mid.lon)
        );
        if (d < bestDist) { bestDist = d; bestIdx = si; }
      }
      if (bestIdx >= 0 && bestDist <= SNAP_RADIUS_M) {
        const arr = segPoints.get(bestIdx) || [];
        arr.push({ lat: p.lat, lon: p.lon, timestamp: p.timestamp });
        segPoints.set(bestIdx, arr);
      }
    }

    // Скорость сегмента: дистанция между первой/последней точкой / время
    for (const si of Array.from(segPoints.keys())) {
      const pts = segPoints.get(si)!;
      if (pts.length < 2) continue;
      const sg = segs[si];
      const first = pts[0];
      const last = pts[pts.length - 1];
      const dtSec = (last.timestamp - first.timestamp) / 1000;
      if (dtSec <= 1) continue;
      const dM = haversineM(first.lat, first.lon, last.lat, last.lon);
      const actualKmh = (dM / 1000) / (dtSec / 3600);
      if (actualKmh > 150) continue; // выброс (GPS-телепорт)
      const severity = Math.min(1, actualKmh / sg.planSpeedKmh);
      const arr = severityHist.get(sg.id) || [];
      arr.push(Math.round(severity * 1000) / 1000);
      severityHist.set(sg.id, arr);
    }
  }

  const history = Array.from(severityHist.entries()).map(([segmentId, severities]) => ({ segmentId, severities }));
  const raw = computeHotspotSegments(history).sort((a, b) => a.p75 - b.p75); // по «тяжести» §10.6
  // v2.9.1: обогащаем хотспоты геометрией сегмента (для severity-подсветки на мини-карте)
  const segById = new Map(segs.map((sg) => [sg.id, sg]));
  const hotspots: HotspotWithGeometry[] = raw.map((h) => {
    const sg = segById.get(h.segmentId);
    return { ...h, a: sg ? sg.a : null, b: sg ? sg.b : null };
  });
  return { hotspots, totalSegments: segs.length, polyline };
}

// === Список всех групп (для UI) ===
// v2.12.0 (D-8): sinceIso — ограничить выборку сессиями периода (группы без
// сессий в периоде исчезают из ответа). v2.12.0 (D-7): группы обрабатываются
// параллельно (Promise.all) вместо последовательного цикла — 8 групп больше
// не ждут друг друга (~8 с → ~1 с).
// v2.23.0: scope — изоляция данных: группы строятся только по видимым сессиям.
export async function listRouteGroups(sinceIso?: string | null, scope?: DataScope): Promise<RouteGroupInfo[]> {
  const sc = scope ? sessionScopeSql(scope) : { clause: "", args: [] as unknown[] };
  const res = await libsql.execute(
    sinceIso != null
      ? {
          sql: `
            SELECT routeHash, topologyHash, COUNT(*) as cnt,
                   MIN(startTime) as firstSeen, MAX(startTime) as lastSeen,
                   GROUP_CONCAT(DISTINCT deviceId) as devices,
                   GROUP_CONCAT(id) as ids
            FROM Session
            WHERE routeHash IS NOT NULL AND deletedAt IS NULL AND startTime >= ?${sc.clause}
            GROUP BY routeHash
            ORDER BY lastSeen DESC
          `,
          args: [sinceIso, ...sc.args] as never[],
        }
      : {
          sql: `
            SELECT routeHash, topologyHash, COUNT(*) as cnt,
                   MIN(startTime) as firstSeen, MAX(startTime) as lastSeen,
                   GROUP_CONCAT(DISTINCT deviceId) as devices,
                   GROUP_CONCAT(id) as ids
            FROM Session
            WHERE routeHash IS NOT NULL AND deletedAt IS NULL${sc.clause}
            GROUP BY routeHash
            ORDER BY lastSeen DESC
          `,
          args: [...sc.args] as never[],
        }
  );
  const groups: RouteGroupInfo[] = [];
  for (const row of res.rows) {
    const r = row as unknown as Record<string, unknown>;
    const routeHash = String(r.routeHash);
    const ids = String(r.ids || "").split(",").filter(Boolean);
    const firstSeen = toMs(r.firstSeen);
    const lastSeen = toMs(r.lastSeen);
    const info: RouteGroupInfo = {
      routeHash,
      topologyHash: r.topologyHash == null ? null : String(r.topologyHash),
      sessionCount: Number(r.cnt),
      firstSeen: new Date(firstSeen).toISOString(),
      lastSeen: new Date(lastSeen).toISOString(),
      avgActiveDurationSec: null,
      bestActiveDurationSec: null,
      worstActiveDurationSec: null,
      stdDevActiveDurationSec: null,
      avgDistanceM: null,
      startCoord: null,
      endCoord: null,
      deviceIds: String(r.devices || "").split(",").filter(Boolean),
      sessionIds: ids,
      polylineSample: null,
    };
    groups.push(info);
  }

  // Детали (ActiveTrip-агрегаты) — только для групп ≤ 12 сессий, чтобы endpoint оставался лёгким.
  // v2.12.0 (D-7): параллельно — раньше последовательный await в цикле.
  // v2.18.0 (P1): КАП на число деталей (MAX_DETAIL_GROUPS = 8, как в
  // heavy-segments): без него список из сотен групп разворачивался в
  // НЕОГРАНИЧЕННЫЙ Promise.all, каждый элемент — N+1 точек по сессиям →
  // 1000+ последовательных HTTPS-раундтрипов к Turso и неограниченная
  // память ответа. Список групп отдаётся целиком, детали — топ по freshности.
  const detailGroups = groups
    .filter((g) => g.sessionIds.length > 0 && g.sessionIds.length <= 12)
    .slice(0, 8);
  const details = await Promise.all(
    detailGroups.map(async (info) => {
      const sessions = await loadGroupSessions(info.routeHash, sinceIso);
      const stats = routeDurationStats(sessions);
      info.avgActiveDurationSec = stats.avg;
      info.bestActiveDurationSec = stats.best;
      info.worstActiveDurationSec = stats.worst;
      info.stdDevActiveDurationSec = stats.stdDev;
      info.avgDistanceM = sessions.length > 0 ? Math.round(sessions.reduce((a, s) => a + s.distanceM, 0) / sessions.length) : null;
      if (sessions.length > 0) {
        // Старт/финиш первой сессии группы (для мини-карты/подписи)
        const ptsRes = await libsql.execute({
          sql: "SELECT lat, lon FROM GpsPoint WHERE sessionId = ? ORDER BY timestamp ASC LIMIT 1",
          args: [sessions[0].sessionId],
        });
        if (ptsRes.rows.length > 0) {
          const p = ptsRes.rows[0] as unknown as Record<string, unknown>;
          info.startCoord = { lat: Number(p.lat), lon: Number(p.lon) };
        }
        const ptsRes2 = await libsql.execute({
          sql: "SELECT lat, lon FROM GpsPoint WHERE sessionId = ? ORDER BY timestamp DESC LIMIT 1",
          args: [sessions[sessions.length - 1].sessionId],
        });
        if (ptsRes2.rows.length > 0) {
          const p = ptsRes2.rows[0] as unknown as Record<string, unknown>;
          info.endCoord = { lat: Number(p.lat), lon: Number(p.lon) };
        }
        // v2.9.1: полилайн активной части первой сессии (для мини-карты в карточке группы)
        const first = sessions[0];
        info.polylineSample = await sessionPolylineSample(
          first.sessionId,
          first.activeStartTime,
          first.activeStartTime + first.activeDuration * 1000
        );
      }
      return info;
    })
  );
  void details; // info-объекты мутируются на месте (в groups)
  return groups;
}

// v2.18.0: groupRouteGpx УДАЛЁН — обслуживал /api/routes/[id]/gpx, удалённый в v2.16.0 (0 потребителей).

// === Сравнение конкретной сессии с её группой (route-comparison endpoint) ===
export interface RouteComparison {
  sessionId: string;
  routeHash: string;
  groupSize: number;
  stats: DurationStats;
  sessionActiveDurationSec: number;
  rank: number | null; // 1 = лучшая (самая быстрая)
  percentile: number | null; // 0..100 (позиция в группе)
  vsAvgPct: number | null; // % отклонения от среднего
  trafficPattern: TrafficBucket[];
  dayOfWeekPattern: DowBucket[];
  trend: RouteTrendResult;
  history: { sessionId: string; date: string; activeDurationSec: number; deviceId: string }[];
}

export async function compareSessionWithGroup(sessionId: string, scope?: DataScope): Promise<RouteComparison | null> {
  // v2.23.0: скоуп применяется и к самой сессии (чужая → null → 404 на роуте),
  // и к группе сравнения (чужие поездки не участвуют в агрегатах)
  const sc = scope ? sessionScopeSql(scope) : { clause: "", args: [] as unknown[] };
  const sessRes = await libsql.execute({
    sql: `SELECT id, routeHash FROM Session WHERE id = ? AND deletedAt IS NULL${sc.clause}`,
    args: [sessionId, ...sc.args] as never[],
  });
  if (sessRes.rows.length === 0) return null;
  const routeHash = (sessRes.rows[0] as unknown as Record<string, unknown>).routeHash;
  if (!routeHash) return null;

  const sessions = await loadGroupSessions(String(routeHash), null, scope);
  const me = sessions.find((s) => s.sessionId === sessionId);
  if (!me) return null;

  const stats = routeDurationStats(sessions);
  const durations = [...sessions].sort((a, b) => a.activeDuration - b.activeDuration);
  const rank = durations.findIndex((s) => s.sessionId === sessionId) + 1;
  const percentile = durations.length > 1 ? Math.round(((rank - 1) / (durations.length - 1)) * 100) : null;
  const vsAvgPct = stats.avg != null && stats.avg > 0
    ? Math.round(((me.activeDuration - stats.avg) / stats.avg) * 1000) / 10
    : null;

  return {
    sessionId,
    routeHash: String(routeHash),
    groupSize: sessions.length,
    stats,
    sessionActiveDurationSec: Math.round(me.activeDuration),
    rank: rank > 0 ? rank : null,
    percentile,
    vsAvgPct,
    trafficPattern: routeTrafficPattern(sessions),
    dayOfWeekPattern: routeDayOfWeekPattern(sessions),
    trend: routeTrend(sessions),
    history: [...sessions]
      .sort((a, b) => a.activeStartTime - b.activeStartTime)
      .map((s) => ({
        sessionId: s.sessionId,
        date: new Date(s.activeStartTime).toISOString(),
        activeDurationSec: Math.round(s.activeDuration),
        deviceId: s.deviceId,
      })),
  };
}
