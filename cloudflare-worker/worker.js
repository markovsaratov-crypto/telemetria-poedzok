// Cloudflare Worker: 2GIS API Proxy
// Проксирует запросы к 2ГИС routing API через российский edge-сервер Cloudflare.
// Решает проблему: Render (EU) не может достучаться до routing.api.2gis.ru.
//
// Развертывание:
// 1. Зарегистрируйся на https://dash.cloudflare.com (бесплатно, без карты)
// 2. Слева меню → Workers & Pages → Create application → Create Worker
// 3. Назови worker: telemetria-2gis-proxy
// 4. Скопируй весь этот код в редакор
// 5. Нажми Save and Deploy
// 6. Получишь URL: https://telemetria-2gis-proxy.<твой-subdomain>.workers.dev
// 7. Сохрани URL — он понадобится в chain.ts
//
// Лимит: 100 000 запросов/день (бесплатно)

export default {
  async fetch(request: Request): Promise<Response> {
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
      // Получаем key из query параметра
      const url = new URL(request.url);
      const key = url.searchParams.get("key");

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
  },
};
