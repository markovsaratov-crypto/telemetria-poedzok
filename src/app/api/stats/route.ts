// GET /api/stats — агрегированная статистика для dashboard (§3.x overview).
// Cookie или Bearer API_KEY.
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { authorizeRequest } from "@/lib/auth";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import { env } from "@/lib/env";
import { readIngestTrace, readIngestRaw } from "@/lib/ingest-trace"; // DIAG-1: трассировка; v2.10.8: сырой дамп по ?ingestRaw=1

export async function GET(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const auth = await authorizeRequest(request, "api");
    if (!auth.ok) return json({ error: auth.reason }, 401, { "X-Request-Id": requestId });

    // All-time stats
    // v2.12.0 (D-1): totalPoints — только точки ЖИВЫХ сессий (deletedAt IS NULL).
    // Раньше считались все строки GpsPoint, включая осиротевшие точки
    // софт-делетнутых сессий → «GPS-точек (всего)» в админке расходилось
    // с суммой по поездкам в других разделах.
    const [totalSessions, totalPoints, totalRoutes, totalTrafficJobs, deadJobs, pendingJobs] = await Promise.all([
      db.session.count({ where: { deletedAt: null } }),
      db.gpsPoint.count({ where: { session: { deletedAt: null } } }),
      db.route.count(),
      db.trafficJob.count(),
      db.trafficJob.count({ where: { status: "dead" } }),
      db.trafficJob.count({ where: { status: "pending" } }),
    ]);

    // Today
    // v2.16.0 (B7): «сегодня» — в часовом поясе КЛИЕНТА (?tzOffsetMin, как
    // Date#getTimezoneOffset; по умолчанию 0 = UTC). Раньше полночь бралась в
    // СЕРВЕРНОМ поясе — на Render UTC «сегодня» начиналось в 03:00 МСК и
    // расходилось с «батя-статс», который всегда считал в поясе клиента.
    const url = new URL(request.url);
    const tzRaw = Number(url.searchParams.get("tzOffsetMin"));
    const tzOffsetMin = Number.isFinite(tzRaw) && Math.abs(tzRaw) <= 15 * 60 ? Math.round(tzRaw) : 0;
    const tzMs = tzOffsetMin * 60_000;
    const todayStartMs = Math.floor((Date.now() - tzMs) / 86_400_000) * 86_400_000 + tzMs;
    const todaySessions = await db.session.count({
      where: { startTime: { gte: new Date(todayStartMs) }, deletedAt: null },
    });

    // v2.16.0 (I4): 4 независимых запроса (7д, 12нед, aggregate, трейс) —
    // параллельно (было 4 последовательных HTTPS-раундтрипа к Turso).
    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
    const twelveWeeksAgo = new Date();
    twelveWeeksAgo.setDate(twelveWeeksAgo.getDate() - 84); // v2.16.0 (V4): имя = суть (12 недель, не «30 дней»)
    const [recentSessions, totalBytesResult, heatmapSessions, ingestTrace] = await Promise.all([
      db.session.findMany({
        where: { startTime: { gte: sevenDaysAgo }, deletedAt: null },
        select: { startTime: true, endTime: true, pointCount: true, payloadBytes: true },
        orderBy: { startTime: "asc" },
        // v2.11.0 (АУДИТ C-7): явный лимит — тихий дефолт 20 резал спарклайн
        take: 5000,
      }),
      db.session.aggregate({
        _sum: { payloadBytes: true },
        where: { deletedAt: null },
      }),
      db.session.findMany({
        where: { startTime: { gte: twelveWeeksAgo }, deletedAt: null },
        select: { startTime: true, pointCount: true },
        orderBy: { startTime: "asc" },
        // v2.11.0 (АУДИТ C-7): явный лимит — тихий дефолт 20 в обёртке резал
        // 12-недельную тепловую карту до 20 сессий
        take: 5000,
      }),
      readIngestTrace().catch(() => ({ last: null, recent: [], updatedAt: null })),
    ]);

    // Per-day buckets for last 7 days
    // v2.9.4: +durationSec — сумма длительностей сессий за день (спарклайн KPI «Длительность» в мобильной аналитике)
    // v2.9.4 fix: startTime из БД приходит ISO-строкой — сравниваем через new Date (раньше string vs Date давал NaN → все бакеты были нулями)
    // v2.16.0: границы суток — в поясе клиента (согласовано с todaySessions выше)
    const perDay: { date: string; count: number; points: number; durationSec: number }[] = [];
    for (let i = 6; i >= 0; i--) {
      const dayStartMs = todayStartMs - i * 86_400_000;
      const nextMs = dayStartMs + 86_400_000;
      const dayItems = recentSessions.filter(
        (s) => new Date(s.startTime).getTime() >= dayStartMs && new Date(s.startTime).getTime() < nextMs
      );
      perDay.push({
        date: new Date(dayStartMs).toISOString().slice(0, 10),
        count: dayItems.length,
        points: dayItems.reduce((a, s) => a + s.pointCount, 0),
        durationSec: dayItems.reduce(
          (a, s) => a + Math.max(0, ((s.endTime ? new Date(s.endTime).getTime() : new Date(s.startTime).getTime()) - new Date(s.startTime).getTime()) / 1000),
          0
        ),
      });
    }

    // v2.10.8: полный дамп последнего нераспознанного батча — ТОЛЬКО по
    // ?ingestRaw=1: до 64 КБ в теле ответе, не таскаем его в каждом запросе.
    const wantRaw = new URL(request.url).searchParams.get("ingestRaw") === "1";
    const ingestRaw = wantRaw
      ? await readIngestRaw().catch(() => null)
      : null;

    return json(
      {
        totalSessions,
        totalPoints,
        totalRoutes,
        totalTrafficJobs,
        deadJobs,
        pendingJobs,
        todaySessions,
        totalPayloadBytes: totalBytesResult._sum.payloadBytes || 0,
        perDay,
        heatmapSessions: heatmapSessions.map((s) => ({
          startTime: s.startTime,
          pointCount: s.pointCount,
        })),
        // Capacity info (блокер №1 — отображение в UI)
        capacity: {
          targetLoadRpm: env().TARGET_LOAD_RPM,
          rateLimitMaxIngest: env().RATE_LIMIT_MAX_INGEST,
          headroom: env().RATE_LIMIT_MAX_INGEST - env().TARGET_LOAD_RPM,
        },
        version: env().APP_VERSION,
        // DIAG-1: {last, recent (≤20), updatedAt} — попытки инжеста всех исходов
        ingestTrace,
        // v2.10.8: {at, deviceId, outcome, bytes, truncated, body} — только при ?ingestRaw=1
        ...(wantRaw ? { ingestRaw } : {}),
      },
      200,
      { "X-Request-Id": requestId }
    );
  } catch (err) {
    logger.error("Stats error", { requestId, error: err instanceof Error ? err.message : String(err) });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}
