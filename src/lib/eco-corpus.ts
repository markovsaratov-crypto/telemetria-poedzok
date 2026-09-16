// src/lib/eco-corpus.ts — v2.16.0: ЕДИНСТВЕННАЯ corpus-калибровка базлайнов EcoScore (§7.3).
//
// До v2.16.0 логика жила ДВАЖДЫ и по-разному:
//   • /api/sessions/[id]/stats (getCorpusEcoBaselines) — N+1: одна сессия = один
//     HTTP-раундтрип к Turso за ВСЕМИ её точками, последовательно; на холодном кэше
//     (раз в 5 минут) самый горячий роут приложения делал full-DB sweep из N+1
//     запросов (22 сессии = 23 раундтрипа; растёт линейно с каждой поездкой).
//   • /api/stats/batya — свой JOIN-проход «дословно реплицированный» (Task 12).
// Теперь: один JOIN всех живых сессий с точками → группировка в памяти →
// computeMethodologyMetrics по каждой сессии → медианные rates → кэш 5 минут.
// Числа совпадают с прежним конвейером дословно (rates считаются по СЫРЫМ
// ненормализованным точкам и ПОЛНОЙ дистанции записи; gate <60 точек — тот же).
//
// v2.38.0 (оптимизация чтений D1): sweep читает ВСЕ точки ВСЕХ сессий (56К
// строк) и выполнялся каждые 5 минут активности — второй жгут чтений после
// статов поездок. Теперь перед sweep проверяется ПОДПИСЬ корпуса — одна
// агрегатная строка COUNT+SUM по финализированным записям: пока корпус не
// менялся (нет финализаций/удалений/backfill), sweep не выполняется вовсе.
// Состав корпуса сужен до ФИНАЛИЗИРОВАННЫХ записей (endTime IS NOT NULL):
// незавершённая live-запись растёт каждую секунду и её rates «дышят»;
// включение живых записей в медиану — шум без ценности. Подпись меняют
// только реальные события: финализация, soft-delete, backfill точек.
// Внутри активной поездки базлайны стабильны — EcoScore не «плывёт» на глазах.
import { libsql } from "./db";
import { logger } from "./logger";
import { computeMethodologyMetrics, calibrateEcoScoreBaselinesFromCorpus, type EcoScoreBaselines } from "./metrics-methodology";
import { haversineM } from "./geo";

const CORPUS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 минут (как прежде в stats-роуте)

const g = globalThis as unknown as {
  __ecoCorpusCache?: { baselines: EcoScoreBaselines; ts: number; sig: string | null; inflight: Promise<EcoScoreBaselines> | null };
};

function store() {
  if (!g.__ecoCorpusCache) g.__ecoCorpusCache = { baselines: calibrateEcoScoreBaselinesFromCorpus([]), ts: 0, sig: null, inflight: null };
  return g.__ecoCorpusCache;
}

/** Подпись корпуса: одна агрегатная строка — меняется только при
 * финализации/удалении записи или backfill точек в финализированную. */
async function corpusSignature(): Promise<string> {
  const res = await libsql.execute({
    sql: `SELECT COUNT(*) AS n, COALESCE(SUM(pointCount), 0) AS pts
          FROM Session WHERE deletedAt IS NULL AND endTime IS NOT NULL`,
    args: [],
  });
  const row = res.rows[0] as Record<string, unknown> | undefined;
  return `${Number(row?.n ?? 0)}:${Number(row?.pts ?? 0)}`;
}

/**
 * Corpus-calibrated CAP baselines (§7.3). Кэш 5 минут на инстанс, общий для
 * /api/sessions/[id]/stats и /api/stats/batya; параллельные холодные вызовы
 * коалесцируются в один проход (inflight-промис). v2.38.0: внутри TTL-окна
 * при НЕИЗМЕННОЙ подписи корпуса тяжёлый sweep не выполняется.
 */
