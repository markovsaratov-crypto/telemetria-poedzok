// src/lib/env.ts — централизованный доступ к env (§11). Все токены server-side only.
import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  LOGIN_PASSWORD: z.string().min(32, "LOGIN_PASSWORD must be ≥32 chars"),
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be ≥32 chars"),
  API_KEY: z.string().min(32, "API_KEY must be ≥32 chars"),
  INGEST_TOKEN: z.string().min(32, "INGEST_TOKEN must be ≥32 chars"),
  CRON_SECRET: z.string().min(32, "CRON_SECRET must be ≥32 chars"),
  ADMIN_TOKEN: z.string().min(32, "ADMIN_TOKEN must be ≥32 chars"),
  RATE_LIMIT_MAX_INGEST: z.coerce.number().int().positive().default(120),
  RATE_LIMIT_MAX_DEFAULT: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_MAX_AUTH: z.coerce.number().int().positive().default(5),
  RATE_LIMIT_MAX_PLAN: z.coerce.number().int().positive().default(5),
  RATE_LIMIT_MAX_AUDIT: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_MAX_ADMIN: z.coerce.number().int().positive().default(1),
  RATE_LIMIT_BACKEND: z.enum(["redis", "memory"]).default("memory"),
  MAX_PAYLOAD_BYTES: z.coerce.number().int().positive().default(262144),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  WORKER_ID: z.string().default("worker-local"),
  WORKER_BATCH_SIZE: z.coerce.number().int().positive().default(10),
  WORKER_MAX_CONCURRENCY: z.coerce.number().int().positive().default(5),
  WORKER_PORT: z.coerce.number().int().positive().default(3001),
  TWO_GIS_API_KEY: z.string().default(""),
  OSRM_BASE_URL: z.string().default("https://router.project-osrm.org"),
  CIRCUIT_BREAKER_THRESHOLD: z.coerce.number().int().positive().default(5),
  CIRCUIT_BREAKER_TIMEOUT_SEC: z.coerce.number().int().positive().default(30),
  RETENTION_DAYS: z.coerce.number().int().positive().default(3650),
  GRACE_PERIOD_DAYS: z.coerce.number().int().positive().default(30),
  AUDIT_RETENTION_DAYS: z.coerce.number().int().positive().default(3650),
  EXPORT_ASYNC_THRESHOLD: z.coerce.number().int().positive().default(5000),
  EXPORT_STORAGE_DIR: z.string().default("/home/z/my-project/download/exports"),
  EXPORT_URL_TTL_HOURS: z.coerce.number().int().positive().default(24),
  EXPORT_MAX_FILE_BYTES: z.coerce.number().int().positive().default(104857600),
  BACKUP_MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),
  BACKUP_STORAGE_DIR: z.string().default("/home/z/my-project/download/backups"),
  BACKUP_VERIFICATION_ENABLED: z.string().default("true"),
  VERCEL_PLAN: z.enum(["free", "pro"]).default("pro"),
  TARGET_LOAD_RPM: z.coerce.number().int().positive().default(100),
  NODE_ENV: z.string().default("development"),
  APP_VERSION: z.string().default("2.6.0"),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

export function env(): Env {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    console.error("[env] Invalid environment variables:", parsed.error.flatten().fieldErrors);
    throw new Error("Invalid environment configuration");
  }
  cached = parsed.data;
  return cached;
}

// CI-проверка: блокер №1 — rate limit vs target load (§9.6, §11)
export function assertCapacity(): { ok: boolean; reason?: string } {
  const e = env();
  // Блокер №1: RATE_LIMIT_MAX_INGEST должен покрывать TARGET_LOAD_RPM × 1.2
  const required = Math.ceil(e.TARGET_LOAD_RPM * 1.2);
  if (e.RATE_LIMIT_MAX_INGEST < required) {
    return {
      ok: false,
      reason: `RATE_LIMIT_MAX_INGEST=${e.RATE_LIMIT_MAX_INGEST} < required ${required} (TARGET_LOAD_RPM=${e.TARGET_LOAD_RPM} × 1.2). Блокер №1: целевая нагрузка недостижима.`,
    };
  }
  // §9.6: Vercel free + TARGET_LOAD_RPM>=100 → exit 1
  if (e.VERCEL_PLAN === "free" && e.TARGET_LOAD_RPM >= 100) {
    return {
      ok: false,
      reason: `VERCEL_PLAN=free с TARGET_LOAD_RPM=${e.TARGET_LOAD_RPM} (требуется Pro). §9.6 BLOCKING.`,
    };
  }
  return { ok: true };
}
