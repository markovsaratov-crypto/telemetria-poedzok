// v2.40.4 (ревью RR-1 / M-1): тесты идемпотентности импорта.
// tripFingerprint — детерминированный identity группы точек;
// csvFallbackClientId / zipImportClientId / zipDefaultDeviceId — стабильны
// при повторном импорте того же контента и различают разный;
// isUniqueConstraintError — P2002 (libsql/Prisma) и UNIQUE constraint failed (D1).
import { describe, it, expect } from "vitest";
import {
  tripFingerprint,
  csvFallbackClientId,
  zipImportClientId,
  zipDefaultDeviceId,
  isUniqueConstraintError,
} from "@/lib/import-idempotency";

const pts = (arr: [number, number, number][]) =>
  arr.map(([timestamp, lat, lon]) => ({ timestamp, lat, lon }));

describe("tripFingerprint", () => {
  it("детерминирован: тот же контент — тот же отпечаток", () => {
    const a = tripFingerprint("dev1", pts([[1700000000000, 51.5, 46.0]]));
    const b = tripFingerprint("dev1", pts([[1700000000000, 51.5, 46.0]]));
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("различает: другой deviceId, таймстемпы, координаты, число точек", () => {
    const base = tripFingerprint("dev1", pts([[1700000000000, 51.5, 46.0], [1700000060000, 51.6, 46.1]]));
    expect(tripFingerprint("dev2", pts([[1700000000000, 51.5, 46.0], [1700000060000, 51.6, 46.1]]))).not.toBe(base);
    expect(tripFingerprint("dev1", pts([[1700000000001, 51.5, 46.0], [1700000060000, 51.6, 46.1]]))).not.toBe(base);
    expect(tripFingerprint("dev1", pts([[1700000000000, 51.500001, 46.0], [1700000060000, 51.6, 46.1]]))).not.toBe(base);
    expect(
      tripFingerprint("dev1", pts([[1700000000000, 51.5, 46.0], [1700000060000, 51.6, 46.1], [1700000120000, 51.7, 46.2]]))
    ).not.toBe(base);
  });

  it("склейка значений не даёт коллизий (разделитель \\x1f)", () => {
    // «12» + «3» vs «1» + «23» — наивная конкатенация склеила бы
    expect(tripFingerprint("dev", pts([[123, 51.5, 46.0]]))).not.toBe(tripFingerprint("dev", pts([[1230, 15.5, 46.0]])));
  });

  it("пустая группа — явная ошибка", () => {
    expect(() => tripFingerprint("dev", [])).toThrow("пустая группа");
  });

  it("координаты до 6 знаков: микрошум ниже порога не меняет отпечаток", () => {
    // датчики шумят на ~1e-8 градуса — это тот же трек, не новый
    const a = tripFingerprint("dev", pts([[1700000000000, 51.123456789, 46.987654321]]));
    const b = tripFingerprint("dev", pts([[1700000000000, 51.123456701, 46.987654299]]));
    expect(a).toBe(b);
  });
});

describe("детерминированные clientId/deviceId", () => {
  const p = pts([[1700000000000, 51.5, 46.0], [1700000060000, 51.6, 46.1]]);

  it("csvFallbackClientId стабилен и читаем (префикс csv-)", () => {
    expect(csvFallbackClientId("dev1", p)).toBe(csvFallbackClientId("dev1", p));
    // контрак: сортировку по времени делает РОУТ перед вызовом; перевёрнутый
    // массив для функции — другой вход (first/last поменялись)
    expect(csvFallbackClientId("dev1", p)).not.toBe(csvFallbackClientId("dev1", [...p].reverse()));
    expect(csvFallbackClientId("dev1", p)).toMatch(/^csv-[0-9a-f]{24}$/);
    expect(csvFallbackClientId("dev1", p)).not.toBe(csvFallbackClientId("dev2", p));
  });

  it("zipImportClientId стабилен (префикс zip-)", () => {
    expect(zipImportClientId("zip-abc", p)).toMatch(/^zip-[0-9a-f]{24}$/);
    expect(zipImportClientId("zip-abc", p)).toBe(zipImportClientId("zip-abc", p));
  });

  it("zipDefaultDeviceId стабилен и паттерну DEVICE_ID_RE (≤64 [A-Za-z0-9_.:- ])", () => {
    const id = zipDefaultDeviceId(p);
    expect(id).toMatch(/^zip-[0-9a-f]{8}$/);
    expect(id).toMatch(/^[A-Za-z0-9_.:\- ]{1,64}$/);
    expect(zipDefaultDeviceId(p)).toBe(zipDefaultDeviceId(p));
  });
});

describe("isUniqueConstraintError", () => {
  it("P2002 (Prisma/libsql)", () => {
    const err = Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
    expect(isUniqueConstraintError(err)).toBe(true);
  });

  it("текст D1 через шлюз (UNIQUE constraint failed)", () => {
    expect(isUniqueConstraintError(new Error("D1_ERROR: UNIQUE constraint failed: Session.device_id, Session.client_id"))).toBe(true);
    expect(isUniqueConstraintError(new Error("UNIQUE constraint failed: TrafficJob.id"))).toBe(true);
  });

  it("не путает: квота, обычная ошибка, не-Error", () => {
    expect(isUniqueConstraintError(new Error("exceeded D1's free tier daily row read limit"))).toBe(false);
    expect(isUniqueConstraintError(new Error(" Connection closed"))).toBe(false);
    expect(isUniqueConstraintError("UNIQUE constraint failed")).toBe(false);
    expect(isUniqueConstraintError(null)).toBe(false);
  });
});
