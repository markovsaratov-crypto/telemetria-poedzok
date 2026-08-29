// src/lib/db.ts — Direct libsql client (production-grade, no Prisma engine)
// Uses @libsql/client directly for all database operations.
// Prisma is used only for type generation (schema.prisma).
import { createClient, type Client, type InValue } from "@libsql/client";
import { randomUUID } from "crypto";

const globalForDb = globalThis as unknown as {
  libsqlClient: Client | undefined;
};

function createDbClient(): Client {
  const url = process.env.DATABASE_URL || "";
  const authToken = process.env.TURSO_AUTH_TOKEN;

  if (url.startsWith("libsql://")) {
    return createClient({ url, authToken });
  }

  return createClient({ url: url || "file:./db/custom.db" });
}

export const libsql = globalForDb.libsqlClient ?? createDbClient();
if (process.env.NODE_ENV !== "production") globalForDb.libsqlClient = libsql;

// Helper to convert snake_case DB rows to camelCase objects
function toCamel(row: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    const camelKey = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    result[camelKey] = value;
  }
  return result;
}

// P1-10 → v2.9.4 fix: унификация временных аргументов SQL-фильтров.
// Дата-время в Session/ExportJob/BackupJob хранится как TEXT ISO-8601 UTC
// («2026-08-16T09:46:40.747Z») — libsql сериализует Date в ISO при INSERT.
// Раньше возвращались epoch-ms ЧИСЛА: в SQLite text всегда > integer,
// из-за чего фильтры startTime >= ?/deletedAt < ? молча матчили ВСЕ text-строки
// (todaySessions считал все сессии, perDay был нулями, retention-purge не находил
// grace-истёкшие строки). Prod-БД нормализована миграцией v2.9.4 (все datetime — text),
// здесь приводим аргументы к тому же формату.
// NB: GpsPoint.timestamp — INTEGER ms (BigInt) и фильтрами через toTs не проходит.
function toTs(v: Date | number): string {
  if (v instanceof Date) return v.toISOString();
  // число трактуем как epoch-ms (Prisma-стиль вызовы)
  return new Date(v).toISOString();
}

// P1: undefined-значения недопустимы для libsql («Unsupported type of value») — вырезаем их из data
function pruneUndefined(o: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out;
}

// ——— Session relations: fetching for include/select (P0-2) ———
type RelationOpts = Record<string, unknown> | true | undefined;

function projectScalars(row: Record<string, unknown>, select: Record<string, boolean>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(select)) {
    if (v && k in row) out[k] = row[k];
  }
  return out;
}

async function fetchGpsPoints(sessionId: string, opts: RelationOpts): Promise<Record<string, unknown>[]> {
  const o = (opts === true ? {} : opts || {}) as { orderBy?: { timestamp?: string }; take?: number; select?: Record<string, boolean> };
  const order = o.orderBy?.timestamp === "desc" ? "DESC" : "ASC";
  let sql = `SELECT * FROM GpsPoint WHERE sessionId = ? ORDER BY timestamp ${order}`;
  const params: unknown[] = [sessionId];
  if (o.take) { sql += " LIMIT ?"; params.push(o.take); }
  const res = await libsql.execute({ sql, args: params as InValue[] });
  let rows = res.rows.map(r => { const p = toCamel(r as Record<string, unknown>); p.timestamp = Number(p.timestamp); return p; });
  if (o.select) rows = rows.map(r => projectScalars(r, o.select as Record<string, boolean>));
  return rows;
}

async function fetchTrafficJobs(sessionId: string, opts: RelationOpts): Promise<Record<string, unknown>[]> {
  const o = (opts === true ? {} : opts || {}) as { orderBy?: { createdAt?: string }; take?: number };
  const order = o.orderBy?.createdAt === "asc" ? "ASC" : "DESC";
  let sql = `SELECT * FROM TrafficJob WHERE sessionId = ? ORDER BY createdAt ${order}`;
  const params: unknown[] = [sessionId];
  if (o.take) { sql += " LIMIT ?"; params.push(o.take); }
  const res = await libsql.execute({ sql, args: params as InValue[] });
  return res.rows.map(r => toCamel(r as Record<string, unknown>));
}

async function fetchRouteById(routeId: unknown): Promise<Record<string, unknown> | null> {
  if (!routeId || typeof routeId !== "string") return null;
  const res = await libsql.execute({ sql: "SELECT * FROM Route WHERE id = ?", args: [routeId] });
  return res.rows.length > 0 ? toCamel(res.rows[0] as Record<string, unknown>) : null;
}

// Applying select/include to a Session row (supports nested relations with orderBy/take/select)
async function projectSession(
  row: Record<string, unknown>,
  select?: Record<string, unknown>,
  include?: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const session = toCamel(row);
  if (include) {
    if (include.gpsPoints) session.gpsPoints = await fetchGpsPoints(session.id as string, include.gpsPoints as RelationOpts);
    if (include.trafficJobs) session.trafficJobs = await fetchTrafficJobs(session.id as string, include.trafficJobs as RelationOpts);
    if (include.route) session.route = await fetchRouteById(session.routeId);
  }
  if (select) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(select)) {
      if (!v) continue;
      if (k === "gpsPoints") out.gpsPoints = await fetchGpsPoints(session.id as string, v as RelationOpts);
      else if (k === "trafficJobs") out.trafficJobs = await fetchTrafficJobs(session.id as string, v as RelationOpts);
      else if (k === "route") out.route = await fetchRouteById(session.routeId);
      else if (k in session) out[k] = session[k];
    }
    return out;
  }
  return session;
}

