// src/lib/telematika-v4-mock.ts — Mock-данные v4-прототипа.
// Перенесено из telematika_markova_v4.html (объекты PERIODS, TRIPS, ROUTES).
// Mulberry32 seeded для детерминированных спарклайнов и G-G диаграммы.

export type PeriodKey = "today" | "week" | "d30" | "month" | "all";

export interface PeriodData {
  sub: string;
  spsub: string;
  kpi: {
    dur: string;
    dist: string;
    avg: string;
    max: string;
    rec: string;
    move: string;
    idle: string;
  };
  tr: {
    dur: [string, "up" | "down" | "neu"];
    dist: [string, "up" | "down" | "neu"];
    avg: [string, "up" | "down" | "neu"];
    max: [string, "up" | "down" | "neu"];
    rec: [string, "up" | "down" | "neu"];
    move: [string, "up" | "down" | "neu"];
    idle: [string, "up" | "down" | "neu"];
  };
  dist: number[]; // 6 бакетов скоростного профиля
  score: number;  // EcoScore 7.3
  eff: number;    // TimeSavingIndex (новая метрика)
  st: {
    p50: string;
    std: string;
    vr: string;
    jam: string;
    cruise: string;
  };
}

export const BUCKETS: [string, string][] = [
  ["0–20", "Медленное движение и манёвры"],
  ["20–40", "Городской поток"],
  ["40–60", "Городские магистрали"],
  ["60–80", "МКАД и шоссе"],
  ["80–100", "Свободное шоссе"],
  ["100+", "Трассовый режим"],
];

export const PERIODS: Record<PeriodKey, PeriodData> = {
  today: {
    sub: "поездка 28 авг",
    spsub: "точки активной части · 138 мин в движении",
    kpi: { dur: "182 / 174", dist: "124,9", avg: "43,1", max: "170", rec: "186", move: "138", idle: "44" },
    tr: {
      dur: ["↑ 8%", "up"], dist: ["↑ 6%", "up"], avg: ["↓ 2%", "down"], max: ["↑ 4%", "up"],
      rec: ["12 июл", "neu"], move: ["↑ 5%", "up"], idle: ["↑ 18%", "down"],
    },
    dist: [8, 24, 27, 20, 12, 9], score: 70, eff: -0.8,
    st: { p50: "38", std: "24", vr: "0,62", jam: "36 мин · 21%", cruise: "56 мин · 41%" },
  },
  week: {
    sub: "22–28 авг · 8 поездок",
    spsub: "точки активных частей · 826 мин в движении",
    kpi: { dur: "1 046", dist: "594,0", avg: "42,5", max: "178", rec: "186", move: "826", idle: "220" },
    tr: {
      dur: ["↑ 3%", "up"], dist: ["↑ 5%", "up"], avg: ["↓ 1%", "down"], max: ["↑ 2%", "up"],
      rec: ["12 июл", "neu"], move: ["↑ 2%", "up"], idle: ["↑ 9%", "down"],
    },
    dist: [7, 22, 28, 21, 13, 9], score: 74, eff: -1.1,
    st: { p50: "41", std: "26", vr: "0,59", jam: "170 мин · 21%", cruise: "318 мин · 38%" },
  },
  d30: {
    sub: "30 дней · 26 поездок",
    spsub: "точки активных частей · 3 090 мин в движении",
    kpi: { dur: "3 912", dist: "2 745", avg: "42,1", max: "182", rec: "186", move: "3 090", idle: "822" },
    tr: {
      dur: ["↓ 4%", "down"], dist: ["↓ 2%", "down"], avg: ["↑ 1%", "up"], max: ["↑ 1%", "up"],
      rec: ["12 июл", "neu"], move: ["↓ 3%", "down"], idle: ["↓ 6%", "up"],
    },
    dist: [9, 25, 27, 19, 12, 8], score: 78, eff: -0.6,
    st: { p50: "40", std: "25", vr: "0,60", jam: "790 мин · 26%", cruise: "1 240 мин · 40%" },
  },
  month: {
    sub: "август · 24 поездки",
    spsub: "точки активных частей · 2 878 мин в движении",
    kpi: { dur: "3 640", dist: "2 548", avg: "41,9", max: "182", rec: "186", move: "2 878", idle: "762" },
    tr: {
      dur: ["↓ 3%", "down"], dist: ["↓ 1%", "down"], avg: ["↑ 1%", "up"], max: ["=", "neu"],
      rec: ["12 июл", "neu"], move: ["↓ 2%", "down"], idle: ["↓ 5%", "up"],
    },
    dist: [9, 24, 27, 20, 12, 8], score: 78, eff: -0.9,
    st: { p50: "39", std: "25", vr: "0,61", jam: "740 мин · 26%", cruise: "1 160 мин · 40%" },
  },
  all: {
    sub: "с 14 мая · 92 поездки",
    spsub: "точки активных частей · 11 180 мин в движении",
    kpi: { dur: "14 120", dist: "9 930", avg: "42,2", max: "186", rec: "186", move: "11 180", idle: "2 940" },
    tr: {
      dur: ["—", "neu"], dist: ["—", "neu"], avg: ["—", "neu"], max: ["—", "neu"],
      rec: ["12 июл", "neu"], move: ["—", "neu"], idle: ["—", "neu"],
    },
    dist: [8, 23, 28, 21, 12, 8], score: 82, eff: -0.8,
    st: { p50: "40", std: "26", vr: "0,58", jam: "2 860 мин · 26%", cruise: "4 470 мин · 40%" },
  },
};

