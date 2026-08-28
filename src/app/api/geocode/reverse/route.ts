// GET /api/geocode/reverse?lat=&lon= — Nominatim reverse geocode, cached in Setting table.
import { NextRequest } from "next/server";
import { authorizeRequest } from "@/lib/auth";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import { libsql } from "@/lib/db";
import { setSetting, getSetting } from "@/lib/settings";

export const dynamic = "force-dynamic";

function round(n: number, digits = 4): number {
  const f = Math.pow(10, digits);
  return Math.round(n * f) / f;
}

function cacheKey(lat: number, lon: number): string {
  return `geocode:${round(lat, 4)},${round(lon, 4)}`;
}

export async function GET(request: NextRequest) {
  const requestId = request.headers.get("x-request-id") || crypto.randomUUID();
  try {
    const auth = await authorizeRequest(request, "api");
    if (!auth.ok) return json({ error: auth.reason }, 401, { "X-Request-Id": requestId });

    const url = new URL(request.url);
    const latStr = url.searchParams.get("lat");
    const lonStr = url.searchParams.get("lon");
    if (!latStr || !lonStr) {
      return json({ error: "lat and lon query params required" }, 400, {
        "X-Request-Id": requestId,
      });
    }
    const lat = Number(latStr);
    const lon = Number(lonStr);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return json({ error: "Invalid coordinates" }, 400, { "X-Request-Id": requestId });
    }

    const key = cacheKey(lat, lon);
    // Check cache via Setting table (cached for 30 days).
    const cached = await getSetting(key);
    if (cached) {
      try {
        const parsed = JSON.parse(cached) as { address: string; cachedAt: string };
        return json({ ...parsed, cached: true }, 200, { "X-Request-Id": requestId });
      } catch {
        // ignore malformed cache
      }
    }

    // Call Nominatim (public, polite usage).
    const nominatimUrl = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(
      lat
    )}&lon=${encodeURIComponent(lon)}&zoom=18&addressdetails=1`;
    const res = await fetch(nominatimUrl, {
      headers: {
        "User-Agent": "telemetria-poedzok/2.6 (https://github.com/markovsaratov-crypto/telemetria-poedzok)",
        "Accept-Language": "ru",
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      // Fall back to coordinates only
      return json(
        { address: `${lat.toFixed(5)}, ${lon.toFixed(5)}`, cached: false, error: `nominatim_${res.status}` },
        200,
        { "X-Request-Id": requestId }
      );
    }
    const data = (await res.json()) as { display_name?: string; address?: Record<string, string> };
    const address = data.display_name || `${lat.toFixed(5)}, ${lon.toFixed(5)}`;

    // Save to Setting table
    const cachedAt = new Date().toISOString();
    const cacheValue = JSON.stringify({ address, cachedAt, raw: data.address ?? null });
    try {
      await setSetting(key, cacheValue, "geocode-cache");
      void libsql; // ensure imported
    } catch (e) {
      logger.warn("Geocode cache write failed", {
        requestId,
        error: e instanceof Error ? e.message : String(e),
      });
    }

    return json({ address, cachedAt, cached: false }, 200, { "X-Request-Id": requestId });
  } catch (err) {
    logger.error("Geocode reverse error", {
      requestId,
      error: err instanceof Error ? err.message : String(err),
    });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}
