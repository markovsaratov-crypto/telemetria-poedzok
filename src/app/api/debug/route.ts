// GET /api/debug — диагностика DB соединения
import { NextRequest } from "next/server";
import { createClient } from "@libsql/client";

export async function GET(request: NextRequest) {
  const result: Record<string, unknown> = {};

  result.databaseUrl = process.env.DATABASE_URL?.slice(0, 50) || "NOT SET";
  result.tursoDatabaseUrl = process.env.TURSO_DATABASE_URL?.slice(0, 50) || "NOT SET";
  result.tursoToken = process.env.TURSO_AUTH_TOKEN?.slice(0, 20) + "..." || "NOT SET";

  // Test libsql with TURSO_DATABASE_URL
  try {
    const url = process.env.TURSO_DATABASE_URL || process.env.DATABASE_URL || "";
    const authToken = process.env.TURSO_AUTH_TOKEN;
    const client = createClient({ url, authToken });
    const res = await client.execute("SELECT name FROM sqlite_master WHERE type='table' LIMIT 5");
    result.libsqlTables = res.rows.map((r) => (r as { name: string }).name);
    result.libsqlStatus = "OK";
  } catch (e) {
    result.libsqlStatus = "ERROR";
    result.libsqlError = e instanceof Error ? e.message : String(e);
  }

  // Test Prisma
  try {
    const { db } = await import("@/lib/db");
    const count = await db.session.count();
    result.prismaCount = count;
    result.prismaStatus = "OK";
  } catch (e) {
    result.prismaStatus = "ERROR";
    result.prismaError = e instanceof Error ? e.message.slice(0, 200) : String(e);
  }

  return Response.json(result, { status: 200 });
}
