// src/lib/db.ts — Direct libsql client (production-grade, no Prisma engine)
// Uses @libsql/client directly for all database operations.
// Prisma is used only for type generation (schema.prisma).
//
// v2.9.10 (P0-фикс Render build failure): убран `import { randomUUID } from "crypto"`.
// Turbopack хардкодит Edge-вариант instrumentation.ts → worker-runtime.ts →
// settings.ts → db.ts, и любой Node.js crypto-импорт в db.ts ломает Edge-bundle
// ("Node.js module is loaded which is not supported in the Edge Runtime").
// Замена: глобальный Web Crypto API `crypto.randomUUID()` — стандартный Web API,
// доступен и в Node.js (>=14.18) и в Edge Runtime. Семантика идентична.
import { createClient, type Client, type InValue } from "@libsql/client";

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

// Helper to convert snake_case DB rows to camelCase objects.
// v2.16.0: экспортирована — worker-runtime.ts и db-обёртки используют единую реализацию.
export function toCamel(row: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    const camelKey = key.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    result[camelKey] = value;
  }
  return result;
}

// P1-10 → v2.9.4 fix: унификация временных аргументов SQL-фильтров.
// Дата-время в Session/ExportJob/BackupJob хранится как TEXT ISO-8601 UTC
// («2026-08-16T09:46:40.747Z»).
// v2.11.0 (АУДИТ C-4, эмпирически подтверждено): @libsql/client превращает
// аргумент-Date в ЧИСЛО epoch-ms (typeof REAL), а НЕ в ISO-строку — комментарий
// «libsql сериализует Date в ISO» был ложным. 11 писателей дат писали числа →
// в SQLite integer < text → фильтры startTime >= ?/deletedAt < ? молча
// теряли строки (prod: 13/36 сессий с числовым startTime, deletedAt-числа).
// Решение: normVal() — ЛЮБОЙ Date в аргументах дамп-обёрток → ISO-строка.
// NB: GpsPoint.timestamp — INTEGER ms (BigInt) и не проходит через normVal (не Date).
function normVal(v: unknown): unknown {
  return v instanceof Date ? v.toISOString() : v;
}
function normVals(vals: unknown[]): unknown[] {
  return vals.map(normVal);
}
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

// v2.16.0 (D-2): ЕДИНЫЕ строители INSERT/UPDATE для всех моделей. До этого
// один и тот же 8-строчный блок копировался 8+ раз (session/trafficJob/auditLog/
// route/exportJob/backupJob + три копии в tx-прокси) с расползанием правок —
// классический источник «починил в одном месте, сломал в другом».
interface TableStamps { createdAt: boolean; updatedAt: boolean }
const TABLE_STAMPS: Record<string, TableStamps> = {
  Session: { createdAt: true, updatedAt: true },
  TrafficJob: { createdAt: true, updatedAt: true },
  Route: { createdAt: true, updatedAt: true },
  RouteCache: { createdAt: true, updatedAt: false },
  AuditLog: { createdAt: true, updatedAt: false },
  // v2.16.0 (B-3): у ExportJob НЕТ колонки updatedAt — tx-прокси раньше писал её
  // и INSERT в транзакции падал «no such column».
  ExportJob: { createdAt: true, updatedAt: false },
  BackupJob: { createdAt: true, updatedAt: false },
  // v2.18.0 (P0): GpsPoint отсутствовал в реестре с рефакторинга v2.16.0 (D-2) —
  // tx-прокси бросал «таблица GpsPoint не поддерживается в транзакции», и ВСЕ
  // транзакционные вставки точек падали: /api/ingest (500 на каждой новой сессии),
  // CSV-импорт (200, но 0 импортированных — всё в errors[]), ZIP-импорт (500).
  // Прод выживал только потому, что SensorLogger шлёт в /api/ingest/sensorlogger
  // (сырой SQL, не через $transaction). У GpsPoint нет createdAt/updatedAt — штампы не нужны.
  GpsPoint: { createdAt: false, updatedAt: false },
};

