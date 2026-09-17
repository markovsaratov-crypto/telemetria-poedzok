// src/lib/share.ts — P1-9: share-токены (HMAC от sessionId+срока, ключ SESSION_SECRET) +
// v2.38.1 (ревью F14) РЕЕСТР выданных (отзываемость, см. блок ниже).
// Раньше токены жили в in-memory Map и терялись при рестарте процесса.
import { createHmac, createHash } from "crypto";
import { env } from "./env";
import { db, libsql } from "./db";
import { json } from "./http-utils";
import { haversineM } from "./geo";
import { computeMovingTime, computeActiveTrip, type MethodologyPoint, type ActiveTrip } from "./active-trip";
import { maxSpeedMs, normalizeSessionSpeeds } from "./kpi";
import { tokenMatches } from "./token-check"; // v2.16.0 (D-16): timing-safe сверка сигнатуры

export const SHARE_DEFAULT_TTL_HOURS = 168; // 7 дней
// v2.38.1 (ревью F14): максимум срока — 30 дней (было 8760 = 1 год: утёкшая
// ссылка открывала точный GPS-трек почти навсегда, а отозвать её было нечем).
// UI (share-button) предлагает 7/30 дней — лимит не ломает ни один сценарий.
export const SHARE_MAX_TTL_HOURS = 720;

// ——— v2.38.1 (ревью F14): реестр выданных токенов — ОТЗЫВАЕМОСТЬ ———
// Проблема (находка F14): токен = stateless HMAC без jti/реестра — отозвать
// конкретную ссылку НЕЛЬЗЯ (только ротация SESSION_SECRET, ломающая все
// сессии сразу, или удаление самой сессии — деструктивный побочный эффект).
// Решение: таблица ShareToken (ensure-on-boot при первом обращении — тот же
// паттерн, что _AlertState в alerts.ts; сырой SQL через libsql, БЕЗ prisma-
// схемы — ею владеет другое изменение). Храним ТОЛЬКО SHA-256 токена: утечка
// дампа БД не раскрывает сами ссылки. expiresAt/createdAt — для ops-чистки.
//
// МИГРАЦИОННЫЙ КОМПРОМИСС: токены, выданные ДО реестра, в нём отсутствуют —
// verifyShareToken считает их валидными до собственного exp (stateless-HMAC
// остаётся источником истины). Реестр НЕ аннулирует старые токены задним
// числом — отзываемыми становятся все новые выдачи.
let shareTokenTableEnsured = false;

async function ensureShareTokenTable(): Promise<void> {
  if (shareTokenTableEnsured) return;
  await libsql.execute(
    "CREATE TABLE IF NOT EXISTS ShareToken (tokenHash TEXT PRIMARY KEY, sessionId TEXT NOT NULL, expiresAt INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, createdAt INTEGER NOT NULL)"
  );
  shareTokenTableEnsured = true;
}

/** SHA-256(токен) — ключ реестра; сам токен в БД не попадает НИКОГДА. */
function shareTokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

// v2.38.1 (F14): makeShareToken стал async (регистрация в реестре); форма
// возвращаемого значения не изменилась — call sites добавляют только await.
export async function makeShareToken(sessionId: string, ttlHours: number): Promise<{ token: string; expiresAt: number }> {
  const expiresAt = Date.now() + ttlHours * 3600 * 1000;
  const exp36 = expiresAt.toString(36);
  const token = `${sessionId}.${exp36}.${sign(sessionId, exp36)}`;
  // Регистрация — best-effort: сбой записи не ломает выдачу ссылки (токен
  // остаётся валидным stateless-путём, как до F14); повторная попытка — при
  // следующем создании.
  try {
    await ensureShareTokenTable();
    await libsql.execute({
      sql: `INSERT OR REPLACE INTO ShareToken (tokenHash, sessionId, expiresAt, revoked, createdAt) VALUES (?, ?, ?, 0, ?)`,
      args: [shareTokenHash(token), sessionId, expiresAt, Date.now()],
    });
  } catch {
    // реестр недоступен (молодая БД/сбой шлюза) — не блокируем шаринг
  }
  return { token, expiresAt };
}

function sign(sessionId: string, exp36: string): string {
  return createHmac("sha256", env().SESSION_SECRET).update(`${sessionId}:${exp36}`).digest("hex").slice(0, 32);
}

