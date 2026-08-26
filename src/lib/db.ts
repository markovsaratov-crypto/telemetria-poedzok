// src/lib/db.ts — Prisma + Turso libsql adapter (production-grade)
// DATABASE_URL is set to file:./db/local.db at build time (for prisma generate)
// At runtime, DATABASE_URL=libsql://... (Turso), adapter overrides the connection
import { PrismaClient } from "@prisma/client";
import { PrismaLibSQL } from "@prisma/adapter-libsql";
import { createClient } from "@libsql/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

function createPrismaClient(): PrismaClient {
  const url = process.env.DATABASE_URL || "";

  // Turso: use adapter (completely replaces Prisma's built-in connector)
  if (url.startsWith("libsql://")) {
    const authToken = process.env.TURSO_AUTH_TOKEN;
    const libsql = createClient({ url, authToken });
    const adapter = new PrismaLibSQL(libsql);
    return new PrismaClient({ adapter, log: ["error", "warn"] });
  }

  // Local SQLite (development)
  return new PrismaClient({ log: ["error", "warn"] });
}

export const db = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;
