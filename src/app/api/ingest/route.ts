// POST /api/ingest — приём GPS-данных (§4.1). Bearer INGEST_TOKEN.
// Идемпотентность через (deviceId, clientId). p-limit(1) serialization для SQLite write lock.
import { NextRequest } from "next/server";
import { zIngestBody } from "@/lib/validation";
import { findExistingSession } from "@/lib/idempotency";
import { db } from "@/lib/db";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import { inc } from "@/lib/metrics";
import { recordIngestAttempt } from "@/lib/ingest-trace"; // DIAG-1: трассировка попыток
import { recordIngestOutcome } from "@/lib/alerts"; // P2-16: правило ingest_error_rate
import { trackLatency } from "@/lib/latency"; // P2-16: api_latency_p95
import { extractBearer } from "@/lib/auth";
import { tokenMatches } from "@/lib/token-check";
import { env } from "@/lib/env";

export async function POST(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  const start = Date.now();
  try {
    // v2.16.0 (V9): проверка INGEST_TOKEN и В РОУТЕ тоже (defense-in-depth — как в
    // sensorlogger). Обычно прокси уже отсекает, но один регресс матчера — и роут
    // без своей проверки писал бы данные по любому запросу.
    const bearer = extractBearer(request);
    const queryToken = new URL(request.url).searchParams.get("token");
    const e = env();
    const tokenOk =
      (await tokenMatches(bearer, e.INGEST_TOKEN)) ||
      (await tokenMatches(queryToken, e.INGEST_TOKEN));
    if (!tokenOk) {
      inc("ingest_unauthorized_total", "Ingest attempts rejected with 401 (bad or missing token)", 1, "ingest");
      return json({ error: "Unauthorized", reason: "Valid INGEST_TOKEN required (Bearer header or ?token= query)" }, 401, { "X-Request-Id": requestId });
    }

    const body = await request.json().catch(() => null);
    const parsed = zIngestBody.safeParse(body);
    if (!parsed.success) {
      recordIngestOutcome(false); // P2-16: ошибка валидации участвует в ingest_error_rate
      // DIAG-1: 400 — приложение может показывать «отправлено», не проверив статус
      recordIngestAttempt({
        at: new Date().toISOString(), route: "ingest",
        deviceId: typeof (body as { deviceId?: unknown } | null)?.deviceId === "string"
          ? (body as { deviceId?: string }).deviceId!.slice(0, 64)
          : null,
        outcome: "invalid", points: 0, dropped: 0,
        bytes: body != null ? Buffer.byteLength(JSON.stringify(body)) : null,
      });
      return json(
        { error: "Validation failed", details: parsed.error.flatten() },
        400,
        { "X-Request-Id": requestId }
      );
    }
    const { deviceId, clientId, points } = parsed.data;
    // P1: deviceName опционален — undefined в INSERT даёт libsql «Unsupported type of value» (500 на ingest без deviceName)
    const deviceName = parsed.data.deviceName ?? null;

    // 1. Идемпотентность (§6.7)
    const existing = await findExistingSession(deviceId, clientId!);
    if (existing) {
      inc("ingest_duplicate_total", "Duplicate ingest (idempotency hit)", 1);
      recordIngestOutcome(true); // P2-16: дубль — успешный исход (идемпотентность)
      recordIngestAttempt({
        at: new Date().toISOString(), route: "ingest", deviceId,
        outcome: "duplicate", points: 0, dropped: 0, bytes: null,
      }); // DIAG-1
      trackLatency(request);
      return json(
        { sessionId: existing, duplicate: true },
        200,
        { "X-Request-Id": requestId }
      );
    }

    // 2. Нормализация таймстемпов: нс → мс → с, фильтрация gap > 30 с
    const normalized = points
      .map((p) => ({
        lat: p.lat,
        lon: p.lon,
        speed: p.speed ?? null,
        altitude: p.altitude ?? null,
        accuracy: p.accuracy ?? null,
        bearing: p.bearing ?? null,
        // v2.11.0 (АУДИТ C-29): три диапазона — нс (> 1e15 → /1e6), мс (> 1e12),
        // СЕКУНДЫ (> 1e9 → ×1000; раньше секунды оставались как мс → даты 1970)
        timestampMs:
          Number(p.timestamp) > 1e15 ? Math.floor(Number(p.timestamp) / 1e6)
          : Number(p.timestamp) > 1e12 ? Number(p.timestamp)
          : Number(p.timestamp) > 1e9 ? Number(p.timestamp) * 1000
          : Number(p.timestamp),
      }))
      .sort((a, b) => a.timestampMs - b.timestampMs);

    // v2.11.0 (АУДИТ C-10): gap сравнивается между СОСЕДНИМИ исходными точками.
    // v2.16.0 (R9): точка-возобновление ПОСЛЕ паузы СОХРАНЯЕТСЯ (раньше —
    // отбрасывалась: «прогулка с паузой» теряла первую точку после каждого
    // перерыва; это не «фильтр мусора», а реальные данные)
    const filtered: typeof normalized = [];
    let lastTs: number | null = null;
    let gapMarkers = 0;
    for (const p of normalized) {
      if (lastTs !== null && p.timestampMs - lastTs > 30000) {
        gapMarkers++; // gap > 30 с — маркер разрыва, точка сохраняется
      }
      filtered.push(p);
      lastTs = p.timestampMs;
    }
    if (filtered.length === 0) {
      filtered.push(...normalized);
    }

    const startTime = new Date(filtered[0].timestampMs);
    const endTime = new Date(filtered[filtered.length - 1].timestampMs);
    const payloadBytes = Buffer.byteLength(JSON.stringify(body));

    // 3. INSERT (no global write lock — SQLite WAL handles concurrency)
    // v2.16.0 (B-6): защита от TOCTOU-гонки идемпотентности — два параллельных
    // ретрая проходят findExistingSession(null) одновременно, второй INSERT
    // падает по @@unique(deviceId,clientId) → раньше это был 500; теперь —
    // повторная проверка и честный ответ duplicate.
    let session: { session: { id: string }, job: { id: string } };
    try {
      session = await db.$transaction(async (tx: any) => {
        const s = await tx.session.create({
          data: {
            deviceId,
            clientId,
            deviceName,
            startTime,
            endTime,
            pointCount: filtered.length,
            payloadBytes,
            status: "completed",
          },
        });
        // Batch insert GPS points
        await tx.gpsPoint.createMany({
          data: filtered.map((p) => ({
            sessionId: s.id,
            lat: p.lat,
            lon: p.lon,
            speed: p.speed,
            altitude: p.altitude,
            accuracy: p.accuracy,
            bearing: p.bearing,
            timestamp: BigInt(p.timestampMs),
          })),
        });
        // Создаём TrafficJob для Worker
        const job = await tx.trafficJob.create({
          data: {
            sessionId: s.id,
            status: "pending",
            priority: 0,
          },
        });
        await tx.session.update({
          where: { id: s.id },
          data: { trafficJobId: job.id },
        });
        return { session: s, job };
      });
    } catch (txErr) {
      const raced = await findExistingSession(deviceId, clientId!);
      if (raced) {
        inc("ingest_duplicate_total", "Duplicate ingest (idempotency race)", 1);
        recordIngestOutcome(true);
        trackLatency(request);
        return json({ sessionId: raced, duplicate: true }, 200, { "X-Request-Id": requestId });
      }
      throw txErr;
    }

    inc("ingest_total", "Total ingest requests", 1);
    recordIngestAttempt({
      at: new Date().toISOString(), route: "ingest", deviceId,
      outcome: "accepted", points: filtered.length, dropped: gapMarkers,
      bytes: payloadBytes,
    }); // DIAG-1
    recordIngestOutcome(true); // P2-16
    trackLatency(request); // P2-16
    logger.info("Ingest success", {
      requestId,
      sessionId: session.session.id,
      points: filtered.length,
      deviceId,
      durationMs: Date.now() - start,
    });

    return json(
      {
        sessionId: session.session.id,
        pointsAccepted: filtered.length,
        trafficJobId: session.job.id,
        duplicate: false,
      },
      201,
      { "X-Request-Id": requestId }
    );
  } catch (err) {
    recordIngestOutcome(false); // P2-16: 5xx участвует в ingest_error_rate
    logger.error("Ingest error", {
      requestId,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - start,
    });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}
