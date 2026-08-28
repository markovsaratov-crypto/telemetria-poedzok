// src/lib/env.ts — централизованный доступ к env (§11). Lenient validation with defaults.
import { z } from "zod";

const schema = z.object({
  DATABASE_URL: z.string().min(1).default("file:./db/custom.db"),
  LOGIN_PASSWORD: z.string().min(1).default("change-me-please-32-chars-minimum-aaaaaa"),
  SESSION_SECRET: z.string().min(1).default("super-secret-session-key-32-chars-minimum"),
  API_KEY: z.string().min(1).default("api-key-server-side-32-chars-minimum-xxx"),
  INGEST_TOKEN: z.string().min(1).default("ingest-token-32-chars-minimum-aaaaaaa"),
  CRON_SECRET: z.string().min(1).default("cron-secret-32-chars-minimum-bbbbbbbb"),
  ADMIN_TOKEN: z.string().min(1).default("admin-token-32-chars-minimum-cccccccc"),
  RATE_LIMIT_MAX_INGEST: z.coerce.number().int().positive().default(120),
  RATE_LIMIT_MAX_DEFAULT: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_MAX_AUTH: z.coerce.number().int().positive().default(5),
  RATE_LIMIT_MAX_PLAN: z.coerce.number().int().positive().default(5),
  RATE_LIMIT_MAX_AUDIT: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_MAX_ADMIN: z.coerce.number().int().positive().default(1),
  RATE_LIMIT_MAX_REQUEUE: z.coerce.number().int().positive().default(10), // P1-11: спека §7.3
  RATE_LIMIT_BACKEND: z.enum(["redis", "memory"]).default("memory"),
  MAX_PAYLOAD_BYTES: z.coerce.number().int().positive().default(262144),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  WORKER_ID: z.string().default("worker-local"),
  WORKER_BATCH_SIZE: z.coerce.number().int().positive().default(10),
  WORKER_MAX_CONCURRENCY: z.coerce.number().int().positive().default(5),
  WORKER_PORT: z.coerce.number().int().positive().default(3001),
  TWO_GIS_API_KEY: z.string().default(""),
  TWO_GIS_PROXY_URL: z.string().default(""),
  OSRM_BASE_URL: z.string().default("https://router.project-osrm.org"),
  CIRCUIT_BREAKER_THRESHOLD: z.coerce.number().int().positive().default(5),
  CIRCUIT_BREAKER_TIMEOUT_SEC: z.coerce.number().int().positive().default(30),
  RETENTION_DAYS: z.coerce.number().int().positive().default(3650),
  GRACE_PERIOD_DAYS: z.coerce.number().int().positive().default(30),
  RETENTION_ARCHIVE_ENABLED: z.string().default("true"),
  ARCHIVE_RETENTION_DAYS: z.coerce.number().int().positive().default(3650),
  AUDIT_RETENTION_DAYS: z.coerce.number().int().positive().default(3650),
  EXPORT_ASYNC_THRESHOLD: z.coerce.number().int().positive().default(5000),
  EXPORT_STORAGE_DIR: z.string().default("/tmp/exports"),
  EXPORT_URL_TTL_HOURS: z.coerce.number().int().positive().default(24),
  EXPORT_MAX_FILE_BYTES: z.coerce.number().int().positive().default(104857600),
  EXPORT_CLEANUP_CRON_UTC: z.string().default("0 * * * *"),
  BACKUP_MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),
  BACKUP_RETRY_INTERVAL_HOURS: z.coerce.number().int().positive().default(1),
  BACKUP_VERIFICATION_ENABLED: z.string().default("true"),
  BACKUP_STORAGE_DIR: z.string().default("/tmp/backups"),
  VERCEL_PLAN: z.enum(["free", "pro"]).default("pro"),
  TARGET_LOAD_RPM: z.coerce.number().int().positive().default(100),
  NODE_ENV: z.string().default("development"),
  APP_VERSION: z.string().default("2.6.0"),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

export function env(): Env {
  if (cached) return cached;
  // Use safeParse with defaults — never throw, always return a valid Env
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    console.error("[env] Missing env vars, using defaults:", parsed.error.flatten().fieldErrors);
    // Apply defaults manually
    const defaults: Env = {
      DATABASE_URL: process.env.DATABASE_URL || "file:./db/custom.db",
      LOGIN_PASSWORD: process.env.LOGIN_PASSWORD || "change-me-please-32-chars-minimum-aaaaaa",
      SESSION_SECRET: process.env.SESSION_SECRET || "super-secret-session-key-32-chars-minimum",
      API_KEY: process.env.API_KEY || "api-key-server-side-32-chars-minimum-xxx",
      INGEST_TOKEN: process.env.INGEST_TOKEN || "ingest-token-32-chars-minimum-aaaaaaa",
      CRON_SECRET: process.env.CRON_SECRET || "cron-secret-32-chars-minimum-bbbbbbbb",
      ADMIN_TOKEN: process.env.ADMIN_TOKEN || "admin-token-32-chars-minimum-cccccccc",
      RATE_LIMIT_MAX_INGEST: Number(process.env.RATE_LIMIT_MAX_INGEST) || 120,
      RATE_LIMIT_MAX_DEFAULT: Number(process.env.RATE_LIMIT_MAX_DEFAULT) || 60,
      RATE_LIMIT_MAX_AUTH: Number(process.env.RATE_LIMIT_MAX_AUTH) || 5,
      RATE_LIMIT_MAX_PLAN: Number(process.env.RATE_LIMIT_MAX_PLAN) || 5,
      RATE_LIMIT_MAX_AUDIT: Number(process.env.RATE_LIMIT_MAX_AUDIT) || 60,
      RATE_LIMIT_MAX_ADMIN: Number(process.env.RATE_LIMIT_MAX_ADMIN) || 1,
      RATE_LIMIT_MAX_REQUEUE: Number(process.env.RATE_LIMIT_MAX_REQUEUE) || 10, // P1-11
      RATE_LIMIT_BACKEND: (process.env.RATE_LIMIT_BACKEND as "redis" | "memory") || "memory",
      MAX_PAYLOAD_BYTES: Number(process.env.MAX_PAYLOAD_BYTES) || 262144,
      WORKER_POLL_INTERVAL_MS: Number(process.env.WORKER_POLL_INTERVAL_MS) || 5000,
      WORKER_ID: process.env.WORKER_ID || "worker-local",
      WORKER_BATCH_SIZE: Number(process.env.WORKER_BATCH_SIZE) || 10,
      WORKER_MAX_CONCURRENCY: Number(process.env.WORKER_MAX_CONCURRENCY) || 5,
      WORKER_PORT: Number(process.env.WORKER_PORT) || 3001,
      TWO_GIS_API_KEY: process.env.TWO_GIS_API_KEY || "",
      TWO_GIS_PROXY_URL: process.env.TWO_GIS_PROXY_URL || "",
      OSRM_BASE_URL: process.env.OSRM_BASE_URL || "https://router.project-osrm.org",
      CIRCUIT_BREAKER_THRESHOLD: Number(process.env.CIRCUIT_BREAKER_THRESHOLD) || 5,
      CIRCUIT_BREAKER_TIMEOUT_SEC: Number(process.env.CIRCUIT_BREAKER_TIMEOUT_SEC) || 30,
      RETENTION_DAYS: Number(process.env.RETENTION_DAYS) || 3650,
      GRACE_PERIOD_DAYS: Number(process.env.GRACE_PERIOD_DAYS) || 30,
      RETENTION_ARCHIVE_ENABLED: process.env.RETENTION_ARCHIVE_ENABLED || "true",
      ARCHIVE_RETENTION_DAYS: Number(process.env.ARCHIVE_RETENTION_DAYS) || 3650,
      AUDIT_RETENTION_DAYS: Number(process.env.AUDIT_RETENTION_DAYS) || 3650,
      EXPORT_ASYNC_THRESHOLD: Number(process.env.EXPORT_ASYNC_THRESHOLD) || 5000,
      EXPORT_STORAGE_DIR: process.env.EXPORT_STORAGE_DIR || "/tmp/exports",
      EXPORT_URL_TTL_HOURS: Number(process.env.EXPORT_URL_TTL_HOURS) || 24,
      EXPORT_MAX_FILE_BYTES: Number(process.env.EXPORT_MAX_FILE_BYTES) || 104857600,
      EXPORT_CLEANUP_CRON_UTC: process.env.EXPORT_CLEANUP_CRON_UTC || "0 * * * *",
      BACKUP_MAX_ATTEMPTS: Number(process.env.BACKUP_MAX_ATTEMPTS) || 3,
      BACKUP_RETRY_INTERVAL_HOURS: Number(process.env.BACKUP_RETRY_INTERVAL_HOURS) || 1,
      BACKUP_VERIFICATION_ENABLED: process.env.BACKUP_VERIFICATION_ENABLED || "true",
      BACKUP_STORAGE_DIR: process.env.BACKUP_STORAGE_DIR || "/tmp/backups",
      VERCEL_PLAN: (process.env.VERCEL_PLAN as "free" | "pro") || "pro",
      TARGET_LOAD_RPM: Number(process.env.TARGET_LOAD_RPM) || 100,
      NODE_ENV: process.env.NODE_ENV || "development",
      APP_VERSION: process.env.APP_VERSION || "2.6.0",
    };
    cached = defaults;
    return cached;
  }
  cached = parsed.data;
  return cached;
}

export function assertCapacity(): { ok: boolean; reason?: string } {
  const e = env();
  const required = Math.ceil(e.TARGET_LOAD_RPM * 1.2);
  if (e.RATE_LIMIT_MAX_INGEST < required) {
    return {
      ok: false,
      reason: `RATE_LIMIT_MAX_INGEST=${e.RATE_LIMIT_MAX_INGEST} < required ${required} (TARGET_LOAD_RPM=${e.TARGET_LOAD_RPM} × 1.2).`,
    };
  }
  if (e.VERCEL_PLAN === "free" && e.TARGET_LOAD_RPM >= 100) {
    return {
      ok: false,
      reason: `VERCEL_PLAN=free with TARGET_LOAD_RPM=${e.TARGET_LOAD_RPM}.`,
    };
  }
  return { ok: true };
}
