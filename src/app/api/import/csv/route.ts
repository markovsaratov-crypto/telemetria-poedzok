// POST /api/import/csv — импорт GPS-сессий из CSV (auto-detect columns).
// Ожидаемые колонки (case-insensitive, любым разделителем , или ;): lat, lon, speed, altitude, accuracy, timestamp, bearing, device_id, client_id, device_name.
// timestamp может быть: epoch ms, epoch ns, ISO8601.
import { parseTimestamp } from "@/lib/parse-timestamp"; // v2.11.0: общий парсер времени (ISO/нс/мкс/мс/с)
import { parseCsvRecords } from "@/lib/csv-records"; // v2.38.2 (ревью F49): RFC-4180-парсер — кавычки, ""-экранирование, разделители внутри кавычек
import { NextRequest } from "next/server";
import { db, isD1QuotaError } from "@/lib/db";
import { authorizeRequest } from "@/lib/auth";
import { dataScopeFor } from "@/lib/scope";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import { inc } from "@/lib/metrics";
import pLimit from "p-limit";
import { randomUUID } from "crypto";
import { assignTripOnSessionFinalize } from "@/lib/trip-grouping"; // v2.26.0 (ТЗ §7): поездки после импорта
import { csvFallbackClientId, isUniqueConstraintError } from "@/lib/import-idempotency"; // v2.40.4 (ревью M-1): идемпотентность

const writeLock = pLimit(1);

// v2.38.2 (ревью F49): наивный parseCSV (split(sep) без кавычек) заменён
// общим RFC-4180-парсером csv-records.ts (паритет с ZIP-импортом): запятые в
// device_name/notes больше не сдвигают колонки.

function findCol(headers: string[], names: string[]): number {
  for (const n of names) {
    const i = headers.findIndex((h) => h === n || h.includes(n));
    if (i >= 0) return i;
  }
  return -1;
}

