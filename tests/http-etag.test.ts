// tests/http-etag.test.ts — v2.39.0 (§A2): юнит-тесты слабого ETag + SWR-кэша
// GET /api/stats и /api/trips/batch. Проверяются: детерминизм/формат хэша
// (известные SHA-256-векторы), мягкий разбор If-None-Match (RFC 9110 §13.1.2)
// и обе ветки jsonWithEtag (200 с телом / 304 с пустым телом и теми же
// заголовками кэша).
import { describe, it, expect } from "vitest";
import type { NextRequest } from "next/server";
import {
  computeWeakEtag,
  ifNoneMatchMatches,
  jsonWithEtag,
  CACHE_CONTROL_PRIVATE_SWR,
} from "../src/lib/http-utils";

const mockRequest = (headers: Record<string, string> = {}): NextRequest =>
  ({ headers: new Headers(headers) }) as unknown as NextRequest;

describe("§A2 computeWeakEtag — SHA-256 → 16 байт hex с W/-префиксом", () => {
  it("известный вектор: SHA-256('abc') первые 32 hex-символа", async () => {
    // ba7816bf8f01cfea414140de5dae2223 | b00361a3… — сверка с эталоном digest
    expect(await computeWeakEtag("abc")).toBe('W/"ba7816bf8f01cfea414140de5dae2223"');
  });

  it("пустая строка — SHA-256('') (e3b0c442…)", async () => {
    expect(await computeWeakEtag("")).toBe('W/"e3b0c44298fc1c149afbf4c8996fb924"');
  });

  it("детерминизм: одинаковый вход → одинаковый ETag", async () => {
    const a = await computeWeakEtag("stats|own|2026-09-18|{}");
    const b = await computeWeakEtag("stats|own|2026-09-18|{}");
    expect(a).toBe(b);
  });

  it("разный вход → разный ETag (кэш-ключ скопа/дня различается)", async () => {
    const a = await computeWeakEtag("stats|own|2026-09-18");
    const b = await computeWeakEtag("stats|own|2026-09-19");
    expect(a).not.toBe(b);
  });

  it("формат: W/\"<32 hex>\"", async () => {
    await expect(computeWeakEtag("x")).resolves.toMatch(/^W\/"[0-9a-f]{32}"$/);
  });
});

describe("§A2 ifNoneMatchMatches — мягкое сравнение (RFC 9110 §13.1.2)", () => {
  const etag = 'W/"abc123"';

  it("заголовка нет → false", () => {
    expect(ifNoneMatchMatches(null, etag)).toBe(false);
    expect(ifNoneMatchMatches("", etag)).toBe(false);
  });

  it("'*' матчит любой ETag", () => {
    expect(ifNoneMatchMatches("*", etag)).toBe(true);
  });

  it("точное совпадение", () => {
    expect(ifNoneMatchMatches(etag, etag)).toBe(true);
  });

  it("слабое сравнение: W/-префиксы обеих сторон игнорируются", () => {
    expect(ifNoneMatchMatches('"abc123"', etag)).toBe(true);
    expect(ifNoneMatchMatches('W/"abc123"', '"abc123"')).toBe(true);
  });

  it("список через запятую — совпадение любого элемента", () => {
    expect(ifNoneMatchMatches('W/"zzz", "abc123", W/"ddd"', etag)).toBe(true);
  });

  it("чужой список без совпадения → false", () => {
    expect(ifNoneMatchMatches('W/"aaa", W/"bbb"', etag)).toBe(false);
  });
});

describe("§A2 jsonWithEtag — 200/304 с сохранением заголовков кэша", () => {
  it("без If-None-Match → 200, тело JSON, ETag + Cache-Control выставлены", async () => {
    const etag = await computeWeakEtag("body-hash");
    const res = jsonWithEtag({ total: 1 }, etag, mockRequest());
    expect(res.status).toBe(200);
    expect(res.headers.get("etag")).toBe(etag);
    expect(res.headers.get("cache-control")).toBe(CACHE_CONTROL_PRIVATE_SWR);
    expect(await res.json()).toEqual({ total: 1 });
  });

  it("If-None-Match совпал → 304 БЕЗ тела, заголовки кэша сохранены", async () => {
    const etag = await computeWeakEtag("body-hash-2");
    const res = jsonWithEtag({ total: 2 }, etag, mockRequest({ "if-none-match": etag }));
    expect(res.status).toBe(304);
    expect(res.headers.get("etag")).toBe(etag);
    expect(res.headers.get("cache-control")).toBe(CACHE_CONTROL_PRIVATE_SWR);
    // 304 не допускает тела — парсинг должен дать пустоту/ошибку, не JSON
    const text = await res.text();
    expect(text).toBe("");
  });

  it("несовпавший If-None-Match → 200 (клиент получает новое тело)", async () => {
    const etag = await computeWeakEtag("v3");
    const res = jsonWithEtag({ v: 3 }, etag, mockRequest({ "if-none-match": 'W/"other"' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ v: 3 });
  });

  it("служебные headers (X-Request-Id) пробрасываются в обеих ветках", async () => {
    const etag = await computeWeakEtag("v4");
    const ok = jsonWithEtag({ v: 4 }, etag, mockRequest(), 200, { "X-Request-Id": "req-1" });
    expect(ok.headers.get("x-request-id")).toBe("req-1");
    const notMod = jsonWithEtag({ v: 4 }, etag, mockRequest({ "if-none-match": etag }), 200, {
      "X-Request-Id": "req-2",
    });
    expect(notMod.headers.get("x-request-id")).toBe("req-2");
  });

  it("Cache-Control — приватный SWR-профиль §A2 (max-age 30, SWR 60)", () => {
    expect(CACHE_CONTROL_PRIVATE_SWR).toBe("private, max-age=30, stale-while-revalidate=60");
    expect(CACHE_CONTROL_PRIVATE_SWR.startsWith("private")).toBe(true); // не общий CDN-кэш
  });
});
