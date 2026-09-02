// GET /api/geocode/reverse?lat=&lon= — Nominatim reverse geocode, cached in Setting table.
// v2.12.0 (Q3): возвращает и «short» — компактную подпись конечной точки
// («улица Ленина, 44» / «Центральный район») для заголовков поездок.
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

// v2.12.0 (Q3): короткая человекочитаемая подпись из компонентов адреса.
// Приоритет: улица+дом → улица → район/населённый пункт. Fallback — первые
// два компонента display_name (для старых записей кэша без raw).
function shortAddress(
  raw: Record<string, string> | null | undefined,
  display: string
): string {
  if (raw && typeof raw === "object") {
    const road = raw.road ?? raw.pedestrian ?? raw.footway ?? raw.path ?? null;
    const house = raw.house_number ?? null;
    if (road && house) return `${road}, ${house}`;
    if (road) return road;
    const area =
      raw.neighbourhood ?? raw.suburb ?? raw.quarter ?? raw.village ??
      raw.town ?? raw.city ?? null;
    if (area) return area;
  }
  const parts = display.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 2) return `${parts[0]}, ${parts[1]}`;
  return display;
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
        const parsed = JSON.parse(cached) as {
          address: string;
          short?: string;
          cachedAt: string;
          raw?: Record<string, string> | null;
        };
        return json(
          {
            address: parsed.address,
            short: parsed.short ?? shortAddress(parsed.raw ?? null, parsed.address),
            cachedAt: parsed.cachedAt,
            cached: true,
          },
          200,
          { "X-Request-Id": requestId }
        );
      } catch {
        // v2.12.0: legacy-кэш до v2.12 — голая строка адреса (не JSON).
        // Используем как есть, короткую подпись строим из display_name.
        return json(
          {
            address: cached,
            short: shortAddress(null, cached),
            cachedAt: new Date().toISOString(),
            cached: true,
          },
          200,
          { "X-Request-Id": requestId }
        );
      }
    }

    // Call Nominatim (public, polite usage).
    const nominatimUrl = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(
      lat
    )}&lon=${encodeURIComponent(lon)}&zoom=18&addressdetails=1`;
    const res = await fetch(nominatimUrl, {
      headers: {
        "User-Agent": "telemetria-poedzok/2.12 (https://github.com/markovsaratov-crypto/telemetria-poedzok)",
        "Accept-Language": "ru",
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      // Fall back to coordinates only
      const coords = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
      return json(
        { address: coords, short: coords, cached: false, error: `nominatim_${res.status}` },
        200,
        { "X-Request-Id": requestId }
      );
    }
    const data = (await res.json()) as { display_name?: string; address?: Record<string, string> };
    const address = data.display_name || `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
    const short = shortAddress(data.address ?? null, address);

    // Save to Setting table
    const cachedAt = new Date().toISOString();
    const cacheValue = JSON.stringify({ address, short, cachedAt, raw: data.address ?? null });
    try {
      await setSetting(key, cacheValue, "geocode-cache");
      void libsql; // ensure imported
    } catch (e) {
      logger.warn("Geocode cache write failed", {
        requestId,
        error: e instanceof Error ? e.message : String(e),
      });
    }

    return json({ address, short, cachedAt, cached: false }, 200, { "X-Request-Id": requestId });
  } catch (err) {
    logger.error("Geocode reverse error", {
      requestId,
      error: err instanceof Error ? err.message : String(err),
    });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}
