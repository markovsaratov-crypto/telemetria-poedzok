// GET /api/sessions/[id]/stats — детальная статистика по сессии.
// Возвращает: distance, duration, avgSpeed, maxSpeed, avgAltitude, elevationGain/loss, movingTime, idleTime
// + v2.9: полный набор метрик методологии (62 метрики в 8 группах + routeId) + план-факт из TrafficJob.
// v2.9: AvgSpeed использует ActiveDuration (§4.11), movingTime/idleTime из state machine (§4.6/§4.7).
import { NextRequest } from "next/server";
import { db, libsql } from "@/lib/db";
import { authorizeRequest } from "@/lib/auth";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import { computeMethodologyMetrics, calibrateEcoScoreBaselinesFromCorpus, type EcoScoreBaselines } from "@/lib/metrics-methodology";
import { avgSpeedMs, meanPointSpeedMs, maxSpeedMs } from "@/lib/kpi"; // P2-13: единый источник KPI
import { haversineM } from "@/lib/geo"; // P2-14: канонический гаверсинус
import { trackLatency } from "@/lib/latency"; // P2-16: замер api_latency_p95

// P1-7: план-фактные отклонения и трафик-блок из результата ворчера (§6.3/§6.6/§6.7/§6.8 методологии)
interface RoutePlanFact {
  provider: string | null;
  planDistanceM: number | null;
  planDurationSec: number | null;
  trafficFetched: boolean;
  trafficDurationSec: number | null;
  timeLostToTrafficSec: number | null;
  durationDeviationPct: number | null;
  distanceDeviationPct: number | null;
  speedDeviationPct: number | null;
}

async function computePlanFact(
  sessionId: string,
  actualDistanceM: number,
  actualDurationSec: number,
  actualAvgSpeed: number | null
): Promise<RoutePlanFact> {
  const empty: RoutePlanFact = {
    provider: null,
    planDistanceM: null,
    planDurationSec: null,
    trafficFetched: false,
    trafficDurationSec: null,
    timeLostToTrafficSec: null,
    durationDeviationPct: null,
    distanceDeviationPct: null,
    speedDeviationPct: null,
  };
  try {
    const res = await libsql.execute({
      sql: "SELECT status, result FROM TrafficJob WHERE sessionId = ? AND status = 'completed' ORDER BY updatedAt DESC LIMIT 1",
      args: [sessionId],
    });
    if (res.rows.length === 0) return empty;
    const row = res.rows[0] as Record<string, unknown>;
    if (!row.result) return empty;
    let parsed: any;
    try { parsed = JSON.parse(String(row.result)); } catch { return empty; }
    if (!parsed || typeof parsed !== "object") return empty;
    const provider = parsed.provider ? String(parsed.provider) : null;

    // План: дистанция провайдера — всегда плановая (геометрия маршрута).
    // Время: для OSRM — свободный поток (план); для 2ГИС total_duration включает пробки →
    // план по времени считаем по базовой линии гаверсинус/40 км/ч (§3.2), трафик — от 2ГИС.
    const distM = Number(parsed.distanceM) || null;
    const durS = Number(parsed.durationSec) || null;
    const trafficFetched = !!parsed.trafficFetched;
    const planDistanceM = distM;
    let planDurationSec = trafficFetched ? null : durS;
    let trafficDurationSec = trafficFetched ? durS : null;
    let timeLostToTrafficSec: number | null = null;

    if (trafficFetched && durS && distM) {
      const direct =
        Array.isArray(parsed.segments) && parsed.segments.length >= 2
          ? haversineM(parsed.segments[0].lat, parsed.segments[0].lon, parsed.segments[parsed.segments.length - 1].lat, parsed.segments[parsed.segments.length - 1].lon)
          : null;
      if (direct && direct > 1) {
        const baselineDur = Math.round((direct / 1000 / 40) * 3600); // гаверсинус @ 40 км/ч
        planDurationSec = baselineDur;
        timeLostToTrafficSec = durS - baselineDur; // §6.8
      }
    }

    const pct = (actual: number, plan: number) =>
      plan > 0 ? Math.round(((actual - plan) / plan) * 1000) / 10 : null;

    let speedDeviationPct: number | null = null;
    if (actualAvgSpeed != null && planDistanceM && planDurationSec && planDurationSec > 0) {
      const planSpeed = planDistanceM / planDurationSec;
      speedDeviationPct = planSpeed > 0 ? Math.round(((actualAvgSpeed - planSpeed) / planSpeed) * 1000) / 10 : null;
    }
    // §6.7: если план по времени недоступен (2ГИС-трафик) — скорость плана = дистанция плана / трафик-время
    if (speedDeviationPct == null && actualAvgSpeed != null && planDistanceM && trafficDurationSec && trafficDurationSec > 0) {
      const trafficSpeed = planDistanceM / trafficDurationSec;
      speedDeviationPct = trafficSpeed > 0 ? Math.round(((actualAvgSpeed - trafficSpeed) / trafficSpeed) * 1000) / 10 : null;
    }

    return {
      provider,
      planDistanceM: planDistanceM ? Math.round(planDistanceM) : null,
      planDurationSec,
      trafficFetched,
      trafficDurationSec,
      timeLostToTrafficSec: timeLostToTrafficSec != null ? Math.round(timeLostToTrafficSec) : null,
      durationDeviationPct: planDurationSec ? pct(actualDurationSec, planDurationSec) : null,
      distanceDeviationPct: planDistanceM ? pct(actualDistanceM, planDistanceM) : null,
      speedDeviationPct,
    };
  } catch {
    return empty;
  }
}

