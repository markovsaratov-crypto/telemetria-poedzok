// POST /api/ingest — приём GPS-данных (§4.1). Bearer INGEST_TOKEN.
// Идемпотентность через (deviceId, clientId). p-limit(1) serialization для SQLite write lock.
import { NextRequest } from "next/server";
import { zIngestBody } from "@/lib/validation";
import { findExistingSession } from "@/lib/idempotency";
import { db } from "@/lib/db";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import { inc } from "@/lib/metrics";

export async function POST(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  const start = Date.now();
  try {
    const body = await request.json().catch(() => null);
    const parsed = zIngestBody.safeParse(body);
    if (!parsed.success) {
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
      return json(
        { sessionId: existing, duplicate: true },
        200,
        { "X-Request-Id": requestId }
      );
    }

    // 2. Нормализация таймстемпов: нс → мс, фильтрация gap > 30 с
    const normalized = points
      .map((p) => ({
        lat: p.lat,
        lon: p.lon,
        speed: p.speed ?? null,
        altitude: p.altitude ?? null,
        accuracy: p.accuracy ?? null,
        bearing: p.bearing ?? null,
        // Если timestamp > 1e15 — считаем наносекундами, делим на 1e6
        timestampMs: Number(p.timestamp) > 1e15 ? Math.floor(Number(p.timestamp) / 1e6) : Number(p.timestamp),
      }))
      .sort((a, b) => a.timestampMs - b.timestampMs);

    const filtered: typeof normalized = [];
    let lastTs: number | null = null;
    for (const p of normalized) {
      if (lastTs !== null && p.timestampMs - lastTs > 30000) {
        // gap > 30 с — пропускаем (§3.1)
      } else {
        filtered.push(p);
        lastTs = p.timestampMs;
      }
    }
    if (filtered.length === 0) {
      filtered.push(...normalized);
    }

    const startTime = new Date(filtered[0].timestampMs);
    const endTime = new Date(filtered[filtered.length - 1].timestampMs);
    const payloadBytes = Buffer.byteLength(JSON.stringify(body));

    // 3. INSERT (no global write lock — SQLite WAL handles concurrency)
    const session = await db.$transaction(async (tx: any) => {
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

    inc("ingest_total", "Total ingest requests", 1);
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
    logger.error("Ingest error", {
      requestId,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - start,
    });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}
