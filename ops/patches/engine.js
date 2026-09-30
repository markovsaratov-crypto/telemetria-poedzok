var FM_ENABLED = true;
function fmNextDayKey(key) {
  return new Date(Date.parse(key + "T00:00:00Z") + 864e5).toISOString().slice(0, 10);
}
__name(fmNextDayKey, "fmNextDayKey");
function fmParseStatsCache(s) {
  const t = { distanceM: 0, durationSec: 0, ecoSum: 0, ecoCount: 0 };
  if (typeof s != "string" || s.length === 0 || s === "__TELEMAT_CACHE_OVERSIZED__") return t;
  try {
    const n = JSON.parse(s);
    if (n?.kind !== "full" || !n.payload) return t;
    const a = Number(n.payload.distance);
    if (Number.isFinite(a) && a > 0) t.distanceM += a;
    const d = Number(n.payload.duration);
    if (Number.isFinite(d) && d > 0) t.durationSec += d;
    const e = n.payload?.methodology?.ecoScore?.value;
    if (e != null && Number.isFinite(Number(e))) {
      t.ecoSum += Number(e);
      t.ecoCount += 1;
    }
  } catch {
  }
  return t;
}
__name(fmParseStatsCache, "fmParseStatsCache");
function fmRollupUpserts(rows, nowIso) {
  return rows.map((r) => ({
    sql: `INSERT INTO StatsRollup (day, userId, sessions, points, distanceM, durationSec, ecoSum, ecoCount, updatedAt)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(day, userId) DO UPDATE SET
  sessions = excluded.sessions,
  points = excluded.points,
  distanceM = excluded.distanceM,
  durationSec = excluded.durationSec,
  ecoSum = excluded.ecoSum,
  ecoCount = excluded.ecoCount,
  updatedAt = excluded.updatedAt`,
    args: [r.day, r.userId, r.sessions, r.points, Math.round(r.distanceM), Math.round(r.durationSec), Math.round(1e3 * r.ecoSum) / 1e3, r.ecoCount, nowIso]
  }));
}
__name(fmRollupUpserts, "fmRollupUpserts");
async function fmSessionsInRange(env, fromMs, toMs) {
  const res = await env.DB.prepare("SELECT startTime, userId, pointCount, statsCache FROM Session WHERE deletedAt IS NULL AND startTime >= ? AND startTime < ?").bind(new Date(fromMs).toISOString(), new Date(toMs).toISOString()).all();
  return res.results ?? [];
}
__name(fmSessionsInRange, "fmSessionsInRange");
function fmComputeDays(rows, dayFrom, dayTo, zone) {
  const agg = /* @__PURE__ */ new Map();
  for (const s of rows) {
    const ts = Date.parse(String(s.startTime));
    if (!Number.isFinite(ts)) continue;
    const day = rollupDayKey(ts, zone);
    if (day < dayFrom || day > dayTo) continue;
    const uid = s.userId == null ? "" : String(s.userId);
    const k = day + "|" + uid;
    let d = agg.get(k);
    if (!d) {
      d = { day, userId: uid, sessions: 0, points: 0, distanceM: 0, durationSec: 0, ecoSum: 0, ecoCount: 0 };
      agg.set(k, d);
    }
    d.sessions += 1;
    d.points += Number(s.pointCount ?? 0);
    const sc = fmParseStatsCache(s.statsCache);
    d.distanceM += sc.distanceM;
    d.durationSec += sc.durationSec;
    d.ecoSum += sc.ecoSum;
    d.ecoCount += sc.ecoCount;
  }
  return [...agg.values()];
}
__name(fmComputeDays, "fmComputeDays");
async function fmWriteDayRows(env, rows) {
  if (rows.length === 0) return 0;
  const nowIso = (/* @__PURE__ */ new Date()).toISOString();
  const stmts = fmRollupUpserts(rows, nowIso);
  for (let i = 0; i < stmts.length; i += 100) {
    const chunk = stmts.slice(i, i + 100).map((s) => env.DB.prepare(s.sql).bind(...s.args));
    await env.DB.batch(chunk);
  }
  return rows.length;
}
__name(fmWriteDayRows, "fmWriteDayRows");
async function fmBackfillOnce(env, zone, yesterdayKey) {
  const kv = env.KV;
  if (!kv) return;
  const marker = await kv.get("fm:backfill:v1").catch(() => null);
  if (marker) return;
  const res = await env.DB.prepare("SELECT startTime, userId, pointCount, statsCache FROM Session WHERE deletedAt IS NULL").all();
  const rows = fmComputeDays(res.results ?? [], "0000-00-00", "9999-12-31", zone);
  const written = await fmWriteDayRows(env, rows);
  const keep = rows.map((r) => r.day + "|" + r.userId);
  if (keep.length > 0) {
    const ph = keep.map(() => "?").join(", ");
    await env.DB.prepare(`DELETE FROM StatsRollup WHERE (day || '|' || userId) NOT IN (${ph})`).bind(...keep).run();
  } else {
    await env.DB.prepare("DELETE FROM StatsRollup").run();
  }
  await kv.put("fm:backfill:v1", JSON.stringify({ at: (/* @__PURE__ */ new Date()).toISOString(), days: rows.length, written }));
  await kv.put("fm:frozenThru", yesterdayKey);
  console.log(JSON.stringify({ level: "info", msg: "fm backfill-once complete (history frozen)", days: rows.length, written, frozenThru: yesterdayKey }));
}
__name(fmBackfillOnce, "fmBackfillOnce");
async function fmEngineTick(env) {
  if (!FM_ENABLED || !env.DB) return { ok: false, reason: "disabled" };
  const zone = env.TELEMAT_TIMEZONE || "UTC";
  const now = Date.now();
  const todayKey = rollupDayKey(now, zone);
  const yesterdayKey = rollupDayKey(now - 864e5, zone);
  const kv = env.KV;
  const out = { todayRows: 0, froze: 0, refresh7d: false, tsw: null, backupReaped: 0 };
  try {
    await fmBackfillOnce(env, zone, yesterdayKey);
  } catch (e) {
    console.log(JSON.stringify({ level: "warn", msg: "fm backfill step failed", error: String(e && e.message || e) }));
  }
  try {
    const fromMs = Date.parse(todayKey + "T00:00:00Z") - 648e5;
    const toMs = Date.parse(fmNextDayKey(todayKey) + "T00:00:00Z") + 648e5;
    const rows = fmComputeDays(await fmSessionsInRange(env, fromMs, toMs), todayKey, todayKey, zone);
    out.todayRows = await fmWriteDayRows(env, rows);
  } catch (e) {
    console.log(JSON.stringify({ level: "warn", msg: "fm today step failed", error: String(e && e.message || e) }));
  }
  if (kv) {
    let frozenThru = null;
    try {
      frozenThru = await kv.get("fm:frozenThru").catch(() => null);
      if (typeof frozenThru !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(frozenThru)) frozenThru = null;
    } catch {
    }
    try {
      if (frozenThru == null) {
        await kv.put("fm:frozenThru", yesterdayKey);
      } else if (frozenThru < yesterdayKey) {
        const from = fmNextDayKey(frozenThru);
        const fromMs = Math.max(Date.parse(from + "T00:00:00Z") - 648e5, 1262304e6);
        const toMs = Date.parse(fmNextDayKey(yesterdayKey) + "T00:00:00Z") + 648e5;
        const rows = fmComputeDays(await fmSessionsInRange(env, fromMs, toMs), from, yesterdayKey, zone);
        await fmWriteDayRows(env, rows);
        await kv.put("fm:frozenThru", yesterdayKey);
        out.froze = rows.length;
        console.log(JSON.stringify({ level: "info", msg: "fm day-flip freeze", from, thru: yesterdayKey, rows: rows.length }));
      }
    } catch (e) {
      console.log(JSON.stringify({ level: "warn", msg: "fm freeze step failed", error: String(e && e.message || e) }));
    }
    try {
      const last7 = await kv.get("fm:refresh7d:at").catch(() => null);
      if (!last7 || now - Date.parse(last7) > 36e5) {
        const fromKey = rollupDayKey(now - 7 * 864e5, zone);
        const fromMs = Date.parse(fromKey + "T00:00:00Z") - 648e5;
        const rows = fmComputeDays(await fmSessionsInRange(env, fromMs, now + 648e5), fromKey, todayKey, zone);
        await fmWriteDayRows(env, rows);
        await kv.put("fm:refresh7d:at", new Date(now).toISOString());
        out.refresh7d = true;
      }
    } catch (e) {
      console.log(JSON.stringify({ level: "warn", msg: "fm refresh7d step failed", error: String(e && e.message || e) }));
    }
  }
  if (new Date(now).getUTCMinutes() % 5 === 0) {
    try {
      const bj = await env.DB.prepare("UPDATE BackupJob SET status = 'failed', error = 'fm: reclaimed stuck running > 2h (worker CPU limit)', completedAt = ? WHERE status = 'running' AND createdAt < ?").bind(new Date(now).toISOString(), new Date(now - 72e5).toISOString()).run();
      out.backupReaped = Number(bj.meta?.changes ?? 0);
    } catch {
    }
    try {
      const t = await env.DB.prepare("SELECT id, userId FROM Trip WHERE deletedAt IS NULL AND statsComputedAt IS NULL AND status = 'completed' AND spanEnd < ? ORDER BY spanStart ASC LIMIT 3").bind(new Date(now - 216e5).toISOString()).all();
      for (const tr of t.results ?? []) {
        const id = String(tr.id);
        const key = "fm:tsw:" + id;
        const last = kv ? await kv.get(key).catch(() => null) : null;
        if (last) continue;
        if (kv) await kv.put(key, new Date(now).toISOString(), { expirationTtl: 21600 });
        const uid = tr.userId == null ? null : String(tr.userId);
        let apiKey = null;
        if (uid) {
          const u = await env.DB.prepare("SELECT apiKey FROM User WHERE id = ?").bind(uid).first().catch(() => null);
          apiKey = u && u.apiKey ? String(u.apiKey) : null;
        }
        if (apiKey && env.APP_ORIGIN) {
          const ctrl = new AbortController();
          const tm = setTimeout(() => ctrl.abort(), 3e4);
          try {
            const r = await fetch(env.APP_ORIGIN + "/api/trips/batch?ids=" + encodeURIComponent(id), { headers: { authorization: "Bearer " + apiKey }, signal: ctrl.signal });
            out.tsw = { tripId: id, status: r.status };
          } catch (e) {
            out.tsw = { tripId: id, error: String(e && e.message || e) };
          } finally {
            clearTimeout(tm);
          }
        }
        break;
      }
    } catch {
    }
  }
  return out;
}
__name(fmEngineTick, "fmEngineTick");
function fmScopeClause(sql) {
  if (/AND\s+userId\s+IS\s+NULL/i.test(sql)) return { clause: " WHERE userId = ''", param: null };
  if (/AND\s+userId\s*=\s*\?/i.test(sql)) return { clause: " WHERE userId = ?", param: 0 };
  return { clause: "", param: null };
}
__name(fmScopeClause, "fmScopeClause");
async function fmInterceptQuery(env, sql, params) {
  if (!FM_ENABLED || typeof sql !== "string") return null;
  try {
    const s = sql.replace(/\s+/g, " ").trim();
    if (/^SELECT startTime, userId, pointCount(, statsCache)? FROM Session WHERE deletedAt IS NULL AND startTime >= \? AND startTime < \?/i.test(s) && typeof params[0] === "string" && params[0] < "2001-01-01") {
      return json({ rows: [], rowsAffected: 0, meta: { rowsRead: 0, rowsWritten: 0, durationMs: 0, fm: "heal-neutralized" } });
    }
    if (/^SELECT COUNT\(\*\) AS c, MAX\(updatedAt\) AS m FROM Session WHERE deletedAt IS NULL( AND userId = \?| AND userId IS NULL)?$/i.test(s)) {
      const scope = fmScopeClause(s);
      const stmt = env.DB.prepare("SELECT COALESCE(SUM(sessions), 0) AS c, MAX(updatedAt) AS m FROM StatsRollup" + scope.clause);
      const res = await (scope.param === 0 ? stmt.bind(params[0]) : stmt).all();
      budgetTrack(res.meta?.rows_read ?? 0, res.meta?.rows_written ?? 0);
      const r = (res.results ?? [])[0] ?? {};
      return json({ rows: [{ c: Number(r.c ?? 0), m: r.m ?? null }], rowsAffected: 0, meta: { rowsRead: res.meta?.rows_read ?? 0, rowsWritten: 0, durationMs: res.meta?.duration ?? 0, fm: "rollup-scope-counters" } });
    }
    if (/^SELECT COUNT\(\*\) as count FROM Session WHERE deletedAt IS NULL( AND userId = \?| AND userId IS NULL)?$/i.test(s)) {
      const scope = fmScopeClause(s);
      const stmt = env.DB.prepare("SELECT COALESCE(SUM(sessions), 0) AS count FROM StatsRollup" + scope.clause);
      const res = await (scope.param === 0 ? stmt.bind(params[0]) : stmt).all();
      budgetTrack(res.meta?.rows_read ?? 0, res.meta?.rows_written ?? 0);
      const r = (res.results ?? [])[0] ?? {};
      return json({ rows: [{ count: Number(r.count ?? 0) }], rowsAffected: 0, meta: { rowsRead: res.meta?.rows_read ?? 0, rowsWritten: 0, durationMs: res.meta?.duration ?? 0, fm: "rollup-total-sessions" } });
    }
    if (/^SELECT COUNT\(\*\) AS c FROM GpsPoint WHERE sessionId IN \(SELECT id FROM Session WHERE deletedAt IS NULL( AND userId = \?| AND userId IS NULL)?\)$/i.test(s)) {
      const scope = fmScopeClause(s);
      const stmt = env.DB.prepare("SELECT COALESCE(SUM(points), 0) AS c FROM StatsRollup" + scope.clause);
      const res = await (scope.param === 0 ? stmt.bind(params[0]) : stmt).all();
      budgetTrack(res.meta?.rows_read ?? 0, res.meta?.rows_written ?? 0);
      const r = (res.results ?? [])[0] ?? {};
      return json({ rows: [{ c: Number(r.c ?? 0) }], rowsAffected: 0, meta: { rowsRead: res.meta?.rows_read ?? 0, rowsWritten: 0, durationMs: res.meta?.duration ?? 0, fm: "rollup-total-points" } });
    }
  } catch (e) {
    console.log(JSON.stringify({ level: "warn", msg: "fm intercept failed (fallthrough)", error: String(e && e.message || e) }));
  }
  return null;
}
__name(fmInterceptQuery, "fmInterceptQuery");
