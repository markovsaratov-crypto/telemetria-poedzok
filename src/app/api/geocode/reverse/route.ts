// GET /api/geocode/reverse?lat=&lon= — Nominatim reverse geocode, cached in Setting table.
// v2.12.0 (Q3): возвращает и «short» — компактную подпись конечной точки
// («улица Ленина, 44» / «Центральный район») для заголовков поездок.
import { NextRequest } from "next/server";
import { authorizeRequest } from "@/lib/auth";
import { json } from "@/lib/http-utils";
import { logger } from "@/lib/logger";
import { setSetting, getSettingDirect, getSettingSync } from "@/lib/settings"; // v2.18.0: точечный read (без full-table refresh); v2.25.0: getSettingSync — ключ 2ГИС

export const dynamic = "force-dynamic";

function round(n: number, digits = 4): number {
  const f = Math.pow(10, digits);
  return Math.round(n * f) / f;
}

function cacheKey(lat: number, lon: number): string {
  return `geocode:${round(lat, 4)},${round(lon, 4)}`;
}

// v2.16.0 (B11): TTL кэша геокода — 30 суток (комментарий «кэш 30 дней» был
// до этого ложью: записей expiry не существовало ВООБЩЕ, они жили в таблице
// Setting вечно). Чтение теперь сверяет cachedAt; чистка протухших строк —
// в retention-cron (ключи geocode:*).
const GEOCODE_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

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
    const cached = await getSettingDirect(key); // v2.18.0: geocode-кэш не грузит всю таблицу Setting
    if (cached) {
      // v2.16.0 (B11): протухшая запись (>30 дней) — НЕ хит, обновляем живым запросом
      let expired = false;
      try {
        const probe = JSON.parse(cached) as { cachedAt?: string };
        if (probe && typeof probe.cachedAt === "string") {
          expired = Date.now() - Date.parse(probe.cachedAt) > GEOCODE_CACHE_TTL_MS;
        }
      } catch {
        // legacy-кэш без JSON/cachedAt — считаем свежим (адреса не меняются часто)
      }
      if (!expired) {
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
    }

    // v2.25.0 (П.1): цепочка провайдеров Nominatim → 2ГИС → координаты.
    // Прод-кейс 10.09: Nominatim с Render-франкфурта недоступен (таймаут/429) —
    // заголовки поездок показывали «→ 51.48900, 46.12461» сырыми координатами,
    // при том что адрес (Тельмана улица, 23а, Энгельс) существует в 2ГИС.
    // 2ГИС-геокодер использует уже настроенный ключ каталога (TWO_GIS_API_KEY),
    // работает из любой точки мира и знает адреса РФ/СНГ детальнее Nominatim.

    // --- Провайдер 1: Nominatim (OSM) ---
    let nominatimData: { display_name?: string; address?: Record<string, string> } | null = null;
    try {
      const nominatimUrl = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(
        lat
      )}&lon=${encodeURIComponent(lon)}&zoom=18&addressdetails=1`;
      const res = await fetch(nominatimUrl, {
        headers: {
          "User-Agent": "telemetria-poedzok/2.25 (https://github.com/markovsaratov-crypto/telemetria-poedzok)",
          "Accept-Language": "ru",
        },
        signal: AbortSignal.timeout(8000),
      });
      // v2.25.0: прежний код при !res.ok возвращал координаты СРАЗУ; при
      // network-ошибке (таймаут) вообще валился в 500. Теперь оба случая —
      // просто «провайдер недоступен», пробуем следующий.
      if (res.ok) {
        nominatimData = (await res.json()) as { display_name?: string; address?: Record<string, string> };
      } else {
        logger.warn("Nominatim reverse geocode failed", { requestId, status: res.status });
      }
    } catch (e) {
      logger.warn("Nominatim reverse geocode error", {
        requestId,
        error: e instanceof Error ? e.message : String(e),
      });
    }

    if (nominatimData && nominatimData.display_name) {
      const address = nominatimData.display_name;
      const short = shortAddress(nominatimData.address ?? null, address);

      // Save to Setting table
      const cachedAt = new Date().toISOString();
      const cacheValue = JSON.stringify({ address, short, cachedAt, raw: nominatimData.address ?? null });
      try {
        await setSetting(key, cacheValue, "geocode-cache");
      } catch (e) {
        logger.warn("Geocode cache write failed", {
          requestId,
          error: e instanceof Error ? e.message : String(e),
        });
      }

      return json({ address, short, cachedAt, cached: false, provider: "nominatim" }, 200, { "X-Request-Id": requestId });
    }

    // --- Провайдер 2: 2ГИС (ключ каталога, РФ/СНГ-адреса) ---
    try {
      const dgisKey = getSettingSync("TWO_GIS_API_KEY");
      if (dgisKey) {
        const proxyUrl = getSettingSync("TWO_GIS_PROXY_URL") || process.env.TWO_GIS_PROXY_URL || "";
        const baseUrl = proxyUrl || "https://catalog.api.2gis.ru";
        // 2ГИС 3.0 items/geocode: q={lon},{lat} — обратное геокодирование координат.
        // items.adm_div — административная привязка: нужна для БЕЗЫМЯННЫХ точек
        // (парковка/поле без названия — v2.25.0: «куда: 51.48971, 46.13059»
        // хотя район/город известны).
        const url = `${baseUrl}/3.0/items/geocode?q=${encodeURIComponent(lon)},${encodeURIComponent(lat)}&fields=items.adm_div&key=${dgisKey}`;
        const res = await fetch(url, {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(8000),
        });
        if (res.ok) {
          const data = (await res.json()) as {
            result?: {
              items?: Array<{
                type?: string;
                subtype?: string;
                full_name?: string;
                name?: string;
                address_name?: string;
                adm_div?: Array<{ name?: string; type?: string }>;
              }>;
            };
          };
          const items = data.result?.items ?? [];
          // items[0] — «coordinates»-заглушка; первый осмысленный — building/street/place
          const item = items.find((it) => it.type !== "coordinates");
          // v2.25.0 (П.1): подпись из имени объекта → адреса → административной
          // привязки (adm_div: город → район → регион). Даже безымянная парковка
          // получает «Энгельс» вместо сырых координат.
          const adm = item?.adm_div ?? [];
          const admCity = [...adm].reverse().find((a) => a.type === "city" || a.type === "town" || a.type === "settlement")?.name ?? null;
          const admArea = [...adm].reverse().find((a) => a.type === "district_area" || a.type === "district")?.name ?? null;
          const admRegion = adm.find((a) => a.type === "region")?.name ?? null;
          const itemName = item?.full_name || item?.name || item?.address_name || null;
          const itemShort = item?.address_name || item?.name || null;
          const placeShort = admCity ?? admArea ?? admRegion ?? null;
          if (itemName || placeShort) {
            // Полный адрес: имя объекта; иначе административная цепочка (регион → район → город)
            const address = itemName || [admRegion, admArea, admCity].filter(Boolean).join(", ");
            const subtypeNote = item?.subtype ? ` (${item.subtype === "ground" ? "парковка" : item.subtype})` : "";
            const short = itemShort || placeShort;
            const cachedAt = new Date().toISOString();
            const cacheValue = JSON.stringify({ address: address + subtypeNote, short, cachedAt, raw: null, provider: "2gis" });
            try {
              await setSetting(key, cacheValue, "geocode-cache");
            } catch (e) {
              logger.warn("Geocode cache write failed (2gis)", {
                requestId,
                error: e instanceof Error ? e.message : String(e),
              });
            }
            return json({ address: address + subtypeNote, short, cachedAt, cached: false, provider: "2gis" }, 200, { "X-Request-Id": requestId });
          }
        } else {
          logger.warn("2GIS reverse geocode failed", { requestId, status: res.status });
        }
      }
    } catch (e) {
      logger.warn("2GIS reverse geocode error", {
        requestId,
        error: e instanceof Error ? e.message : String(e),
      });
    }

    // --- Оба провайдера недоступны: координаты (НЕ кэшируем — при следующем
    // запросе попробуем снова, провайдеры могут подняться) ---
    const coords = `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
    return json(
      { address: coords, short: coords, cached: false, provider: "none", error: "geocode_unavailable" },
      200,
      { "X-Request-Id": requestId }
    );
  } catch (err) {
    logger.error("Geocode reverse error", {
      requestId,
      error: err instanceof Error ? err.message : String(err),
    });
    return json({ error: "Internal Server Error" }, 500, { "X-Request-Id": requestId });
  }
}