function buildInsert(table: string, data: Record<string, unknown>): { sql: string; args: InValue[] } {
  const stamps = TABLE_STAMPS[table] ?? { createdAt: false, updatedAt: false };
  const now = new Date().toISOString();
  const full: Record<string, unknown> = {
    id: crypto.randomUUID(),
    ...(stamps.createdAt ? { createdAt: now } : {}),
    ...(stamps.updatedAt ? { updatedAt: now } : {}),
    ...pruneUndefined(data),
  };
  const keys = Object.keys(full);
  const values = normVals(Object.values(full));
  const placeholders = keys.map(() => "?").join(", ");
  return { sql: `INSERT INTO ${table} (${keys.join(", ")}) VALUES (${placeholders}) RETURNING *`, args: values as InValue[] };
}

function buildUpdate(table: string, data: Record<string, unknown>, whereSql: string, whereArgs: unknown[]): { sql: string; args: InValue[] } {
  const stamps = TABLE_STAMPS[table] ?? { createdAt: false, updatedAt: false };
  const full = pruneUndefined(data);
  if (stamps.updatedAt) full.updatedAt = new Date().toISOString();
  const keys = Object.keys(full);
  const sets = keys.map((k) => `${k} = ?`).join(", ");
  const values = normVals([...Object.values(full), ...whereArgs]);
  return { sql: `UPDATE ${table} SET ${sets} WHERE ${whereSql} RETURNING *`, args: values as InValue[] };
}

async function insertRow(table: string, data: Record<string, unknown>): Promise<Record<string, unknown>> {
  const q = buildInsert(table, data);
  const result = await libsql.execute(q);
  return toCamel(result.rows[0] as Record<string, unknown>);
}

