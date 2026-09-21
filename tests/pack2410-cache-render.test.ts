// tests/pack2410-cache-render.test.ts — v2.41.0: честность кэша ПО ПОЛЯМ
// (P0-A, N-8 «лжесвежесть частичным write-through») + рендер-прореживание
// батч-ответов (P0-C, N-9) + SWR (m-22) + метр квоты шлюза (P1, m-21).
//
// РЕГРЕССИЯ N-8 (прод-кейс 20.09, сессия 920ff881): строка Session.cacheVersion=10
// проставлена stats/batch (конвейер v2.40.7), trackCache той же строки — от
// конвейера v2.40.6 (ДО фильтра островов N-3) → 2 точки Казахстана жили на
// карте как «свежие». Инвариант: свежесть поля определяется ШТАМПОМ ВНУТРИ
// payload (cacheV), а не строкой, которую пишут чужие батч-роуты.
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import {
  SESSION_CACHE_VERSION,
  getCachedPayload,
  detectStaleCacheFields,
  type SessionCacheMeta,
} from "../src/lib/session-cache";
import { CACHE_PIPELINE_VERSIONS, payloadCacheV } from "../src/lib/cache-versions";
import { computeSessionTrack } from "../src/lib/session-track";
import { computeSessionEvents } from "../src/lib/session-events";
import { computeSessionStats } from "../src/lib/session-stats";
import {
  thinTrackForRender,
  thinEventsForRender,
  parseRenderMode,
  RENDER_MAX_POINTS_DEFAULT,
  RENDER_EVENTS_CAPS,
} from "../src/lib/track-render";
import { TtlCache } from "../src/lib/ttl-cache";
import {
  getGatewayDayBudget,
  resetGatewayDayBudgetForTests,
  D1_DAILY_READ_LIMIT,
} from "../src/lib/gateway-budget";

// ——— синтетика: поездка ~100 с, 1 Гц, скорость 15 м/с на юг ———
function synthPoints(n: number) {
  const out: Array<{
    lat: number; lon: number; speed: number | null; altitude: number | null;
    accuracy: number | null; bearing: number | null; timestamp: number;
  }> = [];
  for (let i = 0; i < n; i++) {
    out.push({
      lat: 51.53 - i * 0.0001,
      lon: 45.99,
      speed: 15,
      altitude: 150,
      accuracy: 5,
      bearing: 180,
      timestamp: 1_760_000_000_000 + i * 1000,
    });
  }
  return out;
}

const SESSION = {
  id: "sess-test",
  deviceId: "dev-test",
  startTime: "2026-09-21T10:00:00.000Z",
  endTime: "2026-09-21T10:05:00.000Z",
  pointCount: 100,
};

const meta = (over: Partial<SessionCacheMeta>): SessionCacheMeta => ({
  id: "s1",
  deviceId: "d1",
  startTime: "2026-09-20T10:00:00.000Z",
  endTime: "2026-09-20T11:00:00.000Z",
  deleted: false,
  routeHash: null,
  topologyHash: null,
  pointCount: 100,
  cachePointCount: 100,
  cacheVersion: SESSION_CACHE_VERSION,
  statsCache: "{}",
  eventsCache: "{}",
  trackCache: "{}",
  ...over,
});