export interface TripSeg {
  name: string;
  type_dist: string;
  plan: number;
  fact: number;
  plan_speed: number;
  fact_speed: number;
  jam?: number;
}

export interface Trip {
  d: string;
  mo: string;
  t: string;
  route: string;
  sub: string;
  eco: number;
  segs: TripSeg[];
  ev: string;
}

export const TRIPS: Trip[] = [
  {
    d: "28", mo: "АВГ", t: "14:23", route: "Дом → Офис",
    sub: "124,9 км · 174 мин · ср 43,1 · макс 170", eco: 70,
    segs: [
      { name: "Дом → МКАД", type_dist: "город · 14,2 км", plan: 18, fact: 20, plan_speed: 47.3, fact_speed: 42.6 },
      { name: "МКАД · север → юг", type_dist: "кольцо · 55,6 км", plan: 50, fact: 46, plan_speed: 66.7, fact_speed: 72.5 },
      { name: "МКАД → ТТК", type_dist: "Ленинградское ш. · 18,9 км", plan: 26, fact: 36, plan_speed: 43.6, fact_speed: 31.5, jam: 8 },
      { name: "ТТК → Садовое", type_dist: "центр · 22,4 км", plan: 38, fact: 40, plan_speed: 35.4, fact_speed: 33.6 },
      { name: "Садовое → Офис", type_dist: "центр · 13,8 км", plan: 38, fact: 32, plan_speed: 21.8, fact_speed: 25.9 },
    ],
    ev: "3 резких торможения · 2 резких разгона · 2 манёвра на скорости выше 60 км/ч",
  },
  {
    d: "28", mo: "АВГ", t: "08:12", route: "Офис → Дом",
    sub: "123,1 км · 168 мин · ср 44,0 · макс 165", eco: 76,
    segs: [
      { name: "Офис → Садовое", type_dist: "центр · 13,9 км", plan: 16, fact: 15, plan_speed: 52.1, fact_speed: 55.6 },
      { name: "Садовое → ТТК", type_dist: "центр · 21,7 км", plan: 27, fact: 26, plan_speed: 48.2, fact_speed: 50.1 },
      { name: "ТТК → МКАД", type_dist: "шоссе · 19,2 км", plan: 34, fact: 36, plan_speed: 33.9, fact_speed: 32.0, jam: 2 },
      { name: "МКАД → Дом", type_dist: "кольцо + город · 68,3 км", plan: 93, fact: 91, plan_speed: 44.1, fact_speed: 45.0 },
    ],
    ev: "2 резких торможения · 1 резкий разгон",
  },
  {
    d: "27", mo: "АВГ", t: "19:40", route: "Офис → Спортзал",
    sub: "21,4 км · 38 мин · ср 33,8 · макс 88", eco: 78,
    segs: [
      { name: "Офис → ТТК", type_dist: "центр · 8,1 км", plan: 12, fact: 13, plan_speed: 40.5, fact_speed: 37.4 },
      { name: "ТТК → Спортзал", type_dist: "центр · 13,3 км", plan: 26, fact: 25, plan_speed: 30.7, fact_speed: 31.9 },
    ],
    ev: "1 резкое торможение",
  },
  {
    d: "27", mo: "АВГ", t: "07:55", route: "Дом → Офис",
    sub: "125,3 км · 181 мин · ср 41,5 · макс 158", eco: 64,
    segs: [
      { name: "Дом → МКАД", type_dist: "город · 14,3 км", plan: 14, fact: 17, plan_speed: 61.3, fact_speed: 50.5, jam: 3 },
      { name: "МКАД · север → юг", type_dist: "кольцо · 55,8 км", plan: 48, fact: 52, plan_speed: 69.8, fact_speed: 64.4 },
      { name: "МКАД → ТТК", type_dist: "шоссе · 19,1 км", plan: 32, fact: 38, plan_speed: 35.8, fact_speed: 30.2, jam: 6 },
      { name: "ТТК → Садовое", type_dist: "центр · 22,6 км", plan: 38, fact: 38, plan_speed: 35.7, fact_speed: 35.7 },
      { name: "Садовое → Офис", type_dist: "центр · 13,5 км", plan: 38, fact: 36, plan_speed: 21.3, fact_speed: 22.5 },
    ],
    ev: "4 резких торможения · 3 резких разгона · 1 манёвр на скорости выше 60 км/ч",
  },
  {
    d: "26", mo: "АВГ", t: "18:20", route: "Офис → Дача",
    sub: "68,2 км · 94 мин · ср 43,5 · макс 142", eco: 72,
    segs: [
      { name: "Офис → МКАД", type_dist: "центр · 18,4 км", plan: 26, fact: 28, plan_speed: 42.5, fact_speed: 39.4, jam: 2 },
      { name: "МКАД → Волоколамское ш.", type_dist: "развязка · 12,1 км", plan: 18, fact: 16, plan_speed: 40.3, fact_speed: 45.4 },
      { name: "Трасса → Дача", type_dist: "шоссе · 37,7 км", plan: 50, fact: 50, plan_speed: 45.2, fact_speed: 45.2 },
    ],
    ev: "2 резких торможения · 1 разворот",
  },
  {
    d: "25", mo: "АВГ", t: "09:05", route: "Дача → Дом",
    sub: "67,8 км · 89 мин · ср 45,7 · макс 138", eco: 74,
    segs: [
      { name: "Дача → трасса", type_dist: "шоссе · 37,5 км", plan: 50, fact: 47, plan_speed: 45.0, fact_speed: 47.9 },
      { name: "Трасса → МКАД", type_dist: "развязка · 12,0 км", plan: 18, fact: 19, plan_speed: 40.0, fact_speed: 37.9 },
      { name: "МКАД → Дом", type_dist: "кольцо + город · 18,3 км", plan: 26, fact: 23, plan_speed: 42.3, fact_speed: 47.7 },
    ],
    ev: "1 резкий разгон",
  },
  {
    d: "24", mo: "АВГ", t: "12:30", route: "Дом → Парк",
    sub: "18,6 км · 42 мин · ср 26,6 · макс 74", eco: 81,
    segs: [
      { name: "Дом → МКАД", type_dist: "город · 9,8 км", plan: 12, fact: 14, plan_speed: 49.0, fact_speed: 42.0, jam: 2 },
      { name: "МКАД → Парк", type_dist: "юг кольца · 8,8 км", plan: 30, fact: 28, plan_speed: 17.6, fact_speed: 18.9 },
    ],
    ev: "без резких манёвров",
  },
  {
    d: "22", mo: "АВГ", t: "15:10", route: "Офис → МКАД · юг",
    sub: "44,7 км · 52 мин · ср 51,6 · макс 168", eco: 85,
    segs: [
      { name: "Офис → ТТК", type_dist: "центр · 16,2 км", plan: 14, fact: 13, plan_speed: 69.4, fact_speed: 74.8 },
      { name: "ТТК → МКАД · юг", type_dist: "шоссе · 28,5 км", plan: 38, fact: 39, plan_speed: 45.0, fact_speed: 43.8 },
    ],
    ev: "1 резкий разгон",
  },
];

