// GET /api/stats/batya — «батя-статс»: сводка водителя за всё время / сегодня /
// 7 дней / 30 дней + рекорды + уровень бати.
// v2.17.0 (историческая справка): владелец писал «сделай батч статс эндпойнт» —
// про БАТЧ-статистику (см. /api/stats/batch); «батя» — моё неверное прочтение
// сленга. Эндпоинт оставлен: работает, верифицирован, геймификация уровней
// («Пешеход» → «Легенда гаража») владельцу понравилась на проде.
//
// Метрики — те же канонические формулы, что в /api/sessions/[id]/stats и в
// период-агрегате «Аналитики» (v4-hooks.ts), поэтому цифры сходятся с UI:
//   distanceKm — Σ активных дистанций (§4.2 + окно §4.11, FIX-C1);
//   durationSec — Σ длительностей записей (§4.1, «всего»);
//   activeSec — Σ активных частей (§4.11, «в поездках»);
//   avgSpeedKmh — Σ дистанций / Σ активных (§4.3, FIX-C1);
//   maxSpeedKmh — §4.4 с анти-джиттером (normalizeSessionSpeeds + median3);
//   ecoScore — §7.3 CAP с corpus-калибровкой (калибровка в том же проходе,
//     как getCorpusEcoBaselines в stats-роуте; env ECO_SCORE_CAP_BASELINE
//     переопределяет); агрегат — взвешенное среднее по активной длительности
//     (wavg), как период-агрегат Аналитики.
//
// «Сегодня» — по часовому поясу клиента: ?tzOffsetMin=-240 (как
// Date#getTimezoneOffset; Саратов UTC+4 → -240; по умолчанию 0 = UTC — как
// todaySessions в /api/stats).
//
// Кэш в памяти 5 минут (по образцу speed-record; глобальный для инстанса,
// валиден для того же tzOffsetMin). Cookie или Bearer API_KEY.
// Данные — одним JOIN-запросом через libsql.
import { NextRequest } from "next/server";
import { libsql } from "@/lib/db";
import { authorizeRequest } from "@/lib/auth";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import { env } from "@/lib/env";
import { maxSpeedMs, normalizeSessionSpeeds } from "@/lib/kpi";
import { computeMovingTime, computeActiveTrip, type MethodologyPoint, type MotionResult, type ActiveTrip } from "@/lib/active-trip";
import { computeEcoScore, type EcoScoreBaselines } from "@/lib/metrics-methodology";
import { getCorpusEcoBaselines } from "@/lib/eco-corpus"; // v2.16.0 (D-11): общая corpus-калибровка со stats-роутом
import { haversineM } from "@/lib/geo";

const CACHE_TTL_MS = 5 * 60 * 1000;

// Уровни бати по накопленным км за всё время (Σ активных дистанций).
const BATYA_LEVELS: ReadonlyArray<{ minKm: number; title: string }> = [
  { minKm: 0, title: "Пешеход" },
  { minKm: 1, title: "Ученик" },
  { minKm: 10, title: "Водитель" },
  { minKm: 50, title: "Батя" },
  { minKm: 200, title: "Заслуженный батя" },
  { minKm: 1000, title: "Легенда гаража" },
];

interface PeriodBucket {
  sessions: number;
  points: number;
  distanceKm: number;
  durationSec: number;
  activeSec: number;
  movingSec: number;
  avgSpeedKmh: number | null;
  maxSpeedKmh: number | null;
  ecoScore: number | null;
}

interface SessionAgg {
  id: string;
  startTimeMs: number;
  endTimeMs: number;
  points: number;
  distanceM: number;
  durationSec: number;
  activeSec: number;
  movingSec: number;
  maxSpeedMs: number | null;
  eco: number | null;
}

interface BatyaStats {
  generatedAt: string;
  version: string;
  tzOffsetMin: number;
  allTime: PeriodBucket & { daysDriven: number; firstTripAt: string | null; lastTripAt: string | null; devices: number };
  today: PeriodBucket;
  last7d: PeriodBucket;
  last30d: PeriodBucket;
  records: {
    maxSpeed: { kmh: number; sessionId: string; at: string } | null;
    longestTrip: { km: number; sessionId: string; at: string } | null;
    longestActiveTrip: { sec: number; sessionId: string; at: string } | null;
  };
  batya: {
    level: number;
    title: string;
    nextTitle: string | null;
    nextKm: number | null;
    progressPct: number;
    verdict: string;
  };
}

