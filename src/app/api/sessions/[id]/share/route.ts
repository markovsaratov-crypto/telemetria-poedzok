// POST /api/sessions/[id]/share — создать shareable token (§7 матрицы: Cookie/API_KEY).
// GET  /api/sessions/[id]/share?token=xxx — публичный доступ к сессии по токену (спека: «Публичный доступ»).
//
// P1-9: токен STATELESS (HMAC sessionId+срок, ключ SESSION_SECRET) — переживает рестарт,
// раньше in-memory Map умирал вместе с процессом. Опциональное тело POST { expiresInHours }
// (1..8760, по умолчанию 168 = 7 дней) — срок уважается при проверке.
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { authorizeRequest } from "@/lib/auth";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import { writeAudit } from "@/lib/audit";
import { zShareBody } from "@/lib/validation";
import { makeShareToken, SHARE_DEFAULT_TTL_HOURS, SHARE_MAX_TTL_HOURS } from "@/lib/share";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const auth = await authorizeRequest(request, "api");
    if (!auth.ok) return json({ error: auth.reason }, 401, { "X-Request-Id": requestId });

    const { id } = await params;
    const session = await db.session.findUnique({
      where: { id },
      select: { id: true, deletedAt: true, deviceId: true },
    });
    if (!session || session.deletedAt) {
      return json({ error: "Not found" }, 404, { "X-Request-Id": requestId });
    }

    // P1-9: уважаем expiresInHours из тела (раньше жёстко 7 дней)
    const body = await request.json().catch(() => ({}));
    const parsed = zShareBody.safeParse(body ?? {});
    // AUDIT B-19: невалидное тело раньше молча давало ссылку на 7 дней —
    // теперь честный 400, чтобы вызывающий код узнал об ошибке.
    if (body != null && !parsed.success) {
      return json({ error: "Validation failed", details: parsed.error.flatten() }, 400, { "X-Request-Id": requestId });
    }
    const ttlHours = parsed.success
      ? Math.min(Math.max(parsed.data.expiresInHours ?? SHARE_DEFAULT_TTL_HOURS, 1), SHARE_MAX_TTL_HOURS)
      : SHARE_DEFAULT_TTL_HOURS;

    const { token, expiresAt } = makeShareToken(id, ttlHours);

    await writeAudit({
      action: "session.share",
      targetId: id,
      targetType: "Session",
      actorType: auth.via === "cookie" ? "user" : "system",
      actorId: auth.via === "cookie" ? "owner" : "api",
      sessionId: id,
      metadata: { tokenPrefix: token.slice(-16, -8), expiresInHours: ttlHours, expiresAt: new Date(expiresAt).toISOString() },
    });

    return json(
      {
        token,
        url: `/shared/${token}`,
        expiresAt: new Date(expiresAt).toISOString(),
        sessionId: id,
      },
      200,
      { "X-Request-Id": requestId }
    );
  } catch (err) {
    logger.error("Share create error", { requestId, error: err instanceof Error ? err.message : String(err) });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}

// v2.18.0: GET ?token= УДАЛЁН — публичное чтение всегда шло через
// /api/share?token= (страница /shared/[token] резолвит сессию сама),
// этого потребителя не было, а каждый лишний публичный роут — лишняя
// атакующая поверхность. POST (создание ссылки) живёт как раньше.
