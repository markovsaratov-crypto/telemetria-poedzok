// src/lib/v4-utils.ts — pure utilities for v4 UI (no mock data).
// Mulberry32 seeded PRNG for deterministic sparklines & G-G diagram.
// EcoScore + efficiency zone classifiers (methodology §7.3 + §6.3).
// BUCKETS constant — 6 speed-bucket labels (0-20 / 20-40 / 40-60 / 60-80 / 80-100 / 100+).

// v2.12.0: период «Месяц» (календарный, с 1-го числа) удалён по требованию владельца —
// осталось 4 периода: Сегодня / 7 дней (скользящее) / 30 дней (скользящее) / Всё время.
export type PeriodKey = "today" | "week" | "d30" | "all";
export type Period = PeriodKey;

// 6 speed buckets for SpeedProfileBlock + G-G diagram axes.
export const BUCKETS: [string, string][] = [
  ["0–20", "Медленное движение и манёвры"],
  ["20–40", "Городской поток"],
  ["40–60", "Городские магистрали"],
  ["60–80", "Шоссе и магистрали"],
  ["80–100", "Свободное шоссе"],
  ["100+", "Трассовый режим"],
];

// Mulberry32 seeded PRNG — deterministic, idempotent.
// v2.16.0 (D-7): единственная реализация в src/lib/utils.ts — была копия и здесь.
export { mulberry32 } from "@/lib/utils";

// v2.16.0: gauss удалён — 0 потребителей (Box-Muller остался только в git-истории).

// EcoScore zone classifier (§7.3 CAP formula).
// v2.26.1: подписи зон — шкала стиля вождения (плавно / умеренно / агрессивно)
// вместо старой «резко» — слово не понимали пользователи.
export function ecoZone(s: number): { c: string; cls: string; band: string } {
  if (s >= 80) return { c: "#8E2D4E", cls: "c-plum", band: "плавно · 80+" };
  if (s >= 60) return { c: "#B47516", cls: "c-amber", band: "умеренно · 60–79" };
  return { c: "#D93A3A", cls: "c-red", band: "агрессивно · ниже 60" };
}

// Efficiency zone classifier (TimeSavingIndex §6.3 DurationDeviation).
// eff = средняя экономия/перерасход в мин/поездку; отрицательное = экономия, положительное = перерасход.
export function effZone(eff: number): { c: string; cls: string; band: string } {
  if (eff <= -1) return { c: "#8E2D4E", cls: "c-plum", band: "экономия · ≤−1 мин" };
  if (eff >= 1) return { c: "#D93A3A", cls: "c-red", band: "перерасход · ≥+1 мин" };
  return { c: "#B47516", cls: "c-amber", band: "в пределах ±1 мин" };
}

// Heat-color for heat-strips (10.3, 10.4). v = session duration; avg = group mean.
export function heatColor(v: number | null, avg: number): string {
  if (v === null) return "#D9C6D2";
  const d = (v - avg) / avg;
  if (d <= -0.05) return "#6E1F3B";
  if (d <= -0.015) return "#8E2D4E";
  if (d <= 0.015) return "#A85D8A";
  if (d <= 0.05) return "#DB6B5B";
  return "#D93A3A";
}

// EcoScore CSS class (s-plum / s-amber / s-red) for trip-card badges.
export function ecoCls(s: number): string {
  return s >= 80 ? "s-plum" : s >= 60 ? "s-amber" : "s-red";
}

// EcoScore human-readable label (плавно / умеренно / агрессивно).
// v2.26.1: «резко» заменено на «агрессивно» — понятно без словаря;
// шкала стала единой по смыслу: все три слова описывают стиль вождения.
export function ecoLab(s: number): string {
  return s >= 80 ? "плавно" : s >= 60 ? "умеренно" : "агрессивно";
}

// v2.28.0: измеримая подпись бейджа EcoScore в списке поездок — та же шкала,
// что в bullet-чарте «Аналитики» (ecoZone band): слово зоны + её числовые
// границы. Раньше «агрессивно · из 100» не объясняло, ГДЕ граница зоны.
export function ecoBandLabel(s: number): string {
  if (s >= 80) return "плавно · 80+";
  if (s >= 60) return "умеренно · 60–79";
  return "агрессивно · ниже 60";
}

// v2.28.0 (запрос владельца: «что значит агрессивно?»): подсказка бейджа —
// измеримая и понятная. Что означает слово зоны (числовая граница), чем именно
// снижается балл (веса манёвров), события ЭТОЙ поездки (если загружены) и
// сколько баллов не хватает до соседней зоны (родительный падёж: «1 балла»,
// «2 баллов», «21 балла» — как «не хватает одного/двух/двадцати одного»).
export function ecoBadgeTip(
  s: number,
  counts?: { harshBraking?: number | null; harshAccel?: number | null } | null
): string {
  const v = Math.max(0, Math.min(100, Math.round(s)));
  const bal = (n: number) => (n % 10 === 1 && n % 100 !== 11 ? "балла" : "баллов");
  const lines: string[] = [];
  lines.push(`Плавность вождения (EcoScore): ${v} из 100`);
  if (v >= 80) {
    lines.push("«Плавно» — 80 и выше баллов: так держать");
  } else if (v >= 60) {
    lines.push("«Умеренно» — 60–79 баллов: есть резкие манёвры, но немного");
    lines.push(`До «плавно» (80) не хватает ${80 - v} ${bal(80 - v)}`);
  } else {
    lines.push("«Агрессивно» — ниже 60: много резких торможений и разгонов");
    lines.push(`До «умеренно» (60) не хватает ${60 - v} ${bal(60 - v)}`);
  }
  const hb = counts?.harshBraking ?? null;
  const ha = counts?.harshAccel ?? null;
  if (hb != null || ha != null) {
    lines.push(`В этой поездке: ${hb ?? 0} резких торможений · ${ha ?? 0} резких разгонов`);
  }
  lines.push("Балл снижают: торможения (вес 45%), разгоны (30%), рывки (25%)");
  lines.push("Зоны: 80+ плавно · 60–79 умеренно · ниже 60 агрессивно");
  return lines.join(" | ");
}