// Prisma-compatible db wrapper using libsql
export const db = {
  session: {
    async count(args?: { where?: Record<string, unknown> }) {
      let sql = "SELECT COUNT(*) as count FROM Session WHERE deletedAt IS NULL";
      const params: unknown[] = [];
      if (args?.where?.status) { sql += " AND status = ?"; params.push(args.where.status); }
      // P1-10: startTime { gte } (было молча игнорировалось → «сегодня» показывало всего)
      const gte = (args?.where?.startTime as { gte?: Date | number } | undefined)?.gte;
      if (gte) { sql += " AND startTime >= ?"; params.push(toTs(gte)); }
      const result = await libsql.execute({ sql, args: params as InValue[] });
      return Number((result.rows[0] as Record<string, unknown>).count);
    },
    async findMany(args?: {
      where?: Record<string, unknown>;
      orderBy?: Record<string, string>;
      take?: number;
      cursor?: { id: string };
      skip?: number;
      include?: Record<string, unknown>;
    }) {
      const take = args?.take ?? 20;
      const skip = args?.skip ?? (args?.cursor ? 1 : 0);
      let sql = "SELECT * FROM Session WHERE deletedAt IS NULL";
      const params: unknown[] = [];
      const deviceId = args?.where?.deviceId as { contains?: string } | string | undefined;
      if (deviceId && typeof deviceId === "object" && deviceId.contains) { sql += " AND deviceId LIKE ?"; params.push(`%${deviceId.contains}%`); }
      else if (deviceId) { sql += " AND deviceId LIKE ?"; params.push(`%${String(deviceId)}%`); }
      if (args?.where?.status) { sql += " AND status = ?"; params.push(args.where.status); }
      if (args?.where?.routeId) { sql += " AND routeId = ?"; params.push(args.where.routeId); }
      if (args?.cursor?.id) { sql += " AND id != ?"; params.push(args.cursor.id); }
      // P1-10: расширенные фильтры (раньше молча игнорировались — retention удалял бы НОВЫЕ сессии!)
      const w = args?.where || {};
      const st = w.startTime as { lt?: Date | number; gte?: Date | number } | undefined;
      if (st?.lt != null) { sql += " AND startTime < ?"; params.push(toTs(st.lt)); }
      if (st?.gte != null) { sql += " AND startTime >= ?"; params.push(toTs(st.gte)); }
      // deletedAt: null — базовый WHERE; поддерживаем { not: null } и { lt, not: null } (retention grace)
      if (w.deletedAt === null) { /* already in WHERE */ }
      else if (w.deletedAt && typeof w.deletedAt === "object") {
        const da = w.deletedAt as { lt?: Date | number; not?: unknown };
        if (da.lt != null) {
          sql = sql.replace("deletedAt IS NULL", "deletedAt IS NOT NULL AND deletedAt < ?");
          params.push(toTs(da.lt));
        } else if (da.not != null) {
          sql = sql.replace("deletedAt IS NULL", "deletedAt IS NOT NULL");
        }
      }
      // purgedAt: null | { lt: Date | number } — обрабатываем оба варианта
      const pa = w.purgedAt as null | { lt?: Date | number; not?: unknown } | undefined;
      if (pa === undefined || pa === null || (pa && (pa as { not?: unknown }).not === undefined && Object.keys(pa).length === 0)) {
        sql += " AND purgedAt IS NULL"; // purgedAt: null — дефолт
      } else if (pa && (pa as { lt?: Date | number }).lt != null) {
        sql += " AND purgedAt < ?"; params.push(toTs((pa as { lt: Date | number }).lt));
      }
      const order = args?.orderBy?.startTime === "asc" ? "ASC" : "DESC";
      sql += ` ORDER BY startTime ${order} LIMIT ?`;
      if (skip > 0) { sql += " OFFSET ?"; params.push(take, skip); } else { params.push(take); }
      const result = await libsql.execute({ sql, args: params as InValue[] });
      return result.rows.map(r => toCamel(r as Record<string, unknown>));
    },
    // P1-10: aggregate (_sum) — /api/stats падал с TypeError (метода не было)
    async aggregate(args?: { _sum?: Record<string, unknown>; where?: Record<string, unknown> }) {
      let sql = "SELECT";
      const params: unknown[] = [];
      const sums: string[] = [];
      if (args?._sum?.payloadBytes) sums.push("SUM(payloadBytes) as payloadBytes");
      if (args?._sum?.distanceM) sums.push("SUM(distanceM) as distanceM");
      if (sums.length === 0) sums.push("1 as x");
      sql += " " + sums.join(", ") + " FROM Session WHERE deletedAt IS NULL";
      const result = await libsql.execute({ sql, args: params as InValue[] });
      const row = result.rows[0] as Record<string, unknown>;
      const sum: Record<string, unknown> = {};
      for (const k of ["payloadBytes", "distanceM"]) {
        if (args?._sum && (args._sum as Record<string, unknown>)[k]) sum[k] = row[k] != null ? Number(row[k]) : null;
      }
      return { _sum: sum };
    },
    async findUnique(args: {
      where: { id?: string; deviceId_clientId?: { deviceId: string; clientId: string } };
      select?: Record<string, unknown>;
      include?: Record<string, unknown>;
    }) {
      // Composite unique key (deviceId, clientId) — §6.2 idempotency.
      // Without the deletedAt filter: the caller itself checks deletedAt.
      let row: Record<string, unknown> | null = null;
      const composite = args.where?.deviceId_clientId;
      if (composite) {
        const result = await libsql.execute({
          sql: "SELECT * FROM Session WHERE deviceId = ? AND clientId = ? LIMIT 1",
          args: [composite.deviceId, composite.clientId],
        });
        row = result.rows.length > 0 ? (result.rows[0] as Record<string, unknown>) : null;
      } else {
        const result = await libsql.execute({
          sql: "SELECT * FROM Session WHERE id = ? AND deletedAt IS NULL",
          args: [args.where?.id as string],
        });
        row = result.rows.length > 0 ? (result.rows[0] as Record<string, unknown>) : null;
      }
      if (!row) return null;
      return projectSession(row, args.select, args.include);
    },
    async create(args: { data: Record<string, unknown> }) {
      const now = new Date().toISOString();
      const data = { id: randomUUID(), createdAt: now, updatedAt: now, ...pruneUndefined(args.data) };
      const keys = Object.keys(data);
      const values = Object.values(data);
      const placeholders = keys.map(() => "?").join(", ");
      const result = await libsql.execute({ sql: `INSERT INTO Session (${keys.join(", ")}) VALUES (${placeholders}) RETURNING *`, args: values as InValue[] });
      return toCamel(result.rows[0] as Record<string, unknown>);
    },
    async update(args: { where: { id: string }; data: Record<string, unknown> }) {
      const sets = Object.keys(args.data).map((k) => `${k} = ?`).join(", ");
      const values = Object.values(args.data);
      const result = await libsql.execute({ sql: `UPDATE Session SET ${sets} WHERE id = ? RETURNING *`, args: [...values, args.where.id] as InValue[] });
      return result.rows.length > 0 ? toCamel(result.rows[0] as Record<string, unknown>) : null;
    },
    async updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }) {
      const sets = Object.keys(args.data).map((k) => `${k} = ?`).join(", ");
      const values = Object.values(args.data);
      const conditions: string[] = [];
      const condParams: unknown[] = [];
      const w = args.where || {};
      // id: { in: [...] } — P0-2 (was ignored along with the rest of the filters)
      const idIn = (w.id as { in?: string[] } | undefined)?.in;
      if (Array.isArray(idIn)) {
        if (idIn.length === 0) return { count: 0 };
        conditions.push(`id IN (${idIn.map(() => "?").join(", ")})`);
        condParams.push(...idIn);
      } else if (typeof w.id === "string") {
        conditions.push("id = ?");
        condParams.push(w.id);
      }
      // Additional scalar filters (previously silently ignored)
      for (const key of ["deviceId", "status", "routeId"] as const) {
        if (typeof w[key] === "string") { conditions.push(`${key} = ?`); condParams.push(w[key]); }
      }
      // Protection from a mistake: an update without filters is forbidden
      if (conditions.length === 0) return { count: 0 };
      const result = await libsql.execute({ sql: `UPDATE Session SET ${sets} WHERE ${conditions.join(" AND ")}`, args: [...values, ...condParams] as InValue[] });
      return { count: result.rowsAffected };
    },
    async groupBy(args: { by: string[]; _count: boolean; where?: Record<string, unknown> }) {
      let sql = `SELECT ${args.by.join(", ")}, COUNT(*) as _count FROM Session WHERE deletedAt IS NULL`;
      const params: unknown[] = [];
      const gbDev = args.where?.deviceId as { contains?: string } | undefined;
      if (gbDev?.contains) { sql += " AND deviceId LIKE ?"; params.push(`%${gbDev.contains}%`); }
      sql += ` GROUP BY ${args.by.join(", ")}`;
      const result = await libsql.execute({ sql, args: params as InValue[] });
      return result.rows.map(r => { const row = r as Record<string, unknown>; return { [args.by[0]]: row[args.by[0]], _count: Number(row._count) }; });
    },
    async findFirst(args?: {
      where?: Record<string, unknown>;
      orderBy?: Record<string, string>;
      select?: Record<string, boolean>;
    }) {
      let sql = "SELECT * FROM Session WHERE deletedAt IS NULL";
      const params: unknown[] = [];
      const w = args?.where || {};
      if (w.deviceId) { sql += " AND deviceId = ?"; params.push(w.deviceId); }
      if (w.status) { sql += " AND status = ?"; params.push(w.status); }
      if (w.routeId) { sql += " AND routeId = ?"; params.push(w.routeId); }
      if (w.id) { sql += " AND id = ?"; params.push(w.id); }
      const order = args?.orderBy?.startTime === "asc" ? "ASC" : "DESC";
      sql += ` ORDER BY startTime ${order} LIMIT 1`;
      const result = await libsql.execute({ sql, args: params as InValue[] });
      if (result.rows.length === 0) return null;
      const row = toCamel(result.rows[0] as Record<string, unknown>);
      if (args?.select) {
        const filtered: Record<string, unknown> = {};
        for (const key of Object.keys(args.select)) {
          if (args.select[key]) filtered[key] = row[key];
        }
        return filtered;
      }
      return row;
    },
  },
  gpsPoint: {
    async createMany(args: { data: Array<Record<string, unknown>> }) {
      for (const item of args.data) {
        // GpsPoint.id — NOT NULL (cuid в Prisma): генерируем, если не передан (P0-2)
        const data = { id: randomUUID(), ...pruneUndefined(item) };
        const keys = Object.keys(data);
        const values = Object.values(data).map((v) => (v === undefined ? null : v));
        const placeholders = keys.map(() => "?").join(", ");
        await libsql.execute({ sql: `INSERT INTO GpsPoint (${keys.join(", ")}) VALUES (${placeholders})`, args: values as InValue[] });
      }
      return { count: args.data.length };
    },
    async deleteMany(args: { where: Record<string, unknown> }) {
      const result = await libsql.execute({ sql: "DELETE FROM GpsPoint WHERE sessionId = ?", args: [args.where.sessionId] as InValue[] });
      return { count: result.rowsAffected };
    },
  },
  trafficJob: {
    async create(args: { data: Record<string, unknown> }) {
      const now = new Date().toISOString();
      const data = { id: randomUUID(), createdAt: now, updatedAt: now, ...pruneUndefined(args.data) };
      const keys = Object.keys(data);
      const values = Object.values(data);
      const placeholders = keys.map(() => "?").join(", ");
      const result = await libsql.execute({ sql: `INSERT INTO TrafficJob (${keys.join(", ")}) VALUES (${placeholders}) RETURNING *`, args: values as InValue[] });
      return toCamel(result.rows[0] as Record<string, unknown>);
    },
    async update(args: { where: { id: string }; data: Record<string, unknown> }) {
      const sets = Object.keys(args.data).map((k) => `${k} = ?`).join(", ");
      const values = Object.values(args.data);
      const result = await libsql.execute({ sql: `UPDATE TrafficJob SET ${sets} WHERE id = ? RETURNING *`, args: [...values, args.where.id] as InValue[] });
      return result.rows.length > 0 ? toCamel(result.rows[0] as Record<string, unknown>) : null;
    },
    async count(args?: { where?: Record<string, unknown> }) {
      let sql = "SELECT COUNT(*) as count FROM TrafficJob";
      const params: unknown[] = [];
      if (args?.where?.status) { sql += " WHERE status = ?"; params.push(args.where.status); }
      const result = await libsql.execute({ sql, args: params as InValue[] });
      return Number((result.rows[0] as Record<string, unknown>).count);
    },
    async findMany(args?: { where?: Record<string, unknown>; orderBy?: Record<string, string>; take?: number; include?: Record<string, unknown> }) {
      const take = args?.take ?? 50;
      let sql = "SELECT * FROM TrafficJob";
      const params: unknown[] = [];
      if (args?.where?.status) { sql += " WHERE status = ?"; params.push(args.where.status); }
      sql += " ORDER BY createdAt DESC LIMIT ?";
      params.push(take);
      const result = await libsql.execute({ sql, args: params as InValue[] });
      const jobs = result.rows.map(r => toCamel(r as Record<string, unknown>));
      if (args?.include?.session) {
        for (const job of jobs) {
          const sResult = await libsql.execute({ sql: "SELECT deviceId, startTime FROM Session WHERE id = ?", args: [job.sessionId as InValue] });
          if (sResult.rows.length > 0) job.session = toCamel(sResult.rows[0] as Record<string, unknown>);
        }
      }
      return jobs;
    },
    async groupBy(args: { by: string[]; _count: boolean; where?: Record<string, unknown> }) {
      let sql = `SELECT ${args.by.join(", ")}, COUNT(*) as _count FROM TrafficJob`;
      const params: unknown[] = [];
      if (args.where?.status) { sql += " WHERE status = ?"; params.push(args.where.status); }
      sql += ` GROUP BY ${args.by.join(", ")}`;
      const result = await libsql.execute({ sql, args: params as InValue[] });
      return result.rows.map(r => { const row = r as Record<string, unknown>; return { [args.by[0]]: row[args.by[0]], _count: Number(row._count) }; });
    },
  },
  auditLog: {
    async create(args: { data: Record<string, unknown> }) {
      const now = new Date().toISOString();
      const data = { id: randomUUID(), createdAt: now, ...pruneUndefined(args.data) };
      const keys = Object.keys(data);
      const values = Object.values(data);
      const placeholders = keys.map(() => "?").join(", ");
      await libsql.execute({ sql: `INSERT INTO AuditLog (${keys.join(", ")}) VALUES (${placeholders})`, args: values as InValue[] });
    },
    async findMany(args?: { where?: Record<string, unknown>; orderBy?: Record<string, string>; take?: number; cursor?: { id: string }; skip?: number }) {
      const take = args?.take ?? 50;
      const skip = args?.skip ?? (args?.cursor ? 1 : 0);
      let sql = "SELECT * FROM AuditLog";
      const params: unknown[] = [];
      const conditions: string[] = [];
      const actContains = (args?.where?.action as { contains?: string } | undefined)?.contains;
      if (actContains) { conditions.push("action LIKE ?"); params.push(`%${actContains}%`); }
      if (args?.where?.actorType) { conditions.push("actorType = ?"); params.push(args.where.actorType); }
      if (args?.where?.targetType) { conditions.push("targetType = ?"); params.push(args.where.targetType); }
      if (conditions.length > 0) sql += " WHERE " + conditions.join(" AND ");
      if (args?.cursor?.id) { sql += skip > 0 ? " AND id != ?" : " WHERE id != ?"; params.push(args.cursor.id); }
      sql += " ORDER BY createdAt DESC LIMIT ?";
      if (skip > 0) { sql += " OFFSET ?"; params.push(take, skip); } else { params.push(take); }
      const result = await libsql.execute({ sql, args: params as InValue[] });
      return result.rows.map(r => toCamel(r as Record<string, unknown>));
    },
    async deleteMany(args?: { where?: Record<string, unknown> }) {
      let sql = "DELETE FROM AuditLog";
      const params: unknown[] = [];
      const createdLt = (args?.where?.createdAt as { lt?: Date | number } | undefined)?.lt;
      if (createdLt != null) { sql += " WHERE createdAt < ?"; params.push(toTs(createdLt)); }
      const result = await libsql.execute({ sql, args: params as InValue[] });
      return { count: result.rowsAffected };
    },
  },
  route: {
    async findMany() {
      const result = await libsql.execute("SELECT * FROM Route ORDER BY createdAt DESC");
      return result.rows.map(r => toCamel(r as Record<string, unknown>));
    },
    async findUnique(args: { where: { id: string } }) {
      const result = await libsql.execute({ sql: "SELECT * FROM Route WHERE id = ?", args: [args.where.id] });
      return result.rows.length > 0 ? toCamel(result.rows[0] as Record<string, unknown>) : null;
    },
    async create(args: { data: Record<string, unknown> }) {
      const now = new Date().toISOString();
      const data = { id: randomUUID(), createdAt: now, updatedAt: now, ...pruneUndefined(args.data) };
      const keys = Object.keys(data);
      const values = Object.values(data);
      const placeholders = keys.map(() => "?").join(", ");
      const result = await libsql.execute({ sql: `INSERT INTO Route (${keys.join(", ")}) VALUES (${placeholders}) RETURNING *`, args: values as InValue[] });
      return toCamel(result.rows[0] as Record<string, unknown>);
    },
    async update(args: { where: { id: string }; data: Record<string, unknown> }) {
      const sets = Object.keys(args.data).map((k) => `${k} = ?`).join(", ");
      const values = Object.values(args.data);
      const result = await libsql.execute({ sql: `UPDATE Route SET ${sets} WHERE id = ? RETURNING *`, args: [...values, args.where.id] as InValue[] });
      return result.rows.length > 0 ? toCamel(result.rows[0] as Record<string, unknown>) : null;
    },
    async delete(args: { where: { id: string } }) {
      await libsql.execute({ sql: "DELETE FROM Route WHERE id = ?", args: [args.where.id] });
    },
    async count() {
      const result = await libsql.execute("SELECT COUNT(*) as count FROM Route");
      return Number((result.rows[0] as Record<string, unknown>).count);
    },
  },
  routeCache: {
    async findUnique(args: { where: { hash: string } }) {
      const result = await libsql.execute({ sql: "SELECT * FROM RouteCache WHERE hash = ?", args: [args.where.hash as InValue] });
      return result.rows.length > 0 ? toCamel(result.rows[0] as Record<string, unknown>) : null;
    },
    async upsert(args: { where: { hash: string }; create: Record<string, unknown>; update: Record<string, unknown> }) {
      // RouteCache: id/createdAt NOT NULL — substitute defaults if the caller didn't pass them (P0-2);
      // drop undefined values (libsql rejects undefined — Prisma semantics "don't set")
      const createData = { id: randomUUID(), createdAt: new Date().toISOString(), ...args.create };
      for (const k of Object.keys(createData)) if (createData[k] === undefined) delete createData[k];
      const updateData = { ...args.update };
      for (const k of Object.keys(updateData)) if (updateData[k] === undefined) delete updateData[k];
      const createKeys = Object.keys(createData);
      const createValues = Object.values(createData);
      const updateKeys = Object.keys(updateData);
      const updateValues = Object.values(updateData);
      const placeholders = createKeys.map(() => "?").join(", ");
      const sets = updateKeys.map((k) => `${k} = ?`).join(", ");
      await libsql.execute({ sql: `INSERT INTO RouteCache (${createKeys.join(", ")}) VALUES (${placeholders}) ON CONFLICT(hash) DO UPDATE SET ${sets}`, args: [...createValues, ...updateValues] as InValue[] });
      const result = await libsql.execute({ sql: "SELECT * FROM RouteCache WHERE hash = ?", args: [args.where.hash as InValue] });
      return result.rows.length > 0 ? toCamel(result.rows[0] as Record<string, unknown>) : null;
    },
  },
  exportJob: {
    async findUnique(args: { where: { id: string }; include?: Record<string, unknown> }) {
      const result = await libsql.execute({ sql: "SELECT * FROM ExportJob WHERE id = ?", args: [args.where.id] });
      if (result.rows.length === 0) return null;
      const job = toCamel(result.rows[0] as Record<string, unknown>);
      if ((args.include?.session as { include?: { gpsPoints?: boolean } } | undefined)?.include?.gpsPoints) {
        const pts = await libsql.execute({ sql: "SELECT * FROM GpsPoint WHERE sessionId = ? ORDER BY timestamp ASC", args: [job.sessionId as InValue] });
        const session = { gpsPoints: pts.rows.map(r => { const p = toCamel(r as Record<string, unknown>); p.timestamp = Number(p.timestamp); return p; }) };
        (job as Record<string, unknown>).session = session;
      }
      return job;
    },
    async create(args: { data: Record<string, unknown> }) {
      const now = new Date().toISOString();
      const data = { id: randomUUID(), createdAt: now, ...pruneUndefined(args.data) };
      const keys = Object.keys(data);
      const values = Object.values(data);
      const placeholders = keys.map(() => "?").join(", ");
      const result = await libsql.execute({ sql: `INSERT INTO ExportJob (${keys.join(", ")}) VALUES (${placeholders}) RETURNING *`, args: values as InValue[] });
      return toCamel(result.rows[0] as Record<string, unknown>);
    },
  },
  backupJob: {
    async create(args: { data: Record<string, unknown> }) {
      const now = new Date().toISOString();
      const data = { id: randomUUID(), createdAt: now, ...pruneUndefined(args.data) };
      const keys = Object.keys(data);
      const values = Object.values(data);
      const placeholders = keys.map(() => "?").join(", ");
      const result = await libsql.execute({ sql: `INSERT INTO BackupJob (${keys.join(", ")}) VALUES (${placeholders}) RETURNING *`, args: values as InValue[] });
      return toCamel(result.rows[0] as Record<string, unknown>);
    },
    async update(args: { where: { id: string }; data: Record<string, unknown> }) {
      const sets = Object.keys(args.data).map((k) => `${k} = ?`).join(", ");
      const values = Object.values(args.data);
      const result = await libsql.execute({ sql: `UPDATE BackupJob SET ${sets} WHERE id = ? RETURNING *`, args: [...values, args.where.id] as InValue[] });
      return result.rows.length > 0 ? toCamel(result.rows[0] as Record<string, unknown>) : null;
    },
    async findMany(args?: { orderBy?: Record<string, string>; take?: number }) {
      const take = args?.take ?? 50;
      const result = await libsql.execute({ sql: "SELECT * FROM BackupJob ORDER BY createdAt DESC LIMIT ?", args: [take] });
      return result.rows.map(r => toCamel(r as Record<string, unknown>));
    },
  },
  $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    let sql = strings[0];
    for (let i = 1; i < strings.length; i++) { sql += `?${strings[i]}`; }
    const result = await libsql.execute({ sql, args: values as InValue[] });
    return result.rows;
  },
  // P2-14: ЧЕСТНАЯ транзакция через libsql.transaction (раньше $transaction просто
  // вызывал fn(db) — атомарности не было: сбой между INSERT сессии и пакетом точек
  // оставлял «висячую» сессию без точек). Транзакционный объект поддерживает
  // generic create/createMany для известных таблиц; неподдерживаемые вызовы
  // падают ГРОМКО (а не молча выполняются вне транзакции).
  $transaction: async <T>(fn: (tx: typeof db) => Promise<T>): Promise<T> => {
    const txClient = await libsql.transaction("write");
    try {
      const out = await fn(makeTxExecutor(txClient) as unknown as typeof db);
      await txClient.commit();
      return out;
    } catch (err) {
      try {
        await txClient.rollback();
      } catch {
        // транзакция уже откатана/закрыта — не маскируем исходную ошибку
      }
      throw err;
    }
  },
};