describe("§P0-A N-8: штампы конвейеров в payload", () => {
  it("computeSessionTrack несёт cacheV конвейера трека", () => {
    const payload = computeSessionTrack(SESSION, synthPoints(100));
    expect(payloadCacheV(payload)).toBe(CACHE_PIPELINE_VERSIONS.track);
  });

  it("computeSessionEvents несёт cacheV конвейера событий", () => {
    const payload = computeSessionEvents("sess-test", "dev-test", synthPoints(100));
    expect(payloadCacheV(payload)).toBe(CACHE_PIPELINE_VERSIONS.events);
  });

  it("computeSessionStats несёт cacheV конвейера статов (full и empty)", () => {
    const full = computeSessionStats(
      { id: SESSION.id, startTime: SESSION.startTime, endTime: SESSION.endTime, routeHash: null, topologyHash: null },
      synthPoints(100)
    );
    expect(full.kind).toBe("full");
    expect(payloadCacheV(full.payload)).toBe(CACHE_PIPELINE_VERSIONS.stats);

    const empty = computeSessionStats(
      { id: SESSION.id, startTime: SESSION.startTime, endTime: null, routeHash: null, topologyHash: null },
      []
    );
    expect(empty.kind).toBe("empty");
    expect(payloadCacheV(empty.payload)).toBe(CACHE_PIPELINE_VERSIONS.stats);
  });

  it("payload без cacheV (все записи до v2.41.0) → версия 0", () => {
    expect(payloadCacheV({ sessionId: "x" })).toBe(0);
    expect(payloadCacheV(null)).toBe(0);
  });

  it("statsCache хранит ОБЁРТКУ {kind,payload} — штамп разворачивается (дебаг бэкфилла 21.09)", () => {
    const wrapper = { kind: "full" as const, payload: { sessionId: "s1", cacheV: CACHE_PIPELINE_VERSIONS.stats } };
    expect(payloadCacheV(wrapper)).toBe(CACHE_PIPELINE_VERSIONS.stats);
    // обёртка без штампа внутри — честный 0
    expect(payloadCacheV({ kind: "full", payload: { sessionId: "s1" } })).toBe(0);
  });

  it("getCachedPayload отдаёт обёртку SessionStatsResult как есть (потребитель читает .kind/.payload)", () => {
    const wrapper = { kind: "full" as const, payload: { sessionId: "s1", cacheV: CACHE_PIPELINE_VERSIONS.stats, pointCount: 10 } };
    const m = meta({ statsCache: JSON.stringify(wrapper) });
    const got = getCachedPayload<{ kind: string; payload: unknown }>(m, "stats");
    expect(got).not.toBeNull();
    expect(got!.kind).toBe("full");
  });
});

describe("§P0-A N-8: свежесть ПО ПОЛЯМ (getCachedPayload)", () => {
  it("РЕГРЕССИЯ 920ff881: строка свежа, trackCache от СТАРОГО конвейера → null", () => {
    // строка «отстирана» чужим батч-роутом (stats/batch): cacheVersion=10,
    // cachePointCount совпал, НО trackCache записан конвейером до v2.41.0
    // (штампа нет = версия 0)
    const m = meta({
      statsCache: JSON.stringify({ cacheV: CACHE_PIPELINE_VERSIONS.stats, sessionId: "s1" }),
      trackCache: JSON.stringify({ sessionId: "s1", points: [{ i: 0, t: 0, lat: 49.73, lng: 58.28, v: 1, st: 1 }] }),
    });
    expect(getCachedPayload(m, "track")).toBeNull(); // лжесвежесть закрыта
    expect(getCachedPayload(m, "stats")).not.toBeNull(); // своё поле — свежее
  });

  it("payload с ТЕКУЩЕЙ версией конвейера → отдаётся", () => {
    const m = meta({
      trackCache: JSON.stringify({ cacheV: CACHE_PIPELINE_VERSIONS.track, sessionId: "s1", points: [] }),
    });
    expect(getCachedPayload<{ sessionId: string }>(m, "track")).not.toBeNull();
  });

  it("строка протухла (pointCount разошёлся) → поле протухло даже с верным cacheV", () => {
    const m = meta({
      cachePointCount: 99,
      trackCache: JSON.stringify({ cacheV: CACHE_PIPELINE_VERSIONS.track, sessionId: "s1" }),
    });
    expect(getCachedPayload(m, "track")).toBeNull();
  });

  it("oversized-маркер и NULL — честно «не свежо» (семантика F51 сохранена)", () => {
    expect(getCachedPayload(meta({ trackCache: "__TELEMAT_CACHE_OVERSIZED__" }), "track")).toBeNull();
    expect(getCachedPayload(meta({ trackCache: null }), "track")).toBeNull();
  });
});

describe("§P0-B: инвентарь протухших полей (detectStaleCacheFields)", () => {
  const freshRow = {
    pointCount: 100 as number | null,
    cachePointCount: 100 as number | null,
    cacheVersion: SESSION_CACHE_VERSION as number | null,
    statsCache: JSON.stringify({ cacheV: CACHE_PIPELINE_VERSIONS.stats }),
    eventsCache: JSON.stringify({ cacheV: CACHE_PIPELINE_VERSIONS.events }),
    trackCache: JSON.stringify({ cacheV: CACHE_PIPELINE_VERSIONS.track }),
  };

  it("всё свежо → пустой список (бэкфилл ничего не делает)", () => {
    expect(detectStaleCacheFields(freshRow)).toEqual([]);
  });

  it("N-8: только trackCache старого конвейера → ['track'] (точечный ремонт)", () => {
    expect(
      detectStaleCacheFields({ ...freshRow, trackCache: JSON.stringify({ sessionId: "x" }) })
    ).toEqual(["track"]);
  });

  it("строчный критерий (состав точек) → все три поля", () => {
    expect(detectStaleCacheFields({ ...freshRow, cachePointCount: 99 })).toEqual(["stats", "events", "track"]);
  });

  it("битый JSON-кэш → поле протухло (пересчёт on-demand)", () => {
    expect(detectStaleCacheFields({ ...freshRow, eventsCache: "{oops" })).toEqual(["events"]);
  });
});

