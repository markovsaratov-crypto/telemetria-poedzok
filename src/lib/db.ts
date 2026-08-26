// src/lib/db.ts — Direct libsql client (no Prisma adapter issues)
// This completely bypasses Prisma's URL validation by using libsql directly.
// All queries go through libsql client, no Prisma engine involved.
import { createClient, type Client } from "@libsql/client";

const globalForDb = globalThis as unknown as {
  libsqlClient: Client | undefined;
};

function createDbClient(): Client {
  const url = process.env.DATABASE_URL || "";
  const authToken = process.env.TURSO_AUTH_TOKEN;

  // Turso connection
  if (url.startsWith("libsql://")) {
    return createClient({ url, authToken });
  }

  // Local SQLite
  return createClient({ url: url || "file:./db/custom.db" });
}

export const libsql = globalForDb.libsqlClient ?? createDbClient();

if (process.env.NODE_ENV !== "production") globalForDb.libsqlClient = libsql;

// Prisma-compatible API wrapper using libsql directly
export const db = {
  session: {
    async count(args?: { where?: Record<string, unknown> }) {
      let sql = "SELECT COUNT(*) as count FROM Session WHERE deletedAt IS NULL";
      const params: unknown[] = [];
      if (args?.where?.status) {
        sql += " AND status = ?";
        params.push(args.where.status);
      }
      const result = await libsql.execute({ sql, args: params });
      return Number((result.rows[0] as { count: number | bigint }).count);
    },
    async findMany(args?: {
      where?: Record<string, unknown>;
      orderBy?: Record<string, string>;
      take?: number;
      select?: Record<string, boolean>;
      include?: Record<string, unknown>;
      cursor?: { id: string };
      skip?: number;
    }) {
      const take = args?.take ?? 20;
      const skip = args?.skip ?? (args?.cursor ? 1 : 0);
      let sql = "SELECT * FROM Session WHERE deletedAt IS NULL";
      const params: unknown[] = [];
      if (args?.where?.deviceId) {
        sql += " AND deviceId LIKE ?";
        params.push(`%${args.where.deviceId}%`);
      }
      if (args?.where?.status) {
        sql += " AND status = ?";
        params.push(args.where.status);
      }
      if (args?.where?.routeId) {
        sql += " AND routeId = ?";
        params.push(args.where.routeId);
      }
      if (args?.cursor?.id) {
        sql += " AND id = ?";
        params.push(args.cursor.id);
      }
      sql += " ORDER BY startTime DESC LIMIT ? OFFSET ?";
      params.push(take, skip);
      const result = await libsql.execute({ sql, args: params });
      return result.rows;
    },
    async findUnique(args: { where: { id: string }; include?: Record<string, unknown> }) {
      const result = await libsql.execute({
        sql: "SELECT * FROM Session WHERE id = ? AND deletedAt IS NULL",
        args: [args.where.id],
      });
      return result.rows[0] || null;
    },
    async create(args: { data: Record<string, unknown> }) {
      const keys = Object.keys(args.data);
      const values = Object.values(args.data);
      const placeholders = keys.map(() => "?").join(", ");
      const result = await libsql.execute({
        sql: `INSERT INTO Session (${keys.join(", ")}) VALUES (${placeholders}) RETURNING *`,
        args: values,
      });
      return result.rows[0];
    },
    async update(args: { where: { id: string }; data: Record<string, unknown> }) {
      const sets = Object.keys(args.data).map((k) => `${k} = ?`).join(", ");
      const values = Object.values(args.data);
      const result = await libsql.execute({
        sql: `UPDATE Session SET ${sets} WHERE id = ? RETURNING *`,
        args: [...values, args.where.id],
      });
      return result.rows[0] || null;
    },
    async updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }) {
      const sets = Object.keys(args.data).map((k) => `${k} = ?`).join(", ");
      const values = Object.values(args.data);
      const conditions = Object.keys(args.where).map((k) => `${k} = ?`).join(" AND ");
      const whereValues = Object.values(args.where);
      const result = await libsql.execute({
        sql: `UPDATE Session SET ${sets} WHERE ${conditions}`,
        args: [...values, ...whereValues],
      });
      return { count: result.rowsAffected };
    },
  },
  gpsPoint: {
    async createMany(args: { data: Array<Record<string, unknown>> }) {
      for (const item of args.data) {
        const keys = Object.keys(item);
        const values = Object.values(item);
        const placeholders = keys.map(() => "?").join(", ");
        await libsql.execute({
          sql: `INSERT INTO GpsPoint (${keys.join(", ")}) VALUES (${placeholders})`,
          args: values,
        });
      }
      return { count: args.data.length };
    },
  },
  trafficJob: {
    async count(args?: { where?: Record<string, unknown> }) {
      let sql = "SELECT COUNT(*) as count FROM TrafficJob";
      const params: unknown[] = [];
      if (args?.where?.status) {
        sql += " WHERE status = ?";
        params.push(args.where.status);
      }
      const result = await libsql.execute({ sql, args: params });
      return Number((result.rows[0] as { count: number | bigint }).count);
    },
    async findMany(args?: { where?: Record<string, unknown>; orderBy?: Record<string, string>; take?: number; select?: Record<string, boolean> }) {
      const take = args?.take ?? 50;
      let sql = "SELECT * FROM TrafficJob";
      const params: unknown[] = [];
      if (args?.where?.status) {
        sql += " WHERE status = ?";
        params.push(args.where.status);
      }
      sql += " ORDER BY createdAt DESC LIMIT ?";
      params.push(take);
      const result = await libsql.execute({ sql, args: params });
      return result.rows;
    },
    async groupBy(args: { by: string[]; _count: boolean; where?: Record<string, unknown> }) {
      let sql = `SELECT ${args.by.join(", ")}, COUNT(*) as _count FROM TrafficJob`;
      const params: unknown[] = [];
      if (args.where?.status) {
        sql += " WHERE status = ?";
        params.push(args.where.status);
      }
      sql += ` GROUP BY ${args.by.join(", ")}`;
      const result = await libsql.execute({ sql, args: params });
      return result.rows.map((r) => ({ [args.by[0]]: (r as Record<string, unknown>)[args.by[0]], _count: Number((r as { _count: number | bigint })._count) }));
    },
  },
  auditLog: {
    async create(args: { data: Record<string, unknown> }) {
      const keys = Object.keys(args.data);
      const values = Object.values(args.data);
      const placeholders = keys.map(() => "?").join(", ");
      await libsql.execute({
        sql: `INSERT INTO AuditLog (${keys.join(", ")}) VALUES (${placeholders})`,
        args: values,
      });
    },
    async findMany(args?: { where?: Record<string, unknown>; orderBy?: Record<string, string>; take?: number; cursor?: { id: string }; skip?: number }) {
      const take = args?.take ?? 50;
      const skip = args?.skip ?? (args?.cursor ? 1 : 0);
      let sql = "SELECT * FROM AuditLog";
      const params: unknown[] = [];
      const conditions: string[] = [];
      if (args?.where?.action?.contains) {
        conditions.push("action LIKE ?");
        params.push(`%${args.where.action.contains}%`);
      }
      if (args?.where?.actorType) {
        conditions.push("actorType = ?");
        params.push(args.where.actorType);
      }
      if (args?.where?.targetType) {
        conditions.push("targetType = ?");
        params.push(args.where.targetType);
      }
      if (conditions.length > 0) {
        sql += " WHERE " + conditions.join(" AND ");
      }
      sql += " ORDER BY createdAt DESC LIMIT ? OFFSET ?";
      params.push(take, skip);
      const result = await libsql.execute({ sql, args: params });
      return result.rows;
    },
    async deleteMany(args?: { where?: Record<string, unknown> }) {
      let sql = "DELETE FROM AuditLog";
      const params: unknown[] = [];
      if (args?.where?.createdAt?.lt) {
        sql += " WHERE createdAt < ?";
        params.push(args.where.createdAt.lt);
      }
      const result = await libsql.execute({ sql, args: params });
      return { count: result.rowsAffected };
    },
  },
  route: {
    async findMany() {
      const result = await libsql.execute("SELECT * FROM Route ORDER BY createdAt DESC");
      return result.rows;
    },
    async findUnique(args: { where: { id: string } }) {
      const result = await libsql.execute({ sql: "SELECT * FROM Route WHERE id = ?", args: [args.where.id] });
      return result.rows[0] || null;
    },
    async create(args: { data: Record<string, unknown> }) {
      const keys = Object.keys(args.data);
      const values = Object.values(args.data);
      const placeholders = keys.map(() => "?").join(", ");
      const result = await libsql.execute({
        sql: `INSERT INTO Route (${keys.join(", ")}) VALUES (${placeholders}) RETURNING *`,
        args: values,
      });
      return result.rows[0];
    },
    async update(args: { where: { id: string }; data: Record<string, unknown> }) {
      const sets = Object.keys(args.data).map((k) => `${k} = ?`).join(", ");
      const values = Object.values(args.data);
      const result = await libsql.execute({
        sql: `UPDATE Route SET ${sets} WHERE id = ? RETURNING *`,
        args: [...values, args.where.id],
      });
      return result.rows[0] || null;
    },
    async delete(args: { where: { id: string } }) {
      await libsql.execute({ sql: "DELETE FROM Route WHERE id = ?", args: [args.where.id] });
    },
    async count() {
      const result = await libsql.execute("SELECT COUNT(*) as count FROM Route");
      return Number((result.rows[0] as { count: number | bigint }).count);
    },
  },
  routeCache: {
    async findUnique(args: { where: { hash: string } }) {
      const result = await libsql.execute({ sql: "SELECT * FROM RouteCache WHERE hash = ?", args: [args.where.hash] });
      return result.rows[0] || null;
    },
    async upsert(args: { where: { hash: string }; create: Record<string, unknown>; update: Record<string, unknown> }) {
      const createKeys = Object.keys(args.create);
      const createValues = Object.values(args.create);
      const updateKeys = Object.keys(args.update);
      const updateValues = Object.values(args.update);
      const placeholders = createKeys.map(() => "?").join(", ");
      const sets = updateKeys.map((k) => `${k} = ?`).join(", ");
      await libsql.execute({
        sql: `INSERT INTO RouteCache (${createKeys.join(", ")}) VALUES (${placeholders}) ON CONFLICT(hash) DO UPDATE SET ${sets}`,
        args: [...createValues, ...updateValues],
      });
      const result = await libsql.execute({ sql: "SELECT * FROM RouteCache WHERE hash = ?", args: [args.where.hash] });
      return result.rows[0];
    },
  },
  exportJob: {
    async findUnique(args: { where: { id: string }; include?: Record<string, unknown> }) {
      const result = await libsql.execute({ sql: "SELECT * FROM ExportJob WHERE id = ?", args: [args.where.id] });
      return result.rows[0] || null;
    },
    async create(args: { data: Record<string, unknown> }) {
      const keys = Object.keys(args.data);
      const values = Object.values(args.data);
      const placeholders = keys.map(() => "?").join(", ");
      const result = await libsql.execute({
        sql: `INSERT INTO ExportJob (${keys.join(", ")}) VALUES (${placeholders}) RETURNING *`,
        args: values,
      });
      return result.rows[0];
    },
  },
  backupJob: {
    async create(args: { data: Record<string, unknown> }) {
      const keys = Object.keys(args.data);
      const values = Object.values(args.data);
      const placeholders = keys.map(() => "?").join(", ");
      const result = await libsql.execute({
        sql: `INSERT INTO BackupJob (${keys.join(", ")}) VALUES (${placeholders}) RETURNING *`,
        args: values,
      });
      return result.rows[0];
    },
    async update(args: { where: { id: string }; data: Record<string, unknown> }) {
      const sets = Object.keys(args.data).map((k) => `${k} = ?`).join(", ");
      const values = Object.values(args.data);
      const result = await libsql.execute({
        sql: `UPDATE BackupJob SET ${sets} WHERE id = ? RETURNING *`,
        args: [...values, args.where.id],
      });
      return result.rows[0] || null;
    },
    async findMany(args?: { orderBy?: Record<string, string>; take?: number }) {
      const take = args?.take ?? 50;
      const result = await libsql.execute({ sql: "SELECT * FROM BackupJob ORDER BY createdAt DESC LIMIT ?", args: [take] });
      return result.rows;
    },
  },
  $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    let sql = strings[0];
    for (let i = 1; i < strings.length; i++) {
      sql += `?${strings[i]}`;
    }
    const result = await libsql.execute({ sql, args: values });
    return result.rows;
  },
  $transaction: async <T>(fn: (tx: typeof db) => Promise<T>): Promise<T> => {
    // Simple transaction wrapper - libsql doesn't support interactive transactions well
    return fn(db);
  },
};
