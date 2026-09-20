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
// sweep процесса — v2.40.3: watermark ДОПОЛНИТЕЛЬНО персистится в Setting
// (см. «рестарт-бёрн» ниже), поэтому «полным» остаётся только САМЫЙ первый
// запуск сервиса; после рестарта/деплоя/эвикции изолята диф продолжается
// с сохранённого watermark.
import { libsql } from "./db";
import { logger } from "./logger";
import { upsertSetting } from "./settings";
import {
  CORPUS_WATERMARK_KEY,
  CORPUS_WATERMARK_MAX_BYTES,
  deserializeWatermark,
  serializeWatermark,
  watermarkSizeBytes,
  type CorpusWatermark,
  type SessionRates,
} from "./eco-corpus-watermark";
import { computeMethodologyMetrics, calibrateEcoScoreBaselinesFromCorpus, type EcoScoreBaselines } from "./metrics-methodology";
import { plausibleIntervalM } from "./geo";

// ——— v2.40.3 (ревью 19-j, критик RR-2 «рестарт-бёрн»): персист watermark ———
// ЧИСТЫЕ функции сериализации — в ./eco-corpus-watermark (без импортов,
// покрыты tests/eco-watermark.test.ts); здесь — только работа с БД:
// загрузка при холодном старте и fire-and-forget сохранение после sweep.

const CORPUS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 минут (как прежде в stats-роуте)

const g = globalThis as unknown as {
  __ecoCorpusCache?: { baselines: EcoScoreBaselines; ts: number; sig: string | null; inflight: Promise<EcoScoreBaselines> | null; perSession: CorpusWatermark | null };
};

function store() {
  if (!g.__ecoCorpusCache) {
    g.__ecoCorpusCache = { baselines: calibrateEcoScoreBaselinesFromCorpus([]), ts: 0, sig: null, inflight: null, perSession: null };
  }
  return g.__ecoCorpusCache!;
}

// ——— v2.40.3 (ревью 19-j, критик RR-2 «рестарт-бёрн»): персист watermark ———
// Watermark жил ТОЛЬКО в памяти процесса: каждый рестарт/деплой/эвикция
// изолята (18.09: 8 эвикций за утро) запускал ПОЛНЫЙ sweep корпуса — чтение
// всех точек всех финализированных записей (десятки тысяч строк на каждый
// холодный инстанс). Теперь watermark переживает рестарт: после успешного
// sweep сериализуется в Setting (компактный JSON), при холодном старте
// читается оттуда — диф сразу продолжается инкрементально. Цена — 1 маленькая
// строка Setting на чтение и на запись; обе операции НЕ фатальны: любой сбой
// (нет строки, исчерпана квота, битый JSON) = деградация к прежнему поведению
// (полный sweep). Ключ в Setting попадает и в ночной бэкап — watermark
// восстанавливается вместе с данными.
async function loadPersistedWatermark(): Promise<CorpusWatermark | null> {
  try {
    const res = await libsql.execute({
      sql: "SELECT value FROM Setting WHERE key = ?",
      args: [CORPUS_WATERMARK_KEY],
    });
    const row = res.rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    return deserializeWatermark(String(row.value));
  } catch {
    return null; // квота/сбой — деградация до полного sweep (прежнее поведение)
  }
}

async function persistWatermark(wm: CorpusWatermark): Promise<void> {
  try {
    const json = serializeWatermark(wm);
    if (watermarkSizeBytes(json) > CORPUS_WATERMARK_MAX_BYTES) {
      // корпус больше лимита — остаёмся на in-memory семантике (v2.38.2/F59):
      // каждый процесс после рестарта делает полный sweep, как раньше
      logger.warn("corpus watermark too large to persist, keeping in-memory", { requestId: "corpus", bytes: watermarkSizeBytes(json) });
      return;
    }
    // D-14: единый UPSERT Setting (копия SQL в этом файле запрещена)
    await upsertSetting(CORPUS_WATERMARK_KEY, json, "system:eco-corpus");
  } catch (err) {
    // не фатально: sweep уже успешно завершён, in-memory watermark актуален;
    // не записали — после рестарта будет полный sweep (прежнее поведение)
    logger.warn("corpus watermark persist failed (non-fatal)", { requestId: "corpus", error: err instanceof Error ? err.message : String(err) });
  }
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
      // v2.40.3 (рестарт-бёрн): in-memory watermark пуст (холодный процесс) —
      // пробуем продолжить диф с персистентного (1 маленькая строка Setting).
      // Неудача загрузки = null = полный sweep, как в v2.38.2.
      const prev = s.perSession ?? (await loadPersistedWatermark());
      const { baselines, perSession } = await computeCorpusBaselines(prev);
      if (sig != null) s.sig = sig;
      s.baselines = baselines;
      s.ts = Date.now();
      // v2.38.2 (F59): watermark обновляется ТОЛЬКО при успехе — сбой sweep
      // оставляет прежний (следующая попытка пересчитает диф заново)
      s.perSession = perSession;
      // v2.40.3: персист нового watermark — fire-and-forget, сбой не валит
      // ответ (ошибки внутри persistWatermark глотаются с warn)
      void persistWatermark(perSession);
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
 * @param prev watermark прошлого sweep (null → полный; v2.40.3: null теперь
 *   только у САМОГО первого запуска — после рестарта диф продолжается
 *   с персистентного watermark)
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
    // watermark пуст И персистентного нет (самый первый запуск сервиса либо
    // корпус превысил лимит персиста) — полный, как в v2.38.2
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
        // Дистанция — по ВСЕМ интервалам записи (гаверсинус), как прежде.
        // v2.40.7 (N-3): интервалы-телепорты (v_impl > 200 км/ч) не входят —
        // иначе корпус-дистанция раздувалась фантомами (см. plausibleIntervalM).
        let distance = 0;
        for (let i = 1; i < points.length; i++) {
          distance += plausibleIntervalM(
            points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon,
            (points[i].timestamp - points[i - 1].timestamp) / 1000
          );
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
