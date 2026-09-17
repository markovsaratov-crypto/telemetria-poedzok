// scripts/backfill-route-hash.ts — v2.38.1 (ревью F7): бэкфилл §10.0 routeHash/topologyHash
// для ЗАВЕРШЁННЫХ сессий, у которых хэш NULL (созданы до порта computeRouteHash
// в прод-воркер — вся эра мини-сервиса, который так и не был развёрнут).
//
// ЗАПУСК (владелец, из корня репо):
//   DATABASE_URL=... (и D1_GATEWAY_* для прод-D1) bun scripts/backfill-route-hash.ts
//   … --dry-run   — только посчитать, ничего не писать
//   … --batch 50  — размер батча сессий (по умолчанию 50)
//   … --limit 500 — стоп после N сессий (0 = все)
//
// ВАЖНО:
//   • НЕ запускается автоматически/при деплое — ручной runbook-шаг владельца:
//     класс сессий заморожен (completed-сессии точки не меняют), повторный
//     запуск идемпотентен (WHERE routeHash IS NULL пропускает уже обработанные);
//   • алгоритм — тот же src/lib/route-hash.ts, что исполняет прод-воркер в
//     completeJob-пути → бэкфилл и новые сессии попадают в ОДНИ §10-группы;
//   • сегменты маршрута — последнего completed TrafficJob сессии (result JSON,
//     как их читает canonicalGroupPolyline в route-comparison.ts); без джоба —
//     topologyHash "no_segments" (A→B-группировка, ветка haversine);
//   • без активной части (§4.11) хэш НЕ пишется (parity с воркером и
//     мини-сервисом: routeHash = NULL — маршрутной группы у записи нет).
//
// Окружение: Bun (Web Crypto для route-hash.ts доступен из коробки).
import { libsql } from "../src/lib/db";
import { computeMovingTime, computeActiveTrip, type MethodologyPoint } from "../src/lib/active-trip";
import { computeRouteHash, type RouteHashSegment } from "../src/lib/route-hash";

// ——— CLI-флаги (минимальный ручной разбор: скрипт — runbook-шаг, не продукт) ———
const argv = process.argv.slice(2);
const DRY_RUN = argv.includes("--dry-run");
const flag = (name: string): number | null => {
  const i = argv.indexOf(name);
  if (i === -1 || i + 1 >= argv.length) return null;
  const n = Number(argv[i + 1]);
  return Number.isFinite(n) && n > 0 ? n : null;
};
const BATCH = flag("--batch") ?? 50; // сессий за проход (точки внутри — чанками по 8, как batch-points.ts)
const LIMIT = flag("--limit") ?? 0; // 0 = без лимита

interface BackfillStats {
  scanned: number;
  updated: number;
  skippedNoActive: number; // нет активной части §4.11 → хэш не положен
  skippedNoJob: number; // нет TrafficJob-сегментов → topologyHash "no_segments"
  failed: number;
}

