// scripts/repair-trips-n4.ts — прямой ремонт Trip-строк после фикса N-3/N-4
// (v2.40.7): пересчёт stats-полей ФИКСИРОВАННЫМ конвейером на реальных точках
// из прод-D1, запись через gateway /batch. План-поля (plan*) не трогаем — их
// дорабатывает воркер/чтение. Запуск: bun scripts/repair-trips-n4.ts
import { computeSessionStats } from "../src/lib/session-stats";
import type { MethodologyPoint } from "../src/lib/active-trip";
import type { SessionStatsResult } from "../src/lib/session-stats";

const GW = "https://d1-gateway.markov-saratov.workers.dev";
const GS = "abf5c5a6a43347d9cde1e40805d139eaccd950c923f72de6";

async function query(sql: string, args: unknown[] = []) {
  const res = await fetch(`${GW}/query`, {
    method: "POST",
    headers: { "x-gateway-secret": GS, "Content-Type": "application/json" },
    body: JSON.stringify({ sql, params: args }),
  });
  if (!res.ok) throw new Error(`gateway ${res.status}`);
  return (await res.json()) as { rows: Record<string, unknown>[] };
}

async function batch(statements: Array<{ sql: string; params?: unknown[] }>) {
  const res = await fetch(`${GW}/batch`, {
    method: "POST",
    headers: { "x-gateway-secret": GS, "Content-Type": "application/json" },
    body: JSON.stringify({ statements }),
  });
  if (!res.ok) throw new Error(`gateway batch ${res.status}`);
  return res.json();
}

function round1(v: number | null | undefined): number | null {
  return v != null && Number.isFinite(v) ? Math.round(v * 10) / 10 : null;
}

// Устройство владельца, поездки с 18.09 (окно инцидента N-4)
const trips = (await query(
  `SELECT id, spanStart, spanEnd, sessionIds, interFragmentGapSec, planDistanceM, planDurationSec, planComparable, planCoverage, routingLegCount
   FROM Trip WHERE deviceId = '56ace75e-f33c-4d4d-8c68-acce81a2fe2a' AND spanStart >= '2026-09-18' ORDER BY spanStart`
)).rows;

console.log(`поездок к пересчёту: ${trips.length}`);

const updates: Array<{ sql: string; params?: unknown[] }> = [];
for (const t of trips) {
  const ids = JSON.parse(String(t.sessionIds ?? "[]")) as string[];
  if (ids.length === 0) continue;
  const placeholders = ids.map(() => "?").join(",");
  const ptsRows = (
    await query(
      `SELECT lat, lon, speed, accuracy, timestamp FROM GpsPoint WHERE sessionId IN (${placeholders}) ORDER BY timestamp ASC`,
      ids
    )
  ).rows;
  const allPoints: MethodologyPoint[] = ptsRows.map((r) => ({
    lat: Number(r.lat),
    lon: Number(r.lon),
    speed: r.speed == null ? null : Number(r.speed),
    altitude: null,
    bearing: null,
    accuracy: r.accuracy == null ? null : Number(r.accuracy),
    timestamp: Number(r.timestamp),
  }));
  const spanStartMs = new Date(String(t.spanStart)).getTime();
  const spanEndMs = t.spanEnd ? new Date(String(t.spanEnd)).getTime() : allPoints[allPoints.length - 1]?.timestamp ?? spanStartMs;
  const points = allPoints.filter((p) => p.timestamp >= spanStartMs && p.timestamp <= spanEndMs);
  if (points.length === 0) {
    console.log(`${String(t.id).slice(0, 8)}: 0 точек в окне — пропуск`);
    continue;
  }
  const result: SessionStatsResult = computeSessionStats(
    { id: String(t.id), startTime: String(t.spanStart), endTime: t.spanEnd ? String(t.spanEnd) : null },
    points
  );
  if (result.kind !== "full") continue;
  const p = result.payload;
  const activeDur = p.methodology?.activeTrip?.activeDuration ?? result.actualDurationSec;
  const eco = p.methodology?.ecoScore?.value ?? null;
  const ecoClamped = eco != null ? Math.max(0, Math.min(100, eco)) : null;
  const writtenAt = new Date().toISOString();
  updates.push({
    sql: `UPDATE Trip SET
            activeDurationSec = ?, movingTimeSec = ?, idleTimeSec = ?, gapTimeSec = ?,
            internalStopTimeSec = ?, interFragmentGapSec = ?, distanceM = ?,
            pointCountActual = ?, maxSpeedMs = ?, ecoScore = ?,
            planDistanceM = ?, planDurationSec = ?, planComparable = ?, planCoverage = ?,
            routingLegCount = ?, statsComputedAt = ?
          WHERE id = ?`,
    params: [
      round1(activeDur),
      round1(p.movingTime),
      round1(p.idleTime),
      round1(p.gapTime),
      round1(p.methodology?.activeTrip?.internalStopTime ?? 0),
      round1(t.interFragmentGapSec == null ? null : Number(t.interFragmentGapSec)),
      Math.round(p.distance),
      p.pointCount,
      p.maxSpeed,
      ecoClamped,
      t.planDistanceM == null ? null : Number(t.planDistanceM),
      t.planDurationSec == null ? null : Number(t.planDurationSec),
      t.planComparable == null ? null : Number(t.planComparable) ? 1 : 0,
      t.planCoverage == null ? null : Number(t.planCoverage),
      t.routingLegCount == null ? null : Number(t.routingLegCount),
      writtenAt,
      String(t.id),
    ],
  });
  console.log(
    `${String(t.id).slice(0, 8)} ← ${(p.distance / 1000).toFixed(1)} км, avg ${((p.avgSpeed ?? 0) * 3.6).toFixed(1)} км/ч, max ${(p.maxSpeed * 3.6).toFixed(0)} км/ч, gap ${p.gapTime} c, teleport ${(p.teleportDistanceM / 1000).toFixed(1)} км`
  );
}

if (updates.length > 0) {
  const res = await batch(updates);
  console.log("batch записан:", JSON.stringify(res).slice(0, 200));
}
