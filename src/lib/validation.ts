// src/lib/validation.ts — Zod-схемы для всех API (§6.2, §4.7)
import { z } from "zod";

export const zIngestPoint = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  speed: z.number().min(0).max(83.33).optional(),
  altitude: z.number().optional(),
  accuracy: z.number().min(0).optional(),
  timestamp: z.number(), // наносекунды или миллисекунды (нормализуем в ingest)
  bearing: z.number().min(0).max(360).optional(),
});

export const zIngestBody = z.object({
  deviceId: z.string().min(1).max(64),
  clientId: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9_-]+$/, "clientId must be UUID/cuid-like"),
  deviceName: z.string().max(128).optional(),
  points: z.array(zIngestPoint).min(1).max(1000),
});

export const zLoginBody = z.object({
  email: z.string().email().optional(),
  // v2.18.0: max(256) — request.json() буферизует тело без ограничения (прокси
  // проверяет content-length, chunked-запросы пропускает), неаутентифицированный
  // запрос мог прислать пароль в десятки МБ → Buffer.from в safeEqual.
  password: z.string().min(1).max(256),
});

export const zRegisterBody = z.object({
  email: z.string().email().min(3).max(255),
  password: z.string().min(8).max(128),
});

// v2.16.0: zPlanBody/zRouteBody/zRouteUpdate удалены вместе с мёртвыми
// /api/plan* и /api/routes CRUD-роутами (0 потребителей).

export const zExportBody = z.object({
  format: z.enum(["gpx", "kml", "json"]),
});

export const zSessionsQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  // v2.18.0: даты валидируются — невалидная строка раньше доходила до
  // new Date("garbage") → Invalid Date → toTs().toISOString() → RangeError → 500
  // вместо честного 400 на ошибку клиента.
  olderThan: z.string().refine((v) => !Number.isNaN(Date.parse(v)), "invalid date").optional(),
  before: z.string().refine((v) => !Number.isNaN(Date.parse(v)), "invalid date").optional(),
  routeId: z.string().optional(),
  status: z.string().optional(),
  deviceId: z.string().optional(),
  // v2.36.0 (кейс 15.09 «блипы»): минимальный pointCount записи для списка —
  // микро-фрагменты деградировавшего логгера (1–3 точки) не несут аналитики,
  // но мусорят селектор «Все записи». Селектор передаёт 10.
  minPoints: z.coerce.number().int().min(1).max(100000).optional(),
});

export const zAuditQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  action: z.string().optional(),
  actorType: z.string().optional(),
  targetType: z.string().optional(),
});

export const zShareBody = z.object({
  // P1-9: срок действия share-ссылки в часах (по умолчанию 168 = 7 дней)
  // v2.38.1 (ревью F14): максимум 720 ч = 30 дней (было 8760 = 1 год):
  // stateless-ссылку с точным GPS-треком нельзя было отозвать (F14), годовой
  // срок умножал цену утечки; UI предлагает 7/30 дней — 720 не ломает ничего.
  // Ввод выше — честный 400 (AUDIT B-19-стиль), SHARE_MAX_TTL_HOURS — тот же
  // предел вторым слоем в роуте создания.
  expiresInHours: z.coerce.number().int().min(1).max(720).optional(),
});

export type IngestBody = z.infer<typeof zIngestBody>;
export type IngestPoint = z.infer<typeof zIngestPoint>;
