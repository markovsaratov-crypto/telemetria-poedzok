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
  // R5.1: align with src/lib/routing/chain.ts — routing.api.2gis.ru is dead,
  // the live 2ГИС routing host is catalog.api.2gis.ru (works globally with this key).
  const baseUrl = proxyUrl || "https://catalog.api.2gis.ru";
  const apiUrl = `${baseUrl}/carrouting/6.0.0/global?key=${key}`;

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
      status: res.status,
      ok: res.ok,
      response: text.slice(0, 300),
      },
      res.ok ? 200 : 502,
      { "X-Request-Id": requestId }
    );
  } catch (err) {
    // v2.16.0 (B18): сбой провайдера — ЧЕСТНЫЙ 502 (200 с полем error клиенты
    // не отличали от успеха); фрагмент ключа из ответа убран (светились последние
    // 2 символа)
    return json(
      {
        configured: true,
        provider: "2gis",
        proxy: proxyUrl ? "proxy" : "direct",
        error: err instanceof Error ? err.message : String(err),
      },
      502,
      { "X-Request-Id": requestId }
    );
  }
}
