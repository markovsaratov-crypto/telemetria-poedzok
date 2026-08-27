// /api/admin/settings — runtime-overridable settings (TWO_GIS_API_KEY, OSRM_BASE_URL).
// GET  — список всех overridable settings с source (db/env) и updatedAt.
// PUT  — обновить один setting. Audit log. ADMIN_TOKEN auth.
//
// Это позволяет менять 2ГИС ключ прямо из UI без redeploy.
import { NextRequest } from "next/server";
import { authorizeRequest } from "@/lib/auth";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import { writeAudit } from "@/lib/audit";
import { setSetting, listOverridableSettings } from "@/lib/settings";

const ALLOWED_KEYS = new Set(["TWO_GIS_API_KEY", "OSRM_BASE_URL"]);

// GET /api/admin/settings
export async function GET(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const auth = await authorizeRequest(request, "admin");
    if (!auth.ok) return json({ error: auth.reason }, 401, { "X-Request-Id": requestId });

    const settings = await listOverridableSettings();
    // Mask sensitive values (показываем только первые 6 и последние 4 символа)
    const masked = settings.map((s) => {
      const isSensitive = s.key === "TWO_GIS_API_KEY";
      const v = s.value;
      const maskedValue =
        isSensitive && v.length > 12
          ? `${v.slice(0, 6)}…${v.slice(-4)} (${v.length} chars)`
          : isSensitive && v.length > 0
          ? `…(${v.length} chars)`
          : v;
      return { ...s, value: maskedValue, isSensitive };
    });

    return json({ settings: masked }, 200, { "X-Request-Id": requestId });
  } catch (err) {
    logger.error("Settings GET error", {
      requestId,
      error: err instanceof Error ? err.message : String(err),
    });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}

// PUT /api/admin/settings { key, value }
export async function PUT(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const auth = await authorizeRequest(request, "admin");
    if (!auth.ok) return json({ error: auth.reason }, 401, { "X-Request-Id": requestId });

    const body = await request.json().catch(() => null);
    const { key, value } = (body || {}) as { key?: string; value?: string };

    if (!key || !ALLOWED_KEYS.has(key)) {
      return json(
        { error: "Invalid key", allowed: Array.from(ALLOWED_KEYS) },
        400,
        { "X-Request-Id": requestId }
      );
    }
    if (typeof value !== "string") {
      return json({ error: "value must be string" }, 400, { "X-Request-Id": requestId });
    }
    if (value.length > 1024) {
      return json({ error: "value too long (max 1024)" }, 400, { "X-Request-Id": requestId });
    }

    const actorId = auth.via === "cookie" ? "owner" : "admin-token";
    await setSetting(key, value, actorId);

    // Audit log (не пишем само значение для sensitive ключей)
    const isSensitive = key === "TWO_GIS_API_KEY";
    await writeAudit({
      action: "settings.update",
      targetId: key,
      targetType: "Setting",
      actorType: "admin",
      actorId,
      metadata: JSON.stringify({
        key,
        valueLength: value.length,
        masked: isSensitive,
      }),
    });

    logger.info("settings updated", { requestId, key, valueLength: value.length });

    return json(
      {
        ok: true,
        key,
        source: "db",
        updatedAt: new Date().toISOString(),
      },
      200,
      { "X-Request-Id": requestId }
    );
  } catch (err) {
    logger.error("Settings PUT error", {
      requestId,
      error: err instanceof Error ? err.message : String(err),
    });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}