// Таблицы, доступные внутри $transaction: model → нужен ли updatedAt при create
const TX_TABLES: Record<string, { updatedAt: boolean }> = {
  Session: { updatedAt: true },
  TrafficJob: { updatedAt: true },
  Route: { updatedAt: true },
  ExportJob: { updatedAt: true },
  GpsPoint: { updatedAt: false },
  AuditLog: { updatedAt: false },
};

type LibsqlTransaction = Awaited<ReturnType<Client["transaction"]>>;

// Транзакционный исполнитель: session.create / gpsPoint.createMany и т.п.,
// но каждый execute идёт через tx (одна атомарная единица работы).
function makeTxExecutor(tx: LibsqlTransaction): Record<string, unknown> {
  return new Proxy({}, {
    get(_target, modelRaw: string | symbol) {
      const model = String(modelRaw);
      const table = model.charAt(0).toUpperCase() + model.slice(1);
      const meta = TX_TABLES[table];
      return {
        async create(args: { data: Record<string, unknown> }) {
          if (!meta) throw new Error(`tx.${model}.create: таблица ${table} не поддерживается в транзакции`);
          const now = new Date().toISOString();
          const data = {
            id: randomUUID(),
            createdAt: now,
            ...(meta.updatedAt ? { updatedAt: now } : {}),
            ...pruneUndefined(args.data),
          };
          const keys = Object.keys(data);
          const values = Object.values(data);
          const placeholders = keys.map(() => "?").join(", ");
          const result = await tx.execute({ sql: `INSERT INTO ${table} (${keys.join(", ")}) VALUES (${placeholders}) RETURNING *`, args: values });
          return toCamel(result.rows[0] as Record<string, unknown>);
        },
        async createMany(args: { data: Array<Record<string, unknown>> }) {
          if (!meta) throw new Error(`tx.${model}.createMany: таблица ${table} не поддерживается в транзакции`);
          let count = 0;
          for (const item of args.data) {
            const data = { id: randomUUID(), ...pruneUndefined(item) };
            const keys = Object.keys(data);
            const values = Object.values(data).map((v) => (v === undefined ? null : v));
            const placeholders = keys.map(() => "?").join(", ");
            await tx.execute({ sql: `INSERT INTO ${table} (${keys.join(", ")}) VALUES (${placeholders})`, args: values });
            count += 1;
          }
          return { count };
        },
        async update(args: { where: { id: string }; data: Record<string, unknown> }) {
          if (!meta) throw new Error(`tx.${model}.update: таблица ${table} не поддерживается в транзакции`);
          const data: Record<string, unknown> = { ...pruneUndefined(args.data) };
          if (meta.updatedAt) data.updatedAt = new Date().toISOString();
          const keys = Object.keys(data);
          if (keys.length === 0) return null;
          const setSql = keys.map((k) => `${k} = ?`).join(", ");
          const values = [...Object.values(data), args.where.id];
          const result = await tx.execute({ sql: `UPDATE ${table} SET ${setSql} WHERE id = ? RETURNING *`, args: values as InValue[] });
          return result.rows.length > 0 ? toCamel(result.rows[0] as Record<string, unknown>) : null;
        },
      };
    },
  });
}

