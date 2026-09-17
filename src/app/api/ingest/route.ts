// POST /api/ingest — приём GPS-данных (§4.1). Bearer INGEST_TOKEN.
// Идемпотентность через (deviceId, clientId). p-limit(1) serialization для SQLite write lock.
// v2.23.0: ЛИЧНЫЙ токен пользователя (User.apiKey) — сессии привязываются к userId.
import { NextRequest } from "next/server";
import { zIngestBody } from "@/lib/validation";
import { findExistingSession } from "@/lib/idempotency";
import { db } from "@/lib/db";
import { payloadLimitBytes, isPayloadTooLarge } from "@/lib/payload-limit"; // v2.38.1 (ревью F20)
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import { inc } from "@/lib/metrics";
import { recordIngestAttempt } from "@/lib/ingest-trace"; // DIAG-1: трассировка попыток
import { recordIngestOutcome } from "@/lib/alerts"; // P2-16: правило ingest_error_rate
import { trackLatency } from "@/lib/latency"; // P2-16: api_latency_p95
import { parseTimestamp } from "@/lib/parse-timestamp"; // v2.38.2 (ревью F39): единый парсер времени (с/мс/мкс/нс/ISO)
import { MAX_TRUSTED_ACCURACY_M } from "@/lib/kpi"; // v2.38.2 (ревью F38): единый порог точности точек (100 м, AUDIT B-5)
// v2.38.1 (ревью F11): extractBearer + resolveIngestToken — единая проверка инжест-токенов
import { extractBearer, resolveIngestToken } from "@/lib/auth";

// v2.38.2 (ревью F38): окно правдоподобия времени точки (±24 ч от серверного
// now) — зеркально sensorlogger-каналу (R7): таймстемы 1970/будущего больше
// не пишутся в БД и метрики (двухканальная симметрия B-5/R7).
const TS_PLAUSIBILITY_MS = 24 * 60 * 60 * 1000;

