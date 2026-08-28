// GET /api/share?token=xxx — публичное получение сессии по share-токену (P1-9).
// Страница /shared/[token] знает только токен (без sessionId) — этот роут резолвит сессию сам.
// Спека (матрица §7): share GET — «Публичный доступ». Middleware исключает этот путь из auth.
import { NextRequest } from "next/server";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import { verifyShareToken, sharePayload } from "@/lib/share";

export async function GET(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const url = new URL(request.url);
    const token = url.searchParams.get("token");
    if (!token) {
      return json({ error: "token required" }, 400, { "X-Request-Id": requestId });
    }

    const verified = verifyShareToken(token);
    if (!verified) {
      return json({ error: "Invalid or expired token" }, 403, { "X-Request-Id": requestId });
    }

    return await sharePayload(verified.sessionId, verified.expiresAt, requestId);
  } catch (err) {
    logger.error("Share resolve error", { requestId, error: err instanceof Error ? err.message : String(err) });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}