// Additional methods needed by API routes

// gpsPoint.count
(db as any).gpsPoint.count = async (args?: { where?: Record<string, unknown> }) => {
  let sql = "SELECT COUNT(*) as count FROM GpsPoint";
  const params: unknown[] = [];
  if (args?.where?.sessionId) { sql += " WHERE sessionId = ?"; params.push(args.where.sessionId); }
  const result = await libsql.execute({ sql, args: params as InValue[] });
  return Number((result.rows[0] as Record<string, unknown>).count);
};

// session.aggregate
(db as any).session.aggregate = async (args: { _sum?: Record<string, boolean>; _count?: Record<string, boolean>; where?: Record<string, unknown> }) => {
  let sql = "SELECT";
  const params: unknown[] = [];
  const parts: string[] = [];
  if (args._sum?.payloadBytes) parts.push("SUM(payloadBytes) as _sum_payloadBytes");
  if (args._sum?.pointCount) parts.push("SUM(pointCount) as _sum_pointCount");
  if (args._count?.id) parts.push("COUNT(*) as _count_id");
  sql += " " + parts.join(", ") + " FROM Session WHERE deletedAt IS NULL";
  if (args.where?.status) { sql += " AND status = ?"; params.push(args.where.status); }
  const result = await libsql.execute({ sql, args: params as InValue[] });
  const row = result.rows[0] as Record<string, unknown>;
  return {
    _sum: {
      payloadBytes: row._sum_payloadBytes ? Number(row._sum_payloadBytes) : null,
      pointCount: row._sum_pointCount ? Number(row._sum_pointCount) : null,
    },
    _count: { id: row._count_id ? Number(row._count_id) : 0 },
  };
};

