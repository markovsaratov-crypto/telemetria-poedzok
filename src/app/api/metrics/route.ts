// GET /api/metrics — Prometheus text exposition (§7.2)
// AUDIT B-13: эндпоинт больше не публичный — требует api-scope (cookie/API_KEY),
// иначе наружу утекают счётчики логинов/регистраций и трафика по путям.
import { NextRequest } from "next/server";
import { metricsText } from "@/lib/metrics";
import { set, TRAFFIC_JOB_DEAD_GAUGE } from "@/lib/metrics";
import { db } from "@/lib/db";
import { authorizeRequest } from "@/lib/auth";
import { getRateLimiterStats } from "@/lib/rate-limit";
import { circuitStatus } from "@/lib/routing/circuit-breaker";
import { logger } from "@/lib/logger";
import { getTtlCache } from "@/lib/ttl-cache"; // v2.40.5 · M-16: TTL-кэш gauge-счётчиков

export const dynamic = "force-dynamic";

// v2.40.5 (квота-M-16, аудит Task 22): 4 COUNT'а gauge-метрик — в TTL-кэше 60с.
// Прежде каждый скрейп Prometheus (а также каждое открытие админки) читал
// Session+TrafficJob×3 заново; при активном мониторинге с интервалом ≤30с это
// двойной-тройной перерасход на одни и те же числа. Gauge с минутной грануляр-
// ностью — норма для Prometheus (scrape_interval обычно ≥15с, счётчики cardinal-
// ности не меняют); кэш на globalThis переживает HMR. При сбое БД (квота/
// шлюз) — счётчики НЕ сбрасываются в 0: реестр metrics хранит последние
// успешные значения set() (v2.38.1-паттерн «лучшая известная величина»),
// скрейп не краснеет — сам сбой и так виден по d1_rows_read_total/алертам.
interface GaugeCounts {
  sessionCount: number;
  trafficJobPending: number;
  trafficJobRunning: number;
  trafficJobDead: number;
}
const GAUGE_CACHE = getTtlCache<GaugeCounts>("metrics-gauges", 60_000);

export async function GET(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  const auth = await authorizeRequest(request, "api");
  if (!auth.ok) {
    return new Response("# unauthorized\n", {
      status: 401,
      headers: { "Content-Type": "text/plain; charset=utf-8", "X-Request-Id": requestId },
    });
  }
  try {
    // Обновляем gauge-метрики (v2.16.0 (I5): 4 счётчика — параллельно)
    // v2.38.1 (ревью F15): gauge dead-джобов вместо фиктивного 'failed'
    // (такого статуса в TrafficJob нет) — и под другим ИМЕНЕМ
    // (traffic_job_dead_total): прежний traffic_job_failed_total в виде gauge
    // конфликтовал с одноимённым counter → двойной # TYPE в exposition →
    // Prometheus-парсер падал, весь scrape — 0 сэмплов. Имя — константа из
    // lib/metrics (единый источник, ревью F15).
    // v2.40.5 (M-16): значения — из TTL-кэша 60с; промах = один параллельный
    // заход в БД и запись в кэш (следующий скрейп в окне — бесплатный). Сбой
    // промаха = прежние значения реестра (не 0, не 500) — см. шапку файла.
    const cachedCounts = GAUGE_CACHE.get("gauges");
    let counts: GaugeCounts;
    if (cachedCounts) {
      counts = cachedCounts;
    } else {
      try {
        const [sessionCount, trafficJobPending, trafficJobRunning, trafficJobDead] = await Promise.all([
          db.session.count({ where: { deletedAt: null } }),
          db.trafficJob.count({ where: { status: "pending" } }),
          db.trafficJob.count({ where: { status: "running" } }),
          db.trafficJob.count({ where: { status: "dead" } }),
        ]);
        counts = { sessionCount, trafficJobPending, trafficJobRunning, trafficJobDead };
        GAUGE_CACHE.set("gauges", counts);
      } catch (countsErr) {
        // БД недоступна (квота/шлюз): скрейп не роняем — в реестре остались
        // последние успешные значения set() ниже; свежих нет — логируем раз.
        logger.warn("metrics gauge counts unavailable (serving last known)", {
          requestId,
          error: countsErr instanceof Error ? countsErr.message : String(countsErr),
        });
        counts = {
          sessionCount: 0, trafficJobPending: 0, trafficJobRunning: 0, trafficJobDead: 0,
          stale: true,
        } as GaugeCounts & { stale: boolean };
      }
    }
    const staleCounts = (counts as GaugeCounts & { stale?: boolean }).stale === true;
    if (!staleCounts) {
      set("sessions_active_total", counts.sessionCount, "Active sessions");
      set("traffic_job_pending_total", counts.trafficJobPending, "Pending traffic jobs");
      set("traffic_job_running_total", counts.trafficJobRunning, "Running traffic jobs");
      set(TRAFFIC_JOB_DEAD_GAUGE, counts.trafficJobDead, "Traffic jobs dead (terminal, max attempts exceeded)");
    }
    set("rate_limiter_buckets", getRateLimiterStats().buckets, "Rate limiter buckets");

    const text = metricsText();
    return new Response(text, {
      status: 200,
      headers: {
        "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  } catch (err) {
    // v2.16.0 (B15): наружу — generic-текст (детали — в логи; err.message мог
    // светить внутренности БД)
    logger.error("metrics route failed", { requestId, error: err instanceof Error ? err.message : String(err) });
    return new Response("# error: internal server error\n", {
      status: 500,
      headers: { "Content-Type": "text/plain" },
    });
  }
}