export async function verifyShareToken(token: string): Promise<{ sessionId: string; expiresAt: number } | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [sessionId, exp36, sig] = parts;
  if (!sessionId || !exp36 || !sig) return null;
  if (!/^[0-9a-f]{32}$/.test(sig)) return null;
  const expected = sign(sessionId, exp36);
  // v2.16.0 (D-16): timing-safe сверка через token-check (раньше — самодельный
  // XOR-цикл, дублирующий ту же логику).
  // v2.18.0 (P0): tokenMatches — АСИНХРОННАЯ функция. Рефакторинг v2.16.0
  // потерял await: Promise всегда truthy → !tokenMatches(...) всегда false →
  // проверка подписи была no-op, и ЛЮБОЙ токен вида
  // «<sessionId>.<будущий срок>.<любые 32 hex>» проходил верификацию на
  // публичном роуте. await обязателен.
  if (!(await tokenMatches(sig, expected))) return null;
  const expiresAt = parseInt(exp36, 36);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return null;
  // v2.38.1 (ревью F14): проверка реестра — отозванные токены отклоняются.
  // Строки НЕТ → legacy-токен (выдан до реестра): валиден до собственного exp
  // (миграционный компромисс, см. ensureShareTokenTable). Недоступность
  // реестра не роняет шаринг — stateless-проверка выше уже прошла.
  try {
    await ensureShareTokenTable();
    const res = await libsql.execute({
      sql: "SELECT revoked FROM ShareToken WHERE tokenHash = ?",
      args: [shareTokenHash(token)],
    });
    if (res.rows.length > 0 && Number((res.rows[0] as Record<string, unknown>).revoked) === 1) {
      return null;
    }
  } catch {
    // реестр недоступен — деградируем к прежнему stateless-поведению
  }
  return { sessionId, expiresAt };
}

// ——— v2.38.1 (ревью F14): API отзыва ———

/** Отозвать конкретный share-токен (владелец попросил «убрать ссылку»).
 *  Возвращает число затронутых строк (0 = токена нет в реестре — либо legacy,
 *  либо уже отозван). */
export async function revokeShareToken(token: string): Promise<number> {
  await ensureShareTokenTable();
  const res = await libsql.execute({
    sql: "UPDATE ShareToken SET revoked = 1 WHERE tokenHash = ? AND revoked = 0",
    args: [shareTokenHash(token)],
  });
  return Number(res.rowsAffected ?? 0);
}

/** Отозвать ВСЕ токены сессии (вызывается при soft-delete записи —
 *  sharePayload и так 404 на deletedAt, но отзыв закрывает ссылку и для
 *  legacy-периода grace/до полной зачистки). Возвращает число отозванных. */
export async function revokeSessionShares(sessionId: string): Promise<number> {
  await ensureShareTokenTable();
  const res = await libsql.execute({
    sql: "UPDATE ShareToken SET revoked = 1 WHERE sessionId = ? AND revoked = 0",
    args: [sessionId],
  });
  return Number(res.rowsAffected ?? 0);
}

// v2.31.0 (MAJ-9): интервал [prevTs, ts] пересекает активную часть — семантика
// intervalInActiveLegs из session-stats.ts (правая точка ≥ старта окна, левая ≤
// финиша; legacy без legs — span). Локальная копия — чтобы не расширять экспорт.
function shareIntervalInActiveLegs(activeTrip: ActiveTrip, prevTs: number, ts: number): boolean {
  const legs = activeTrip.legs;
  if (legs && legs.length > 0) {
    for (const l of legs) {
      if (ts >= l.startTime && prevTs <= l.endTime) return true;
    }
    return false;
  }
  return ts >= activeTrip.activeStartTime && prevTs <= activeTrip.activeEndTime;
}

