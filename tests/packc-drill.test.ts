// tests/packc-drill.test.ts — v2.40.9 (Pack C, P1-в): read-back drill
// бэкапов — раз в неделю. resolveDrillMode: auto = воскресенье UTC полный
// прогон, будни лёгкая сверка checksum; явные full/checksum перекрывают.
import { describe, it, expect } from "vitest";
import { resolveDrillMode } from "../src/lib/github-backup";

const sunday = new Date("2026-09-20T03:31:00Z"); // вс 20.09 (день github-крона)
const monday = new Date("2026-09-21T03:31:00Z");
const saturday = new Date("2026-09-19T23:59:00Z");

describe("§C P1-в: resolveDrillMode — расписание drill", () => {
  it("auto: воскресенье UTC → full (день еженедельного github-крона)", () => {
    expect(resolveDrillMode(sunday, "auto")).toBe("full");
  });
  it("auto: будни → checksum (без парсинга 66К строк)", () => {
    expect(resolveDrillMode(monday, "auto")).toBe("checksum");
    expect(resolveDrillMode(saturday, "auto")).toBe("checksum");
  });
  it("явное full/checksum перекрывает календарь (ранбуки/инциденты)", () => {
    expect(resolveDrillMode(monday, "full")).toBe("full");
    expect(resolveDrillMode(sunday, "checksum")).toBe("checksum");
  });
  it("граница: суббота 23:59 UTC — ещё checksum, вс 00:00+ — уже full", () => {
    expect(resolveDrillMode(new Date("2026-09-20T00:00:00Z"), "auto")).toBe("full");
    expect(resolveDrillMode(new Date("2026-09-19T23:59:59Z"), "auto")).toBe("checksum");
  });
});