// trafficJob.findUnique
(db as any).trafficJob.findUnique = async (args: { where: { id: string } }) => {
  const result = await libsql.execute({ sql: "SELECT * FROM TrafficJob WHERE id = ?", args: [args.where.id] });
  return result.rows.length > 0 ? toCamel(result.rows[0] as Record<string, unknown>) : null;
};

// backupJob.findUnique
(db as any).backupJob.findUnique = async (args: { where: { id: string } }) => {
  const result = await libsql.execute({ sql: "SELECT * FROM BackupJob WHERE id = ?", args: [args.where.id] });
  return result.rows.length > 0 ? toCamel(result.rows[0] as Record<string, unknown>) : null;
};

// session.findMany with more where options (gte, lt, etc.)
const originalFindMany = (db as any).session.findMany;
(db as any).session.findMany = async (args?: {
  where?: Record<string, unknown>;
  orderBy?: Record<string, string>;
  take?: number;
  cursor?: { id: string };
  skip?: number;
  select?: Record<string, boolean>;
  include?: Record<string, unknown>;
}) => {
  const take = args?.take ?? 20;
  const skip = args?.skip ?? (args?.cursor ? 1 : 0);
  let sql = "SELECT * FROM Session WHERE deletedAt IS NULL";
  const params: unknown[] = [];
  const w = args?.where || {};
  
  // Handle deviceId contains
  const devId = w.deviceId as { contains?: string } | string | undefined;
  if (devId && typeof devId === "object" && devId.contains) { sql += " AND deviceId LIKE ?"; params.push(`%${devId.contains}%`); }
  else if (devId) { sql += " AND deviceId LIKE ?"; params.push(`%${String(devId)}%`); }
  // Handle id: scalar or { in: [...] } — P0-2 (batch/bulk-delete)
  const idIn = (w.id as { in?: string[] } | undefined)?.in;
  if (Array.isArray(idIn)) {
    if (idIn.length === 0) return [];
    sql += ` AND id IN (${idIn.map(() => "?").join(", ")})`;
    params.push(...idIn);
  } else if (typeof w.id === "string") { sql += " AND id = ?"; params.push(w.id); }
  // Handle status
  if (w.status) { sql += " AND status = ?"; params.push(w.status); }
  // Handle routeId
  if (w.routeId) { sql += " AND routeId = ?"; params.push(w.routeId); }
  // Handle startTime gte/lt
  const stW = w.startTime as { gte?: Date | number; lt?: Date | number } | undefined;
  if (stW?.gte != null) { sql += " AND startTime >= ?"; params.push(toTs(stW.gte)); }
  if (stW?.lt != null) { sql += " AND startTime < ?"; params.push(toTs(stW.lt)); }
  // Handle endTime
  const etW = w.endTime as { lt?: Date | number; gt?: Date | number } | undefined;
  if (etW?.lt != null) { sql += " AND endTime < ?"; params.push(toTs(etW.lt)); }
  if (etW?.gt != null) { sql += " AND endTime > ?"; params.push(toTs(etW.gt)); }
  // Handle deletedAt
  const delW = w.deletedAt as null | { not?: null } | undefined;
  if (delW === null) { /* already in WHERE */ }
  else if (delW && typeof delW === "object" && delW.not === null) { sql += " AND deletedAt IS NOT NULL"; }
  // Handle cursor
  if (args?.cursor?.id) { sql += " AND id != ?"; params.push(args.cursor.id); }
  
  const order = args?.orderBy?.startTime === "asc" ? "ASC" : "DESC";
  sql += ` ORDER BY startTime ${order} LIMIT ?`;
  if (skip > 0) { sql += " OFFSET ?"; params.push(take, skip); } else { params.push(take); }
  
  const result = await libsql.execute({ sql, args: params as InValue[] });
  const rows = result.rows.map(r => toCamel(r as Record<string, unknown>));
  // select: scalar fields + nested gpsPoints (P0-2)
  if (args?.select) {
    const out: Record<string, unknown>[] = [];
    for (const row of rows) {
      const proj: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(args.select)) {
        if (!v) continue;
        if (k === "gpsPoints") proj.gpsPoints = await fetchGpsPoints(row.id as string, args.select.gpsPoints as RelationOpts);
        else if (k in row) proj[k] = row[k];
      }
      out.push(proj);
    }
    return out;
  }
  return rows;
};