let cache: { value: BatyaStats; ts: number } | null = null;

function bucketOf(aggs: SessionAgg[]): PeriodBucket {
  let points = 0;
  let durationSec = 0;
  let activeSec = 0;
  let movingSec = 0;
  let distM = 0;
  let ecoWSum = 0;
  let ecoW = 0;
  let maxMs: number | null = null;
  for (const s of aggs) {
    points += s.points;
    durationSec += s.durationSec;
    activeSec += s.activeSec;
    movingSec += s.movingSec;
    distM += s.distanceM;
    if (s.maxSpeedMs != null) maxMs = Math.max(maxMs ?? 0, s.maxSpeedMs);
    if (s.eco != null) {
      // wavg по §4.11 — как период-агрегат Аналитики
      ecoWSum += s.eco * s.activeSec;
      ecoW += s.activeSec;
    }
  }
  return {
    sessions: aggs.length,
    points,
    distanceKm: Math.round(distM / 100) / 10, // км, 1 знак
    durationSec: Math.round(durationSec),
    activeSec: Math.round(activeSec),
    movingSec: Math.round(movingSec),
    avgSpeedKmh: activeSec > 0 ? Math.round((distM / activeSec) * 3.6 * 10) / 10 : null,
    maxSpeedKmh: maxMs != null ? Math.round(maxMs * 3.6 * 10) / 10 : null,
    ecoScore: ecoW > 0 ? Math.max(0, Math.min(100, Math.round(ecoWSum / ecoW))) : null,
  };
}

function batyaVerdict(eco: number | null, km: number): string {
  if (km < 1) return "Батя пока без машины. Крути педали!";
  if (eco == null) return "Батя в здании. Данных для оценки плавности пока маловато.";
  if (eco >= 80) return "Плавно, сынок. Батя одобряет.";
  if (eco >= 60) return "Нормально едешь. Батя в здании.";
  return "Резковато, но батя есть батя.";
}

function computeBatya(km: number, eco: number | null): BatyaStats["batya"] {
  let idx = 0;
  for (let i = 0; i < BATYA_LEVELS.length; i++) {
    if (km >= BATYA_LEVELS[i].minKm) idx = i;
  }
  const cur = BATYA_LEVELS[idx];
  const next = idx + 1 < BATYA_LEVELS.length ? BATYA_LEVELS[idx + 1] : null;
  const progressPct = next
    ? Math.min(100, Math.round(((km - cur.minKm) / (next.minKm - cur.minKm)) * 1000) / 10)
    : 100;
  return {
    level: idx + 1,
    title: cur.title,
    nextTitle: next ? next.title : null,
    nextKm: next ? next.minKm : null,
    progressPct,
    verdict: batyaVerdict(eco, km),
  };
}

