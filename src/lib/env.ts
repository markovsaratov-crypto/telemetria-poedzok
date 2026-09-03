// src/lib/env.ts — централизованный доступ к env (§11). Lenient validation with defaults.
import { z } from "zod";
import pkg from "../../package.json";
import { logger } from "./logger"; // v2.16.0: структурный лог вместо console.error

const schema = z.object({
  DATABASE_URL: z.string().min(1).default("file:./db/custom.db"),
  LOGIN_PASSWORD: z.string().min(1).default("change-me-please-32-chars-minimum-aaaaaa"),
  SESSION_SECRET: z.string().min(1).default("super-secret-session-key-32-chars-minimum"),
  API_KEY: z.string().min(1).default("api-key-server-side-32-chars-minimum-xxx"),
  INGEST_TOKEN: z.string().min(1).default("ingest-token-32-chars-minimum-aaaaaaa"),
  CRON_SECRET: z.string().min(1).default("cron-secret-32-chars-minimum-bbbbbbbb"),
  ADMIN_TOKEN: z.string().min(1).default("admin-token-32-chars-minimum-cccccccc"),
  // AUDIT B-1: регистрация новых пользователей — выключена по умолчанию (single-user продукт).
  // Включается только явным REGISTRATION_ENABLED=true.
  REGISTRATION_ENABLED: z.string().default("false"),
  RATE_LIMIT_MAX_INGEST: z.coerce.number().int().positive().default(120),
  RATE_LIMIT_MAX_DEFAULT: z.coerce.number().int().positive().default(60),
  // v2.14.1: дешёвые GET-чтения вкладки «Поездки» (список, статы записей, геокод) —
  // отдельный скоп: склейка поездок делает всплеск N stats+geocode запросов на одно
  // открытие вкладки, при N>=20 они с ретраями react-query выбивают default 60/мин (429-тосты).
  RATE_LIMIT_MAX_READ: z.coerce.number().int().positive().default(240),
  RATE_LIMIT_MAX_AUTH: z.coerce.number().int().positive().default(5),
  // v2.18.0: RATE_LIMIT_MAX_PLAN/RATE_LIMIT_MAX_AUDIT удалены — скопы /api/plan и
  // /api/audit не существуют с чистки v2.16.0, поля читались 0 раз.
  RATE_LIMIT_MAX_ADMIN: z.coerce.number().int().positive().default(1),
  RATE_LIMIT_MAX_REQUEUE: z.coerce.number().int().positive().default(10), // P1-11: спека §7.3
  RATE_LIMIT_BACKEND: z.enum(["redis", "memory"]).default("memory"),
  MAX_PAYLOAD_BYTES: z.coerce.number().int().positive().default(262144),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  WORKER_ID: z.string().default("worker-local"),
  WORKER_BATCH_SIZE: z.coerce.number().int().positive().default(10),
  WORKER_MAX_CONCURRENCY: z.coerce.number().int().positive().default(5),
  // v2.18.0: WORKER_PORT удалён — воркер in-process (instrumentation), порт не слушается.
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
  EXPORT_URL_TTL_HOURS: z.coerce.number().int().positive().default(24),
  // v2.18.0: EXPORT_STORAGE_DIR/EXPORT_MAX_FILE_BYTES удалены — не читались
  // (worker-runtime v2.9.10 убрал fs; download-роут не проверяет размер).
  EXPORT_CLEANUP_CRON_UTC: z.string().default("0 * * * *"),
  BACKUP_MAX_ATTEMPTS: z.coerce.number().int().positive().default(3),
  BACKUP_RETRY_INTERVAL_HOURS: z.coerce.number().int().positive().default(1),
  BACKUP_VERIFICATION_ENABLED: z.string().default("true"),
  BACKUP_STORAGE_DIR: z.string().default("/tmp/backups"),
  VERCEL_PLAN: z.enum(["free", "pro"]).default("pro"),
  TARGET_LOAD_RPM: z.coerce.number().int().positive().default(100),
  NODE_ENV: z.string().default("development"),
  APP_VERSION: z.string().default(pkg.version),
  // v2.9 §4.6: MovingTime state machine — гистерезис 5/2 км/ч + debounce 5 сек + gap 30 сек
  MOVING_TIME_HYSTERESIS_HIGH_KMH: z.coerce.number().positive().default(5),
  MOVING_TIME_HYSTERESIS_LOW_KMH: z.coerce.number().positive().default(2),
  MOVING_TIME_DEBOUNCE_SEC: z.coerce.number().positive().default(5),
  MOVING_TIME_GAP_SEC: z.coerce.number().positive().default(30),
  // v2.9 §7.3: CAP EcoScore — базовые линии калибруются по референсному корпусу (по умолчанию 0.5/0.4/0.3)
  ECO_SCORE_CAP_BASELINE: z.string().default(""),
  ECO_SCORE_CAP_PENALTY_EXPONENT: z.coerce.number().positive().default(1.5),
  ECO_SCORE_MIN_CALIBRATION_CORPUS: z.coerce.number().int().positive().default(30),
  ECO_SCORE_MIN_BASELINE_VALUE: z.coerce.number().positive().default(0.05),
  ECO_SCORE_MIN_ACTIVE_DISTANCE_KM: z.coerce.number().positive().default(5),
  ECO_SCORE_MIN_ACTIVE_DURATION_SEC: z.coerce.number().positive().default(300),
  // v2.9 §17.2: HMM map matching — σ (GPS-погрешность, м) + β (transition, м)
  HMM_EMISSION_SIGMA_M: z.coerce.number().positive().default(5),
  HMM_TRANSITION_BETA_M: z.coerce.number().positive().default(5),
  // v2.9 §10.5: Theil-Sen RouteTrend — bootstrap при n > 200
  ROUTE_TREND_BOOTSTRAP_THRESHOLD: z.coerce.number().int().positive().default(200),
  ROUTE_TREND_BOOTSTRAP_SAMPLES: z.coerce.number().int().positive().default(200),
  // v2.9 §10.6: HotspotSegments — перцентильная основа
  HOTSPOT_SEGMENTS_PERCENTILE: z.coerce.number().int().min(1).max(100).default(75),
  HOTSPOT_SEGMENTS_THRESHOLD: z.coerce.number().positive().default(0.5),
  // v2.9 §10.0: routeHash — snap-to-grid шаг (0.0005° ≈ 55 м на широте Москвы)
  ROUTE_ID_SNAP_GRID_DEG: z.coerce.number().positive().default(0.0005),
  // P2-16: вебхук Slack для алертов §14.4 (пусто — только журнал и /api/admin/alerts)
  SLACK_WEBHOOK_URL: z.string().default(""),
});