export async function POST(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  const start = Date.now();
  try {
    // v2.16.0 (V9): проверка INGEST_TOKEN и В РОУТЕ тоже (defense-in-depth — как в
    // sensorlogger). Обычно прокси уже отсекает, но один регресс матчера — и роут
    // без своей проверки писал бы данные по любому запросу.
    const bearer = extractBearer(request);
    const queryToken = new URL(request.url).searchParams.get("token");
    // v2.38.1 (ревью F11): единая проверка (auth.ts): глобальный INGEST_TOKEN
    // (Bearer/?token=, канал владельца) / производный it_-токен (Bearer/?token=,
    // SensorLogger Push URL) / сырой per-user apiKey — ТОЛЬКО Bearer-заголовок.
    // Раньше сырой apiKey принимался из ?token= и утекал в access-логи
    // CDN/Render. Ротация apiKey автоматически ротирует it_-токен (HMAC).
    const ingestAuth = await resolveIngestToken(bearer, queryToken);
    // v2.23.0: пер-юзерный токен → привязка сессий к пользователю (userId IS NULL = владелец)
    const ingestUserId = ingestAuth.ok ? ingestAuth.userId : null;
    if (!ingestAuth.ok) {
      inc("ingest_unauthorized_total", "Ingest attempts rejected with 401 (bad or missing token)", 1, "ingest");
      return json({ error: "Unauthorized", reason: ingestAuth.reason }, 401, { "X-Request-Id": requestId });
    }

    // v2.38.1 (ревью F20): РЕАЛЬНАЯ проверка размера тела — ПОСЛЕ чтения, ДО
    // json.parse/Zod. Прежняя схема полагалась на Content-Length в proxy —
    // Transfer-Encoding: chunked обходил гард; request.json() парсил в память
    // тело любого размера (Zod points ≤1000 срабатывал ПОСЛЕ полного парсинга:
    // один chunked-запрос на сотни МБ → OOM инстанса 512 МБ).
    const rawBody = await request.text().catch(() => "");
    if (isPayloadTooLarge(Buffer.byteLength(rawBody))) {
      inc("ingest_invalid_total", "Ingest rejected with 413 (payload over MAX_PAYLOAD_BYTES)", 1, "ingest");
      recordIngestOutcome(false); // P2-16: 413 — валидационная ошибка, участвует в ingest_error_rate
      return json({ error: "Payload too large", limit: payloadLimitBytes() }, 413, { "X-Request-Id": requestId });
    }
    let body: unknown = null;
    try {
      body = JSON.parse(rawBody);
    } catch {
      body = null; // невалидный JSON → Zod-ветка 400 (прежняя семантика request.json().catch(() => null))
    }
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
    const existing = await findExistingSession(deviceId, clientId!, ingestUserId);
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

    // 2. Нормализация таймстемпов + входные фильтры — v2.38.2 (ревью F38/F39):
    // паритет с sensorlogger-каналом. Раньше здесь была ТРЕТЬЯ реализация
    // магнитуда-эвристики (инлайн, без ISO и µs) рядом с «единым» парсером
    // parse-timestamp.ts (F39), НЕ было окна ±24 ч (R7 — таймстемы 1970/будущего
    // писались в БД) и accuracy-фильтра (B-5 — мусор 400–585 м портил метрики).
    const now = Date.now();
    let droppedTimestamp = 0; // непарсящееся/неправдоподобное (±24 ч) время
    let droppedInaccurate = 0; // accuracy > 100 м (AUDIT B-5)
    const normalized: {
      lat: number; lon: number; speed: number | null; altitude: number | null;
      accuracy: number | null; bearing: number | null; timestampMs: number;
    }[] = [];
    for (const p of points) {
      // v2.38.2 (ревью F39): единый parseTimestamp — с/мс/мкс/нс/ISO (µs — F74);
      // null → точка отброшена, «фальшивое сейчас» НЕ подставляется (D-6)
      const ts = parseTimestamp(String(p.timestamp));
      if (ts == null || Math.abs(now - ts) > TS_PLAUSIBILITY_MS) {
        droppedTimestamp++;
        continue;
      }
      if (p.accuracy != null && p.accuracy > MAX_TRUSTED_ACCURACY_M) {
        droppedInaccurate++;
        continue;
      }
      normalized.push({
        lat: p.lat,
        lon: p.lon,
        speed: p.speed ?? null,
        altitude: p.altitude ?? null,
        accuracy: p.accuracy ?? null,
        bearing: p.bearing ?? null,
        timestampMs: ts,
      });
    }
    if (droppedTimestamp > 0 || droppedInaccurate > 0) {
      logger.warn("Ingest: dropped points on input filters", {
        requestId, deviceId,
        droppedTimestamp, droppedInaccurate, received: points.length,
      });
    }
    if (normalized.length === 0) {
      // v2.38.2 (ревью F38): пустую сессию не создаём; трейс-исход dropped_all
      // (как в sensorlogger) — приложение не увидит ложного успеха молча
      recordIngestOutcome(false); // P2-16: 400 — валидационная ошибка
      recordIngestAttempt({
        at: new Date().toISOString(), route: "ingest", deviceId,
        outcome: "dropped_all", points: 0, dropped: droppedTimestamp + droppedInaccurate,
        bytes: Buffer.byteLength(rawBody),
      }); // DIAG-1
      return json(
        {
          error: "All points rejected by input filters",
          dropped: { timestamp: droppedTimestamp, accuracy: droppedInaccurate },
          plausibilityWindowHours: TS_PLAUSIBILITY_MS / (60 * 60 * 1000),
          maxAccuracyM: MAX_TRUSTED_ACCURACY_M,
        },
        400,
        { "X-Request-Id": requestId }
      );
    }
    normalized.sort((a, b) => a.timestampMs - b.timestampMs);

    // v2.11.0 (АУДИТ C-10): gap сравнивается между СОСЕДНИМИ исходными точками.
    // v2.16.0 (R9): точка-возобновление ПОСЛЕ паузы СОХРАНЯЕТСЯ (раньше —
    // отбрасывалась: «прогулка с паузой» теряла первую точку после каждого
    // перерыва; это не «фильтр мусора», а реальные данные)
    // v2.18.0: мёртвый «фильтр» удалён — цикл сохранял КАЖДУЮ точку, а ветка
    // `if (filtered.length === 0) push(...normalized)` была недостижима
    // (filtered всегда == normalized по построению; zIngestBody требует ≥1 точки).
    const filtered = normalized;
    let gapMarkers = 0;
    let lastTs: number | null = null;
    for (const p of normalized) {
      if (lastTs !== null && p.timestampMs - lastTs > 30000) {
        gapMarkers++; // gap > 30 с — маркер разрыва, точка СОХРАНЯЕТСЯ (не «отброшена»!)
      }
      lastTs = p.timestampMs;
    }

    const startTime = new Date(filtered[0].timestampMs);
    const endTime = new Date(filtered[filtered.length - 1].timestampMs);
    const payloadBytes = Buffer.byteLength(JSON.stringify(body));

    // 3. INSERT (no global write lock — SQLite WAL handles concurrency)
    // v2.16.0 (B-6): защита от TOCTOU-гонки идемпотентности — два параллельных
    // ретрая проходят findExistingSession(null) одновременно, второй INSERT
    // падает по @@unique(deviceId,clientId) → раньше это был 500; теперь —
    // повторная проверка и честный ответ duplicate.
    let session: { session: Record<string, unknown>, job: Record<string, unknown> };
    try {
      session = await db.$transaction(async (tx) => {
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
            ...(ingestUserId ? { userId: ingestUserId } : {}), // v2.23.0: изоляция данных
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
          where: { id: String(s.id) },
          data: { trafficJobId: String(job.id) },
        });
        return { session: s, job };
      });
    } catch (txErr) {
      // race-фолбэк — БЕЗ скоупа: уникальный ключ (deviceId, clientId) глобален;
      // коллизия пары разных владельцев маловероятна (clientId — UUID батча),
      // но честный «duplicate» лучше 500-го
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
      // v2.38.2 (ревью F38): dropped — ЧЕСТНЫЙ счётчик отброшенных точек
      // (битое время + accuracy), а НЕ gap-маркеры, как раньше — диагностика
      // «точка-сохранена-но-разрыв» ≠ «точка-отброшена», поле вводило в заблуждение
      outcome: "accepted", points: filtered.length, dropped: droppedTimestamp + droppedInaccurate,
      bytes: payloadBytes,
    }); // DIAG-1
    recordIngestOutcome(true); // P2-16
    trackLatency(request); // P2-16
    logger.info("Ingest success", {
      requestId,
      sessionId: String(session.session.id),
      points: filtered.length,
      droppedTimestamp,
      droppedInaccurate,
      gapMarkers,
      deviceId,
      durationMs: Date.now() - start,
    });

    return json(
      {
        sessionId: String(session.session.id),
        pointsAccepted: filtered.length,
        // v2.38.2 (ревью F38): прозрачность частичного отбрака в ответе
        dropped: { timestamp: droppedTimestamp, accuracy: droppedInaccurate },
        gapMarkers,
        trafficJobId: String(session.job.id),
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