// v2.11.0: парсер времени вынесен в lib/parse-timestamp (общий с ZIP-импортом)
function finiteOrUndefined(raw: string): number | undefined {
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

export async function POST(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const auth = await authorizeRequest(request, "api");
    if (!auth.ok) return json({ error: auth.reason }, 401, { "X-Request-Id": requestId });

    const formData = await request.formData();
    const file = formData.get("file");
    if (!file || !(file instanceof File)) {
      return json({ error: "file required (multipart/form-data)" }, 400, { "X-Request-Id": requestId });
    }
    // v2.18.0: лимит размера файла ДО чтения в память (прокси резал честные CSV
    // на дефолтных 256 КБ — полный день 1 Гц ≈ 5 МБ; здесь — явный бизнес-лимит).
    const MAX_CSV_BYTES = 20 * 1024 * 1024; // 20 МБ
    if (file.size > MAX_CSV_BYTES) {
      return json({ error: `CSV file too large (${file.size} > ${MAX_CSV_BYTES} bytes)` }, 413, { "X-Request-Id": requestId });
    }
    const text = await file.text();
    const { headers, rows } = parseCsvRecords(text);

    if (headers.length === 0) {
      return json({ error: "Empty CSV" }, 400, { "X-Request-Id": requestId });
    }

    const iLat = findCol(headers, ["lat", "latitude"]);
    const iLon = findCol(headers, ["lon", "lng", "longitude"]);
    const iSpeed = findCol(headers, ["speed"]);
    const iAlt = findCol(headers, ["alt", "altitude", "elevation"]);
    const iAcc = findCol(headers, ["acc", "accuracy"]);
    const iTs = findCol(headers, ["ts", "timestamp", "time", "date"]);
    const iBearing = findCol(headers, ["bearing", "heading", "course"]);
    const iDevice = findCol(headers, ["device_id", "deviceid", "device"]);
    const iClient = findCol(headers, ["client_id", "clientid", "client"]);
    const iDeviceName = findCol(headers, ["device_name", "name"]);

    if (iLat < 0 || iLon < 0) {
      return json({ error: "CSV must contain lat and lon columns" }, 400, { "X-Request-Id": requestId });
    }

    // Группируем по deviceId (или по clientId если есть)
    // v2.18.0 (P1): fallback-clientId — ОДИН на весь файл, а не randomUUID()
    // на каждую строку. Раньше CSV без колонки client_id (обычный случай) рвал
    // каждую строку в СВОЮ сессию через `${deviceId}:${randomUUID()}` — тысячи
    // одно-точечных сессий, каждой — TrafficJob. Комментарий выше утверждал
    // обратное («группируем по deviceId»); ZIP-импорт делал это правильно.
    // v2.40.4 (ревью M-1): сам fallback больше НЕ randomUUID() на запрос —
    // тот же файл дважды = два «разных» clientId = полные дубликаты. Группируем
    // по deviceId с плейсхолдером, детерминированный clientId считается
    // ПОСЛЕ сортировки группы — из её контента (csvFallbackClientId).
    const groups = new Map<string, { deviceId: string; clientId: string | null; deviceName?: string; points: { lat: number; lon: number; speed?: number; altitude?: number; accuracy?: number; timestamp: number; bearing?: number }[] }>();
    // v2.38.2 (ревью F37): строки с непарсящимся таймстемпом больше НЕ получают
    // Date.now() (фальсификация времени: «сейчас» ломало startTime/сортировку/
    // дату поездки — фикс D-6 для sensorlogger не был применён здесь). Как в
    // ZIP-импорте: строка отбрасывается и попадает в счётчик skipped.
    let skippedUnparseableTs = 0;

    for (const row of rows) {
      const lat = Number(row[iLat]);
      const lon = Number(row[iLon]);
      // v2.29.0 (MI-7 кодревью): диапазонные проверки — паритет с zIngestBody
      // (validation.ts ±90/±180); мусорные координаты (0/999 и т.п.) не попадают в БД.
      if (isNaN(lat) || isNaN(lon)) continue;
      if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;
      // Нет колонки времени → Date.now() (как в ZIP); битая/пустая/отсутствующая
      // ячейка (рваная строка короче заголовка) → skip
      const ts = iTs < 0 ? Date.now() : row[iTs] != null ? parseTimestamp(row[iTs]) : null;
      if (ts == null) {
        skippedUnparseableTs++;
        continue;
      }
      const deviceId = iDevice >= 0 ? row[iDevice] || "csv-import" : "csv-import";
      // v2.40.4: clientId из файла — детерминирован сам по себе (повторный
      // импорт честно ловит @@unique); без колонки — плейсхолдер (одна группа
      // на deviceId), реальный clientId посчитается из контента группы.
      const clientId = iClient >= 0 && row[iClient] ? row[iClient] : null;
      const key = `${deviceId}:${clientId ?? "__fallback__"}`;
      if (!groups.has(key)) {
        groups.set(key, { deviceId, clientId, deviceName: iDeviceName >= 0 ? row[iDeviceName] : undefined, points: [] });
      }
      groups.get(key)!.points.push({
        lat,
        lon,
        // v2.11.0 (АУДИТ C-22): «Number(x) || undefined» превращал ЛЕГИТИМНЫЕ нули
        // (speed=0 — стоим; altitude=0 — уровень моря) в NULL. Теперь честная проверка.
        speed: iSpeed >= 0 ? finiteOrUndefined(row[iSpeed]) : undefined,
        altitude: iAlt >= 0 ? finiteOrUndefined(row[iAlt]) : undefined,
        accuracy: iAcc >= 0 ? finiteOrUndefined(row[iAcc]) : undefined,
        timestamp: ts,
        // v2.18.0: bearing — finiteOrUndefined, как speed/alt/acc (АУДИТ C-22
        // для соседних полей): «Number(x) || undefined» превращал ЛЕГИТИМНЫЙ
        // bearing 0 (север) в NULL.
        bearing: iBearing >= 0 ? finiteOrUndefined(row[iBearing]) : undefined,
      });
    }

    const imported: { id: string; deviceId: string; points: number }[] = [];
    const errors: { deviceId: string; error: string }[] = [];
    // v2.40.4 (ревью M-1): дубликаты (тот же файл уже импортирован) —
    // НЕ ошибка, отдельный счётчик с внятным статусом в ответе.
    const duplicates: string[] = [];
    // v2.23.0: изоляция данных — импорт привязывается к импортёру (role=user)
    const importerScope = dataScopeFor(auth);
    const importerUserId = importerScope.mode === "own" ? importerScope.userId : null;

    for (const [, g] of groups) {
      try {
        g.points.sort((a, b) => a.timestamp - b.timestamp);
        // v2.40.4 (ревью M-1): детерминированный clientId из контента группы —
        // ПОСЛЕ сортировки (нужны первый/последний таймстемпы).
        if (g.clientId == null) {
          g.clientId = csvFallbackClientId(g.deviceId, g.points);
        }
        const startTime = new Date(g.points[0].timestamp);
        const endTime = new Date(g.points[g.points.length - 1].timestamp);

        // v2.40.2 (инцидент 18.09 «ошибка импорта файла поездки»): как в
        // ZIP-импорте — финальный `UPDATE Session SET trafficJobId…` УДАЛЁН,
        // id джоба генерируется ДО сессии и пишется в её строку сразу.
        // Транзакция = чистые INSERT'ы (rowsRead = 0 на D1) и не падает при
        // исчерпанной дневной квоте чтений free tier; атомарность на месте
        // (батч шлюза — одна D1-транзакция на чанк).
        const trafficJobId = randomUUID();
        const session = await writeLock(async () => {
          return db.$transaction(async (tx) => {
            const s = await tx.session.create({
              data: {
                deviceId: g.deviceId,
                clientId: g.clientId,
                deviceName: g.deviceName,
                startTime,
                endTime,
                pointCount: g.points.length,
                payloadBytes: Buffer.byteLength(JSON.stringify(g.points)),
                status: "completed",
                trafficJobId,
                ...(importerUserId ? { userId: importerUserId } : {}), // v2.23.0: изоляция
              },
            });
            await tx.gpsPoint.createMany({
              data: g.points.map((p) => ({
                sessionId: s.id,
                lat: p.lat,
                lon: p.lon,
                speed: p.speed ?? null,
                altitude: p.altitude ?? null,
                accuracy: p.accuracy ?? null,
                bearing: p.bearing ?? null,
                timestamp: BigInt(p.timestamp),
              })),
            });
            const job = await tx.trafficJob.create({
              data: { id: trafficJobId, sessionId: String(s.id), status: "pending" },
            });
            return { s, job };
          });
        });
        imported.push({ id: String(session.s.id), deviceId: String(session.s.deviceId), points: g.points.length });
        // v2.26.0 (ТЗ §7): импорт создаёт completed-запись — назначаем поездки
        // устройства (канонический пересчёт; non-fatal, ошибки не в errors[])
        await assignTripOnSessionFinalize(String(session.s.id)).catch(() => null);
        inc("ingest_total", "Total ingest requests", 1, "csv");
      } catch (err) {
        // v2.40.4 (ревью M-1): нарушение @@unique([deviceId, clientId]) —
        // этот файл/группа уже импортированы. Не ошибка: дубликат не создаётся
        // (транзакция атомарна), пользователь получает честный статус.
        if (isUniqueConstraintError(err)) {
          duplicates.push(g.deviceId);
          logger.info("CSV import: duplicate group skipped", { requestId, deviceId: g.deviceId, points: g.points.length });
          continue;
        }
        // v2.38.2 (ревью F36): err.message наружу утекал внутренности БД/libsql
        // (имена констрейнтов, SQL) в ответе 200.errors[]. Детали — в серверный
        // лог (с deviceId и requestId), клиенту — стабильный код ошибки.
        // v2.40.2: квота D1 — отдельный стабильный код (читается восстановимо,
        // сброс в 00:00 UTC), чтобы клиент мог показать внятный тост.
        const detail = err instanceof Error ? err.message : String(err);
        const quotaBlocked = isD1QuotaError(err);
        logger.warn("CSV import: session batch failed", {
          requestId,
          deviceId: g.deviceId,
          points: g.points.length,
          quotaBlocked,
          error: detail,
        });
        errors.push({ deviceId: g.deviceId, error: quotaBlocked ? "d1_quota_exhausted" : "import_failed" });
      }
    }

    // v2.38.2 (ревью F37): пропущенные строки (битый таймстемп) — в ответ,
    // чтобы фальсификация времени не проходила молча
    // v2.40.2: подсказка при квоте — сколько ждать (сброс 00:00 UTC)
    const quotaHit = errors.some((e) => e.error === "d1_quota_exhausted");
    return json(
      {
        imported: imported.length,
        sessions: imported,
        errors,
        skipped: { unparseableTimestamp: skippedUnparseableTs },
        // v2.40.4 (ревью M-1): дубликаты — отдельным полем (UI показывает
        // «уже импортировано», а не молчаливую ошибку или новый дубликат)
        duplicates: duplicates.length,
        duplicateDevices: [...new Set(duplicates)],
        ...(quotaHit ? { quota: "дневная квота чтений D1 исчерпана — сброс в 00:00 UTC" } : {}),
      },
      200,
      { "X-Request-Id": requestId }
    );
  } catch (err) {
    logger.error("CSV import error", { requestId, error: err instanceof Error ? err.message : String(err) });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}
