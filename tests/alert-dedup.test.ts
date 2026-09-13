import { describe, it, expect } from "vitest";
// decideDedup — чистая функция (без БД/сети): alerts.ts импортируется только
// ради этой функции; БД-клиент создаётся лениво и не подключается.
import { decideDedup } from "../src/lib/alerts";

const MIN = 60_000;
const NOW = 1_000_000_000_000;

describe("дедуп Slack-алертов (претензия №8: спам каждые 5 мин, пока правило горит)", () => {
  it("первое срабатывание (состояния нет) → уведомить", () => {
    expect(decideDedup(true, null, NOW, 60 * MIN)).toEqual({ notify: true, reason: "no-state" });
  });

  it("правило горит, уведомлено 10 мин назад при кулдауне 60 мин → молчать", () => {
    expect(decideDedup(true, NOW - 10 * MIN, NOW, 60 * MIN)).toEqual({ notify: false, reason: "cooldown" });
  });

  it("правило горит, уведомлено ровно кулдаун назад → напоминание", () => {
    expect(decideDedup(true, NOW - 60 * MIN, NOW, 60 * MIN)).toEqual({ notify: true, reason: "reminder" });
  });

  it("правило погасло → clear (разоружить, следующее срабатывание уведомит сразу)", () => {
    expect(decideDedup(false, NOW - 10 * MIN, NOW, 60 * MIN)).toEqual({ notify: false, reason: "clear" });
  });

  it("кулдаун 0 = дедуп выключен: любое горящее правило уведомляется", () => {
    expect(decideDedup(true, NOW - 1, NOW, 0).notify).toBe(true);
  });
});