function parseSegments(resultJson: string | null): RouteHashSegment[] {
  if (resultJson == null || resultJson === "") return [];
  try {
    const parsed = JSON.parse(resultJson) as { segments?: unknown };
    if (!Array.isArray(parsed.segments)) return [];
    return parsed.segments
      .filter((s): s is { lat: number; lon: number; bearing?: number | null } => {
        const seg = s as { lat?: unknown; lon?: unknown };
        return typeof seg?.lat === "number" && typeof seg?.lon === "number";
      })
      .map((s) => ({ lat: s.lat, lon: s.lon, bearing: s.bearing ?? null }));
  } catch {
    return []; // битый result-JSON — ветка «no_segments»
  }
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error("[backfill-route-hash] DATABASE_URL не задан — подключение к БД невозможно. Отказ.");
    process.exit(1);
  }
  const stats: BackfillStats = { scanned: 0, updated: 0, skippedNoActive: 0, skippedNoJob: 0, failed: 0 };
  console.log(JSON.stringify({ msg: "backfill-route-hash started", dryRun: DRY_RUN, batch: BATCH, limit: LIMIT || "all" }));

  // Курсор по startTime: completed-сессии без routeHash, старейшие первыми —
  // перезапуск после сбоя не теряет хвост (курсор стабильный, LIMIT — по scanned).
  let cursorIso: string | null = null;
  let stop = false;
  while (!stop) {
    const res = await libsql.execute({
      sql: `SELECT id, startTime FROM Session
            WHERE routeHash IS NULL AND deletedAt IS NULL AND status = 'completed'
              ${cursorIso != null ? "AND startTime > ?" : ""}
            ORDER BY startTime ASC LIMIT ?`,
      args: (cursorIso != null ? [cursorIso, BATCH] : [BATCH]) as never[],
    });
    const rows = res.rows as Record<string, unknown>[];
    if (rows.length === 0) break;
    cursorIso = String(rows[rows.length - 1].startTime);
    const ids = rows.map((r) => String(r.id));

    // Точки всех сессий батча — чанками по 8 id (паттерн batch-points.ts:
    // лимит параметров D1 ≤100 + параллельные раундтрипы к шлюзу).
    const pointsBySession = new Map<string, MethodologyPoint[]>();
    for (let i = 0; i < ids.length; i += 8) {
      const chunk = ids.slice(i, i + 8);
      const ph = chunk.map(() => "?").join(", ");
      const ptsRes = await libsql.execute({
        sql: `SELECT sessionId, lat, lon, speed, altitude, accuracy, bearing, timestamp
              FROM GpsPoint WHERE sessionId IN (${ph}) ORDER BY timestamp ASC`,
        args: chunk as never[],
      });
      for (const p of ptsRes.rows as Record<string, unknown>[]) {
        const sid = String(p.sessionId);
        const list = pointsBySession.get(sid) ?? [];
        list.push({
          lat: Number(p.lat),
          lon: Number(p.lon),
          speed: p.speed == null ? null : Number(p.speed),
          altitude: p.altitude == null ? null : Number(p.altitude),
          accuracy: p.accuracy == null ? null : Number(p.accuracy),
          bearing: p.bearing == null ? null : Number(p.bearing),
          timestamp: Number(p.timestamp),
        });
        pointsBySession.set(sid, list);
      }
    }

    // Сегменты маршрута — completed TrafficJob каждой сессии (ORDER BY updatedAt
    // ASC + перезапись Map = последняя завершённая попытка, как «latest completed»
    // в canonicalGroupPolyline). Чанки по 8 — тот же лимит параметров.
    const segmentsBySession = new Map<string, RouteHashSegment[]>();
    for (let i = 0; i < ids.length; i += 8) {
      const chunk = ids.slice(i, i + 8);
      const ph = chunk.map(() => "?").join(", ");
      const jobsRes = await libsql.execute({
        sql: `SELECT sessionId, result FROM TrafficJob
              WHERE status = 'completed' AND result IS NOT NULL AND sessionId IN (${ph})
              ORDER BY updatedAt ASC`,
        args: chunk as never[],
      });
      for (const j of jobsRes.rows as Record<string, unknown>[]) {
        segmentsBySession.set(String(j.sessionId), parseSegments(j.result == null ? null : String(j.result)));
      }
    }

    for (const id of ids) {
      stats.scanned += 1;
      try {
        const points = pointsBySession.get(id) ?? [];
        if (points.length < 2) {
          stats.skippedNoActive += 1;
          continue;
        }
        const motion = computeMovingTime(points);
        const active = computeActiveTrip(points, motion);
        if (!active.hasActiveTrip) {
          stats.skippedNoActive += 1;
          continue;
        }
        const segments = segmentsBySession.get(id) ?? [];
        if (segments.length === 0) stats.skippedNoJob += 1;
        const { routeHash, topologyHash } = await computeRouteHash(
          { lat: active.activeStartCoord.lat, lon: active.activeStartCoord.lon },
          { lat: active.activeEndCoord.lat, lon: active.activeEndCoord.lon },
          segments
        );
        if (!routeHash) {
          stats.skippedNoActive += 1;
          continue;
        }
        if (!DRY_RUN) {
          await libsql.execute({
            sql: `UPDATE Session SET routeHash = ?, topologyHash = ?, updatedAt = ? WHERE id = ? AND routeHash IS NULL`,
            args: [routeHash, topologyHash, new Date().toISOString(), id],
          });
        }
        stats.updated += 1;
      } catch (err) {
        stats.failed += 1;
        console.error(
          JSON.stringify({
            level: "error",
            msg: "backfill-route-hash: session failed",
            sessionId: id,
            error: err instanceof Error ? err.message : String(err),
          })
        );
      }
    }

    if (LIMIT > 0 && stats.scanned >= LIMIT) stop = true;
  }

  console.log(JSON.stringify({ msg: "backfill-route-hash finished", dryRun: DRY_RUN, ...stats }));
}

main().catch((err) => {
  console.error(
    JSON.stringify({
      level: "error",
      msg: "backfill-route-hash fatal",
      error: err instanceof Error ? err.message : String(err),
    })
  );
  process.exit(1);
});
