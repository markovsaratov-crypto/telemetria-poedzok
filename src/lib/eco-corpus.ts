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
//
// v2.38.2 (ревью F59): ИНКРЕМЕНТАЛЬНЫЙ sweep. Подпись лишь ОТКЛЮЧАЛА пересчёт
// при неизменном корпусе — но каждая финализация меняла подпись и снова
// запускала ПОЛНЫЙ JOIN всех точек всех финализированных записей: объём
// чтений рос ЛИНЕЙНО с историей (56К → 100К+ строк). Теперь кэш хранит
// пер-сессионные rates последнего sweep (watermark: id → rates + pointCount
// на момент расчёта); диф по метa-запросу Session (сотни маленьких строк)
// вычисляет ТОЛЬКО новые/изменившиеся записи — точки читаются чанками ≤8 id
// (паттерн batch-points) исключительно для них. Причины изменения подписи
// покрываются дифом полностью: финализация → новый id; soft-delete → id
// исчез; backfill в финализированную → pointCount не совпал. Итоговая
// калибровка всегда по ПОЛНОМУ набору rates актуального корпуса (диф лишь
// минимизирует чтения — числа тождественны полному пересчёту). Первый
// sweep процесса (watermark пуст — рестарт/деплой) — полный, как раньше.
import { libsql } from "./db";
import { logger } from "./logger";
import { computeMethodologyMetrics, calibrateEcoScoreBaselinesFromCorpus, type EcoScoreBaselines } from "./metrics-methodology";
import { haversineM } from "./geo";

const CORPUS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 минут (как прежде в stats-роуте)

/** rates методологии одной записи корпуса (null — ниже gate <60, не калибрует). */
interface SessionRates {
  braking: number;
  accel: number;
  jerk: number;
}

/** Watermark инкрементального sweep (F59): rates записи + число точек, ПО
 *  КОТОРОМУ они посчитаны (изменение pointCount = backfill → пересчёт записи). */
type CorpusWatermark = Map<string, { rates: SessionRates | null; pointCount: number }>;

const g = globalThis as unknown as {
  __ecoCorpusCache?: { baselines: EcoScoreBaselines; ts: number; sig: string | null; inflight: Promise<EcoScoreBaselines> | null; perSession: CorpusWatermark | null };
};

