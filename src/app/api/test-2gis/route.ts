export const dynamic = "force-dynamic";
import { NextRequest } from "next/server";
import { json } from "@/lib/http-utils";

export async function GET(request: NextRequest) {
  const { getSettingSync } = await import("@/lib/settings");
  const key = getSettingSync("TWO_GIS_API_KEY");
  if (!key) return json({ error: "No TWO_GIS_API_KEY" }, 400);
  
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
          { lat: 51.60, lon: 45.98 },
        ],
      }),
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    return json({
      key: key.slice(0, 6) + "..." + key.slice(-4),
      proxyUrl: proxyUrl || "DIRECT (no proxy)",
      apiUrl: apiUrl.slice(0, 80),
      status: res.status,
      response: text.slice(0, 500),
    });
  } catch (err) {
    return json({
      key: key.slice(0, 6) + "..." + key.slice(-4),
      proxyUrl: proxyUrl || "DIRECT (no proxy)",
      apiUrl: apiUrl.slice(0, 80),
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
