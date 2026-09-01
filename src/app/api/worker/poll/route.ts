// POST /api/worker/poll — атомарный захват pending TrafficJob (§2.6 RETURNING id)
// Worker вызывает с { workerId, batchSize }. Возвращает массив захваченных jobs.
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
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
    const workerId = (body as { workerId?: string })?.workerId || env().WORKER_ID;
    const batchSize = Math.min((body as { batchSize?: number })?.batchSize || env().WORKER_BATCH_SIZE, 50);

    // Атомарный захват через UPDATE ... WHERE status='pending' RETURNING id
    // SQLite не поддерживает RETURNING через Prisma напрямую → используем raw SQL
    // v2.11.0 (АУДИТ C-4): was new Date() → libsql сериализует в ЧИСЛО →
    // lockedAt/updatedAt/scheduledFor-сравнения ломались. Теперь ISO-строка.
    const now = new Date().toISOString();
    const ids = await db.$queryRaw<{ id: string }[]>`
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

    if (ids.length === 0) {
      return json({ jobs: [] }, 200, { "X-Request-Id": requestId });
    }

    const jobs = await db.trafficJob.findMany({
      where: { id: { in: ids.map((r) => r.id) } },
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
    const normalized = jobs.map((j) => ({
      ...j,
      session: {
        ...j.session,
        gpsPoints: j.session.gpsPoints.map((p) => ({
          lat: p.lat,
          lon: p.lon,
          speed: p.speed,
          altitude: p.altitude,
          accuracy: p.accuracy,
          bearing: p.bearing,
          timestamp: Number(p.timestamp),
        })),
      },
    }));

    return json({ jobs: normalized }, 200, { "X-Request-Id": requestId });
  } catch (err) {
    logger.error("Worker poll error", { requestId, error: err instanceof Error ? err.message : String(err) });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}
