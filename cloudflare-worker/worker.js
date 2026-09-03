// Cloudflare Worker: 2GIS API Proxy
// Проксирует запросы к 2ГИС routing API через российский edge-сервер Cloudflare.
// Решает проблему: Render (EU) не может достучаться до routing.api.2gis.ru.
//
// Развертывание:
// 1. Зарегистрируйся на https://dash.cloudflare.com (бесплатно, без карты)
// 2. Слева меню → Workers & Pages → Create application → Create Worker
// 3. Назови worker: telemetria-2gis-proxy
// 4. Скопируй весь этот код в редактор
// 5. Задай секрет воркера (Settings → Variables): PROXY_SECRET — любое длинное
//    случайное значение. Без него воркер — ОТКРЫТЫЙ прокси (квота 2ГИС утекает).
//    В chain.ts проксирующий URL тогда должен содержать &secret=<PROXY_SECRET>.
// 6. Нажми Save and Deploy
// 7. Получишь URL: https://telemetria-2gis-proxy.<твой-subdomain>.workers.dev
// 8. Сохрани URL — он понадобится в chain.ts
//
// Лимит: 100 000 запросов/день (бесплатно)
//
// v2.16.0 (V4/S5): убраны TS-аннотации из .js (не деплоился в CF-редактор);
// добавлена авторизация по секрету PROXY_SECRET (раньше — открытый прокси:
// любой мог прожигать чужую квоту 2ГИС, а ключ светился в логах).

async function handleRequest(request) {
  // CORS headers
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }

  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const url = new URL(request.url);
    const key = url.searchParams.get("key");

    // v2.16.0 (S5): секрет обязателен — иначе прокси открыт всему интернету
    const expectedSecret = (typeof PROXY_SECRET !== "undefined" && PROXY_SECRET) || null;
    if (expectedSecret) {
      const provided = request.headers.get("x-proxy-secret") || url.searchParams.get("secret");
      if (provided !== expectedSecret) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    if (!key) {
      return new Response(JSON.stringify({ error: "Missing key parameter" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Читаем тело запроса (points array)
    const body = await request.text();

    // Проксируем к 2ГИС API
    const twoGisUrl = `https://routing.api.2gis.ru/carrouting/6.0.0/global?key=${key}`;
    const twoGisRes = await fetch(twoGisUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: body,
    });

    // Возвращаем ответ 2ГИС
    const twoGisBody = await twoGisRes.text();
    return new Response(twoGisBody, {
      status: twoGisRes.status,
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "Proxy error", message: err instanceof Error ? err.message : String(err) }),
      {
        status: 502,
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      }
    );
  }
}

const worker = { fetch: handleRequest };

export default worker;
