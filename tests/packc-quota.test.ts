// tests/packc-quota.test.ts — v2.40.9 (Pack C): sticky-флаги дневной квоты D1
// (m-20) — «/health рисует db:ok при мёртвой квоте» больше не воспроизводится.
// Проверяется контракт d1-quota.ts: постановка на РЕАЛЬНОЙ ошибке, снятие
// успешным чтением строк, самосброс в полночь UTC, детекторы read/write.
import { describe, it, expect, beforeEach } from "vitest";
import {
  isD1QuotaError,
  isD1ReadQuotaError,
  isD1WriteQuotaError,
  markD1ReadQuotaExhausted,
  markD1WriteQuotaExhausted,
  clearD1QuotaIfAlive,
  isD1ReadQuotaExhausted,
  isD1WriteQuotaExhausted,
  d1QuotaSnapshot,
  nextUtcMidnight,
  resetD1QuotaFlagsForTests,
} from "../src/lib/d1-quota";

const READ_ERR = new Error(
  "D1_ERROR: Your account has exceeded D1's free tier daily row read limit (daily limit 5,000,000 rows read) — contact Cloudflare support or upgrade to Workers Paid"
);
const WRITE_ERR = new Error(
  "D1_ERROR: Your account has exceeded D1's free tier daily row write limit"
);
const OTHER_ERR = new Error("D1_ERROR: no such table: Nope");

describe("§C m-20 детекторы ошибок квоты", () => {
  it("read-ошибка распознаётся и в read, и в общем детекторе", () => {
    expect(isD1ReadQuotaError(READ_ERR)).toBe(true);
    expect(isD1QuotaError(READ_ERR)).toBe(true);
    expect(isD1WriteQuotaError(READ_ERR)).toBe(false);
  });
  it("write-ошибка — только write/общий", () => {
    expect(isD1WriteQuotaError(WRITE_ERR)).toBe(true);
    expect(isD1QuotaError(WRITE_ERR)).toBe(true);
    expect(isD1ReadQuotaError(WRITE_ERR)).toBe(false);
  });
  it("прочие D1-ошибки и не-Error значения — не квота", () => {
    expect(isD1QuotaError(OTHER_ERR)).toBe(false);
    expect(isD1QuotaError("exceeded D1's free tier daily row read limit")).toBe(false);
    expect(isD1QuotaError(null)).toBe(false);
    expect(isD1QuotaError({ message: "x" })).toBe(false);
  });
});

describe("§C m-20 sticky-флаг read-квоты", () => {
  beforeEach(() => resetD1QuotaFlagsForTests());

  it("SELECT 1 не ставит флаг (0 строк — успешные чтения его СНИМАЮТ)", () => {
    expect(isD1ReadQuotaExhausted()).toBe(false);
    markD1ReadQuotaExhausted();
    expect(isD1ReadQuotaExhausted()).toBe(true);
    // успешный ответ с 0 строк (SELECT 1) НЕ доказывает жизнь квоты
    clearD1QuotaIfAlive(0, 0);
    expect(isD1ReadQuotaExhausted()).toBe(true);
    // успешное чтение строк — доказательство
    clearD1QuotaIfAlive(12, 0);
    expect(isD1ReadQuotaExhausted()).toBe(false);
  });

  it("полночь UTC после отметки = самовосстановление (сброс 00:00 UTC)", () => {
    const at = Date.UTC(2026, 8, 20, 17, 46, 0); // 20.09 17:46 UTC
    markD1ReadQuotaExhausted(at);
    expect(isD1ReadQuotaExhausted(at + 60_000)).toBe(true); // до полуночи
    const midnight = nextUtcMidnight(at);
    expect(midnight).toBe(Date.UTC(2026, 8, 21, 0, 0, 0)); // 21.09 00:00 UTC
    expect(isD1ReadQuotaExhausted(midnight + 1)).toBe(false); // сброс пришёл
  });

  it("write-квота — симметрично, независимо от read", () => {
    markD1WriteQuotaExhausted();
    expect(isD1WriteQuotaExhausted()).toBe(true);
    expect(isD1ReadQuotaExhausted()).toBe(false); // инжест продолжает писать/читать
    clearD1QuotaIfAlive(0, 5);
    expect(isD1WriteQuotaExhausted()).toBe(false);
  });

  it("снапшот для /health: ISO-метки + булевы состояния", () => {
    const at = Date.UTC(2026, 8, 20, 17, 46, 0);
    markD1ReadQuotaExhausted(at);
    const snap = d1QuotaSnapshot(at + 1000);
    expect(snap.readExhausted).toBe(true);
    expect(snap.readExhaustedAt).toBe(new Date(at).toISOString());
    expect(snap.writeExhaustedAt).toBeNull();
    expect(snap.writeExhausted).toBe(false);
  });

  it("повторная отметка НЕ двигает время вперёд (первая причина важнее)", () => {
    const first = Date.UTC(2026, 8, 20, 17, 46, 0);
    markD1ReadQuotaExhausted(first);
    markD1ReadQuotaExhausted(first + 3600_000);
    expect(d1QuotaSnapshot(first + 1000).readExhaustedAt).toBe(new Date(first).toISOString());
  });
});