function store() {
  if (!g.__ecoCorpusCache) {
    g.__ecoCorpusCache = { baselines: calibrateEcoScoreBaselinesFromCorpus([]), ts: 0, sig: null, inflight: null, perSession: null };
  }
  return g.__ecoCorpusCache!;
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
      const { baselines, perSession } = await computeCorpusBaselines(s.perSession);
      if (sig != null) s.sig = sig;
      s.baselines = baselines;
      s.ts = Date.now();
      // v2.38.2 (F59): watermark обновляется ТОЛЬКО при успехе — сбой sweep
      // оставляет прежний (следующая попытка пересчитает диф заново)
      s.perSession = perSession;
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

/**
 * v2.38.2 (ревью F59): инкрементальная калибровка корпуса.
 * @param prev watermark прошлого sweep (null → полный, первый за процесс)
 * @returns baselines + НОВЫЙ watermark (пер-сессионные rates) для кэша
 */
async function computeCorpusBaselines(prev: CorpusWatermark | null): Promise<{ baselines: EcoScoreBaselines; perSession: CorpusWatermark }> {
  // ——— диф корпуса: метa-запрос Session (id/окна/pointCount) — сотни
  // маленьких строк вместо JOIN всех точек истории ———
  // (v2.16.0 I1: один JOIN вместо N+1; v2.38.0: только финализированные;
  // v2.38.2: только НОВЫЕ/ИЗМЕНИВШИЕСЯ — см. шапку модуля)
  const metaRes = await libsql.execute({
    sql: `SELECT id, startTime, endTime, pointCount FROM Session
          WHERE deletedAt IS NULL AND endTime IS NOT NULL`,
    args: [],
  });
  const metas = new Map<string, { startTimeMs: number; endTimeMs: number; pointCount: number }>();
  for (const row of metaRes.rows as Record<string, unknown>[]) {
    metas.set(String(row.id), {
      startTimeMs: new Date(String(row.startTime)).getTime(),
      endTimeMs: row.endTime == null ? NaN : new Date(String(row.endTime)).getTime(),
      pointCount: Number(row.pointCount ?? 0),
    });
  }

  const next: CorpusWatermark = new Map();
  const toCompute: string[] = [];
  if (prev) {
    for (const [id, m] of metas) {
      const p = prev.get(id);
      if (p && p.pointCount === m.pointCount) next.set(id, p); // неизменна — rates прошлого sweep
      else toCompute.push(id); // новая запись ИЛИ backfill (pointCount ≠ watermark)
    }
    // записи, исчезнувшие из корпуса (soft-delete), в next НЕ переносятся
  } else {
    // первый sweep процесса — полный (watermark пуст после рестарта/деплоя)
    toCompute.push(...metas.keys());
  }

  // ——— точки ТОЛЬКО вычисляемых записей, чанками ≤8 id (паттерн batch-points:
  // ограниченный ответ/память шлюза; ORDER BY sessionId, timestamp — внутри
  // сессии хронология asc, как в прежнем JOIN) ———
  const CHUNK = 8;
  for (let ci = 0; ci < toCompute.length; ci += CHUNK) {
    const chunk = toCompute.slice(ci, ci + CHUNK);
    const ph = chunk.map(() => "?").join(", ");
    const res = await libsql.execute({
      sql: `SELECT sessionId, lat, lon, timestamp, speed, bearing, altitude, accuracy
            FROM GpsPoint WHERE sessionId IN (${ph}) ORDER BY sessionId, timestamp ASC`,
      args: chunk,
    });
    const bySession = new Map<string, Array<{ lat: number; lon: number; timestamp: number; speed: number | null; bearing: number | null; altitude: number | null; accuracy: number | null }>>();
    for (const row of res.rows as Record<string, unknown>[]) {
      const sid = String(row.sessionId);
      let arr = bySession.get(sid);
      if (!arr) { arr = []; bySession.set(sid, arr); }
      arr.push({
        lat: Number(row.lat),
        lon: Number(row.lon),
        timestamp: Number(row.timestamp),
        speed: row.speed == null ? null : Number(row.speed),
        bearing: row.bearing == null ? null : Number(row.bearing),
        altitude: row.altitude == null ? null : Number(row.altitude),
        accuracy: row.accuracy == null ? null : Number(row.accuracy),
      });
    }
    for (const id of chunk) {
      const m = metas.get(id);
      if (!m) continue;
      const points = bySession.get(id) ?? [];
      // gate — как в прежнем конвейере stats-роута: < 60 точек → сессия не
      // калибрует (null в watermark: запись УЧТЕНА — не пересчитывается каждый
      // sweep, пока pointCount не изменится)
      let rates: SessionRates | null = null;
      if (points.length >= 60) {
        const lastTs = points[points.length - 1].timestamp;
        const end = Number.isFinite(m.endTimeMs) ? m.endTimeMs : lastTs;
        const durationSec = Math.max(0, (end - m.startTimeMs) / 1000);
        // Дистанция — по ВСЕМ интервалам записи (гаверсинус), как прежде
        let distance = 0;
        for (let i = 1; i < points.length; i++) {
          distance += haversineM(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon);
        }
        const met = computeMethodologyMetrics(points, distance, durationSec);
        if (met.ecoScore.value != null) {
          rates = { braking: met.ecoScore.brakingRate, accel: met.ecoScore.accelRate, jerk: met.ecoScore.jerkRate };
        }
      }
      next.set(id, { rates, pointCount: m.pointCount });
    }
    // v2.32.0 (претензия №1 ревью): воркер in-process делит event loop с API —
    // уступаем цикл между чанками (p95 API-роутов не растёт от фоновой
    // корпус-калибровки)
    await new Promise<void>((resolve) => setImmediate(resolve));
  }

  // калибровка — по ПОЛНОМУ набору rates актуального корпуса (диф лишь
  // минимизирует чтения; медианы тождественны полному пересчёту)
  const rates: SessionRates[] = [];
  for (const v of next.values()) if (v.rates) rates.push(v.rates);
  return { baselines: calibrateEcoScoreBaselinesFromCorpus(rates), perSession: next };
}
