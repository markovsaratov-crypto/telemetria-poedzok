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

export async function GET(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const auth = await authorizeRequest(request, "admin");
    if (!auth.ok) return json({ error: auth.reason }, 401, { "X-Request-Id": requestId });

    const settings = await listOverridableSettings();
    return json({ settings }, 200, { "X-Request-Id": requestId });
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