async function computeBatyaStats(tzOffsetMin: number): Promise<BatyaStats> {
  // Все живые сессии с GPS-точками одним JOIN (хронологический порядок) —
  // как speed-record. Пустые (без точек) записи в JOIN не попадают: они не
  // дают ни км, ни времени.
  const res = await libsql.execute({
    sql: `SELECT s.id AS sid, s.startTime AS startTime, s.endTime AS endTime,
                 g.lat, g.lon, g.timestamp, g.speed, g.bearing, g.accuracy, g.altitude
          FROM Session s JOIN GpsPoint g ON g.sessionId = s.id
          WHERE s.deletedAt IS NULL
          ORDER BY s.startTime ASC, g.timestamp ASC`,
  });

  const bySession = new Map<
    string,
    { startTimeMs: number; endTimeMs: number | null; points: MethodologyPoint[] }
  >();
  for (const row of res.rows as Record<string, unknown>[]) {
    const sid = String(row.sid);
    let entry = bySession.get(sid);
    if (!entry) {
      entry = {
        startTimeMs: new Date(String(row.startTime)).getTime(),
        endTimeMs: row.endTime != null ? new Date(String(row.endTime)).getTime() : null,
        points: [],
      };
      bySession.set(sid, entry);
    }
    entry.points.push({
      lat: Number(row.lat),
      lon: Number(row.lon),
      timestamp: Number(row.timestamp),
      speed: row.speed == null ? null : Number(row.speed),
      bearing: row.bearing == null ? null : Number(row.bearing),
      accuracy: row.accuracy == null ? null : Number(row.accuracy),
      altitude: row.altitude == null ? null : Number(row.altitude),
    });
  }

  // v2.16.0 (D-11): corpus-калибровка EcoScore — ОБЩИЙ модуль eco-corpus.ts
  // со stats-роутом (один JOIN, кэш 5 минут, коалесценция параллельных вызовов).
  // Раньше здесь была «дословная репликация» того же прохода — второй полный
  // скан всех точек на каждый холодный кэш.
  const baselines: EcoScoreBaselines = await getCorpusEcoBaselines();

  const sids: string[] = [];
  const meta: Array<{ startTimeMs: number; endTimeMs: number; points: MethodologyPoint[]; motion: MotionResult; active: ActiveTrip }> = [];
  const distArr: number[] = [];
  const activeArr: number[] = [];
  const durArr: number[] = [];
  const movingArr: number[] = [];
  const maxSpeedArr: Array<number | null> = [];

  for (const [sid, { startTimeMs, endTimeMs, points }] of bySession) {
    sids.push(sid);
    // Финальный проход (как основной путь stats-роута): нормализованные точки,
    // дистанция — только активное окно. motion/active кешируются в meta —
    // v2.16.0 (I7): раньше «проход 2» пересчитывал их ЕЩЁ РАЗ (третий раз на сессию).
    const norm = normalizeSessionSpeeds(points);
    const motion = computeMovingTime(norm);
    const activeTrip = computeActiveTrip(norm, motion);
    const hasActive = activeTrip.hasActiveTrip;
    const lastMs = norm.length > 0 ? norm[norm.length - 1].timestamp : startTimeMs;
    const end = endTimeMs ?? lastMs;
    const durationSec = Math.max(0, (end - startTimeMs) / 1000);
    let distM = 0;
    for (let i = 1; i < norm.length; i++) {
      const prev = norm[i - 1];
      const p = norm[i];
      if (hasActive && p.timestamp >= activeTrip.activeStartTime && prev.timestamp <= activeTrip.activeEndTime) {
        distM += haversineM(prev.lat, prev.lon, p.lat, p.lon);
      }
    }
    meta.push({ startTimeMs, endTimeMs: end, points: norm, motion, active: activeTrip });
    distArr.push(distM);
    activeArr.push(hasActive ? activeTrip.activeDuration : 0);
    durArr.push(durationSec);
    movingArr.push(motion.movingTime);
    maxSpeedArr.push(norm.length >= 5 ? maxSpeedMs(norm) : null);
  }

  // Проход 2 (v2.16.0 I7): финальный EcoScore с калиброванными базлайнами —
  // БЕЗ пересчёта motion/active (из meta).
  const aggs: SessionAgg[] = meta.map((m, idx) => {
    const eco = computeEcoScore(m.points, distArr[idx], m.active, baselines);
    return {
      id: sids[idx],
      startTimeMs: m.startTimeMs,
      endTimeMs: m.endTimeMs,
      points: m.points.length,
      distanceM: distArr[idx],
      durationSec: durArr[idx],
      activeSec: activeArr[idx],
      movingSec: movingArr[idx],
      maxSpeedMs: maxSpeedArr[idx],
      eco: eco.value != null ? Math.max(0, Math.min(100, Math.round(eco.value))) : null,
    };
  });

  // Границы периодов. «Сегодня» — в tz клиента: v2.16.0 (B19) — ЧИСТАЯ
  // UTC-арифметика (floor дня), без new Date().setHours — он зависит от
  // СЕРВЕРНОГО пояса и на не-UTC хосте сместил бы полночь.
  const now = Date.now();
  const tzMs = tzOffsetMin * 60_000;
  const todayStartMs = Math.floor((now - tzMs) / 86_400_000) * 86_400_000 + tzMs;
  const d7StartMs = now - 7 * 24 * 3_600_000;
  const d30StartMs = now - 30 * 24 * 3_600_000;

  const allTime = bucketOf(aggs);
  const today = bucketOf(aggs.filter((s) => s.startTimeMs >= todayStartMs));
  const last7d = bucketOf(aggs.filter((s) => s.startTimeMs >= d7StartMs));
  const last30d = bucketOf(aggs.filter((s) => s.startTimeMs >= d30StartMs));

  // Дни за рулём — по локальным датам tz клиента; девайсы — отдельный лёгкий запрос.
  const days = new Set<string>();
  for (const s of aggs) {
    days.add(new Date(s.startTimeMs - tzMs).toISOString().slice(0, 10));
  }
  const devices = new Set<string>();
  const devRes = await libsql
    .execute({ sql: "SELECT DISTINCT deviceId FROM Session WHERE deletedAt IS NULL" })
    .catch(() => null);
  if (devRes) {
    for (const row of devRes.rows as Record<string, unknown>[]) devices.add(String(row.deviceId));
  }

  // Рекорды
  let maxSpeedRec: BatyaStats["records"]["maxSpeed"] = null;
  let longestTrip: BatyaStats["records"]["longestTrip"] = null;
  let longestActive: BatyaStats["records"]["longestActiveTrip"] = null;
  for (const s of aggs) {
    const at = new Date(s.startTimeMs).toISOString();
    if (s.maxSpeedMs != null && (!maxSpeedRec || s.maxSpeedMs * 3.6 > maxSpeedRec.kmh)) {
      maxSpeedRec = { kmh: Math.round(s.maxSpeedMs * 3.6 * 10) / 10, sessionId: s.id, at };
    }
    if (s.distanceM > 0 && (!longestTrip || s.distanceM / 1000 > longestTrip.km)) {
      longestTrip = { km: Math.round(s.distanceM / 100) / 10, sessionId: s.id, at };
    }
    if (s.activeSec > 0 && (!longestActive || s.activeSec > longestActive.sec)) {
      longestActive = { sec: Math.round(s.activeSec), sessionId: s.id, at };
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    version: env().APP_VERSION,
    tzOffsetMin,
    allTime: {
      ...allTime,
      daysDriven: days.size,
      firstTripAt: aggs.length ? new Date(aggs[0].startTimeMs).toISOString() : null,
      lastTripAt: aggs.length ? new Date(aggs[aggs.length - 1].startTimeMs).toISOString() : null,
      devices: devices.size,
    },
    today,
    last7d,
    last30d,
    records: { maxSpeed: maxSpeedRec, longestTrip, longestActiveTrip: longestActive },
    batya: computeBatya(allTime.distanceKm, allTime.ecoScore),
  };
}

export async function GET(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const auth = await authorizeRequest(request, "api");
    if (!auth.ok) return json({ error: auth.reason }, 401, { "X-Request-Id": requestId });

    const url = new URL(request.url);
    const tzRaw = Number(url.searchParams.get("tzOffsetMin"));
    const tzOffsetMin = Number.isFinite(tzRaw) && Math.abs(tzRaw) <= 15 * 60 ? Math.round(tzRaw) : 0;

    // Кэш валиден для того же tz (today-бакет зависит от границы суток).
    if (cache && Date.now() - cache.ts < CACHE_TTL_MS && cache.value.tzOffsetMin === tzOffsetMin) {
      return json(cache.value, 200, {
        "X-Request-Id": requestId,
        "Cache-Control": "private, max-age=300",
      });
    }

    const value = await computeBatyaStats(tzOffsetMin);
    cache = { value, ts: Date.now() };
    return json(value, 200, {
      "X-Request-Id": requestId,
      "Cache-Control": "private, max-age=300",
    });
  } catch (err) {
    logger.error("batya stats failed", {
      requestId,
      error: err instanceof Error ? err.message : String(err),
    });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}