async function updateRowById(table: string, id: string, data: Record<string, unknown>): Promise<Record<string, unknown> | null> {
  const q = buildUpdate(table, data, "id = ?", [id]);
  const result = await libsql.execute(q);
  return result.rows.length > 0 ? toCamel(result.rows[0] as Record<string, unknown>) : null;
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
      const st = (args?.where?.startTime as { gte?: Date | number; lt?: Date | number } | undefined);
      if (st?.gte != null) { sql += " AND startTime >= ?"; params.push(toTs(st.gte)); }
      if (st?.lt != null) { sql += " AND startTime < ?"; params.push(toTs(st.lt)); }
      const result = await libsql.execute({ sql, args: params as InValue[] });
      return Number((result.rows[0] as Record<string, unknown>).count);
    },
    // v2.11.0 (АУДИТ C-2/C-5/C-6/C-7/C-21): ЕДИНСТВЕННАЯ реализация findMany.
    // Раньше их было ДВЕ и вторая (bottom override) молча затирала первую:
    // дропались deletedAt:{lt}/purgedAt (retention grace), OR (поиск), тэки.
    // Здесь: keyset-пагинация вместо «id != cursor + OFFSET 1» (страница 2
    // возвращала 19 уже видимых строк), scalar deviceId → точное =, а не
    // LIKE %…% (C-21: подстрока/подстановки ломали семантику фильтра),
    // take без значения → без LIMIT (hard cap 5000 от OOM), OR-условия поиска.
    async findMany(args?: {
      where?: Record<string, unknown>;
      orderBy?: Record<string, string>;
      take?: number;
      cursor?: { id: string };
      skip?: number;
      include?: Record<string, unknown>;
      select?: Record<string, unknown>;
    }) {
      const HARD_CAP = 5000;
      const take = Math.min(args?.take ?? HARD_CAP, HARD_CAP);
      const w = args?.where || {};
      const conditions: string[] = [];
      const params: unknown[] = [];

      // deviceId: scalar → ТОЧНОЕ совпадение (C-21); {contains} → LIKE с ESCAPE
      // v2.18.0: LOWER(...) LIKE LOWER(?) — как в OR-ветках поиска (v2.16.0):
      // голый LIKE в SQLite регистронезависим только для ASCII, фильтр по
      // кириллическому deviceId вёл себя иначе, чем поиск
      const devId = w.deviceId as { contains?: string } | string | undefined;
      if (devId && typeof devId === "object" && devId.contains != null) {
        conditions.push("LOWER(deviceId) LIKE ? ESCAPE '\\'");
        params.push(`%${String(devId.contains).toLowerCase().replace(/[\\%_]/g, (m) => "\\" + m)}%`);
      } else if (typeof devId === "string" && devId) {
        conditions.push("deviceId = ?");
        params.push(devId);
      }
      // id: scalar | {in}
      const idIn = (w.id as { in?: string[] } | undefined)?.in;
      if (Array.isArray(idIn)) {
        if (idIn.length === 0) return [];
        conditions.push(`id IN (${idIn.map(() => "?").join(", ")})`);
        params.push(...idIn);
      } else if (typeof w.id === "string") {
        conditions.push("id = ?");
        params.push(w.id);
      }
      if (typeof w.status === "string") { conditions.push("status = ?"); params.push(w.status); }
      if (typeof w.routeId === "string") { conditions.push("routeId = ?"); params.push(w.routeId); }
      // текстовые колонки: null | {not: null} (поиск/теги)
      for (const col of ["notes", "tags", "deviceName"] as const) {
        const v = w[col];
        if (v === null) { conditions.push(`${col} IS NULL`); }
        else if (v && typeof v === "object" && (v as { not?: unknown }).not === null) {
          conditions.push(`${col} IS NOT NULL`);
        } else if (typeof v === "string") { conditions.push(`${col} = ?`); params.push(v); }
      }
      // startTime/endTime: gte/lt/gt (ISO-строки через toTs)
      const stW = w.startTime as { gte?: Date | number; lt?: Date | number } | undefined;
      if (stW?.gte != null) { conditions.push("startTime >= ?"); params.push(toTs(stW.gte)); }
      if (stW?.lt != null) { conditions.push("startTime < ?"); params.push(toTs(stW.lt)); }
      const etW = w.endTime as { lt?: Date | number; gt?: Date | number; gte?: Date | number } | undefined;
      if (etW?.lt != null) { conditions.push("endTime < ?"); params.push(toTs(etW.lt)); }
      if (etW?.gt != null) { conditions.push("endTime > ?"); params.push(toTs(etW.gt)); }
      if (etW?.gte != null) { conditions.push("endTime >= ?"); params.push(toTs(etW.gte)); }
      // deletedAt: null (базовый WHERE) | {not:null} | {lt, not:null} — retention grace
      if (w.deletedAt === null) { /* базовый фильтр WHERE deletedAt IS NULL */ }
      else if (w.deletedAt && typeof w.deletedAt === "object") {
        const da = w.deletedAt as { lt?: Date | number; not?: unknown };
        if (da.lt != null) { conditions.push("deletedAt IS NOT NULL AND deletedAt < ?"); params.push(toTs(da.lt)); }
        else if (da.not != null) { conditions.push("deletedAt IS NOT NULL"); }
      }
      // purgedAt: null | {lt} | {not: null} — фильтруется ТОЛЬКО когда явно передан
      const pa = w.purgedAt as null | { lt?: Date | number; not?: unknown } | undefined;
      if (pa !== undefined) {
        if (pa === null) conditions.push("purgedAt IS NULL");
        else if (pa && typeof pa === "object") {
          if ((pa as { lt?: Date | number }).lt != null) { conditions.push("purgedAt < ?"); params.push(toTs((pa as { lt: Date | number }).lt)); }
          else if ((pa as { not?: unknown }).not != null) conditions.push("purgedAt IS NOT NULL");
        }
      }
      // OR: массив {col: {contains}} — глобальный поиск (C-6: раньше молча игнорировался).
      // v2.16.0: LOWER(col) LIKE LOWER(?) — регистронезависимо и для КИРИЛЛИЦЫ
      // (голый LIKE в SQLite регистронезависим только для ASCII: «работа» ≠ «Работа»)
      const or = w.OR as Array<Record<string, { contains?: string }>> | undefined;
      if (Array.isArray(or) && or.length > 0) {
        const orConds: string[] = [];
        for (const branch of or) {
          for (const [col, val] of Object.entries(branch)) {
            if (val && typeof val === "object" && val.contains != null && ["deviceId", "deviceName", "notes", "tags"].includes(col)) {
              orConds.push(`LOWER(${col}) LIKE ? ESCAPE '\\'`);
              params.push(`%${String(val.contains).toLowerCase().replace(/[\\%_]/g, (m) => "\\" + m)}%`);
            }
          }
        }
        if (orConds.length > 0) conditions.push(`(${orConds.join(" OR ")})`);
      }

      // Курсорная пагинация: keyset по (startTime, id) — эмуляция Prisma cursor+skip:1.
      // C-5: старая схема «id != cursor + OFFSET 1» выдавала страницу 2 из уже видимых строк.
      // v2.18.0 (P1): Prisma-семантика cursor = «начать строго ПОСЛЕ курсора».
      // Keyset-предикат (startTime < ? OR (= AND id < ?)) УЖЕ исключает курсор и всё до него
      // → наложение OFFSET поверх него (skip:1 от роута) выбрасывало ПЕРВУЮ строку
      // после курсора — страница 2 молча теряла одну сессию. Теперь при активном
      // keyset args.skip ИГНОРИРУЕТСЯ; OFFSET работает только для безкурсорного skip.
      let cursorSkip = 0;
      let keysetActive = false;
      if (args?.cursor?.id) {
        const cur = await libsql.execute({
          sql: "SELECT startTime FROM Session WHERE id = ? LIMIT 1",
          args: [args.cursor.id],
        });
        if (cur.rows.length > 0) {
          const curStart = String((cur.rows[0] as Record<string, unknown>).startTime);
          conditions.push("(startTime < ? OR (startTime = ? AND id < ?))");
          params.push(curStart, curStart, args.cursor.id);
          keysetActive = true;
        } else {
          // Курсор удалён (soft-delete) — повторяем страницу с начала: безопаснее,
          // чем терять строку; клиент увидит уже виденные записи и пересчитает курсор.
          conditions.push("id != ?");
          params.push(args.cursor.id);
        }
      }
      const skip = keysetActive ? 0 : (args?.skip ?? cursorSkip);

      let sql = "SELECT * FROM Session WHERE deletedAt IS NULL";
      if (conditions.length > 0) sql += " AND " + conditions.join(" AND ");
      const order = args?.orderBy?.startTime === "asc" ? "ASC" : "DESC";
      sql += ` ORDER BY startTime ${order}, id ${order} LIMIT ?`;
      if (skip > 0) { sql += " OFFSET ?"; params.push(take, skip); } else { params.push(take); }

      const result = await libsql.execute({ sql, args: params as InValue[] });
      const rows = result.rows.map(r => toCamel(r as Record<string, unknown>));
      // select: скалярные поля + вложенные gpsPoints/route (P0-2)
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
      // include: gpsPoints / trafficJobs / route
      // v2.16.0 (B-2): исправлен no-op — раньше результат projectSession ВЫБРАСЫВАЛСЯ
      // (`await projectSession(row, ...)` без присваивания), т.е. include в findMany
      // молча не работал и возвращал только скаляры. Теперь строки проектируются.
      if (args?.include) {
        const out: Record<string, unknown>[] = [];
        for (const row of rows) {
          out.push(await projectSession(row, undefined, args.include));
        }
        return out;
      }
      return rows;
    },
    // P1-10: aggregate (_sum/_count) — ЕДИНСТВЕННАЯ реализация (v2.16.0: мёртвый
    // литеральный дубль внизу файла, затираемый (db as any)-патчем, удалён;
    // сигнатура — как у живого патча: _sum.payloadBytes/_sum.pointCount/_count.id)
    async aggregate(args: { _sum?: { payloadBytes?: boolean; pointCount?: boolean }; _count?: { id?: boolean }; where?: { status?: string } }) {
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
      return insertRow("Session", args.data);
    },
    async update(args: { where: { id: string }; data: Record<string, unknown> }) {
      return updateRowById("Session", args.where.id, args.data);
    },
    async updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }) {
      const sets = Object.keys(args.data).map((k) => `${k} = ?`).join(", ");
      const values = normVals(Object.values(args.data));
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
    async groupBy(args: { by: string[]; _count: boolean; where?: { deviceId?: { contains?: string } } }) {
      // v2.16.0: единственная реализация (ORDER BY _count DESC — как у живого патча;
      // мёртвый литеральный дубль без сортировки удалён)
      let sql = `SELECT ${args.by.join(", ")}, COUNT(*) as _count FROM Session WHERE deletedAt IS NULL`;
      const params: unknown[] = [];
      const gbDev = args.where?.deviceId;
      if (gbDev?.contains) { sql += " AND deviceId LIKE ?"; params.push(`%${gbDev.contains}%`); }
      sql += ` GROUP BY ${args.by.join(", ")} ORDER BY _count DESC`;
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
    // v2.16.0: count — полноценный метод литерала (v2.12.0 D-1: точки только ЖИВЫХ
    // сессий; раньше был (db as any)-патч внизу файла)
    async count(args?: { where?: { sessionId?: string; session?: { deletedAt?: null } } }) {
      let sql = "SELECT COUNT(*) as count FROM GpsPoint";
      const params: unknown[] = [];
      const w = args?.where ?? {};
      if (w.sessionId != null) {
        sql += " WHERE sessionId = ?";
        params.push(w.sessionId);
        if (w.session?.deletedAt === null) {
          sql += " AND sessionId IN (SELECT id FROM Session WHERE deletedAt IS NULL)";
        }
      } else if (w.session?.deletedAt === null) {
        sql += " WHERE sessionId IN (SELECT id FROM Session WHERE deletedAt IS NULL)";
      }
      const result = await libsql.execute({ sql, args: params as InValue[] });
      return Number((result.rows[0] as Record<string, unknown>).count);
    },
    // v2.11.0 (АУДИТ C-16): было по одному INSERT на строку (последовательные
    // HTTPS-раундтрипы к Turso ~50-100 мс каждый; 100 точек ≈ 5-10 с).
    // Теперь — многорядный INSERT чанками по 50 строк (450 плейсхолдеров <
    // лимита SQLite 999 переменных).
    async createMany(args: { data: Array<Record<string, unknown>> }) {
      const items = args.data.map((item) => ({ id: crypto.randomUUID(), ...pruneUndefined(item) }));
      if (items.length === 0) return { count: 0 };
      // Колонки — по ключам первой строки; отсутствующие в остальных → NULL
      const cols = Object.keys(items[0]);
      const rows = items.map((item) => normVals(cols.map((c) => (item[c] === undefined ? null : item[c]))));
      const ph = `(${cols.map(() => "?").join(", ")})`;
      const CH = Math.max(1, Math.floor(900 / cols.length)); // < 999 переменных SQLite
      for (let i = 0; i < rows.length; i += CH) {
        const chunk = rows.slice(i, i + CH);
        const placeholders = chunk.map(() => ph).join(", ");
        await libsql.execute({
          sql: `INSERT INTO GpsPoint (${cols.join(", ")}) VALUES ${placeholders}`,
          args: chunk.flat() as InValue[],
        });
      }
      return { count: rows.length };
    },
    async deleteMany(args: { where: Record<string, unknown> }) {
      const result = await libsql.execute({ sql: "DELETE FROM GpsPoint WHERE sessionId = ?", args: [args.where.sessionId] as InValue[] });
      return { count: result.rowsAffected };
    },
  },
  trafficJob: {
    // v2.16.0: findUnique — полноценный метод литерала (был (db as any)-патч)
    async findUnique(args: { where: { id: string } }) {
      const result = await libsql.execute({ sql: "SELECT * FROM TrafficJob WHERE id = ?", args: [args.where.id] });
      return result.rows.length > 0 ? toCamel(result.rows[0] as Record<string, unknown>) : null;
    },
    async create(args: { data: Record<string, unknown> }) {
      return insertRow("TrafficJob", args.data);
    },
    async update(args: { where: { id: string }; data: Record<string, unknown> }) {
      return updateRowById("TrafficJob", args.where.id, args.data);
    },
    async count(args?: { where?: Record<string, unknown> }) {
      let sql = "SELECT COUNT(*) as count FROM TrafficJob";
      const params: unknown[] = [];
      if (args?.where?.status) { sql += " WHERE status = ?"; params.push(args.where.status); }
      const result = await libsql.execute({ sql, args: params as InValue[] });
      return Number((result.rows[0] as Record<string, unknown>).count);
    },
    // v2.11.0 (АУДИТ C-8): id:{in} теперь поддержан (раньше молча игнорировался —
    // worker/poll получал последние 50 джобов вместо захваченных); include.session
    // умеет gpsPoints (раньше джоб падал 500 на j.session.gpsPoints.map).
    async findMany(args?: { where?: Record<string, unknown>; orderBy?: Record<string, string>; take?: number; include?: Record<string, unknown> }) {
      const take = args?.take ?? 50;
      const conditions: string[] = [];
      const params: unknown[] = [];
      if (typeof args?.where?.status === "string") { conditions.push("status = ?"); params.push(args.where.status); }
      const idIn = (args?.where?.id as { in?: string[] } | undefined)?.in;
      if (Array.isArray(idIn)) {
        if (idIn.length === 0) return [];
        conditions.push(`id IN (${idIn.map(() => "?").join(", ")})`);
        params.push(...idIn);
      }
      let sql = "SELECT * FROM TrafficJob";
      if (conditions.length > 0) sql += " WHERE " + conditions.join(" AND ");
      sql += " ORDER BY createdAt DESC LIMIT ?";
      params.push(take);
      const result = await libsql.execute({ sql, args: params as InValue[] });
      const jobs = result.rows.map(r => toCamel(r as Record<string, unknown>));
      if (args?.include?.session) {
        const wantPoints = !!(args.include.session as { select?: { gpsPoints?: unknown } }).select?.gpsPoints;
        for (const job of jobs) {
          const sResult = await libsql.execute({ sql: "SELECT * FROM Session WHERE id = ?", args: [job.sessionId as InValue] });
          if (sResult.rows.length > 0) {
            const session = toCamel(sResult.rows[0] as Record<string, unknown>);
            if (wantPoints) {
              const pts = await libsql.execute({ sql: "SELECT lat, lon, speed, altitude, accuracy, bearing, timestamp FROM GpsPoint WHERE sessionId = ? ORDER BY timestamp ASC", args: [job.sessionId as InValue] });
              session.gpsPoints = pts.rows.map(r => { const p = toCamel(r as Record<string, unknown>); p.timestamp = Number(p.timestamp); return p; });
            } else {
              delete session.gpsPoints;
            }
            job.session = session;
          }
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
      // v2.16.0: AuditLog — только createdAt, без updatedAt (единая таблица штампов)
      const stamps = TABLE_STAMPS["AuditLog"]!;
      const now = new Date().toISOString();
      const data = { id: crypto.randomUUID(), ...(stamps.createdAt ? { createdAt: now } : {}), ...pruneUndefined(args.data) };
      const keys = Object.keys(data);
      const values = normVals(Object.values(data));
      const placeholders = keys.map(() => "?").join(", ");
      await libsql.execute({ sql: `INSERT INTO AuditLog (${keys.join(", ")}) VALUES (${placeholders})`, args: values as InValue[] });
    },
    // v2.11.0 (АУДИТ C-5): keyset-пагинация по (createdAt, id) вместо
    // «id != cursor + OFFSET 1» — страница 2 возвращала уже виденные строки.
    async findMany(args?: { where?: Record<string, unknown>; orderBy?: Record<string, string>; take?: number; cursor?: { id: string }; skip?: number }) {
      const take = args?.take ?? 50;
      const conditions: string[] = [];
      const params: unknown[] = [];
      const actContains = (args?.where?.action as { contains?: string } | undefined)?.contains;
      if (actContains) { conditions.push("action LIKE ? ESCAPE '\\\'"); params.push(`%${actContains.replace(/[\\%_]/g, (m) => "\\" + m)}%`); }
      if (args?.where?.actorType) { conditions.push("actorType = ?"); params.push(args.where.actorType); }
      if (args?.where?.targetType) { conditions.push("targetType = ?"); params.push(args.where.targetType); }
      let cursorSkip = 0;
      if (args?.cursor?.id) {
        const cur = await libsql.execute({ sql: "SELECT createdAt FROM AuditLog WHERE id = ? LIMIT 1", args: [args.cursor.id] });
        if (cur.rows.length > 0) {
          const curCreated = String((cur.rows[0] as Record<string, unknown>).createdAt);
          conditions.push("(createdAt < ? OR (createdAt = ? AND id < ?))");
          params.push(curCreated, curCreated, args.cursor.id);
        } else {
          cursorSkip = 1;
          conditions.push("id != ?");
          params.push(args.cursor.id);
        }
      }
      const skip = args?.skip ?? cursorSkip;
      let sql = "SELECT * FROM AuditLog";
      if (conditions.length > 0) sql += " WHERE " + conditions.join(" AND ");
      sql += " ORDER BY createdAt DESC, id DESC LIMIT ?";
      if (skip > 0) { sql += " OFFSET ?"; params.push(take, skip); } else { params.push(take); }
      const result = await libsql.execute({ sql, args: params as InValue[] });
      return result.rows.map(r => toCamel(r as Record<string, unknown>));
    },
    // v2.11.0 (АУДИТ C-23): deleteMany без условий — защита аудиторского следа
    // (одно неверное обновление вызова — и DELETE FROM AuditLog стирает всё).
    async deleteMany(args?: { where?: Record<string, unknown> }) {
      let sql = "DELETE FROM AuditLog";
      const params: unknown[] = [];
      const createdLt = (args?.where?.createdAt as { lt?: Date | number } | undefined)?.lt;
      if (createdLt != null) { sql += " WHERE createdAt < ?"; params.push(toTs(createdLt)); }
      else { return { count: 0 }; } // guard: пустое where → отказ (в отличие от Prisma)
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
      return insertRow("Route", args.data);
    },
    async update(args: { where: { id: string }; data: Record<string, unknown> }) {
      return updateRowById("Route", args.where.id, args.data);
    },
    async delete(args: { where: { id: string } }) {
      await libsql.execute({ sql: "DELETE FROM Route WHERE id = ?", args: [args.where.id] });
    },
    async count() {
      const result = await libsql.execute("SELECT COUNT(*) as count FROM Route");
      return Number((result.rows[0] as Record<string, unknown>).count);
    },
  },
  // v2.18.0: db.routeCache УДАЛЁН — обёртку использовал только мёртвый src/lib/cache.ts
  // (0 importers; двухуровневый кэш маршрутизации §3.2 из спеки в рантайме
  // не существовал). Таблица RouteCache остаётся в схеме/бэкапах/restore.

  exportJob: {
    async findUnique(args: { where: { id: string }; include?: Record<string, unknown> }) {
      const result = await libsql.execute({ sql: "SELECT * FROM ExportJob WHERE id = ?", args: [args.where.id] });
      if (result.rows.length === 0) return null;
      const job = toCamel(result.rows[0] as Record<string, unknown>);
      // v2.16.0 (QA-фикс): include.session.gpsPoints раньше собирал session ТОЛЬКО
      // с полем gpsPoints (без id/startTime/deviceId/…) — download-роут падал 500
      // на generateExport. Теперь грузится полная строка Session + точки.
      if ((args.include?.session as { include?: { gpsPoints?: boolean } } | undefined)?.include?.gpsPoints) {
        const sRes = await libsql.execute({ sql: "SELECT * FROM Session WHERE id = ?", args: [job.sessionId as InValue] });
        if (sRes.rows.length > 0) {
          const session = toCamel(sRes.rows[0] as Record<string, unknown>);
          const pts = await libsql.execute({ sql: "SELECT * FROM GpsPoint WHERE sessionId = ? ORDER BY timestamp ASC", args: [job.sessionId as InValue] });
          session.gpsPoints = pts.rows.map(r => { const p = toCamel(r as Record<string, unknown>); p.timestamp = Number(p.timestamp); return p; });
          (job as Record<string, unknown>).session = session;
        }
      }
      return job;
    },
    async create(args: { data: Record<string, unknown> }) {
      return insertRow("ExportJob", args.data);
    },
  },
  backupJob: {
    // v2.16.0: findUnique — полноценный метод литерала (был (db as any)-патч)
    async findUnique(args: { where: { id: string } }) {
      const result = await libsql.execute({ sql: "SELECT * FROM BackupJob WHERE id = ?", args: [args.where.id] });
      return result.rows.length > 0 ? toCamel(result.rows[0] as Record<string, unknown>) : null;
    },
    async create(args: { data: Record<string, unknown> }) {
      return insertRow("BackupJob", args.data);
    },
    async update(args: { where: { id: string }; data: Record<string, unknown> }) {
      return updateRowById("BackupJob", args.where.id, args.data);
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
  // v2.18.0 (типизация): раньше параметр fn типизировался как `typeof db` —
  // циклическая ссылка объекта на собственный тип в собственном инициализаторе
  // → TS7022 («db implicitly has type any»), спрятанная noImplicitAny:false.
  // Весь db-слой был нетипизирован: лишние/неверно набранные аргументы вызовов
  // (напр. select в trafficJob.findMany) проходили молча. Теперь — отдельный
  // интерфейс DbTx: db получает честный выведенный тип, компилятор снова видит формы.
  $transaction: async <T>(fn: (tx: DbTx) => Promise<T>): Promise<T> => {
    const txClient = await libsql.transaction("write");
    try {
      const out = await fn(makeTxExecutor(txClient) as unknown as DbTx);
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

// Таблицы, доступные внутри $transaction (v2.16.0: TableStamps вместо дубля
// «updatedAt: boolean» — единственный источник штампов колонок; ExportJob без
// updatedAt, как в схеме)
type LibsqlTransaction = Awaited<ReturnType<Client["transaction"]>>;

// v2.18.0: тип транзакционного исполнителя — строго create/createMany/update
// по каждой известной таблице (замена `typeof db`, порождавшего TS7022).
interface TxModelApi {
  create(args: { data: Record<string, unknown> }): Promise<Record<string, unknown>>;
  createMany(args: { data: Array<Record<string, unknown>> }): Promise<{ count: number }>;
  update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<Record<string, unknown> | null>;
}
export interface DbTx {
  session: TxModelApi;
  gpsPoint: TxModelApi;
  trafficJob: TxModelApi;
  route: TxModelApi;
  routeCache: TxModelApi;
  auditLog: TxModelApi;
  exportJob: TxModelApi;
  backupJob: TxModelApi;
}

// Транзакционный исполнитель: session.create / gpsPoint.createMany и т.п.,
// но каждый execute идёт через tx (одна атомарная единица работы).
// v2.16.0: строители SQL — те же TABLE_STAMPS/buildInsert, что и вне транзакции.
function makeTxExecutor(tx: LibsqlTransaction): Record<string, unknown> {
  return new Proxy({}, {
    get(_target, modelRaw: string | symbol) {
      const model = String(modelRaw);
      const table = model.charAt(0).toUpperCase() + model.slice(1);
      const stamps = TABLE_STAMPS[table];
      const requireStamps = (op: string) => {
        if (!stamps) throw new Error(`tx.${model}.${op}: таблица ${table} не поддерживается в транзакции`);
        return stamps;
      };
      return {
        async create(args: { data: Record<string, unknown> }) {
          const s = requireStamps("create");
          const now = new Date().toISOString();
          const data = {
            id: crypto.randomUUID(),
            ...(s.createdAt ? { createdAt: now } : {}),
            ...(s.updatedAt ? { updatedAt: now } : {}),
            ...pruneUndefined(args.data),
          };
          const keys = Object.keys(data);
          const values = normVals(Object.values(data));
          const placeholders = keys.map(() => "?").join(", ");
          const result = await tx.execute({ sql: `INSERT INTO ${table} (${keys.join(", ")}) VALUES (${placeholders}) RETURNING *`, args: values as InValue[] });
          return toCamel(result.rows[0] as Record<string, unknown>);
        },
        async createMany(args: { data: Array<Record<string, unknown>> }) {
          // v2.16.0: чанки по <999 плейсхолдеров — как в НЕ-транзакционном
          // createMany (раньше тут была ПОСТРОЧНАЯ вставка: 1000 точек = 1000
          // последовательных execute внутри транзакции)
          requireStamps("createMany");
          if (args.data.length === 0) return { count: 0 };
          const items = args.data.map((item) => ({ id: crypto.randomUUID(), ...pruneUndefined(item) }));
          const cols = Object.keys(items[0]);
          const ph = `(${cols.map(() => "?").join(", ")})`;
          const CH = Math.max(1, Math.floor(900 / cols.length));
          let count = 0;
          for (let i = 0; i < items.length; i += CH) {
            const chunk = items.slice(i, i + CH);
            const placeholders = chunk.map(() => ph).join(", ");
            const rows = chunk.map((item) => normVals(cols.map((c) => (item[c] === undefined ? null : item[c]))));
            await tx.execute({ sql: `INSERT INTO ${table} (${cols.join(", ")}) VALUES ${placeholders}`, args: rows.flat() as InValue[] });
            count += chunk.length;
          }
          return { count };
        },
        async update(args: { where: { id: string }; data: Record<string, unknown> }) {
          const s = requireStamps("update");
          const data: Record<string, unknown> = { ...pruneUndefined(args.data) };
          if (s.updatedAt) data.updatedAt = new Date().toISOString();
          const keys = Object.keys(data);
          if (keys.length === 0) return null;
          const setSql = keys.map((k) => `${k} = ?`).join(", ");
          const values = normVals([...Object.values(data), args.where.id]);
          const result = await tx.execute({ sql: `UPDATE ${table} SET ${setSql} WHERE id = ? RETURNING *`, args: values as InValue[] });
          return result.rows.length > 0 ? toCamel(result.rows[0] as Record<string, unknown>) : null;
        },
      };
    },
  });
}