describe("§P0-C N-9: thinTrackForRender — прореживание трека", () => {
  const full = computeSessionTrack(SESSION, synthPoints(100)) as Record<string, unknown>;

  it("точки ≤ maxPoints, компактные поля, перенумерация i", () => {
    const thin = thinTrackForRender(full, 20) as Record<string, unknown>;
    const points = thin.points as Array<Record<string, unknown>>;
    expect(points.length).toBeLessThanOrEqual(20);
    for (const p of points) {
      expect(Object.keys(p).sort()).toEqual(["i", "lat", "lng", "st", "t", "v"]);
    }
    expect(points.map((p) => p.i)).toEqual(points.map((_, idx) => idx)); // 0..n-1 подряд
  });

  it("первая/последняя точки сохранены (старт/финиш маркеров)", () => {
    const thin = thinTrackForRender(full, 20) as Record<string, unknown>;
    const src = full.points as Array<{ lat: number; lng: number }>;
    const out = thin.points as Array<{ lat: number; lng: number }>;
    expect(out[0]!.lat).toBe(src[0]!.lat);
    expect(out[out.length - 1]!.lat).toBe(src[src.length - 1]!.lat);
  });

  it("сегменты пересобраны: Σ точек сегментов = числу оставшихся точек", () => {
    const thin = thinTrackForRender(full, 20) as Record<string, unknown>;
    const segments = thin.segments as Array<{ points: unknown[]; color: string }>;
    const points = thin.points as unknown[];
    expect(segments.reduce((a, s) => a + s.points.length, 0)).toBe(points.length);
    // цвета — из канонической таблицы бакетов
    const canonical = ["#9ca3af", "#f59e0b", "#10b981", "#3b82f6", "#8b5cf6", "#dc2626"];
    for (const s of segments) expect(canonical).toContain(s.color);
  });

  it("bounds/markers/legend — ИСХОДНЫЕ (авто-зум не дышит при сэмпле)", () => {
    const thin = thinTrackForRender(full, 20) as Record<string, unknown>;
    expect(thin.bounds).toEqual(full.bounds);
    expect(thin.markers).toEqual(full.markers);
    expect(thin.legend).toEqual(full.legend);
  });

  it("разрывы перемаплены в диапазон прореженного массива и уникальны", () => {
    // собираем payload с разрывами вручную (у синтетики dt=1с — разрывов нет)
    const payload: Record<string, unknown> = {
      ...full,
      points: Array.from({ length: 100 }, (_, i) => ({
        i, t: i * 100, lat: 51.5 - i * 0.0001, lng: 45.99, v: 15, st: 1,
      })),
      gaps: [
        { fromIdx: 10, toIdx: 11, durationSec: 120 },
        { fromIdx: 50, toIdx: 51, durationSec: 300 },
      ],
      harshPoints: Array.from({ length: 20 }, (_, i) => ({
        lat: 51.5, lng: 45.99, type: "braking", dv: (i + 1) * 0.1, idx: i, t: i,
      })),
    };
    const thin = thinTrackForRender(payload, 20, 5) as Record<string, unknown>;
    const points = thin.points as unknown[];
    const gaps = thin.gaps as Array<{ fromIdx: number; toIdx: number }>;
    const seen = new Set<number>();
    for (const g of gaps) {
      expect(g.fromIdx).toBeGreaterThanOrEqual(0);
      expect(g.toIdx).toBeLessThan(points.length);
      expect(g.fromIdx).toBeLessThan(g.toIdx);
      expect(seen.has(g.fromIdx)).toBe(false);
      seen.add(g.fromIdx);
    }
    // «самые резкие» ≤ maxHarsh, отсортированы по исходному порядку
    const harsh = thin.harshPoints as Array<{ dv: number; idx: number }>;
    expect(harsh.length).toBe(5);
    const dvs = harsh.map((h) => h.dv);
    expect(Math.max(...dvs)).toBe(2.0); // топ-5 по |dv| = 2.0, 1.9, 1.8, 1.7, 1.6
    expect(Math.min(...dvs)).toBe(1.6);
  });

  it("детерминирован: путь «из кэша» ≡ путь «live-конвейер»", () => {
    expect(thinTrackForRender(full, 20)).toEqual(thinTrackForRender(structuredClone(full), 20));
  });

  it("≤ maxPoints точек — без прореживания, поля всё равно компактные", () => {
    const thin = thinTrackForRender(full, 400) as Record<string, unknown>;
    expect((thin.points as unknown[]).length).toBe(100);
    expect((thin.points as Array<Record<string, unknown>>)[0]!["alt"]).toBeUndefined();
  });

  it("пустой трек — форма сохранена, render-метка для наблюдаемости", () => {
    const empty = computeSessionTrack(SESSION, []) as Record<string, unknown>;
    const thin = thinTrackForRender(empty, 20) as { points: unknown[]; render: { sourcePoints: number } };
    expect(thin.points).toEqual([]);
    expect(thin.render.sourcePoints).toBe(0);
  });
});

