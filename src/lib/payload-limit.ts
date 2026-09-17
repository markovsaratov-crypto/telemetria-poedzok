// src/lib/payload-limit.ts — v2.38.1 (ревью F20): РЕАЛЬНЫЙ лимит размера тела
// запроса для инжест-роутов.
//
// Проблема: proxy.ts проверял только заголовок Content-Length — запрос с
// Transfer-Encoding: chunked (без content-length) проходил свободно, оба
// инжест-роута звали request.json() без ограничений, а Zod-валидация точек
// срабатывала ПОСЛЕ полного парсинга в память. Один chunked-запрос на сотни
// МБ укладывал инстанс (Render free 512 МБ).
//
// Решение: роуты читают тело текстом и сверяют Buffer.byteLength с тем же
// env().MAX_PAYLOAD_BYTES (256 КБ по умолчанию), который использует proxy,
// ДО json.parse/Zod. Модуль-константа — отдельный (http-utils.ts принадлежит
// другому направлению правок), но источник значения один: env().
import { env } from "./env";

/** Тот же лимит, что и в payload-guard proxy.ts (env MAX_PAYLOAD_BYTES). */
export function payloadLimitBytes(): number {
  return env().MAX_PAYLOAD_BYTES;
}

/** Проверка реальной длины прочитанного тела (после await req.text()). */
export function isPayloadTooLarge(bodyBytes: number): boolean {
  return bodyBytes > payloadLimitBytes();
}
