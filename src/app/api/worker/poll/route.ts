// POST /api/worker/poll — атомарный захват pending TrafficJob (§2.6 RETURNING id)
// Worker вызывает с { workerId, batchSize }. Возвращает массив захваченных jobs.
import { NextRequest } from "next/server";
import { db, libsql } from "@/lib/db";
import { authorizeRequest } from "@/lib/auth";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import { env } from "@/lib/env";

export async function POST(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const auth = await authorizeRequest(request, "cron");
    if (!auth.ok) return json({ error: auth.reason }, 401, { "X-Request-Id": requestId });

    const body = await request.json().catch(() => ({}));
    const workerId = String((body as { workerId?: unknown })?.workerId || env().WORKER_ID);
    // v2.18.0: clamp 1..50. Раньше batchSize=-5 уходил в LIMIT -5 (в SQLite =
    // «без лимита» — захват всего бэклога разом), а NaN/2.5 роняли bind (500).
    const batchRaw = (body as { batchSize?: unknown })?.batchSize;
    const parsedBatch = typeof batchRaw === "number" && Number.isFinite(batchRaw) ? Math.floor(batchRaw) : NaN;
    const batchSize = Math.min(Math.max(Number.isFinite(parsedBatch) ? parsedBatch : env().WORKER_BATCH_SIZE, 1), 50);

    // Атомарный захват через UPDATE ... WHERE status='pending' RETURNING id
    // SQLite не поддерживает RETURNING через Prisma напрямую → используем raw SQL
    // v2.11.0 (АУДИТ C-4): was new Date() → libsql сериализует в ЧИСЛО →
    // lockedAt/updatedAt/scheduledFor-сравнения ломались. Теперь ISO-строка.
    // v2.16.0 (R6): ПЕРЕД захватом — реклейм зависших running-джобов (60с TTL,
    // attempts+1, после 10 — dead), тот же паттерн, что и у in-process воркера.
    // Раньше HTTP-воркер вообще не имел реклейма: джоб, оставшийся 'running' после
    // смерти воркера, висел в этом статусе навсегда.
    const now = new Date().toISOString();
    const stuckCutoff = new Date(Date.now() - 60_000).toISOString();
    await db.$queryRaw`
      UPDATE TrafficJob
      SET status = CASE WHEN attempts >= 9 THEN 'dead' ELSE 'pending' END,
          attempts = attempts + 1,
          "lockedBy" = NULL, "lockedAt" = NULL, "updatedAt" = ${now}
      WHERE status = 'running' AND "lockedAt" < ${stuckCutoff}
    `;
    const claimRows = await db.$queryRaw`
      UPDATE TrafficJob
      SET status = 'running', "lockedBy" = ${workerId}, "lockedAt" = ${now}, "updatedAt" = ${now}
      WHERE id IN (
        SELECT id FROM TrafficJob
        WHERE status = 'pending' AND "scheduledFor" <= ${now}
        ORDER BY priority DESC, "scheduledFor" ASC
        LIMIT ${batchSize}
      )
      RETURNING id
    `;
    // v2.18.0: $queryRaw больше не генерик — строки конвертируем сами
    const ids = (claimRows as unknown as Array<Record<string, unknown>>).map((r) => String(r.id));

    if (ids.length === 0) {
      return json({ jobs: [] }, 200, { "X-Request-Id": requestId });
    }

    const jobs = await db.trafficJob.findMany({
      where: { id: { in: ids } },
      include: {
        session: {
          select: {
            id: true,
            deviceId: true,
            // Выбираем только нужные поля gpsPoints и маппим BigInt timestamp → Number
            // (JSON.stringify не умеет сериализовать BigInt → "Do not know how to serialize a BigInt")
            gpsPoints: {
              orderBy: { timestamp: "asc" },
              select: {
                lat: true,
                lon: true,
                speed: true,
                altitude: true,
                accuracy: true,
                bearing: true,
                timestamp: true,
              },
            },
          },
        },
      },
    });

    // Нормализация BigInt timestamp → Number (мс) для JSON-сериализации
    // v2.18.0: типизированный db — include-поля unknown, конвертация явная
    const normalized = jobs.map((rawJob) => {
      const j = rawJob as Record<string, unknown>;
      const session = (j.session ?? {}) as Record<string, unknown>;
      const gpsPoints = (session.gpsPoints ?? []) as Array<Record<string, unknown>>;
      const { gpsPoints: _drop, ...sessionScalars } = session;
      return {
        ...j,
        session: {
          ...sessionScalars,
          gpsPoints: gpsPoints.map((p) => ({
            lat: Number(p.lat),
            lon: Number(p.lon),
            speed: p.speed == null ? null : Number(p.speed),
            altitude: p.altitude == null ? null : Number(p.altitude),
            accuracy: p.accuracy == null ? null : Number(p.accuracy),
            bearing: p.bearing == null ? null : Number(p.bearing),
            timestamp: Number(p.timestamp),
          })),
        },
      };
    });

    return json({ jobs: normalized }, 200, { "X-Request-Id": requestId });
  } catch (err) {
    logger.error("Worker poll error", { requestId, error: err instanceof Error ? err.message : String(err) });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}