export type Env = z.infer<typeof schema>;

let cached: Env | null = null;

// AUDIT B-2: fail-closed секреты. В production дефолтные (публично известные) значения
// секретов недопустимы — приложение обязано упасть на старте, а не молча принять их.
const PROD_INSECURE_DEFAULTS: Partial<Record<keyof Env, string>> = {
  LOGIN_PASSWORD: "change-me-please-32-chars-minimum-aaaaaa",
  SESSION_SECRET: "super-secret-session-key-32-chars-minimum",
  API_KEY: "api-key-server-side-32-chars-minimum-xxx",
  INGEST_TOKEN: "ingest-token-32-chars-minimum-aaaaaaa",
  CRON_SECRET: "cron-secret-32-chars-minimum-bbbbbbbb",
  ADMIN_TOKEN: "admin-token-32-chars-minimum-cccccccc",
};

function assertProdSecrets(e: Env): void {
  if (e.NODE_ENV !== "production") return;
  const insecure: string[] = [];
  for (const [key, bad] of Object.entries(PROD_INSECURE_DEFAULTS)) {
    if (e[key as keyof Env] === bad) insecure.push(key);
  }
  if (insecure.length > 0) {
    // Fail-closed: с публично известными секретами прод не поднимается.
    throw new Error(
      `[env] PRODUCTION FAIL-CLOSED: используются дефолтные (небезопасные) значения: ${insecure.join(", ")}. ` +
        "Задайте реальные значения через переменные окружения."
    );
  }
}

export function env(): Env {
  if (cached) return cached;
  // Use safeParse with defaults — never throw, always return a valid Env.
  const parsed = schema.safeParse(process.env);
  if (parsed.success) {
    // v2.7: APP_VERSION всегда из package.json (единый источник; env дашборда не может перекрыть релиз)
    cached = { ...parsed.data, APP_VERSION: pkg.version };
    assertProdSecrets(cached);
    return cached;
  }
  // v2.16.0 (D-1): lenient-фолбэк БЕЗ дубля схемы. Раньше сюда был скопирован
  // весь 70-полей объект-литерал «|| default» — любое новое поле схемы надо было
  // помнить добавить в ДВУХ местах (расползание). Теперь: каждое поле парсится
  // ИНДИВИДУАЛЬНО (одно битое значение не сбрасывает все остальные к дефолтам —
  // строго better, чем раньше), дефолт — из самой zod-схемы.
  logger.warn("[env] некоторые переменные окружения невалидны — применяю по-полевые дефолты", {
    fields: parsed.error.flatten().fieldErrors,
  });
  const lenient: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(schema.shape)) {
    const raw = process.env[key];
    const single = field.safeParse(raw);
    lenient[key] = single.success ? single.data : field.parse(undefined);
  }
  cached = { ...lenient, APP_VERSION: pkg.version } as Env;
  assertProdSecrets(cached);
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