export async function getCorpusEcoBaselines(): Promise<EcoScoreBaselines> {
  const s = store();
  if (Date.now() - s.ts < CORPUS_CACHE_TTL_MS) return s.baselines;
  if (s.inflight) return s.inflight;
  s.inflight = (async () => {
    let sig: string | null = null;
    try {
      sig = await corpusSignature();
    } catch {
      // транзиентный сбой подписи — ниже пробуем sweep как прежде
    }
    if (sig != null && sig === s.sig) {
      // корпус не менялся — sweep не нужен, продлеваем TTL-окно
      s.ts = Date.now();
      return s.baselines;
    }
    try {
      const baselines = await computeCorpusBaselines();
      if (sig != null) s.sig = sig;
      s.baselines = baselines;
      s.ts = Date.now();
      return baselines;
    } catch (err) {
      // сбой sweep: держим прежние базлайны, подпись НЕ запоминаем —
      // следующая попытка через TTL (не залипаем на дефолтах)
      logger.warn("corpus baseline calibration failed, using previous", {
        requestId: "corpus",
        error: err instanceof Error ? err.message : String(err),
      });
      s.ts = Date.now();
      return s.baselines;
    }
  })().finally(() => {
    s.inflight = null;
  });
  return s.inflight;
}

async function computeCorpusBaselines(): Promise<EcoScoreBaselines> {
  // v2.16.0 (I1): ОДИН JOIN вместо N+1 построчных выборок. 25k точек прод-БД —
  // один rowset; с ростом истории объём растёт линейно, но это всё равно один
  // раундтрип вместо N.
  // v2.38.0: только ФИНАЛИЗИРОВАННЫЕ записи (endTime IS NOT NULL) — см. шапку.
  const res = await libsql.execute({
    sql: `SELECT s.id AS sid, s.startTime AS startTime, s.endTime AS endTime,
                 g.lat, g.lon, g.timestamp, g.speed, g.bearing, g.altitude, g.accuracy
          FROM Session s JOIN GpsPoint g ON g.sessionId = s.id
          WHERE s.deletedAt IS NULL AND s.endTime IS NOT NULL
          ORDER BY s.startTime ASC, g.timestamp ASC`,
  });

  // Группировка в память по сессиям (сохраняя хронологию внутри каждой)
  const bySession = new Map<string, { startTimeMs: number; endTimeMs: number; points: Array<{ lat: number; lon: number; timestamp: number; speed: number | null; bearing: number | null; altitude: number | null; accuracy: number | null }> }>();
  for (const row of res.rows as Record<string, unknown>[]) {
    const sid = String(row.sid);
    let entry = bySession.get(sid);
    if (!entry) {
      entry = {
        startTimeMs: new Date(String(row.startTime)).getTime(),
        endTimeMs: row.endTime != null ? new Date(String(row.endTime)).getTime() : NaN,
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
      altitude: row.altitude == null ? null : Number(row.altitude),
      accuracy: row.accuracy == null ? null : Number(row.accuracy),
    });
  }

  const rates: { braking: number; accel: number; jerk: number }[] = [];
  for (const { startTimeMs, endTimeMs, points } of bySession.values()) {
    // v2.32.0 (претензия №1 ревью): воркер in-process делит event loop с API.
    // Синхронные computeMethodologyMetrics по сессиям склеивались в один
    // длинный блок — уступаем цикл между сессиями (p95 API-роутов не растёт
    // от фонового прогрева корпус-калибровки).
    await new Promise<void>((resolve) => setImmediate(resolve));
    // gate — как в прежнем конвейере stats-роута: < 60 точек → сессия не калибрует
    if (points.length < 60) continue;
    const lastTs = points[points.length - 1].timestamp;
    const end = Number.isFinite(endTimeMs) ? endTimeMs : lastTs;
    const durationSec = Math.max(0, (end - startTimeMs) / 1000);
    // Дистанция — по ВСЕМ интервалам записи (гаверсинус), как прежде
    let distance = 0;
    for (let i = 1; i < points.length; i++) {
      distance += haversineM(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon);
    }
    const m = computeMethodologyMetrics(points, distance, durationSec);
    if (m.ecoScore.value == null) continue;
    rates.push({ braking: m.ecoScore.brakingRate, accel: m.ecoScore.accelRate, jerk: m.ecoScore.jerkRate });
  }

  return calibrateEcoScoreBaselinesFromCorpus(rates);
}