describe("§P0-C N-9: thinEventsForRender — потолки событий", () => {
  it("капы применены, summary — ПОЛНЫЙ (счётчики честные)", () => {
    const maneuvers = Array.from({ length: 1000 }, (_, i) => ({
      lat: 51.5, lng: 45.99, t: i, longA: 0.1, latA: 0.2, speed: 50, bearing: 90,
    }));
    const payload = {
      sessionId: "s1",
      cacheV: CACHE_PIPELINE_VERSIONS.events,
      maneuvers,
      gg: { points: maneuvers.map((m) => ({ x: m.longA / 9.81, y: m.latA / 9.81 })), rings: [0.2, 0.4, 0.6] },
      harshEvents: maneuvers.slice(0, 700).map((m) => ({
        lat: m.lat, lng: m.lng, type: "braking" as const, longA: m.longA, t: m.t, speed: m.speed,
      })),
      hscEvents: maneuvers.slice(0, 700).map((m) => ({
        lat: m.lat, lng: m.lng, t: m.t, turnDeg: 46, speed: m.speed,
      })),
      summary: {
        accelerationRMS: 0.5, jerkRMS: 1.2, harshBraking: 700, harshAcceleration: 0,
        maneuvers: 1000, hscCount: 700,
      },
    };
    const thin = thinEventsForRender(payload) as Record<string, unknown>;
    expect((thin.maneuvers as unknown[]).length).toBe(RENDER_EVENTS_CAPS.maneuvers);
    expect(((thin.gg as { points: unknown[] }).points)).toHaveLength(RENDER_EVENTS_CAPS.ggPoints);
    expect((thin.harshEvents as unknown[]).length).toBe(RENDER_EVENTS_CAPS.harshEvents);
    expect((thin.hscEvents as unknown[]).length).toBe(RENDER_EVENTS_CAPS.hscEvents);
    // счётчики НЕ прорежены — блок «События вождения» честен
    expect(thin.summary).toEqual(payload.summary);
  });

  it("малые payload — без потерь (капы не режут)", () => {
    const payload = computeSessionEvents("s1", "d1", synthPoints(50));
    const thin = thinEventsForRender(payload as unknown as Record<string, unknown>) as unknown as typeof payload;
    expect(thin.maneuvers.length).toBe(payload.maneuvers.length);
    expect(thin.summary).toEqual(payload.summary);
  });
});

describe("§P0-C: parseRenderMode — разбор ?mode=/?maxPoints=", () => {
  it("без mode — полный режим (совместимость потребителей)", () => {
    expect(parseRenderMode(null, null)).toEqual({ render: false, maxPoints: RENDER_MAX_POINTS_DEFAULT });
    expect(parseRenderMode("full", null).render).toBe(false);
  });
  it("mode=render — рендер с дефолтом 400", () => {
    expect(parseRenderMode("render", null)).toEqual({ render: true, maxPoints: RENDER_MAX_POINTS_DEFAULT });
  });
  it("maxPoints клампится: минимум 50, максимум 2000", () => {
    expect(parseRenderMode("render", "50").maxPoints).toBe(50);
    expect(parseRenderMode("render", "10").maxPoints).toBe(50); // ниже минимума → кламп вверх (сэмпл вырождается)
    expect(parseRenderMode("render", "9999").maxPoints).toBe(2000);
    expect(parseRenderMode("render", "abc").maxPoints).toBe(RENDER_MAX_POINTS_DEFAULT);
  });
});

