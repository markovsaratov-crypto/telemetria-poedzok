// GET /api/debug — диагностика DB соединения (временный endpoint)
import { NextRequest } from "next/server";
import { createClient } from "@libsql/client";

export async function GET(request: NextRequest) {
  const result: Record<string, unknown> = {};

  // 1. Check env vars
  result.databaseUrl = process.env.DATABASE_URL?.slice(0, 30) + "..." || "NOT SET";
  result.tursoToken = process.env.TURSO_AUTH_TOKEN?.slice(0, 20) + "..." || "NOT SET";
  result.nodeEnv = process.env.NODE_ENV;
  result.port = process.env.PORT;

  // 2. Test direct libsql connection
  try {
    const url = process.env.DATABASE_URL || "";
    const authToken = process.env.TURSO_AUTH_TOKEN;
    const client = createClient({ url, authToken });
    const res = await client.execute("SELECT name FROM sqlite_master WHERE type='table' LIMIT 5");
    result.libsqlTables = res.rows.map((r) => (r as { name: string }).name);
    result.libsqlStatus = "OK";
  } catch (e) {
    result.libsqlStatus = "ERROR";
    result.libsqlError = e instanceof Error ? e.message : String(e);
  }

  // 3. Test Prisma connection
  try {
    const { db } = await import("@/lib/db");
    const count = await db.session.count();
    result.prismaCount = count;
    result.prismaStatus = "OK";
  } catch (e) {
    result.prismaStatus = "ERROR";
    result.prismaError = e instanceof Error ? e.message : String(e);
    result.prismaStack = e instanceof Error ? e.stack?.slice(0, 500) : undefined;
  }

  return Response.json(result, { status: 200 });
}