export interface RouteData {
  n: string;
  c: string;
  cls: "rc-1" | "rc-2" | "rc-3" | "rc-4";
  sub: string;
  avg: number;
  best: number;
  worst: number;
  std: number;
  hours: (number | null)[];
  hlab: string[];
  days: number[];
  dlab: string[];
  slope: number | null;
  ci: string | null;
  npts: number;
  seed: number;
  trendWord: string | null;
}

export const ROUTES: RouteData[] = [
  {
    n: "Дом → Офис", c: "18", cls: "rc-1",
    sub: "Сокольники · 124,9 км · плавность 74 · план-факт +6 мин",
    avg: 176, best: 162, worst: 208, std: 11,
    hours: [null, 182, 171, 179], hlab: ["ночь", "утро", "день", "вечер"],
    days: [174, 171, 177, 181, 176, 168, 173], dlab: ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"],
    slope: -0.4, ci: "−0,9 … +0,1", npts: 18, seed: 51, trendWord: "стабильно-улучшающийся",
  },
  {
    n: "Офис → МКАД · юг", c: "12", cls: "rc-2",
    sub: "вечерние поездки · 44,7 км · плавность 84 · план-факт +1 мин",
    avg: 52, best: 46, worst: 63, std: 4,
    hours: [null, 55, 50, 53], hlab: ["ночь", "утро", "день", "вечер"],
    days: [52, 51, 53, 54, 53, 49, 50], dlab: ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"],
    slope: 0.2, ci: "−0,3 … +0,7", npts: 12, seed: 52, trendWord: "стабильный",
  },
  {
    n: "Офис → Дача", c: "8", cls: "rc-3",
    sub: "Истра · 68,2 км · плавность 77 · план-факт −2 мин",
    avg: 94, best: 88, worst: 112, std: 6,
    hours: [null, 96, 92, 95], hlab: ["ночь", "утро", "день", "вечер"],
    days: [95, 92, 94, 96, 94, 90, 93], dlab: ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"],
    slope: -0.8, ci: "−1,6 … −0,1", npts: 8, seed: 53, trendWord: "улучшающийся",
  },
  {
    n: "Дом → Спортзал", c: "5", cls: "rc-4",
    sub: "Балашиха · 21,4 км · плавность 82 · план-факт +3 мин",
    avg: 38, best: 34, worst: 44, std: 3,
    hours: [null, 40, 36, 39], hlab: ["ночь", "утро", "день", "вечер"],
    days: [39, 37, 38, 40, 38, 36, 37], dlab: ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"],
    slope: 0.0, ci: "−0,4 … +0,4", npts: 5, seed: 54, trendWord: "стабильный",
  },
  {
    n: "Дом → Парк", c: "3", cls: "rc-4",
    sub: "Кузьминки · 18,6 км · плавность 83 · план-факт +2 мин",
    avg: 42, best: 39, worst: 46, std: 3,
    hours: [null, 44, 40, 43], hlab: ["ночь", "утро", "день", "вечер"],
    days: [43, 41, 42, 44, 42, 40, 41], dlab: ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"],
    slope: null, ci: null, npts: 3, seed: 55, trendWord: null,
  },
];

