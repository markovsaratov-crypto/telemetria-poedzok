// src/lib/db.ts — Direct libsql client (production-grade, no Prisma engine)
// Uses @libsql/client directly for all database operations.
// Prisma is used only for type generation (schema.prisma).
import { createClient, type Client } from "@libsql/client";

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

// Prisma-compatible db wrapper using libsql
export const db = {
  session: {
    async count(args?: { where?: Record<string, unknown> }) {
      let sql = "SELECT COUNT(*) as count FROM Session WHERE deletedAt IS NULL";
      const params: unknown[] = [];
      if (args?.where?.status) { sql += " AND status = ?"; params.push(args.where.status); }
      const result = await libsql.execute({ sql, args: params });
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
      if (args?.where?.deviceId?.contains) { sql += " AND deviceId LIKE ?"; params.push(`%${args.where.deviceId.contains}%`); }
      else if (args?.where?.deviceId) { sql += " AND deviceId LIKE ?"; params.push(`%${args.where.deviceId}%`); }
      if (args?.where?.status) { sql += " AND status = ?"; params.push(args.where.status); }
      if (args?.where?.routeId) { sql += " AND routeId = ?"; params.push(args.where.routeId); }
      if (args?.cursor?.id) { sql += " AND id != ?"; params.push(args.cursor.id); }
      const order = args?.orderBy?.startTime === "asc" ? "ASC" : "DESC";
      sql += ` ORDER BY startTime ${order} LIMIT ?`;
      if (skip > 0) { sql += " OFFSET ?"; params.push(take, skip); } else { params.push(take); }
      const result = await libsql.execute({ sql, args: params });
      return result.rows.map(r => toCamel(r as Record<string, unknown>));
    },
    async findUnique(args: { where: { id: string }; include?: Record<string, unknown> }) {
      const result = await libsql.execute({ sql: "SELECT * FROM Session WHERE id = ? AND deletedAt IS NULL", args: [args.where.id] });
      if (result.rows.length === 0) return null;
      const session = toCamel(result.rows[0] as Record<string, unknown>);
      if (args.include?.gpsPoints) {
        const pts = await libsql.execute({ sql: "SELECT * FROM GpsPoint WHERE sessionId = ? ORDER BY timestamp ASC", args: [args.where.id] });
        (session as Record<string, unknown>).gpsPoints = pts.rows.map(r => { const p = toCamel(r as Record<string, unknown>); p.timestamp = Number(p.timestamp); return p; });
      }
      if (args.include?.trafficJobs) {
        const jobs = await libsql.execute({ sql: "SELECT * FROM TrafficJob WHERE sessionId = ? ORDER BY createdAt DESC LIMIT 1", args: [args.where.id] });
        (session as Record<string, unknown>).trafficJobs = jobs.rows.map(r => toCamel(r as Record<string, unknown>));
      }
      if (args.include?.route) {
        if (session.routeId) {
          const route = await libsql.execute({ sql: "SELECT * FROM Route WHERE id = ?", args: [session.routeId] });
          (session as Record<string, unknown>).route = route.rows.length > 0 ? toCamel(route.rows[0] as Record<string, unknown>) : null;
        } else {
          (session as Record<string, unknown>).route = null;
        }
      }
      return session;
    },
    async create(args: { data: Record<string, unknown> }) {
      const keys = Object.keys(args.data);
      const values = Object.values(args.data);
      const placeholders = keys.map(() => "?").join(", ");
      const result = await libsql.execute({ sql: `INSERT INTO Session (${keys.join(", ")}) VALUES (${placeholders}) RETURNING *`, args: values });
      return toCamel(result.rows[0] as Record<string, unknown>);
    },
    async update(args: { where: { id: string }; data: Record<string, unknown> }) {
      const sets = Object.keys(args.data).map((k) => `${k} = ?`).join(", ");
      const values = Object.values(args.data);
      const result = await libsql.execute({ sql: `UPDATE Session SET ${sets} WHERE id = ? RETURNING *`, args: [...values, args.where.id] });
      return result.rows.length > 0 ? toCamel(result.rows[0] as Record<string, unknown>) : null;
    },
    async updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }) {
      const sets = Object.keys(args.data).map((k) => `${k} = ?`).join(", ");
      const values = Object.values(args.data);
      const conditions = Object.keys(args.where).map((k) => `${k} IN (SELECT value FROM json_each(?))`).join(" AND ");
      // Simple approach: use IN clause
      const ids = (args.where.id?.in || []) as string[];
      if (ids.length === 0) return { count: 0 };
      const placeholders = ids.map(() => "?").join(", ");
      const result = await libsql.execute({ sql: `UPDATE Session SET ${sets} WHERE id IN (${placeholders})`, args: [...values, ...ids] });
      return { count: result.rowsAffected };
    },
    async groupBy(args: { by: string[]; _count: boolean; where?: Record<string, unknown> }) {
      let sql = `SELECT ${args.by.join(", ")}, COUNT(*) as _count FROM Session WHERE deletedAt IS NULL`;
      const params: unknown[] = [];
      if (args.where?.deviceId?.contains) { sql += " AND deviceId LIKE ?"; params.push(`%${args.where.deviceId.contains}%`); }
      sql += ` GROUP BY ${args.by.join(", ")}`;
      const result = await libsql.execute({ sql, args: params });
      return result.rows.map(r => { const row = r as Record<string, unknown>; return { [args.by[0]]: row[args.by[0]], _count: Number(row._count) }; });
    },
  },
  gpsPoint: {
    async createMany(args: { data: Array<Record<string, unknown>> }) {
      for (const item of args.data) {
        const keys = Object.keys(item);
        const values = Object.values(item);
        const placeholders = keys.map(() => "?").join(", ");
        await libsql.execute({ sql: `INSERT INTO GpsPoint (${keys.join(", ")}) VALUES (${placeholders})`, args: values });
      }
      return { count: args.data.length };
    },
    async deleteMany(args: { where: Record<string, unknown> }) {
      const result = await libsql.execute({ sql: "DELETE FROM GpsPoint WHERE sessionId = ?", args: [args.where.sessionId] });
      return { count: result.rowsAffected };
    },
  },
  trafficJob: {
    async create(args: { data: Record<string, unknown> }) {
      const keys = Object.keys(args.data);
      const values = Object.values(args.data);
      const placeholders = keys.map(() => "?").join(", ");
      const result = await libsql.execute({ sql: `INSERT INTO TrafficJob (${keys.join(", ")}) VALUES (${placeholders}) RETURNING *`, args: values });
      return toCamel(result.rows[0] as Record<string, unknown>);
    },
    async update(args: { where: { id: string }; data: Record<string, unknown> }) {
      const sets = Object.keys(args.data).map((k) => `${k} = ?`).join(", ");
      const values = Object.values(args.data);
      const result = await libsql.execute({ sql: `UPDATE TrafficJob SET ${sets} WHERE id = ? RETURNING *`, args: [...values, args.where.id] });
      return result.rows.length > 0 ? toCamel(result.rows[0] as Record<string, unknown>) : null;
    },
    async count(args?: { where?: Record<string, unknown> }) {
      let sql = "SELECT COUNT(*) as count FROM TrafficJob";
      const params: unknown[] = [];
      if (args?.where?.status) { sql += " WHERE status = ?"; params.push(args.where.status); }
      const result = await libsql.execute({ sql, args: params });
      return Number((result.rows[0] as Record<string, unknown>).count);
    },
    async findMany(args?: { where?: Record<string, unknown>; orderBy?: Record<string, string>; take?: number; include?: Record<string, unknown> }) {
      const take = args?.take ?? 50;
      let sql = "SELECT * FROM TrafficJob";
      const params: unknown[] = [];
      if (args?.where?.status) { sql += " WHERE status = ?"; params.push(args.where.status); }
      sql += " ORDER BY createdAt DESC LIMIT ?";
      params.push(take);
      const result = await libsql.execute({ sql, args: params });
      const jobs = result.rows.map(r => toCamel(r as Record<string, unknown>));
      if (args?.include?.session) {
        for (const job of jobs) {
          const sResult = await libsql.execute({ sql: "SELECT deviceId, startTime FROM Session WHERE id = ?", args: [job.sessionId] });
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
      const result = await libsql.execute({ sql, args: params });
      return result.rows.map(r => { const row = r as Record<string, unknown>; return { [args.by[0]]: row[args.by[0]], _count: Number(row._count) }; });
    },
  },
  auditLog: {
    async create(args: { data: Record<string, unknown> }) {
      const keys = Object.keys(args.data);
      const values = Object.values(args.data);
      const placeholders = keys.map(() => "?").join(", ");
      await libsql.execute({ sql: `INSERT INTO AuditLog (${keys.join(", ")}) VALUES (${placeholders})`, args: values });
    },
    async findMany(args?: { where?: Record<string, unknown>; orderBy?: Record<string, string>; take?: number; cursor?: { id: string }; skip?: number }) {
      const take = args?.take ?? 50;
      const skip = args?.skip ?? (args?.cursor ? 1 : 0);
      let sql = "SELECT * FROM AuditLog";
      const params: unknown[] = [];
      const conditions: string[] = [];
      if (args?.where?.action?.contains) { conditions.push("action LIKE ?"); params.push(`%${args.where.action.contains}%`); }
      if (args?.where?.actorType) { conditions.push("actorType = ?"); params.push(args.where.actorType); }
      if (args?.where?.targetType) { conditions.push("targetType = ?"); params.push(args.where.targetType); }
      if (conditions.length > 0) sql += " WHERE " + conditions.join(" AND ");
      if (args?.cursor?.id) { sql += skip > 0 ? " AND id != ?" : " WHERE id != ?"; params.push(args.cursor.id); }
      sql += " ORDER BY createdAt DESC LIMIT ?";
      if (skip > 0) { sql += " OFFSET ?"; params.push(take, skip); } else { params.push(take); }
      const result = await libsql.execute({ sql, args: params });
      return result.rows.map(r => toCamel(r as Record<string, unknown>));
    },
    async deleteMany(args?: { where?: Record<string, unknown> }) {
      let sql = "DELETE FROM AuditLog";
      const params: unknown[] = [];
      if (args?.where?.createdAt?.lt) { sql += " WHERE createdAt < ?"; params.push(args.where.createdAt.lt); }
      const result = await libsql.execute({ sql, args: params });
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
      const keys = Object.keys(args.data);
      const values = Object.values(args.data);
      const placeholders = keys.map(() => "?").join(", ");
      const result = await libsql.execute({ sql: `INSERT INTO Route (${keys.join(", ")}) VALUES (${placeholders}) RETURNING *`, args: values });
      return toCamel(result.rows[0] as Record<string, unknown>);
    },
    async update(args: { where: { id: string }; data: Record<string, unknown> }) {
      const sets = Object.keys(args.data).map((k) => `${k} = ?`).join(", ");
      const values = Object.values(args.data);
      const result = await libsql.execute({ sql: `UPDATE Route SET ${sets} WHERE id = ? RETURNING *`, args: [...values, args.where.id] });
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
      const result = await libsql.execute({ sql: "SELECT * FROM RouteCache WHERE hash = ?", args: [args.where.hash] });
      return result.rows.length > 0 ? toCamel(result.rows[0] as Record<string, unknown>) : null;
    },
    async upsert(args: { where: { hash: string }; create: Record<string, unknown>; update: Record<string, unknown> }) {
      const createKeys = Object.keys(args.create);
      const createValues = Object.values(args.create);
      const updateKeys = Object.keys(args.update);
      const updateValues = Object.values(args.update);
      const placeholders = createKeys.map(() => "?").join(", ");
      const sets = updateKeys.map((k) => `${k} = ?`).join(", ");
      await libsql.execute({ sql: `INSERT INTO RouteCache (${createKeys.join(", ")}) VALUES (${placeholders}) ON CONFLICT(hash) DO UPDATE SET ${sets}`, args: [...createValues, ...updateValues] });
      const result = await libsql.execute({ sql: "SELECT * FROM RouteCache WHERE hash = ?", args: [args.where.hash] });
      return result.rows.length > 0 ? toCamel(result.rows[0] as Record<string, unknown>) : null;
    },
  },
  exportJob: {
    async findUnique(args: { where: { id: string }; include?: Record<string, unknown> }) {
      const result = await libsql.execute({ sql: "SELECT * FROM ExportJob WHERE id = ?", args: [args.where.id] });
      if (result.rows.length === 0) return null;
      const job = toCamel(result.rows[0] as Record<string, unknown>);
      if (args.include?.session?.include?.gpsPoints) {
        const pts = await libsql.execute({ sql: "SELECT * FROM GpsPoint WHERE sessionId = ? ORDER BY timestamp ASC", args: [job.sessionId] });
        const session = { gpsPoints: pts.rows.map(r => { const p = toCamel(r as Record<string, unknown>); p.timestamp = Number(p.timestamp); return p; }) };
        (job as Record<string, unknown>).session = session;
      }
      return job;
    },
    async create(args: { data: Record<string, unknown> }) {
      const keys = Object.keys(args.data);
      const values = Object.values(args.data);
      const placeholders = keys.map(() => "?").join(", ");
      const result = await libsql.execute({ sql: `INSERT INTO ExportJob (${keys.join(", ")}) VALUES (${placeholders}) RETURNING *`, args: values });
      return toCamel(result.rows[0] as Record<string, unknown>);
    },
  },
  backupJob: {
    async create(args: { data: Record<string, unknown> }) {
      const keys = Object.keys(args.data);
      const values = Object.values(args.data);
      const placeholders = keys.map(() => "?").join(", ");
      const result = await libsql.execute({ sql: `INSERT INTO BackupJob (${keys.join(", ")}) VALUES (${placeholders}) RETURNING *`, args: values });
      return toCamel(result.rows[0] as Record<string, unknown>);
    },
    async update(args: { where: { id: string }; data: Record<string, unknown> }) {
      const sets = Object.keys(args.data).map((k) => `${k} = ?`).join(", ");
      const values = Object.values(args.data);
      const result = await libsql.execute({ sql: `UPDATE BackupJob SET ${sets} WHERE id = ? RETURNING *`, args: [...values, args.where.id] });
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
    const result = await libsql.execute({ sql, args: values });
    return result.rows;
  },
  $transaction: async <T>(fn: (tx: typeof db) => Promise<T>): Promise<T> => {
    return fn(db);
  },
};
