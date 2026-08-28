export const dynamic = "force-dynamic";
import { NextRequest } from "next/server";
import { json } from "@/lib/http-utils";
import { authorizeRequest } from "@/lib/auth";

// GET /api/test-2gis — диагностика провайдера 2ГИС.
// P0-3: только для администратора (Bearer ADMIN_TOKEN или owner/admin cookie);
// из ответа УБРАНЫ фрагменты ключа и apiUrl с ключом (была частичная утечка).
export async function GET(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  const auth = await authorizeRequest(request, "admin");
  if (!auth.ok) return json({ error: auth.reason }, 401, { "X-Request-Id": requestId });

  const { getSettingSync } = await import("@/lib/settings");
  const key = getSettingSync("TWO_GIS_API_KEY");
  if (!key) return json({ error: "No TWO_GIS_API_KEY" }, 400, { "X-Request-Id": requestId });

  const proxyUrl = getSettingSync("TWO_GIS_PROXY_URL");
  const apiUrl = proxyUrl
    ? `${proxyUrl}?key=${key}`
    : `https://routing.api.2gis.ru/carrouting/6.0.0/global?key=${key}`;

  try {
    const res = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        points: [
          { lat: 51.59, lon: 45.96 },
          { lat: 51.6, lon: 45.98 },
        ],
      }),
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    return json({
      configured: true,
      provider: "2gis",
      proxy: proxyUrl ? "proxy" : "direct",
      keyMasked: "***" + key.slice(-2),
      status: res.status,
      ok: res.ok,
      response: text.slice(0, 300),
      },
      200,
      { "X-Request-Id": requestId }
    );
  } catch (err) {
    return json(
      {
        configured: true,
        provider: "2gis",
        proxy: proxyUrl ? "proxy" : "direct",
        keyMasked: "***" + key.slice(-2),
        error: err instanceof Error ? err.message : String(err),
      },
      200,
      { "X-Request-Id": requestId }
    );
  }
}
