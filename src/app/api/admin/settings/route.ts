// GET /api/admin/settings — list overridable settings.
// PUT /api/admin/settings — update a setting (key, value).
import { NextRequest } from "next/server";
import { authorizeRequest, getUserIdFromRequest } from "@/lib/auth";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import { listOverridableSettings, setSetting } from "@/lib/settings";
import { z } from "zod";

export const dynamic = "force-dynamic";

const zUpdateBody = z.object({
  key: z.string().min(1).max(64),
  value: z.string().max(4096),
});

// v2.16.0 (S6): allow-list ключей — админ может менять ТОЛЬКО известные
// переопределяемые настройки (как в listOverridableSettings). Раньше PUT писал
// в таблицу Setting ЛЮБОЙ ключ — та же таблица хранит кэш геокода (geocode:*)
// и диагностические ключи (diag.*) — любая опечатка/злоупотребление портила их.
const SETTING_KEY_ALLOWLIST = ["TWO_GIS_API_KEY", "TWO_GIS_PROXY_URL", "OSRM_BASE_URL"] as const;
export const _SETTING_KEY_ALLOWLIST = SETTING_KEY_ALLOWLIST;

export async function GET(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const auth = await authorizeRequest(request, "admin");
    if (!auth.ok) return json({ error: auth.reason }, 401, { "X-Request-Id": requestId });

    const settings = await listOverridableSettings();
    // AUDIT B-14: чувствительные значения не отдаются наружу целиком — маска
    // «****xx» (последние 2 символа, как в /api/test-2gis). UI показывает
    // маску как плейсхолдер; новое значение вводится только при изменении.
    const masked = settings.map((s) =>
      s.isSensitive && s.value
        ? { ...s, value: `****${s.value.slice(-2)}`, masked: true }
        : { ...s, masked: false }
    );
    return json({ settings: masked }, 200, { "X-Request-Id": requestId });
  } catch (err) {
    logger.error("Settings list error", {
      requestId,
      error: err instanceof Error ? err.message : String(err),
    });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}

export async function PUT(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const auth = await authorizeRequest(request, "admin");
    if (!auth.ok) return json({ error: auth.reason }, 401, { "X-Request-Id": requestId });

    const body = await request.json().catch(() => null);
    const parsed = zUpdateBody.safeParse(body);
    if (!parsed.success) {
      return json({ error: "Validation failed", details: parsed.error.flatten() }, 400, {
        "X-Request-Id": requestId,
      });
    }

    const userId = await getUserIdFromRequest(request);
    const { key, value } = parsed.data;
    if (!(SETTING_KEY_ALLOWLIST as readonly string[]).includes(key)) {
      return json(
        { error: `Ключ «${key}» не является переопределяемой настройкой. Доступно: ${SETTING_KEY_ALLOWLIST.join(", ")}` },
        400,
        { "X-Request-Id": requestId }
      );
    }
    await setSetting(key, value, userId ?? auth.role);
    return json({ ok: true, key, value }, 200, { "X-Request-Id": requestId });
  } catch (err) {
    logger.error("Settings update error", {
      requestId,
      error: err instanceof Error ? err.message : String(err),
    });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}

// P1-11: спека (матрица §7) определяет контракт POST /api/admin/settings.
// PUT сохранён как алиас для обратной совместимости существующих клиентов.
export const POST = PUT;
