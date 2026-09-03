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
export function ecoZone(s: number): { c: string; cls: string; band: string } {
  if (s >= 80) return { c: "#8E2D4E", cls: "c-plum", band: "отлично · 80+" };
  if (s >= 60) return { c: "#B47516", cls: "c-amber", band: "неплохо · 60–79" };
  return { c: "#D93A3A", cls: "c-red", band: "резко · ниже 60" };
}

// Efficiency zone classifier (TimeSavingIndex §6.3 DurationDeviation).
// eff = средняя экономия/перерасход в мин/поездку; отрицательное = экономия, положительное = перерасход.
export function effZone(eff: number): { c: string; cls: string; band: string } {
  if (eff <= -1) return { c: "#8E2D4E", cls: "c-plum", band: "экономия · ≤−1 мин" };
  if (eff >= 1) return { c: "#D93A3A", cls: "c-red", band: "перерасход · ≥+1 мин" };
  return { c: "#B47516", cls: "c-amber", band: "в пределах ±1 мин" };
}

// Transform eff (-5..+5) → marker position on gauge (0..100, 50 = center).
export function effToGaugePct(eff: number): number {
  const clamped = Math.max(-5, Math.min(5, eff));
  return ((5 + clamped) / 10) * 100;
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

// EcoScore human-readable label (отлично / неплохо / резко).
export function ecoLab(s: number): string {
  return s >= 80 ? "отлично" : s >= 60 ? "неплохо" : "резко";
}
