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
  password: z.string().min(1),
});

export const zRegisterBody = z.object({
  email: z.string().email().min(3).max(255),
  password: z.string().min(8).max(128),
});

export const zPlanBody = z.object({
  startLat: z.number().min(-90).max(90),
  startLon: z.number().min(-180).max(180),
  endLat: z.number().min(-90).max(90),
  endLon: z.number().min(-180).max(180),
  sessionId: z.string().optional(),
});

export const zRouteBody = z.object({
  name: z.string().min(1).max(128),
  description: z.string().max(512).optional(),
  startLat: z.number().min(-90).max(90),
  startLon: z.number().min(-180).max(180),
  endLat: z.number().min(-90).max(90),
  endLon: z.number().min(-180).max(180),
});

export const zRouteUpdate = zRouteBody.partial();

export const zExportBody = z.object({
  format: z.enum(["gpx", "kml", "json"]),
});

export const zSessionsQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  olderThan: z.string().optional(),
  before: z.string().optional(),
  routeId: z.string().optional(),
  status: z.string().optional(),
  deviceId: z.string().optional(),
});

export const zAuditQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  action: z.string().optional(),
  actorType: z.string().optional(),
  targetType: z.string().optional(),
});

export const zShareBody = z.object({
  // P1-9: срок действия share-ссылки в часах (по умолчанию 168 = 7 дней, максимум 1 год)
  expiresInHours: z.coerce.number().int().min(1).max(8760).optional(),
});

export type IngestBody = z.infer<typeof zIngestBody>;
export type IngestPoint = z.infer<typeof zIngestPoint>;
export type PlanBody = z.infer<typeof zPlanBody>;
export type RouteBody = z.infer<typeof zRouteBody>;
