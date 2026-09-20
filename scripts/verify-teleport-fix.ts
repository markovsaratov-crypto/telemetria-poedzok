// scripts/verify-teleport-fix.ts — офлайн-проверка N-3 на РЕАЛЬНЫХ точках
// прод-записей 920ff881 (890 км телепортов) и 92cf1bc1 (155 км), выгруженных
// из D1 в /tmp/pts_*.json. Запуск: bun scripts/verify-teleport-fix.ts
import { computeSessionStats } from "../src/lib/session-stats";
import { computeSessionTrack } from "../src/lib/session-track";
import { readFileSync } from "fs";
import type { MethodologyPoint } from "../src/lib/active-trip";

interface RawRow {
  lat: number;
  lon: number;
  speed: number | null;
  accuracy: number | null;
  timestamp: number;
}

function load(file: string): MethodologyPoint[] {
  const d = JSON.parse(readFileSync(file, "utf-8"));
  return (d.rows as RawRow[]).map((r) => ({
    lat: r.lat,
    lon: r.lon,
    speed: r.speed,
    altitude: null,
    bearing: null,
    accuracy: r.accuracy,
    timestamp: Number(r.timestamp),
  }));
}

const cases: Array<{ file: string; id: string; start: string; end: string }> = [
  { file: "/tmp/pts_920ff881.json", id: "920ff881-5b09-49ca-a6ad-e5c3dc41eeee", start: "2026-09-20T00:34:14.000Z", end: "2026-09-20T02:24:49.000Z" },
  { file: "/tmp/pts_92cf1bc1.json", id: "92cf1bc1-2d89-484c-a961-3b2356822e9d", start: "2026-09-18T05:37:39.000Z", end: "2026-09-18T06:08:57.000Z" },
  { file: "/tmp/pts_08c29265.json", id: "08c29265-e734-4b1c-a735-04b802cba14c", start: "2026-09-20T08:33:18.000Z", end: "2026-09-20T10:10:44.000Z" },
];

for (const c of cases) {
  const pts = load(c.file);
  console.log(`\n=== ${c.id} (${pts.length} точек) ===`);
  const res = computeSessionStats({ id: c.id, startTime: c.start, endTime: c.end }, pts);
  if (res.kind !== "full") {
    console.log("EMPTY");
    continue;
  }
  const p = res.payload;
  const avgKmh = p.avgSpeed != null ? p.avgSpeed * 3.6 : null;
  const maxKmh = p.maxSpeed * 3.6;
  console.log(`distance      = ${(p.distance / 1000).toFixed(2)} км (было в кэше: см. worklog)`);
  console.log(`rawDistanceM  = ${(p.rawDistanceM / 1000).toFixed(2)} км`);
  console.log(`teleport      = ${(p.teleportDistanceM / 1000).toFixed(2)} км СРЕЗАНО`);
  console.log(`duration      = ${(p.duration / 60).toFixed(1)} мин | active = ${((p.methodology.activeTrip?.activeDuration ?? 0) / 60).toFixed(1)} мин`);
  console.log(`avgSpeed      = ${avgKmh != null ? avgKmh.toFixed(1) : "—"} км/ч | maxSpeed = ${maxKmh.toFixed(1)} км/ч`);
  console.log(`ИНВАРИАНТ avg ≤ max: ${avgKmh != null && maxKmh > 0 ? (avgKmh <= maxKmh + 1 ? "OK ✓" : "НАРУШЕН ✗") : "—"}`);
  console.log(`gapTime       = ${p.gapTime} с (телепорты — честные разрывы)`);
  const tr = computeSessionTrack({ id: c.id, deviceId: "d", startTime: c.start, endTime: c.end, pointCount: pts.length }, pts) as Record<string, unknown>;
  const bounds = tr.bounds as number[][];
  console.log(`track bounds  = [${bounds[0][0].toFixed(3)}, ${bounds[0][1].toFixed(3)}] → [${bounds[1][0].toFixed(3)}, ${bounds[1][1].toFixed(3)}] | точек на карте: ${(tr.points as unknown[]).length}`);
}
