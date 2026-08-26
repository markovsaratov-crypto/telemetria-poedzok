import { PrismaClient } from "@prisma/client";
import { PrismaLibSql } from "@prisma/adapter-libsql";
import { createClient } from "@libsql/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

function createPrismaClient(): PrismaClient {
  const url = process.env.DATABASE_URL || "";

  if (url.startsWith("libsql://")) {
    const authToken = process.env.TURSO_AUTH_TOKEN;
    const libsql = createClient({ url, authToken });
    const adapter = new PrismaLibSql(libsql);
    return new PrismaClient({ adapter, log: ["error", "warn"] });
  }

  return new PrismaClient({
    log: ["error", "warn"],
  });
}

export const db = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;