// Mulberry32 seeded PRNG — детерминированный, идемпотентный.
export function mulberry32(a: number): () => number {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function gauss(r: () => number): number {
  let u = 0, v = 0;
  while (!u) u = r();
  while (!v) v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

// EcoScore zone classifier (7.3 CAP-методика)
export function ecoZone(s: number): { c: string; cls: string; band: string } {
  if (s >= 80) return { c: "#8E2D4E", cls: "c-plum", band: "отлично · 80+" };
  if (s >= 60) return { c: "#B47516", cls: "c-amber", band: "неплохо · 60–79" };
  return { c: "#D93A3A", cls: "c-red", band: "резко · ниже 60" };
}

// Эффективность zone classifier (новая метрика TimeSavingIndex)
// eff = средняя экономия/перерасход в мин/поездку; отрицательное = экономия, положительное = перерасход
export function effZone(eff: number): { c: string; cls: string; band: string } {
  if (eff <= -1) return { c: "#8E2D4E", cls: "c-plum", band: "экономия · ≤−1 мин" };
  if (eff >= 1) return { c: "#D93A3A", cls: "c-red", band: "перерасход · ≥+1 мин" };
  return { c: "#B47516", cls: "c-amber", band: "в пределах ±1 мин" };
}

// Преобразование eff (-5..+5) в позицию маркера gauge (0..100, 50 = центр)
export function effToGaugePct(eff: number): number {
  const clamped = Math.max(-5, Math.min(5, eff));
  return ((5 + clamped) / 10) * 100;
}

// Heat-color для теплополос (10.3, 10.4)
export function heatColor(v: number | null, avg: number): string {
  if (v === null) return "#D9C6D2";
  const d = (v - avg) / avg;
  if (d <= -0.05) return "#6E1F3B";
  if (d <= -0.015) return "#8E2D4E";
  if (d <= 0.015) return "#A85D8A";
  if (d <= 0.05) return "#DB6B5B";
  return "#D93A3A";
}

// Список поездок для trip-filter (combobox)
export const TRIP_FILTER_LIST = TRIPS.map((t, i) => ({
  id: `t${i + 1}`,
  label: `${t.d} ${t.mo} ${t.t}`,
  route: t.route,
  sub: t.sub,
}));

export function ecoCls(s: number): string {
  return s >= 80 ? "s-plum" : s >= 60 ? "s-amber" : "s-red";
}
export function ecoLab(s: number): string {
  return s >= 80 ? "отлично" : s >= 60 ? "неплохо" : "резко";
}
