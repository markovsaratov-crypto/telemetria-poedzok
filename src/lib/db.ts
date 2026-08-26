// src/lib/db.ts — Prisma with libsql adapter
// DATABASE_URL = file: (for Prisma schema validation)
// TURSO_DATABASE_URL = libsql:// (actual Turso connection)
import { PrismaClient } from "@prisma/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import { createClient } from "@libsql/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

function createPrismaClient(): PrismaClient {
  // Use TURSO_DATABASE_URL for actual connection (libsql://)
  // Fall back to DATABASE_URL for local dev (file:./db/custom.db)
  const tursoUrl = process.env.TURSO_DATABASE_URL || "";
  const localUrl = process.env.DATABASE_URL || "";

  // Для Turso — используем adapter
  if (tursoUrl.startsWith("libsql://")) {
    const authToken = process.env.TURSO_AUTH_TOKEN;
    const libsql = createClient({ url: tursoUrl, authToken });
    const adapter = new PrismaLibSql(libsql);
    return new PrismaClient({ adapter, log: ["error", "warn"] });
  }

  // Локальная SQLite — стандартный connector
  return new PrismaClient({
    log: ["error", "warn"],
  });
}

export const db = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;