// session.count with more where options
const originalCount = (db as any).session.count;
(db as any).session.count = async (args?: { where?: Record<string, unknown> }) => {
  let sql = "SELECT COUNT(*) as count FROM Session WHERE deletedAt IS NULL";
  const params: unknown[] = [];
  const w = args?.where || {};
  if (w.status) { sql += " AND status = ?"; params.push(w.status); }
  const cntSt = w.startTime as { gte?: Date | number } | undefined;
  if (cntSt?.gte != null) { sql += " AND startTime >= ?"; params.push(toTs(cntSt.gte)); }
  if (w.deletedAt === null) { /* already in WHERE */ }
  const result = await libsql.execute({ sql, args: params as InValue[] });
  return Number((result.rows[0] as Record<string, unknown>).count);
};

// session.groupBy
(db as any).session.groupBy = async (args: { by: string[]; _count: boolean; where?: Record<string, unknown> }) => {
  let sql = `SELECT ${args.by.join(", ")}, COUNT(*) as _count FROM Session WHERE deletedAt IS NULL`;
  const params: unknown[] = [];
  const gbDev = args.where?.deviceId as { contains?: string } | undefined;
  if (gbDev?.contains) { sql += " AND deviceId LIKE ?"; params.push(`%${gbDev.contains}%`); }
  sql += ` GROUP BY ${args.by.join(", ")} ORDER BY _count DESC`;
  const result = await libsql.execute({ sql, args: params as InValue[] });
  return result.rows.map(r => {
    const row = r as Record<string, unknown>;
    return { [args.by[0]]: row[args.by[0]], _count: Number(row._count) };
  });
};