describe("§P0-C m-22: TtlCache.getStale — SWR", () => {
  let cache: TtlCache<string>;
  const TTL = 50;

  beforeEach(() => {
    cache = new TtlCache<string>(TTL, 8);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("свежая запись — stale:false, onStale НЕ звался", () => {
    cache.set("k", "v1");
    const cb = vi.fn();
    const res = cache.getStale("k", cb);
    expect(res).toEqual({ value: "v1", stale: false });
    expect(cb).not.toHaveBeenCalled();
  });

  it("просроченная в stale-окне — stale:true + ОДНА ревалидация (анти-стампедо)", () => {
    cache.set("k", "v1");
    const cb = vi.fn();
    vi.advanceTimersByTime(TTL + 1); // истёк TTL, внутри stale-окна
    const a = cache.getStale("k", cb);
    expect(a).toEqual({ value: "v1", stale: true }); // старое значение немедленно
    const b = cache.getStale("k", cb); // конкурент ДО завершения ревалидации
    expect(b).toEqual({ value: "v1", stale: true });
    expect(cb).toHaveBeenCalledTimes(1); // одиночный полёт
    cache.set("k", "v2"); // фоновая ревалидация завершилась записью
    const c = cache.getStale("k", cb);
    expect(c).toEqual({ value: "v2", stale: false }); // после set() — свежая
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("старше 2×ttl — честный miss (полный путь)", () => {
    cache.set("k", "v1");
    vi.advanceTimersByTime(2 * TTL + 1);
    expect(cache.getStale("k", vi.fn())).toBeUndefined();
    expect(cache.get("k")).toBeUndefined();
  });

  it("сбой onStale не роняет чтение и снимает одиночный полёт", () => {
    cache.set("k", "v1");
    vi.advanceTimersByTime(TTL + 1);
    const boom = vi.fn(() => {
      throw new Error("revalidation failed");
    });
    const res = cache.getStale("k", boom); // синхронный throw внутри onStale
    expect(res).toEqual({ value: "v1", stale: true });
    expect(boom).toHaveBeenCalledTimes(1);
    const cb = vi.fn();
    expect(cache.getStale("k", cb)).toEqual({ value: "v1", stale: true }); // полёт снят — ретрай возможен
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe("§P1 m-21: getGatewayDayBudget — авторитетный метр шлюза", () => {
  beforeEach(() => {
    resetGatewayDayBudgetForTests();
    process.env.D1_GATEWAY_URL = "https://gw.test";
    process.env.D1_GATEWAY_SECRET = "sec-test";
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.D1_GATEWAY_URL;
    delete process.env.D1_GATEWAY_SECRET;
  });

  it("парсит KV-запись дня и считает проценты", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ value: JSON.stringify({ rowsRead: 510_057, rowsWritten: 1_234, quotaExhaustedAt: null }) }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);
    const budget = await getGatewayDayBudget();
    expect(budget).not.toBeNull();
    expect(budget!.rowsRead).toBe(510_057);
    expect(budget!.rowsWritten).toBe(1_234);
    expect(budget!.readPct).toBe(Math.round((510_057 / D1_DAILY_READ_LIMIT) * 1000) / 10);
    expect(budget!.quotaExhaustedAt).toBeNull();
    // ключ дня — quota:day:<UTC-сегодня> (конвенция d1-gateway.js)
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.key).toBe(`quota:day:${new Date().toISOString().slice(0, 10)}`);
  });

  it("записи дня нет → честные нули (метр жив)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ value: null }), { status: 200 })));
    const budget = await getGatewayDayBudget();
    expect(budget).not.toBeNull();
    expect(budget!.rowsRead).toBe(0);
    expect(budget!.readPct).toBe(0);
  });

  it("канал упал → null (НЕ-fatal; счётчик приложения не подмешивается)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("oops", { status: 500 })));
    expect(await getGatewayDayBudget()).toBeNull();
  });

  it("нет env-пары шлюза → null без сети", async () => {
    delete process.env.D1_GATEWAY_URL;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await getGatewayDayBudget()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