// Общий payload для обоих share-GET-роутов (sessions/[id]/share и /api/share)
export async function sharePayload(sessionId: string, expiresAt: number, requestId: string) {
  const session = await db.session.findUnique({
    where: { id: sessionId },
    include: {
      gpsPoints: { orderBy: { timestamp: "asc" } },
    },
  });

  if (!session || session.deletedAt) {
    return json({ error: "Not found" }, 404, { "X-Request-Id": requestId });
  }

  // FIX-C3: серверные KPI по методологии — раньше страница считала дистанцию
  // по всей записи (включая дрейф «хвостов») и среднюю скорость как
  // «вся дистанция / вся длительность», расходясь с админкой.
  // v2.18.0: типизированный db — gpsPoints unknown
  const gpsPts = (session.gpsPoints ?? []) as Array<Record<string, unknown>>;
  const rawPoints = gpsPts.map((p) => ({
    lat: Number(p.lat),
    lon: Number(p.lon),
    speed: p.speed == null ? null : Number(p.speed),
    altitude: p.altitude == null ? null : Number(p.altitude),
    bearing: p.bearing == null ? null : Number(p.bearing),
    accuracy: p.accuracy == null ? null : Number(p.accuracy),
    timestamp: Number(p.timestamp),
  }));
  // B-4: нормализация скоростей — публичная страница согласована с админкой
  const points = normalizeSessionSpeeds(rawPoints);

  let rawDistanceM = 0;
  let distanceM = 0; // активная дистанция (§4.11)
  let activeDurationSec = 0;
  let preTripIdleSec = 0;
  let postTripIdleSec = 0;
  let hasActiveTrip = false;
  if (points.length >= 2) {
    const motion = computeMovingTime(points as MethodologyPoint[]);
    const active = computeActiveTrip(points as MethodologyPoint[], motion);
    hasActiveTrip = active.hasActiveTrip;
    activeDurationSec = active.activeDuration;
    preTripIdleSec = active.preTripIdle;
    postTripIdleSec = active.postTripIdle;
    for (let i = 1; i < points.length; i++) {
      const d = haversineM(points[i - 1].lat, points[i - 1].lon, points[i].lat, points[i].lon);
      rawDistanceM += d;
      // v2.31.0 (MAJ-9): гейтинг по LEGS (§4.11), как в session-stats
      // (intervalInActiveLegs). Раньше — по SPAN (activeStartTime…activeEndTime):
      // для мульти-поездочных записей долгая парковка между поездками
      // попадала в «активную» дистанцию — гибрид «span-дистанция /
      // legs-длительность» расходился с приложением и каноном §4.2.
      if (hasActiveTrip && shareIntervalInActiveLegs(active, points[i - 1].timestamp, points[i].timestamp)) {
        distanceM += d;
      }
    }
  }
  const maxSpeed = maxSpeedMs(points) ?? 0;

  // v2.38.1 (ревью F21): плотность трека vs размер payload. Публичная страница
  // не нуждается в полном разрешении: 56K точек = ~3–4 МБ JSON + тяжёлый SVG-рендер
  // (и Math.min(...lats) спредом на клиенте). KPI выше считаются по ПОЛНОМУ
  // массиву — прореживание только наружу: равномерный сэмпл ≤800 точек, первая/
  // последняя сохранены всегда (старт/финиш трека), значения speed остаются при
  // СВОИХ оставшихся точках (никакой интерполяции). Форма ответа не меняется.
  const MAX_SHARE_POINTS = 800;
  let sharePoints = points;
  if (points.length > MAX_SHARE_POINTS) {
    const step = (points.length - 1) / (MAX_SHARE_POINTS - 1);
    sharePoints = [];
    for (let i = 0; i < MAX_SHARE_POINTS - 1; i++) {
      sharePoints.push(points[Math.round(i * step)]);
    }
    sharePoints.push(points[points.length - 1]); // финиш — всегда
  }

  return json(
    {
      sessionId: session.id,
      deviceId: session.deviceId,
      deviceName: session.deviceName,
      startTime: session.startTime,
      endTime: session.endTime,
      pointCount: session.pointCount,
      points: sharePoints.map((p) => ({
        lat: p.lat,
        lon: p.lon,
        speed: p.speed,
        altitude: p.altitude,
        timestamp: p.timestamp,
      })),
      // FIX-C3: серверные KPI (активная часть) — клиент только отображает
      distanceM: Math.round(distanceM),
      rawDistanceM: Math.round(rawDistanceM),
      activeDurationSec: Math.round(activeDurationSec),
      preTripIdleSec: Math.round(preTripIdleSec),
      postTripIdleSec: Math.round(postTripIdleSec),
      hasActiveTrip,
      maxSpeedMs: Math.round(maxSpeed * 10) / 10,
      shared: true,
      expiresAt: new Date(expiresAt).toISOString(),
    },
    200,
    { "X-Request-Id": requestId }
  );
}

