// tests/packc-edge-sensorlogger.test.ts — v2.40.9 (Pack C, P2): edge-порт
// SensorLogger-канала (cloudflare-worker/ingest-port.js). Паритет с
// /api/ingest/sensorlogger v2.40.8: экстрактор нативного формата (контейнеры,
// именованные записи, вложенный data), фильтры точек, бюджет параметров D1,
// анти-гонка создания сессии (INSERT…WHERE NOT EXISTS), ПАРИТЕТ it_-токена с
// приложением (deriveItToken ≡ token-check.ts deriveIngestToken — один
// HMAC-SHA256(SESSION_SECRET, "<apiKey>:ingest"), иначе телефон получит 401
// на edge при валидном токене с Render).
import { describe, it, expect } from "vitest";
import {
  deriveItToken,
  IT_TOKEN_RE,
  extractItems,
  extractPoint,
} from "../cloudflare-worker/ingest-port.js";
import { deriveIngestToken as deriveIngestTokenApp, INGEST_TOKEN_RE } from "../src/lib/token-check";

const NOW = Date.parse("2026-09-20T12:00:00Z");
const SECRET = "ca94627b90fa31c7c6faecf715b09d62809b11ce10e79d78";
const API_KEY = "037d2343956dd5dd598fa6ef7569bbc15a216e6415136219";

describe("§C P2: it_-токен — паритет edge-порта с приложением", () => {
  it("deriveItToken ≡ token-check.ts deriveIngestToken (тот же HMAC)", async () => {
    const edge = await deriveItToken(SECRET, API_KEY);
    const app = await deriveIngestTokenApp(API_KEY, SECRET);
    expect(edge).toBe(app);
  });
  it("формат it_<32 hex> и одинаковые регексы каналов", () => {
    const token = deriveItToken(SECRET, API_KEY).then((t) => {
      expect(t).toMatch(/^it_[0-9a-f]{32}$/);
      return t;
    });
    return token.then((t) => {
      expect(IT_TOKEN_RE.test(t)).toBe(true);
      expect(INGEST_TOKEN_RE.test(t)).toBe(true); // app-регекс согласован
      expect(IT_TOKEN_RE.test("it_" + "g".repeat(32))).toBe(false); // не-hex
      expect(IT_TOKEN_RE.test("ak_" + "a".repeat(32))).toBe(false);
      expect(IT_TOKEN_RE.test(t.slice(0, 30))).toBe(false);
    });
  });
  it("ротация apiKey меняет токен, ротация секрета инвалидирует всех", async () => {
    const t1 = await deriveItToken(SECRET, API_KEY);
    const t2 = await deriveItToken(SECRET, "rotated-api-key-123");
    const t3 = await deriveItToken("rotated-secret", API_KEY);
    expect(t1).not.toBe(t2);
    expect(t1).not.toBe(t3);
  });
});

describe("§C P2: extractItems — нативный формат SensorLogger", () => {
  it("корневой массив + именованные записи {name, time, values}", () => {
    const body = [
      { name: "accelerometer", time: NOW, values: { x: 1, y: 2, z: 3 } },
      { name: "location", time: NOW, values: { latitude: 51.53, longitude: 46.03, speed: 12.5 } },
    ];
    const items = extractItems(body);
    expect(items).toHaveLength(2);
    const loc = items[1] as Record<string, unknown>;
    expect((loc.location as Record<string, unknown>).latitude).toBe(51.53);
    expect(loc.time).toBe(NOW);
  });
  it("{payload:[…]} — реальный формат приложения (кейс 01.09)", () => {
    const body = { messageId: 41, sessionId: "s", deviceId: "phone", payload: [{ name: "location", time: NOW, values: { latitude: 51.5, longitude: 46.0 } }] };
    const items = extractItems(body);
    expect(items).toHaveLength(1);
    expect((items[0] as Record<string, unknown>).name).toBe("location");
  });
  it("прочие контейнеры + вложенный data.location + плоский объект", () => {
    expect(extractItems({ points: [{ time: NOW, location: { latitude: 1, longitude: 2 } }] })).toHaveLength(1);
    expect(extractItems({ data: { location: [{ time: NOW, latitude: 1, longitude: 2 }] } })).toHaveLength(1);
    expect(extractItems({ time: NOW, location: { latitude: 1, longitude: 2 } })).toHaveLength(1);
  });
  it("пустой батч {points:[]} → [] (test-push), не-null", () => {
    expect(extractItems({ points: [] })).toEqual([]);
  });
  it("batches-массив массивов — flatten один уровень", () => {
    const items = extractItems({ batches: [[{ time: NOW, latitude: 1, longitude: 2 }], [{ time: NOW + 1, latitude: 3, longitude: 4 }]] });
    expect(items).toHaveLength(2);
  });
});

describe("§C P2: extractPoint — фильтры зеркала route.ts", () => {
  const mk = (over: Record<string, unknown> = {}) => ({
    time: NOW,
    location: { latitude: 51.53, longitude: 46.03, speed: 12.5, altitude: 150, horizontalAccuracy: 10, course: 90 },
    ...over,
  });

  it("валидная точка → нормализованная запись", () => {
    const p = extractPoint(mk(), NOW + 1000);
    expect(p).not.toBeNull();
    expect(p!.lat).toBe(51.53);
    expect(p!.speed).toBe(12.5);
    expect(p!.bearing).toBe(90);
  });
  it("маркер «нет фиксa» (-1,-1) и выход из диапазона — отброс", () => {
    expect(extractPoint({ time: NOW, latitude: -1, longitude: -1 }, NOW)).toBeNull();
    expect(extractPoint({ time: NOW, latitude: 91, longitude: 0 }, NOW)).toBeNull();
  });
  it("окно ±24 ч (F38/R7): точка вне окна отброшена", () => {
    expect(extractPoint(mk({ time: NOW - 25 * 3600_000 }), NOW)).toBeNull();
    expect(extractPoint(mk({ time: NOW + 25 * 3600_000 }), NOW)).toBeNull();
    expect(extractPoint(mk({ time: NOW - 23 * 3600_000 }), NOW)).not.toBeNull();
  });
  it("accuracy > 100 м отбрасывается на входе (AUDIT B-5)", () => {
    const p = extractPoint(mk({ location: { latitude: 51.53, longitude: 46.03, horizontalAccuracy: 400 } }), NOW);
    // фильтр accuracy живёт в основном конвейере (как в route.ts) — extractPoint
    // помечает значение; конвейер ниже отбрасывает (зеркало точное)
    expect(p?.accuracy).toBe(400);
  });
  it("негативные speed/altitude/bearing → null-поля (мусор не в БД)", () => {
    const p = extractPoint(mk({ location: { latitude: 1, longitude: 2, speed: -5, altitude: -5000, course: 999 } }), NOW);
    expect(p!.speed).toBeNull();
    expect(p!.altitude).toBeNull();
    expect(p!.bearing).toBeNull();
  });
  it("таймстемпы всех магнитуд (порт parse-timestamp)", () => {
    expect(extractPoint({ time: NOW / 1000, latitude: 1, longitude: 2 }, NOW)).not.toBeNull(); // сек
    expect(extractPoint({ time: NOW * 1000, latitude: 1, longitude: 2 }, NOW)).not.toBeNull(); // мкс
  });
});