const EARTH_R = 6371000; // (оставлено для совместимости сигнатур; расчёт — в metrics-methodology)
void EARTH_R;

// ——— v2.10.0 R6.1: corpus-calibrated CAP baselines (§7.3) ———
// Iterate all non-deleted sessions once, compute braking/accel/jerk rates per session,
// take median as baseline for EcoScore penalty formula. Cached for CORPUS_CACHE_TTL_MS.
// Production-correct: avoids EcoScore=0 on noisy synthetic CSV data (default baselines
// 0.5/0.4/0.3 are calibrated for high-quality real GPS data).
const CORPUS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
let _corpusCache: { baselines: EcoScoreBaselines; ts: number } | null = null;

async function getCorpusEcoBaselines(): Promise<EcoScoreBaselines> {
  if (_corpusCache && Date.now() - _corpusCache.ts < CORPUS_CACHE_TTL_MS) {
    return _corpusCache.baselines;
  }
  try {
    // Get all non-deleted sessions with their points
    const sessions = await libsql.execute({
      sql: `SELECT s.id, s.startTime, s.endTime FROM Session s WHERE s.deletedAt IS NULL ORDER BY s.startTime DESC`,
    });
    const rates: { braking: number; accel: number; jerk: number }[] = [];
    for (const row of sessions.rows) {
      const sid = row.id as string;
      const pts = await libsql.execute({
        sql: "SELECT lat, lon, timestamp, speed, bearing, altitude, accuracy FROM GpsPoint WHERE sessionId = ? ORDER BY timestamp ASC",
        args: [sid],
      });
      const points = pts.rows.map((p: Record<string, unknown>) => ({
        lat: p.lat as number,
        lon: p.lon as number,
        timestamp: Number(p.timestamp),
        speed: p.speed == null ? null : (p.speed as number),
        bearing: p.bearing == null ? null : (p.bearing as number),
        altitude: p.altitude == null ? null : (p.altitude as number),
        // v2.10.0 R6.1: accuracy field is required by MethodologyPoint interface; GpsPoint
        // table may not have it populated for legacy rows → default null.
        accuracy: (p.accuracy as number | undefined) ?? null,
      }));
      if (points.length < 60) continue;
      const startTime = Number(row.startTime);
      const endTime = row.endTime ? Number(row.endTime) : points[points.length - 1].timestamp;
      const durationSec = Math.max(0, (endTime - startTime) / 1000);
      // Distance via haversine
      let distance = 0;
      for (let i = 1; i < points.length; i++) {
        const R = 6371000;
        const dLat = ((points[i].lat - points[i - 1].lat) * Math.PI) / 180;
        const dLon = ((points[i].lon - points[i - 1].lon) * Math.PI) / 180;
        const a = Math.sin(dLat / 2) ** 2 + Math.cos((points[i - 1].lat * Math.PI) / 180) * Math.cos((points[i].lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
        distance += 2 * R * Math.asin(Math.sqrt(a));
      }
      const m = computeMethodologyMetrics(points, distance, durationSec);
      if (m.ecoScore.value == null) continue;
      rates.push({ braking: m.ecoScore.brakingRate, accel: m.ecoScore.accelRate, jerk: m.ecoScore.jerkRate });
    }
    const baselines = calibrateEcoScoreBaselinesFromCorpus(rates);
    _corpusCache = { baselines, ts: Date.now() };
    return baselines;
  } catch (err) {
    logger.warn("corpus baseline calibration failed, using defaults", {
      requestId: "corpus",
      error: err instanceof Error ? err.message : String(err),
    });
    return calibrateEcoScoreBaselinesFromCorpus([]);
  }
}

// ——— v2.9.3: спидограмма — даунсемпл GPS-точек для графика скорость-время ———
// v2.9.4: сэмпл расширен полями alt (высотный профиль) и lat/lng (связка карта↔график).
// st: 0 = idle (<2 км/ч), 1 = moving, 2 = gap (dt > 30 сек от предыдущей точки).
// Максимум SPEED_PROFILE_MAX точек; при меньшем числе точек — как есть.
const SPEED_PROFILE_MAX = 240;
interface SpeedProfilePoint {
  t: number; // сек от начала сессии
  v: number | null; // км/ч (null — нет GPS-скорости у точки)
  st: 0 | 1 | 2;
  alt?: number | null; // м над уровнем моря (v2.9.4: высотный профиль)
  lat?: number; // v2.9.4: координата сэмпла для маркера на карте (5 знаков)
  lng?: number; // v2.9.4: координата сэмпла для маркера на карте (5 знаков)
}
function buildSpeedProfile(
  points: Array<{
    speed: number | null;
    timestamp: number;
    altitude?: number | null;
    lat?: number;
    lon?: number;
  }>,
  startMs: number
): SpeedProfilePoint[] {
  if (points.length === 0) return [];
  // gap-флаги считаются на ИСХОДНОМ ряду (до даунсемпла), иначе при длинных
  // сессиях интервал сэмплов превысил бы 30с и дал ложные gap-детекты
  const gapFlag = new Array<boolean>(points.length).fill(false);
  for (let i = 1; i < points.length; i++) {
    if (points[i].timestamp - points[i - 1].timestamp > 30_000) gapFlag[i] = true;
  }
  const step = Math.max(1, Math.ceil(points.length / SPEED_PROFILE_MAX));
  const out: SpeedProfilePoint[] = [];
  // v2.9.4: высотный ряд сглаживаем скользящим окном ±2 сэмпла исходного ряда —
  // GPS-высота шумит сильнее горизонтали, сырые значения дают «пилу» на графике
  const smoothAlt = (idx: number): number | null => {
    let sum = 0;
    let n = 0;
    for (let j = Math.max(0, idx - 2); j <= Math.min(points.length - 1, idx + 2); j++) {
      const a = points[j].altitude;
      if (a != null) {
        sum += a;
        n++;
      }
    }
    return n >= 2 ? Math.round((sum / n) * 10) / 10 : points[idx].altitude ?? null;
  };
  for (let i = 0; i < points.length; i += step) {
    const p = points[i];
    const t = Math.round((p.timestamp - startMs) / 1000);
    const kmh = p.speed != null && p.speed >= 0 ? Math.round(p.speed * 3.6 * 10) / 10 : null;
    // gap мог произойти между сэмплами — проверяем всё окно даунсемпла
    let isGap = gapFlag[i];
    if (!isGap) {
      for (let j = Math.max(1, i - step + 1); j < i; j++) {
        if (gapFlag[j]) {
          isGap = true;
          break;
        }
      }
    }
    const st: 0 | 1 | 2 = isGap ? 2 : kmh == null || kmh < 2 ? 0 : 1;
    const sample: SpeedProfilePoint = { t, v: kmh, st };
    // v2.9.4: высота (сглаженная) и координаты для связки с картой
    const alt = smoothAlt(i);
    if (alt != null) sample.alt = alt;
    if (typeof p.lat === "number" && typeof p.lon === "number") {
      sample.lat = Math.round(p.lat * 1e5) / 1e5;
      sample.lng = Math.round(p.lon * 1e5) / 1e5;
    }
    out.push(sample);
  }
  // хвостовая точка — чтобы график дотягивался до конца записи
  const last = points[points.length - 1];
  if (out.length === 0 || out[out.length - 1].t < (last.timestamp - startMs) / 1000 - 1) {
    const t = Math.round((last.timestamp - startMs) / 1000);
    const kmh =
      last.speed != null && last.speed >= 0 ? Math.round(last.speed * 3.6 * 10) / 10 : null;
    const sample: SpeedProfilePoint = { t, v: kmh, st: kmh != null && kmh >= 2 ? 1 : 0 };
    const lastAlt = points.length > 0 ? points[points.length - 1].altitude : null;
    if (lastAlt != null) sample.alt = lastAlt;
    if (typeof last.lat === "number" && typeof last.lon === "number") {
      sample.lat = Math.round(last.lat * 1e5) / 1e5;
      sample.lng = Math.round(last.lon * 1e5) / 1e5;
    }
    out.push(sample);
  }
  return out;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const auth = await authorizeRequest(request, "api");
    if (!auth.ok) return json({ error: auth.reason }, 401, { "X-Request-Id": requestId });

    const { id } = await params;
    const session = await db.session.findUnique({
      where: { id },
      select: {
        id: true,
        startTime: true,
        endTime: true,
        pointCount: true,
        deletedAt: true,
        routeHash: true,    // v2.9 §10.0: детерминированный хэш маршрута
        topologyHash: true, // v2.9 §10.0: 8-char хэш топологии
        gpsPoints: {
          orderBy: { timestamp: "asc" },
          select: { lat: true, lon: true, speed: true, altitude: true, accuracy: true, bearing: true, timestamp: true },
        },
      },
    });

    if (!session || session.deletedAt) {
      return json({ error: "Not found" }, 404, { "X-Request-Id": requestId });
    }

    const points = session.gpsPoints.map((p) => ({
      ...p,
      timestamp: Number(p.timestamp),
    }));

    if (points.length === 0) {
      return json(
        { sessionId: id, pointCount: 0, distance: 0, duration: 0, avgSpeed: null, maxSpeed: null },
        200,
        { "X-Request-Id": requestId }
      );
    }

    // Расчёт дистанции
    let distance = 0;
    let speedSum = 0;
    let speedCount = 0;
    let elevationGain = 0;
    let elevationLoss = 0;
    let prevAlt: number | null = null;

    // P2-13: maxSpeed через единый фильтр выбросов (kpi.ts) — GPS-джиттер раньше
    // давал нереальные значения MaxSpeed на экране
    const maxSpeed = maxSpeedMs(points) ?? 0;

    for (let i = 0; i < points.length; i++) {
      const p = points[i];

      // Distance
      if (i > 0) {
        const prev = points[i - 1];
        distance += haversineM(prev.lat, prev.lon, p.lat, p.lon);
      }

      // Speed stats — сумма для meanPointSpeed (НЕ KPI AvgSpeed, см. ниже)
      if (p.speed != null && p.speed >= 0) {
        speedSum += p.speed;
        speedCount++;
      }

      // Elevation
      if (p.altitude != null) {
        if (prevAlt != null) {
          const diff = p.altitude - prevAlt;
          if (diff > 0) elevationGain += diff;
          else elevationLoss += Math.abs(diff);
        }
        prevAlt = p.altitude;
      }
    }

    const startTime = new Date(session.startTime).getTime();
    const endTime = session.endTime
      ? new Date(session.endTime).getTime()
      : points.length > 0
      ? points[points.length - 1].timestamp
      : startTime;
    const durationSec = Math.max(0, (endTime - startTime) / 1000);

    // v2.9: метрики методологии (§12) — state machine + ActiveTrip + CAP EcoScore + новые поведенческие
    // v2.10.0 R6.1: EcoScore использует corpus-calibrated baselines (median of all sessions in DB)
    // instead of DEFAULT_BASELINES that produce EcoScore=0 on noisy synthetic CSV data.
    const ecoBaselines = await getCorpusEcoBaselines();
    const methodology = computeMethodologyMetrics(points, distance, durationSec, ecoBaselines);
    // v2.9: AvgSpeed = Distance / ActiveDuration (§4.3 + §4.11)
    const avgSpeed = avgSpeedMs(distance, durationSec, methodology.activeTrip.activeDuration);
    const speedMean = meanPointSpeedMs(points);

    // Bounding box
    const lats = points.map((p) => p.lat);
    const lons = points.map((p) => p.lon);
    const bbox = {
      minLat: Math.min(...lats),
      maxLat: Math.max(...lats),
      minLon: Math.min(...lons),
      maxLon: Math.max(...lons),
    };

    // P1-7: план-факт из завершённого TrafficJob
    const route = await computePlanFact(id, distance, durationSec, avgSpeed);
    // v2.9.3: спидограмма (даунсемпл ≤240 точек, сек от старта, км/ч, состояние)
    // v2.9.4: сэмплы дополнены alt/lat/lng (высотный профиль + связка с картой)
    const speedProfile = buildSpeedProfile(points, startTime);
    // v2.9.4: флаг наличия высотных данных (для показа высотного профиля в UI)
    const hasAltitude = speedProfile.some((p) => p.alt != null);
    trackLatency(request); // P2-16: успешный ответ участвует в api_latency_p95

    return json(
      {
        sessionId: id,
        pointCount: points.length,
        distance: Math.round(distance),
        duration: Math.round(durationSec),
        // v2.9.3: спидограмма для графика скорость-время
        speedProfile,
        // v2.9.4: есть ли высотные данные у сэмплов (иначе профиль высоты не рендерим)
        hasAltitude,
        // v2.9: из state machine (§4.6/§4.7)
        movingTime: methodology.movingTime,
        idleTime: methodology.idleTime,
        gapTime: methodology.gapTime,
        // v2.9 §10.0: детерминированные хэши маршрута
        routeHash: session.routeHash,
        topologyHash: session.topologyHash,
        avgSpeed: avgSpeed != null ? Math.round(avgSpeed * 10) / 10 : null,
        // P2-13: средняя по точкам — отдельно от KPI AvgSpeed (§4.3)
        speedMeanMs: speedMean != null ? Math.round(speedMean * 10) / 10 : null,
        maxSpeed: Math.round(maxSpeed * 10) / 10,
        avgAltitude: prevAlt != null ? Math.round(points.filter((p) => p.altitude != null).reduce((a, p) => a + (p.altitude || 0), 0) / (points.filter((p) => p.altitude != null).length || 1)) : null,
        elevationGain: Math.round(elevationGain),
        elevationLoss: Math.round(elevationLoss),
        bbox,
        startTime: session.startTime,
        endTime: session.endTime,
        methodology,
        route,
      },
      200,
      { "X-Request-Id": requestId }
    );
  } catch (err) {
    logger.error("Session stats error", { requestId, error: err instanceof Error ? err.message : String(err) });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}
