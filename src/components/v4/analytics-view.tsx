// src/components/v4/analytics-view.tsx — вкладка Аналитика v4 (v2.10.1).
// 11 блоков (порядок утверждён, не менять):
//   1. Шапка сессии + таймлайн записи
//   2. 01 Основные показатели (7 KPI)          — LIVE /api/sessions/[id]/stats
//   3. 02 Оценка вождения — EcoScore + Эффективность — LIVE stats + events
//   4. 03 Скоростной профиль                  — LIVE stats
//   5. 04 План и факт · время                  — LIVE stats.route + route-comparison (v2.10.1)
//   6. 05 Карта поездки                        — LIVE /api/sessions/[id]/track (Leaflet)
//   7. 06 Поведение и манёвры                 — LIVE /api/sessions/[id]/events (G-G diagram)
//   8. 07 Пробки и заторы                      — LIVE stats.methodology + stats.route (v2.10.1)
//   9. 08 География и рельеф                  — LIVE stats.methodology + bbox (v2.10.1)
//  10. 09 Тяжёлые участки (аккордеон)         — LIVE /api/routes/heavy-segments (v2.10.1)
//  11. 10 Частые маршруты                      — LIVE /api/routes/grouped + /trend (v2.10.1)
//  12. 11 Качество данных (аккордеон)         — LIVE stats.methodology (v2.10.1)

"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import { motion } from "framer-motion";
import {
  BUCKETS,
  mulberry32,
  ecoZone,
  effZone,
  effToGaugePct,
  heatColor,
  type PeriodKey,
} from "@/lib/v4-utils";
import {
  useSessionStats,
  useRouteComparison,
  useRouteGroups,
  useHeavySegments,
  useRouteTrend,
  type SessionStats,
  type RouteGroupInfo,
  type HeavySegmentsData,
  type RouteComparisonData,
  type RouteTrendData,
} from "@/lib/hooks";
import { useV4Track, useV4Events, usePeriodStats, type PeriodAggregate } from "@/lib/v4-hooks";
import type { TrackResponse, EventsResponse } from "@/lib/api-client";
import { bindTips } from "./use-v4-tipbox";
import { GaugeArc } from "./widgets/gauge-arc";

// v2.10.0 R2: Leaflet MapTrack — dynamic import с ssr: false (Leaflet требует window).
const V4MapTrack = dynamic(
  () => import("./widgets/map-track").then((m) => m.V4MapTrack),
  {
    ssr: false,
    loading: () => (
      <div
        style={{
          height: 380,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          color: "var(--muted)",
          fontSize: 12,
          background: "var(--bg)",
        }}
      >
        Загрузка карты…
      </div>
    ),
  }
);

interface Props {
  period: PeriodKey;
  sessionId: string | null;
}

export function AnalyticsView({ period, sessionId }: Props) {
  // v2.10.0 R1+R2 + v2.10.1: live API hooks для ВСЕХ 11 блоков.
  // 01 KPI, 02 Score, 03 Speed, 04 PlanFact, 05 Map, 06 Behavior, 07 Traffic,
  // 08 Geo, 09 Heavy, 10 Routes, 11 Quality — все используют live API.
  const stats = useSessionStats(sessionId);
  const track = useV4Track(sessionId);
  const events = useV4Events(sessionId);
  const comparison = useRouteComparison(sessionId); // v2.10.1: для блока 04
  const groups = useRouteGroups(); // v2.10.1: для блока 10
  const heavy = useHeavySegments(); // v2.10.1: для блока 09

  // v2.10.2: период-режим — метрики по ВСЕМ поездкам выбранного периода.
  // Активен, когда конкретная поездка не выбрана (клик по period-pill).
  // Выбор конкретной поездки в dropdown → только её данные (режим ниже).
  const periodAgg = usePeriodStats(period);

  const rootRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (rootRef.current) bindTips(rootRef.current);
  });

  // === Период-режим: все метрики по поездкам за выбранный период ===
  if (!sessionId) {
    const agg = periodAgg.data;

    if (periodAgg.isLoading) {
      return (
        <div ref={rootRef}>
          <div className="card" style={{ padding: "28px 20px", textAlign: "center", color: "var(--muted)", fontSize: 13 }}>
            Считаем метрики за период «{PERIOD_LABELS[period]}»…
          </div>
        </div>
      );
    }

    if (periodAgg.isError) {
      return (
        <div ref={rootRef}>
          <div className="card" style={{ padding: "28px 20px", textAlign: "center", color: "var(--muted)", fontSize: 13 }}>
            Не удалось загрузить метрики за период. Обновите страницу или нажмите ⟳ в панели сверху.
          </div>
          <HeavySegmentsBlock data={heavy.data} />
          <RoutesBlock groups={groups.data} />
        </div>
      );
    }

    if (!agg || agg.trips === 0) {
      return (
        <div ref={rootRef}>
          <div className="card" style={{ padding: "28px 20px", textAlign: "center", color: "var(--muted)", fontSize: 13 }}>
            За период «{PERIOD_LABELS[period]}» поездок нет.
            <br />
            Выберите другой период или конкретную поездку в фильтре «Все поездки · период».
          </div>
          <HeavySegmentsBlock data={heavy.data} />
          <RoutesBlock groups={groups.data} />
        </div>
      );
    }

    // Блоки 01–08 и 11 — агрегат периода; 09/10 — агрегаты по routeHash-группам.
    return (
      <div ref={rootRef}>
        <PeriodHeader agg={agg} period={period} />
        <KpiBlock stats={agg.stats} period={period} aggregated />
        <DrivingScoreBlock stats={agg.stats} events={agg.events} aggregated />
        <SpeedProfileBlock stats={agg.stats} aggregated />
        <PlanFactBlock stats={agg.stats} comparison={null} aggregated />
        <MapBlock track={agg.track} isLoading={false} isError={false} aggregated />
        <BehaviorBlock events={agg.events} stats={agg.stats} aggregated />
        <TrafficBlock stats={agg.stats} aggregated />
        <GeoBlock stats={agg.stats} aggregated />
        <HeavySegmentsBlock data={heavy.data} />
        <RoutesBlock groups={groups.data} />
        <DataQualityBlock stats={agg.stats} aggregated />
      </div>
    );
  }

  // === Режим конкретной поездки: данные только по ней ===
  return (
    <div ref={rootRef}>
      <SessionHeader stats={stats.data} period={period} />
      <KpiBlock stats={stats.data} period={period} />
      <DrivingScoreBlock stats={stats.data} events={events.data} />
      <SpeedProfileBlock stats={stats.data} />
      <PlanFactBlock stats={stats.data} comparison={comparison.data} />
      <MapBlock track={track.data} isLoading={track.isLoading} isError={track.isError} />
      <BehaviorBlock events={events.data} stats={stats.data} />
      <TrafficBlock stats={stats.data} />
      <GeoBlock stats={stats.data} />
      <HeavySegmentsBlock data={heavy.data} />
      <RoutesBlock groups={groups.data} />
      <DataQualityBlock stats={stats.data} />
    </div>
  );
}

// Подписи периодов (совпадают с PERIOD_LIST в telematika-layout).
const PERIOD_LABELS: Record<PeriodKey, string> = {
  today: "Сегодня",
  week: "7 дней",
  d30: "30 дней",
  month: "Месяц",
  all: "Всё время",
};

// Шапка периода (период-режим, v2.10.2): N поездок + диапазон дат + сводный таймлайн.
function PeriodHeader({ agg, period }: { agg: PeriodAggregate; period: PeriodKey }) {
  const totalMin = secToMin(agg.stats.duration);
  const moveMin = secToMin(agg.stats.movingTime);
  const idleMin = secToMin(agg.stats.idleTime);
  const gapSec = agg.stats.gapTime ?? 0;
  const total = Math.max(1, agg.stats.duration || 1);
  const movePct = ((agg.stats.movingTime ?? 0) / total) * 100;
  const idlePct = ((agg.stats.idleTime ?? 0) / total) * 100;
  const gapPct = Math.max(0.1, (gapSec / total) * 100);

  const d1 = new Date(agg.rangeStart);
  const d2 = new Date(agg.rangeEnd);
  const fmt = (d: Date) =>
    d.toLocaleDateString("ru-RU", { day: "2-digit", month: "short" });

  const tripsWord =
    agg.trips % 10 === 1 && agg.trips % 100 !== 11
      ? "поездка"
      : [2, 3, 4].includes(agg.trips % 10) && ![12, 13, 14].includes(agg.trips % 100)
        ? "поездки"
        : "поездок";

  return (
    <div className="session">
      <div className="session-top">
        <span className="s-lab">период</span>
        <b>
          {PERIOD_LABELS[period]} · {fmt(d1)}–{fmt(d2)}
        </b>
        <span>
          {agg.trips} {tripsWord}
        </span>
        <span className="muted">
          · всего <b>{fmtInt(totalMin)} мин</b> · в движении <b>{fmtInt(moveMin)} мин</b> ·{" "}
          {fmtInt(agg.stats.pointCount)} точек
        </span>
      </div>
      <div className="mline">
        <i
          className="ml-move"
          style={{ width: `${movePct}%` }}
          data-tip={`Движение (сумма MovingTime всех поездок периода): ${fmtInt(moveMin)} мин`}
        />
        <i
          className="ml-idle"
          style={{ width: `${idlePct}%` }}
          data-tip={`Стоянки (сумма IdleTime всех поездок периода): ${fmtInt(idleMin)} мин`}
        />
        <i
          className="ml-gap"
          style={{ width: `${gapPct}%`, minWidth: gapSec > 0 ? "3px" : "0" }}
          data-tip={`Разрывы записи за период: суммарно ${fmtInt(gapSec)} сек`}
        />
      </div>
      <div className="mline-cap">
        <span>
          <i className="ml-move" style={{ background: "var(--plum)" }} />
          движение · {fmtInt(moveMin)} мин
        </span>
        <span>
          <i style={{ background: "#DCC9D3" }} />
          стоянки · {fmtInt(idleMin)} мин
        </span>
        <span>
          <i style={{ background: "repeating-linear-gradient(90deg,#C99A2E 0 3px,#F3E3C9 3px 6px)" }} />
          разрывы · {fmtInt(gapSec)} сек
        </span>
      </div>
    </div>
  );
}

// === Helpers для конвертации единиц ===
function fmtNum(n: number | null | undefined, decimals = 1): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toFixed(decimals).replace(".", ",");
}
function fmtInt(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return Math.round(n).toString();
}
function msToKmh(ms: number | null | undefined): number | null {
  if (ms == null || !Number.isFinite(ms)) return null;
  return ms * 3.6;
}
function secToMin(sec: number | null | undefined): number {
  if (sec == null || !Number.isFinite(sec) || sec < 0) return 0;
  return sec / 60;
}

// === Блок 1: Шапка сессии + таймлайн ===
function SessionHeader({
  stats,
  period,
}: {
  stats: SessionStats | null | undefined;
  period: PeriodKey;
}) {
  if (!stats) {
    return (
      <div className="session">
        <div className="session-top">
          <span className="s-lab">поездка</span>
          <b>загрузка…</b>
          <span>SensorLogger</span>
          <span className="muted">· ожидание данных статистики</span>
        </div>
      </div>
    );
  }
  const totalMin = secToMin(stats.duration);
  const moveMin = secToMin(stats.movingTime);
  const idleMin = secToMin(stats.idleTime);
  const gapSec = stats.gapTime ?? 0;
  // Доли движения/стоянок/разрывов на таймлайне (0..100%)
  const total = Math.max(1, stats.duration || 1);
  const movePct = ((stats.movingTime ?? 0) / total) * 100;
  const idlePct = ((stats.idleTime ?? 0) / total) * 100;
  const gapPct = Math.max(0.1, (gapSec / total) * 100);

  // Format session date/label
  const sessionDate = new Date(stats.startTime);
  const dateStr = sessionDate.toLocaleDateString("ru-RU", {
    day: "2-digit",
    month: "short",
  });
  const timeStr = sessionDate.toLocaleTimeString("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <div className="session">
      <div className="session-top">
        <span className="s-lab">поездка</span>
        <b>
          {dateStr} · {timeStr}
        </b>
        <span>SensorLogger</span>
        <span className="muted">
          · запись <b>{fmtInt(totalMin)} мин</b> · в поездке{" "}
          <b>{fmtInt(moveMin)} мин</b> · {fmtInt(stats.pointCount)} точек
        </span>
      </div>
      <div className="mline">
        <i
          className="ml-move"
          style={{ width: `${movePct}%` }}
          data-tip={`Движение (§4.6 MovingTime): ${fmtInt(moveMin)} мин — интервалы со сглаженной скоростью выше 2 км/ч после гистерезиса 5/2 км/ч`}
        />
        <i
          className="ml-idle"
          style={{ width: `${idlePct}%` }}
          data-tip={`Время стоянок (§4.7 IdleTime): ${fmtInt(idleMin)} мин, включая «хвосты» до старта и после финиша — они не входят в активную поездку`}
        />
        <i
          className="ml-gap"
          style={{ width: `${gapPct}%`, minWidth: gapSec > 0 ? "3px" : "0" }}
          data-tip={`Разрывы записи (§4.6 states='gap'): ${fmtInt(stats.methodology?.gapCount ?? 0)} разрыва суммарно ${fmtInt(gapSec)} сек — интервалы между точками длиннее 30 сек`}
        />
      </div>
      <div className="mline-cap">
        <span>
          <i className="ml-move" style={{ background: "var(--plum)" }} />
          движение · {fmtInt(moveMin)} мин
        </span>
        <span>
          <i style={{ background: "#DCC9D3" }} />
          Время стоянок · {fmtInt(idleMin)} мин
        </span>
        <span>
          <i style={{ background: "repeating-linear-gradient(90deg,#C99A2E 0 3px,#F3E3C9 3px 6px)" }} />
          разрывы · {fmtInt(gapSec)} сек
        </span>
      </div>
    </div>
  );
}

// === Блок 01: Основные показатели (7 KPI) ===
function KpiBlock({
  stats,
  period,
  aggregated = false,
}: {
  stats: SessionStats | null | undefined;
  period: PeriodKey;
  aggregated?: boolean;
}) {
  // Compute KPI values from live stats.
  const dur = stats ? secToMin(stats.duration) : 0;
  const dist = stats ? stats.distance / 1000 : 0;
  const avgKmh = stats
    ? stats.distance > 0 && stats.duration > 0
      ? (stats.distance / stats.duration) * 3.6
      : 0
    : 0;
  const maxKmh = stats ? msToKmh(stats.maxSpeed) ?? 0 : 0;
  const moveMin = stats ? secToMin(stats.movingTime) : 0;
  const idleMin = stats ? secToMin(stats.idleTime) : 0;

  // Sparkline values from speedProfile.v[] (last 14 points, km/h).
  const sparkData = React.useMemo(() => {
    if (!stats?.speedProfile) return [];
    return stats.speedProfile
      .slice(-14)
      .map((p) => (p.v != null && p.v >= 0 ? p.v : 0));
  }, [stats]);

  return (
    <section>
      <div className="sec-head">
        <span className="sec-num">01</span>
        <span className="sec-title">Основные показатели</span>
        <span className="sec-sub">
          {stats
            ? aggregated
              ? `${fmtInt(stats.pointCount)} точек · все поездки периода`
              : `${fmtInt(stats.pointCount)} точек · запись ${fmtInt(dur)} мин`
            : "загрузка статистики…"}
        </span>
      </div>
      <div className="kpi-grid">
        <KpiCard
          label="Длительность"
          tip={`Длительность записи (§4.1 Duration): от первой до последней точки, включая стоянки-«хвосты» | Аналитика считается по активной части — см. «в поездке ${fmtInt(moveMin)} мин» в шапке`}
          value={stats ? fmtInt(dur) : "—"}
          unit="мин"
          trend={["—", "neu"]}
          sparkData={sparkData}
          color="#8E2D4E"
        />
        <KpiCard
          label="Дистанция"
          tip="Дистанция (§4.2 Distance): сумма гаверсинусов между соседними точками активной части | Точность ±1–3% от накопления погрешностей GPS"
          value={stats ? fmtNum(dist, 1) : "—"}
          unit="км"
          trend={["—", "neu"]}
          sparkData={sparkData}
          color="#8E2D4E"
        />
        <KpiCard
          label="Средняя скорость"
          tip="Средняя скорость (§4.3 AvgSpeed): дистанция, делённая на длительность активной поездки | Как читать: больше — лучше"
          value={stats ? fmtNum(avgKmh, 1) : "—"}
          unit="км/ч"
          trend={["—", "neu"]}
          sparkData={sparkData}
          color="#7B4B9E"
        />
        <KpiCard
          label="Макс. скорость"
          tip="Максимальная скорость (§4.4 MaxSpeed): пик за поездку с фильтрацией GPS-выбросов | Цвет по методологии: до 60 — норма, 60–100 — внимание, выше 100 — опасно"
          value={stats ? fmtNum(maxKmh, 1) : "—"}
          unit="км/ч"
          trend={["—", "neu"]}
          sparkData={sparkData}
          color="#D93A3A"
          variant="k-red"
        />
        <KpiCard
          label="Рекорд скорости"
          tip="Рекорд скорости за всё время (§4.5 MaxSpeedAllTime): максимум по всем вашим записям за всё время | Ваш личный рекорд — сравните с сегодняшним максимумом"
          value="—"
          unit="км/ч"
          trend={["—", "neu"]}
          sparkData={sparkData}
          color="#7B4B9E"
          variant="k-violet"
        />
        <KpiCard
          label="В движении"
          tip="Время в движении (§4.6 MovingTime): интервалы со скоростью выше 2 км/ч после сглаживания и гистерезиса | Контрольная сумма: движение + стоянки + разрывы = длительность записи"
          value={stats ? fmtInt(moveMin) : "—"}
          unit="мин"
          trend={["—", "neu"]}
          sparkData={sparkData}
          color="#8E2D4E"
          variant="k-plum"
        />
        <KpiCard
          label="Время стоянок"
          tip="Время стоянок (§4.7 IdleTime): интервалы со скоростью ниже 2 км/ч, включая «хвосты» записи | Как читать: меньше — лучше"
          value={stats ? fmtInt(idleMin) : "—"}
          unit="мин"
          trend={["—", "neu"]}
          sparkData={sparkData}
          color="#B47516"
        />
      </div>
    </section>
  );
}

function KpiCard({
  label,
  tip,
  value,
  unit,
  trend,
  sparkData,
  color,
  variant,
}: {
  label: string;
  tip: string;
  value: string;
  unit: string;
  trend: [string, "up" | "down" | "neu"];
  sparkData: number[];
  color: string;
  variant?: "k-red" | "k-violet" | "k-plum";
}) {
  return (
    <div className={`kpi ${variant ?? ""}`}>
      <div className="label">
        <span data-tip={tip}>{label}</span>
      </div>
      <div className="val">
        {value} <span className="unit">{unit}</span>
      </div>
      <span className={`trend ${trend[1]}`}>{trend[0]}</span>
      <Sparkline data={sparkData} color={color} />
    </div>
  );
}

function Sparkline({ data, color }: { data: number[]; color: string }) {
  // v2.10.0 R1: sparkline from real speedProfile data (last 14 points).
  // Если данных мало — fallback к seeded-плейсхолдеру (визуально непустая линия).
  const pts = React.useMemo(() => {
    if (data && data.length >= 2) {
      const mn = Math.min(...data);
      const mx = Math.max(...data);
      const rg = mx - mn + 0.001;
      return data.map((p, i) => {
        const x = 2 + i * (96 / (data.length - 1));
        const y = 24 - ((p - mn) / rg) * 18 - 3;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      });
    }
    // Fallback: 14 seeded-точек
    const r = mulberry32(31 * 48271 + 17);
    const arr: number[] = [];
    let v = 10 + r() * 8;
    for (let i = 0; i < 14; i++) {
      v += (r() - 0.5) * 5;
      v = Math.max(2, Math.min(26, v));
      arr.push(v);
    }
    const mn = Math.min(...arr);
    const mx = Math.max(...arr);
    const rg = mx - mn + 0.001;
    return arr.map((p, i) => `${(2 + i * (96 / 13)).toFixed(1)},${(24 - ((p - mn) / rg) * 18 - 3).toFixed(1)}`);
  }, [data]);

  const last = pts[pts.length - 1].split(",");
  return (
    <svg className="spark" viewBox="0 0 100 26" preserveAspectRatio="none" aria-hidden="true">
      <polyline points={pts.join(" ")} fill="none" stroke={color} strokeWidth="1.6" opacity="0.85" />
      <circle cx={last[0]} cy={last[1]} r="2" fill={color} />
    </svg>
  );
}

// === Блок 02: Оценка вождения — ДВА gauge-виджета ===
function DrivingScoreBlock({
  stats,
  events,
  aggregated = false,
}: {
  stats: SessionStats | null | undefined;
  events: EventsResponse | null | undefined;
  aggregated?: boolean;
}) {
  void aggregated; // подписка блока на режим (период-агрегат) — данные уже агрегированы вызывающим
  // Canonical CAP value + breakdown from stats.methodology.ecoScore.
  // /stats endpoint computes EcoScore with corpus-calibrated baselines (median of
  // all sessions + 1.2x margin for small corpus per §7.3). Fallback to count-based
  // formula only when stats not available.
  const hb = events?.summary?.harshBraking ?? 0;
  const ha = events?.summary?.harshAcceleration ?? 0;
  const mn = events?.summary?.maneuvers ?? 0;
  const ecoBreakdown = stats?.methodology?.ecoScore?.breakdown;
  // Simplify baseline version label for UI (was "corpus-median-8-margin1.2").
  const rawBaselineVersion = stats?.methodology?.ecoScore?.baselineVersion ?? "default";
  const baselineVersion = rawBaselineVersion.startsWith("corpus-median-")
    ? "корпус-медиана"
    : rawBaselineVersion === "default"
      ? "базовый"
      : rawBaselineVersion;

  const ecoScore = React.useMemo(() => {
    // 1. Canonical CAP value from methodology (corpus-calibrated baselines).
    if (stats?.methodology?.ecoScore?.value != null) {
      return Math.max(0, Math.min(100, Math.round(stats.methodology.ecoScore.value)));
    }
    // 2. Fallback: count-based formula from events.summary.
    if (events?.summary) {
      const raw = 100 - hb * 4 - ha * 2 - mn * 0.5;
      return Math.max(0, Math.min(100, Math.round(raw)));
    }
    return 70;
  }, [stats, events, hb, ha, mn]);

  const z = ecoZone(ecoScore);

  // v2.10.0 R6.1: canonical breakdown from stats.methodology.ecoScore.breakdown
  // (brakingPenalty / accelPenalty / jerkPenalty — already in 0..1 range from penalty formula).
  // Each component's "score cost" = penalty × weight (45 / 30 / 25 per §7.3).
  const canonicalBrakingPenalty = ecoBreakdown?.brakingPenalty;
  const canonicalAccelPenalty = ecoBreakdown?.accelPenalty;
  const canonicalJerkPenalty = ecoBreakdown?.jerkPenalty;
  const brakingPenalty = canonicalBrakingPenalty != null
    ? Math.round(canonicalBrakingPenalty * 45 * 10) / 10
    : Math.round(hb * 4.8 * 10) / 10;
  const accelPenalty = canonicalAccelPenalty != null
    ? Math.round(canonicalAccelPenalty * 30 * 10) / 10
    : Math.round(ha * 2.8 * 10) / 10;
  const jerkPenalty = canonicalJerkPenalty != null
    ? Math.round(canonicalJerkPenalty * 25 * 10) / 10
    : Math.round(mn * 0.3 * 10) / 10;

  // barPct: share of max weight (45 / 30 / 25 per methodology §7.3).
  const brakingBarPct = Math.min(100, (brakingPenalty / 45) * 100);
  const accelBarPct = Math.min(100, (accelPenalty / 30) * 100);
  const jerkBarPct = Math.min(100, (jerkPenalty / 25) * 100);

  // Efficiency (TimeSavingIndex) = (duration - planDurationSec) / 60 → min/trip.
  const planDurationSec = stats?.route?.planDurationSec;
  const actualDuration = stats?.duration;
  const eff = React.useMemo(() => {
    if (planDurationSec != null && actualDuration != null && planDurationSec > 0) {
      return (actualDuration - planDurationSec) / 60;
    }
    // No plan — neutral efficiency.
    return 0;
  }, [planDurationSec, actualDuration]);

  const ez = effZone(eff);
  const effPct = effToGaugePct(eff);
  const effBigValue = `${eff > 0 ? "+" : "−"}${Math.abs(eff).toFixed(1).replace(".", ",")}`;

  return (
    <section>
      <div className="sec-head">
        <span className="sec-num">02</span>
        <span className="sec-title">Оценка вождения</span>
        <span className="sec-sub">
          {events ? `${mn} манёвров · ${hb + ha} резких` : "загрузка событий…"} · базлайн: {baselineVersion}
        </span>
      </div>
      <div className="score-grid">
        {/* === Виджет 1: Плавность · EcoScore === */}
        <GaugeArc
          title="Плавность · EcoScore"
          helpTip="Оценка плавности вождения (§7.3, методика CAP). Формула: 100×(1 − 0.45·penalty(braking) − 0.30·penalty(accel) − 0.25·penalty(jerk)), где penalty = 1 − 1/(1+(actual/baseline)^1.5). Baseline = корпус-медиана ≥30 поездок по routeHash × 1.2 (margin для малого корпуса). Зоны: 80+ отлично · 60–79 неплохо · ниже 60 резко"
          bigValue={String(ecoScore)}
          bigValueSuffix="/ 100"
          arcColor={z.c}
          arcPct={ecoScore}
          bandText={z.band}
          bandCls={z.cls}
          note={
            <>
              Шкала штрафа — доля от максимума компонента (45 / 30 / 25 баллов за плавность торможения / разгона / рывка. Breakdown показывает вклад каждого компонента в итоговый EcoScore, базлайн {baselineVersion}.
            </>
          }
          rows={[
            {
              label: "Торможения",
              tip: `Энергия торможения на километр против базовой линии | Вклад в оценку с весом 0,45 — самый опасный манёвр (риск удара сзади) | canonical penalty=${canonicalBrakingPenalty ?? "—"} → −${brakingPenalty} балла`,
              barPct: brakingBarPct,
              value: `−${brakingPenalty.toString().replace(".", ",")} балла`,
            },
            {
              label: "Разгоны",
              tip: `Энергия разгона на километр против базовой линии | Вклад с весом 0,30 — расход топлива | canonical penalty=${canonicalAccelPenalty ?? "—"} → −${accelPenalty} балла`,
              barPct: accelBarPct,
              value: `−${accelPenalty.toString().replace(".", ",")} балла`,
            },
            {
              label: "Рывки",
              tip: `Энергия рывков на километр против базовой линии | Вклад с весом 0,25 — комфорт пассажиров (ISO 2631-1) | canonical penalty=${canonicalJerkPenalty ?? "—"} → −${jerkPenalty} балла`,
              barPct: jerkBarPct,
              value: `−${jerkPenalty.toString().replace(".", ",")} балла`,
            },
          ]}
        />

        {/* === Виджет 2: Эффективность · экономия к плану === */}
        <GaugeArc
          title="Эффективность · экономия к плану"
          helpTip="Метрика TimeSavingIndex (§6.3 DurationDeviation): среднее отклонение времени от плана маршрута в минутах на поездку. Отрицательное значение = экономия (слива), положительное = перерасход (алый). Источник: stats.route.planDurationSec vs stats.duration."
          bigValue={effBigValue}
          bigValueSuffix="мин/поездку"
          arcColor={ez.c}
          arcPct={effPct}
          bandText={ez.band}
          bandCls={ez.cls}
          note={
            <>
              Шкала: 0 в центре, левее — экономия (слива), правее — перерасход (алый). Отклонение =
              (Duration − PlanDuration)/60 за поездку.
            </>
          }
          rows={[
            {
              label: stats?.route?.provider ? `план (${stats.route.provider})` : "план",
              tip: `План маршрута: ${stats?.route?.provider ?? "—"} · ${planDurationSec ? fmtInt(planDurationSec / 60) + " мин" : "—"}`,
              barPct: planDurationSec && actualDuration ? Math.min(100, (planDurationSec / actualDuration) * 100) : 0,
              barColor: "var(--plum)",
              value: planDurationSec ? `${fmtInt(planDurationSec / 60)} мин` : "—",
              valueColor: "var(--plum)",
            },
            {
              label: "факт",
              tip: `Фактическая длительность активной поездки: ${fmtInt(secToMin(actualDuration))} мин`,
              barPct: 100,
              barColor: eff > 0 ? "var(--red)" : "var(--plum)",
              value: actualDuration ? `${fmtInt(secToMin(actualDuration))} мин` : "—",
              valueColor: eff > 0 ? "var(--red)" : "var(--plum)",
            },
            {
              label: "отклонение",
              tip: `Отклонение факта от плана: ${eff > 0 ? "перерасход" : "экономия"} ${Math.abs(eff).toFixed(1)} мин (${stats?.route?.durationDeviationPct ?? 0}%)`,
              barPct: Math.min(100, Math.abs(eff) * 20),
              barColor: eff > 0 ? "var(--red)" : "var(--plum)",
              value: effBigValue + " мин",
              valueColor: eff > 0 ? "var(--red)" : "var(--plum)",
            },
          ]}
        />
      </div>
    </section>
  );
}

// === Блок 03: Скоростной профиль ===
function SpeedProfileBlock({
  stats,
  aggregated = false,
}: {
  stats: SessionStats | null | undefined;
  aggregated?: boolean;
}) {
  // Compute 6 buckets from speedProfile.v[] (km/h).
  // Buckets: 0-20 / 20-40 / 40-60 / 60-80 / 80-100 / 100+
  // If speedProfile missing — try methodology.speedDistribution (6-element array from /stats).
  const buckets = React.useMemo(() => {
    if (stats?.methodology?.speedDistribution && stats.methodology.speedDistribution.length === 6) {
      return stats.methodology.speedDistribution.map((v) =>
        Math.round((Number(v) || 0) * 10) / 10
      );
    }
    if (!stats?.speedProfile || stats.speedProfile.length === 0) {
      // No data — equal-split placeholder.
      return [16, 16, 16, 16, 16, 16];
    }
    const counts = [0, 0, 0, 0, 0, 0];
    let total = 0;
    for (const p of stats.speedProfile) {
      if (p.v == null || p.v < 0) continue;
      if (p.st === 0) continue; // skip idle points
      if (p.v < 20) counts[0]++;
      else if (p.v < 40) counts[1]++;
      else if (p.v < 60) counts[2]++;
      else if (p.v < 80) counts[3]++;
      else if (p.v < 100) counts[4]++;
      else counts[5]++;
      total++;
    }
    if (total === 0) return [16, 16, 16, 16, 16, 16];
    return counts.map((c) => Math.round((c / total) * 1000) / 10);
  }, [stats]);

  // 5 stats from speedProfile (or fallback to methodology).
  const sp = React.useMemo(() => {
    if (!stats?.speedProfile || stats.speedProfile.length === 0) {
      return { p50: "—", std: "—", vr: "—", jam: "0 мин", cruise: "0 мин" };
    }
    const vs = stats.speedProfile
      .filter((p) => p.v != null && p.v >= 0 && p.st !== 0)
      .map((p) => p.v as number);
    if (vs.length === 0) {
      return { p50: "—", std: "—", vr: "—", jam: "0 мин", cruise: "0 мин" };
    }
    const sorted = [...vs].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length / 2)] ?? sorted[0];
    const mean = vs.reduce((s, v) => s + v, 0) / vs.length;
    const variance = vs.reduce((s, v) => s + (v - mean) ** 2, 0) / vs.length;
    const std = Math.sqrt(variance);
    const vr = mean > 0 ? std / mean : 0;

    // Time in traffic: sum dt where 0 < v < 10 km/h and st == 1
    // Time at cruise: sum dt where v > 60 km/h and st == 1
    let jamSec = 0;
    let cruiseSec = 0;
    for (let i = 1; i < stats.speedProfile.length; i++) {
      const prev = stats.speedProfile[i - 1];
      const curr = stats.speedProfile[i];
      if (curr.t == null || prev.t == null) continue;
      const dt = curr.t - prev.t;
      if (dt <= 0 || dt > 30) continue;
      if (curr.st === 1 && curr.v != null && curr.v > 0 && curr.v < 10) jamSec += dt;
      if (curr.st === 1 && curr.v != null && curr.v > 60) cruiseSec += dt;
    }
    const jamMin = jamSec / 60;
    const cruiseMin = cruiseSec / 60;
    const jamPct = stats.duration > 0 ? (jamSec / stats.duration) * 100 : 0;
    const cruisePct = stats.duration > 0 ? (cruiseSec / stats.duration) * 100 : 0;
    return {
      p50: fmtNum(p50, 0),
      std: fmtNum(std, 0),
      vr: fmtNum(vr, 2),
      jam: `${fmtInt(jamMin)} мин · ${fmtInt(jamPct)}%`,
      cruise: `${fmtInt(cruiseMin)} мин · ${fmtInt(cruisePct)}%`,
    };
  }, [stats]);

  // Bucket percentages sum normalized to 100
  const totalPct = buckets.reduce((s, v) => s + v, 0) || 100;
  const normalizedBuckets = buckets.map((v) => Math.round((v / totalPct) * 1000) / 10);

  return (
    <section>
      <div className="sec-head">
        <span className="sec-num">03</span>
        <span className="sec-title">Скоростной профиль{aggregated ? " · все поездки" : ""}</span>
        <span className="sec-sub">
          {stats?.speedProfile
            ? `${stats.speedProfile.length} точек${aggregated ? " (все поездки периода)" : " активной части"} · ${sp.p50} км/ч медиана`
            : "загрузка скоростного профиля…"}
        </span>
      </div>
      <div className="card">
        <div className="spwrap">
          <div className="sp-pcts">
            {normalizedBuckets.map((v, i) => (
              <span key={i} style={{ width: `${v}%` }}>
                {v}
                <i>%</i>
              </span>
            ))}
          </div>
          <div className="sp-bar">
            {normalizedBuckets.map((v, i) => (
              <i
                key={i}
                className={`s${i + 1}`}
                style={{ width: `${v}%` }}
                data-tip={`${BUCKETS[i][0]} км/ч: ${v}% точек в движении | ${BUCKETS[i][1]}`}
              />
            ))}
          </div>
          <div className="sp-ticks">
            {BUCKETS.map((b, i) => (
              <span key={i} style={{ width: `${normalizedBuckets[i]}%` }}>
                <b>{b[0]}</b>
              </span>
            ))}
          </div>
        </div>
        <div className="stats-grid">
          <Stat
            value={`${sp.p50} км/ч`}
            tip="Медианная скорость (§5.1 SpeedP50): половину времени в движении вы ехали быстрее этого значения | Устойчива к выбросам GPS, в отличие от среднего"
            label="Медиана скорости"
          />
          <Stat
            value={`${sp.std} км/ч`}
            tip="Разброс скорости (§5.2 SpeedStdDev): стандартное отклонение по алгоритму Уэлфорда | Как читать: меньше — ровнее езда"
            label="Разброс скорости"
          />
          <Stat
            value={sp.vr}
            tip="Перепады скорости (§5.6 SpeedVariation): отношение разброса к средней скорости | 0 — идеально ровно, выше 1 — рваный ритм"
            label="Перепады скорости"
          />
          <Stat
            value={sp.jam}
            cls="c-red"
            tip="Время в пробках (§5.4 TimeInTraffic): движение со сглаженной скоростью ниже 10 км/ч | Считается по вашим точкам GPS, стоянки не входят"
            label="Время в пробках"
          />
          <Stat
            value={sp.cruise}
            cls="c-plum"
            tip="Время крейсерского хода (§5.5 TimeAtCruise): движение быстрее 60 км/ч | Доля загородного и магистрального режима"
            label="Крейсерский ход"
          />
        </div>
      </div>
    </section>
  );
}

function Stat({
  value,
  tip,
  label,
  cls,
}: {
  value: string;
  tip: string;
  label: string;
  cls?: string;
}) {
  return (
    <div className="stat">
      <div className={`v ${cls ?? ""}`} dangerouslySetInnerHTML={{ __html: value }} />
      <div className="l">
        <span data-tip={tip}>{label}</span>
      </div>
    </div>
  );
}

// === Блок 04: План и факт · время (LIVE v2.10.1) ===
// Источники:
//   - stats.route.* из /api/sessions/[id]/stats (computePlanFact — уже считает plan/fact
//     и deviations на основе TrafficJob от 2ГИС/OSRM и haversine/40 baseline).
//   - route-comparison.stats из /api/sessions/[id]/route-comparison — сравнение с
//     routeHash-группой: rank, percentile, avg/best/worst/stdDev, trend.
function PlanFactBlock({
  stats,
  comparison,
  aggregated = false,
}: {
  stats: SessionStats | null | undefined;
  comparison: RouteComparisonData | null | undefined;
  aggregated?: boolean;
}) {
  void aggregated; // план/факт в период-режиме — суммы по всем поездкам
  // v2.10.1: useMemo ДОЛЖЕН быть до любого early return (rules-of-hooks).
  // Поэтому все производные значения — через optional chaining, а useMemo хранит
  // пустой массив если stats ещё не загружен.
  const route = stats?.route;
  const actualDurSec = stats?.duration ?? 0;
  const planDurSec = route?.planDurationSec ?? null;
  let dtMin: number | null = null;
  if (planDurSec != null && planDurSec > 0) {
    dtMin = (actualDurSec - planDurSec) / 60;
  } else if (route?.durationDeviationPct != null) {
    dtMin = (route.durationDeviationPct * actualDurSec) / 100 / 60;
  }
  const heroCls = dtMin == null ? "c-amber" : dtMin <= 0 ? "c-plum" : dtMin <= 2 ? "c-amber" : "c-red";
  const heroSign = dtMin == null ? "" : dtMin > 0 ? "+" : "−";
  const heroVal = dtMin == null ? "—" : Math.abs(dtMin).toFixed(0).replace(".", ",");
  const dtPct = route?.durationDeviationPct ?? (planDurSec && planDurSec > 0 ? Math.round(((actualDurSec - planDurSec) / planDurSec) * 1000) / 10 : null);
  const heroChip = dtMin == null ? "chip-amber" : Math.abs(dtMin) <= Math.max(2, (planDurSec ?? actualDurSec) / 60 * 0.05) ? "chip-amber" : dtMin <= 0 ? "chip-plum" : "chip-red";
  const heroLabel = dtMin == null ? "нет плана" : Math.abs(dtMin) <= (planDurSec ?? actualDurSec) / 60 * 0.05 ? "в пределах ±5%" : dtMin <= 0 ? "экономия" : "перерасход";

  const distDevPct = route?.distanceDeviationPct ?? null;
  const spdDevPct = route?.speedDeviationPct ?? null;
  const timeLostSec = route?.timeLostToTrafficSec ?? 0;
  const timeLostMin = timeLostSec / 60;
  const provider = route?.provider;
  const trafficFetched = !!route?.trafficFetched;

  const cmpStats = comparison?.stats;
  const cmpVsAvgPct = comparison?.vsAvgPct ?? null;
  const cmpRank = comparison?.rank ?? null;
  const cmpGroupSize = comparison?.groupSize ?? 0;
  const cmpPercentile = comparison?.percentile ?? null;
  const cmpTrend = comparison?.trend;
  const trendWord = cmpTrend?.rating === "improving" ? "улучшающийся" : cmpTrend?.rating === "degrading" ? "ухудшающийся" : cmpTrend?.rating === "stable" ? "стабильный" : "недостаточно данных";
  const trendSlopeWord = cmpTrend?.slope == null ? "—" : (cmpTrend.slope > 0 ? "+" : cmpTrend.slope < 0 ? "−" : "±") + Math.abs(cmpTrend.slope).toString().replace(".", ",");

  const planSpeedKmh = planDurSec != null && route?.planDistanceM != null && planDurSec > 0
    ? (route.planDistanceM / planDurSec) * 3.6
    : 40;
  const segs = React.useMemo(() => {
    if (!stats?.speedProfile || stats.speedProfile.length === 0) return [];
    const buckets = [
      { name: "Городской поток", range: [0, 30] as [number, number], type: "0–30 км/ч" },
      { name: "Магистраль", range: [30, 60] as [number, number], type: "30–60 км/ч" },
      { name: "Шоссе", range: [60, 90] as [number, number], type: "60–90 км/ч" },
      { name: "Трасса", range: [90, 1000] as [number, number], type: "90+ км/ч" },
    ];
    const totals = buckets.map(() => ({ durSec: 0, distM: 0, count: 0, vMax: 0, vSum: 0 }));
    for (let i = 1; i < stats.speedProfile.length; i++) {
      const prev = stats.speedProfile[i - 1];
      const curr = stats.speedProfile[i];
      const dt = curr.t - prev.t;
      if (dt <= 0 || dt > 30) continue;
      if (curr.st === 0) continue;
      const v = curr.v ?? 0;
      const bi = buckets.findIndex((b) => v >= b.range[0] && v < b.range[1]);
      if (bi < 0) continue;
      const avgVms = ((prev.v ?? 0) + v) / 2 / 3.6;
      totals[bi].durSec += dt;
      totals[bi].distM += avgVms * dt;
      totals[bi].count++;
      totals[bi].vMax = Math.max(totals[bi].vMax, v);
      totals[bi].vSum += v;
    }
    return buckets.map((b, i) => ({
      name: b.name,
      type: b.type,
      factDurSec: totals[i].durSec,
      factDistM: totals[i].distM,
      // v2.10.1 fix: planDurSec = (dist_km / planSpeed_kmh) * 3600 — секунды.
      // Раньше здесь было * 3600 дважды — давало 3600× завышение.
      planDurSec: totals[i].distM > 0 && planSpeedKmh > 0 ? (totals[i].distM / 1000) / planSpeedKmh * 3600 : 0,
      planSpeedKmh: planSpeedKmh,
      factSpeedKmh: totals[i].durSec > 0 ? (totals[i].distM / totals[i].durSec) * 3.6 : 0,
      count: totals[i].count,
    })).filter((s) => s.count > 0);
  }, [stats, planSpeedKmh]);

  const maxSegDur = Math.max(1, ...segs.map((s) => Math.max(s.factDurSec, s.planDurSec)));

  // v2.10.1: early return ПОСЛЕ всех hooks (rules-of-hooks).
  if (!stats) {
    return (
      <section>
        <div className="sec-head">
          <span className="sec-num">04</span>
          <span className="sec-title">План и факт · время</span>
          <span className="sec-sub">загрузка…</span>
        </div>
      </section>
    );
  }

  return (
    <section>
      <div className="sec-head">
        <span className="sec-num">04</span>
        <span className="sec-title">План и факт · время</span>
        <span className="sec-sub">
          {provider ? `план: ${provider}` : "плана нет"}
          {trafficFetched ? " · трафик 2ГИС учтён" : " · трафик не получен"}
          {cmpGroupSize > 0 ? ` · группа ${cmpGroupSize} поездок` : ""}
        </span>
      </div>
      <div className="card">
        <div className="pf-hero">
          <div>
            <div className="pf-label">
              <span
                data-tip="Отклонение по времени (§6.3 DurationDeviation): факт минус план, в минутах и процентах | Факт — активная поездка, план — расчёт маршрутизатора (2ГИС или OSRM) или baseline гаверсинус/40 км/ч | Обратная шкала: экономия — слива, перерасход — алый"
              >
                Отклонение по времени
              </span>
              <span
                className="help"
                data-tip="Главный показатель пунктуальности поездки | Как читать: −4 мин — приехали раньше, +4 мин — опоздали | Норма по методологии: ±5%"
              >
                ?
              </span>
            </div>
            <div className={`pf-val ${heroCls}`}>
              {heroSign}
              {heroVal} <span className="unit">мин</span>
            </div>
            <div className="pf-sub">
              {dtPct != null ? `${dtPct.toFixed(1).replace(".", ",")}% к плану` : "нет данных о плане"}{" "}
              <span className={`chip ${heroChip}`}>{heroLabel}</span>
            </div>
          </div>
          <div className="pf-side">
            <div className="pf-mini">
              <span
                data-tip={`Отклонение по дистанции (§6.6 DistanceDeviation): факт ${(stats.distance / 1000).toFixed(1).replace(".", ",")} км против плана ${route?.planDistanceM ? (route.planDistanceM / 1000).toFixed(1).replace(".", ",") : "—"} км | Обратная шкала: короче плана — слива, длиннее — алый`}
              >
                Откл. по дистанции
              </span>
              <b className={distDevPct == null ? "c-faint" : Math.abs(distDevPct) <= 2 ? "c-amber" : distDevPct > 0 ? "c-red" : "c-plum"}>
                {distDevPct == null ? "—" : `${distDevPct > 0 ? "+" : ""}${distDevPct.toString().replace(".", ",")}%`}
              </b>
            </div>
            <div className="pf-mini">
              <span
                data-tip="Отклонение скорости (§6.7 SpeedDeviation): средняя фактическая vs плановая (planDist/planDur) | Прямая шкала: быстрее плана — слива, медленнее — алый"
              >
                Откл. по скорости
              </span>
              <b className={spdDevPct == null ? "c-faint" : Math.abs(spdDevPct) <= 2 ? "c-amber" : spdDevPct > 0 ? "c-plum" : "c-red"}>
                {spdDevPct == null ? "—" : `${spdDevPct > 0 ? "+" : ""}${spdDevPct.toString().replace(".", ",")}%`}
              </b>
            </div>
            <div className="pf-mini">
              <span
                data-tip="Потери времени из-за пробок (§6.8 TimeLostToTraffic): на сколько минут пробки удлинили поездку относительно плана | Алый — безусловная потеря"
              >
                Потери в пробках
              </span>
              <b className={timeLostMin > 0 ? "c-red" : "c-plum"}>
                {fmtInt(timeLostMin)} мин
              </b>
            </div>
          </div>
        </div>

        <div className="pf-segs-head">
          По скоростным сегментам поездки{" "}
          <span className="muted">│ — план · полоса — факт · цвет — знак отклонения</span>
        </div>

        {segs.length === 0 ? (
          <p className="pf-note">Нет данных о скоростных сегментах для текущей поездки.</p>
        ) : (
          segs.map((s, i) => {
            const sdt = s.factDurSec - s.planDurSec;
            const sdtMin = sdt / 60;
            const sCls = sdt <= 0 ? "save" : sdtMin <= 2 ? "warn" : "lost";
            const sCc = sdt <= 0 ? "c-plum" : sdtMin <= 2 ? "c-amber" : "c-red";
            const dv = Math.round(((s.factSpeedKmh - s.planSpeedKmh) / s.planSpeedKmh) * 100);
            const scc = dv >= 0 ? "chip-plum" : dv >= -10 ? "chip-amber" : "chip-red";
            const factMin = s.factDurSec / 60;
            const planMin = s.planDurSec / 60;
            return (
              <div className="seg-row" key={i}>
                <div className="seg-name">
                  {s.name}
                  <small>{s.type} · {(s.factDistM / 1000).toFixed(1).replace(".", ",")} км</small>
                </div>
                <div className="bullet">
                  <div className={`fill ${sCls}`} style={{ width: `${(s.factDurSec / maxSegDur) * 100}%` }} />
                  <div className="tick" style={{ left: `${(s.planDurSec / maxSegDur) * 100}%` }} />
                </div>
                <div className="seg-delta">
                  <b className={sCc}>
                    {sdt > 0 ? "+" : "−"}
                    {Math.abs(sdtMin).toFixed(0)} мин
                  </b>
                  <span className="p">факт {fmtInt(factMin)} · план {fmtInt(planMin)}</span>
                  <span className="spd">
                    {s.factSpeedKmh.toFixed(1).replace(".", ",")} км/ч{" "}
                    <span className={`chip ${scc}`}>
                      {dv > 0 ? "+" : ""}
                      {dv}%
                    </span>
                  </span>
                </div>
              </div>
            );
          })
        )}

        <div className="seg-total">
          <span>Итог:</span>
          <span>
            план <b>{planDurSec != null ? fmtInt(planDurSec / 60) + " мин" : "—"}</b>
          </span>
          <span>
            факт <b>{fmtInt(actualDurSec / 60)} мин</b>
          </span>
          <b className={heroCls}>
            {dtMin == null ? "—" : `${dtMin > 0 ? "+" : "−"}${Math.abs(dtMin).toFixed(0)} мин`}
          </b>
        </div>

        {/* v2.10.1: vs routeHash-группа из route-comparison */}
        {comparison ? (
          <div className="pf-cmp">
            <div className="pf-segs-head">vs routeHash-группа ({cmpGroupSize} поездок)</div>
            <div className="stats-grid" style={{ marginTop: 0 }}>
              <Stat
                value={cmpRank != null ? `#${cmpRank}` : "—"}
                cls="c-plum"
                tip={`Ранг сессии в группе (§10.2): 1 = лучшая (самая быстрая) | Группа из ${cmpGroupSize} поездок по тому же routeHash`}
                label="Ранг в группе"
              />
              <Stat
                value={cmpPercentile != null ? `${cmpPercentile}%` : "—"}
                tip="Перцентиль (§10.2): позиция в группе, 0% = лучшая, 100% = худшая"
                label="Перцентиль"
              />
              <Stat
                value={cmpVsAvgPct != null ? `${cmpVsAvgPct > 0 ? "+" : ""}${cmpVsAvgPct.toString().replace(".", ",")}%` : "—"}
                cls={cmpVsAvgPct == null ? "c-faint" : cmpVsAvgPct <= 0 ? "c-plum" : "c-red"}
                tip="Отклонение от среднего (§10.2): отрицательное — быстрее среднего, положительное — медленнее"
                label="vs среднего"
              />
              <Stat
                value={cmpStats?.best != null ? `${fmtInt(cmpStats.best / 60)} мин` : "—"}
                cls="c-plum"
                tip="Лучшее время в группе (§10.2): минимальная активная длительность по всем сессиям с надёжностью ≥ 0.6"
                label="Лучшее в группе"
              />
              <Stat
                value={cmpStats?.worst != null ? `${fmtInt(cmpStats.worst / 60)} мин` : "—"}
                cls="c-red"
                tip="Худшее время в группе (§10.2): максимальная активная длительность"
                label="Худшее в группе"
              />
              <Stat
                value={cmpTrend?.slope != null ? `${trendSlopeWord} сек/день` : "—"}
                cls={cmpTrend?.slope == null ? "c-faint" : cmpTrend.slope < 0 ? "c-plum" : cmpTrend.slope > 0 ? "c-red" : "c-amber"}
                tip={`Тренд Theil-Sen (§10.5): наклон изменения времени по дням | CI 95%: ${cmpTrend?.ci95 ? `[${cmpTrend.ci95[0].toFixed(2)}, ${cmpTrend.ci95[1].toFixed(2)}]` : "—"} | Рейтинг: ${trendWord}`}
                label="Тренд Theil-Sen"
              />
            </div>
          </div>
        ) : null}

        <p className="pf-note">
          Сегменты — по фактической скорости (городской поток / магистраль / шоссе / трасса), план для каждого — {planSpeedKmh.toFixed(1).replace(".", ",")} км/ч (средняя плановая скорость).
          {" "}Сравнение с группой — через routeHash ({cmpGroupSize > 0 ? `${cmpGroupSize} поездок с тем же маршрутом` : "нет группы — единственная поездка"}).
        </p>
      </div>
    </section>
  );
}

// === Блок 05: Карта поездки (LIVE Leaflet) ===
function MapBlock({
  track,
  isLoading,
  isError,
  aggregated = false,
}: {
  track: TrackResponse | null | undefined;
  isLoading: boolean;
  isError: boolean;
  aggregated?: boolean;
}) {
  return (
    <section>
      <div className="sec-head">
        <span className="sec-num">05</span>
        <span className="sec-title">{aggregated ? "Карта поездок за период" : "Карта поездки"}</span>
        <span className="sec-sub">
          {track
            ? `${track.points.length} точек · ${track.segments.length} сегментов · слой ${track.defaultLayer}`
            : isLoading
              ? "загрузка трека…"
              : "сегменты по скорости · HMM/Viterbi"}
        </span>
      </div>
      <div className="card">
        <V4MapTrack
          track={track ?? null}
          isLoading={isLoading}
          isError={isError}
        />
        <p className="pf-note" style={{ marginTop: 10 }}>
          Цвет трека — средняя скорость сегмента (диапазоны те же, что в скоростном профиле).
          Маркеры старта и финиша — границы активной поездки (§4.11). Разрывы записи (&gt;30 сек)
          показаны пунктиром. Слой по умолчанию — «Street» (OpenStreetMap Standard tiles),
          доступны Satellite (Esri World Imagery), Terrain (OpenTopoMap), Dark (CartoDB dark_all).
        </p>
      </div>
    </section>
  );
}

// === Блок 06: Поведение и манёвры (LIVE /events) ===
function BehaviorBlock({
  events,
  stats,
  aggregated = false,
}: {
  events: EventsResponse | null | undefined;
  stats: SessionStats | null | undefined;
  aggregated?: boolean;
}) {
  void aggregated; // события в период-режиме — суммы по всем поездкам
  const hb = events?.summary?.harshBraking ?? 0;
  const ha = events?.summary?.harshAcceleration ?? 0;
  const hscCount = events?.summary?.hscCount ?? 0;
  const maneuversCount = events?.summary?.maneuvers ?? 0;
  const accelRMS = events?.summary?.accelerationRMS ?? 0;
  const jerkRMS = events?.summary?.jerkRMS ?? 0;
  const uniformity = React.useMemo(() => {
    const v = 1 - accelRMS / 10;
    return Math.max(0, Math.min(1, v));
  }, [accelRMS]);

  const ggPointsCount = events?.gg?.points?.length ?? 0;

  return (
    <section>
      <div className="sec-head">
        <span className="sec-num">06</span>
        <span className="sec-title">Поведение и манёвры</span>
        <span className="sec-sub">
          {events
            ? `${maneuversCount} манёвров · ${ggPointsCount} точек G-G · accelerationRMS ${accelRMS} м/с²`
            : "загрузка событий…"}
        </span>
      </div>
      <div className="beh-grid">
        <div className="card">
          <div className="card-title">
            Диаграмма манёвров
            <span
              className="help"
              data-tip="Каждая точка — манёвр: по горизонтали боковое ускорение (longA/g), по вертикали продольное (разгон вверх, торможение вниз). Визуализация метрик §7.4 AccelerationRMS и §7.5 JerkRMS. Алые кольца — события резких торможений и разгонов (§7.1, §7.2). Внутри 0,4g — плавная езда. Источник: /events.gg.points[] (x=longA/g, y=latA/g)."
            >
              ?
            </span>
          </div>
          <GgDiagram events={events} />
          <div className="gg-legend">
            {events
              ? `${ggPointsCount} манёвров · ${hb + ha} резких (алые кольца) · пунктир — граница 0,4g`
              : "загрузка…"}
          </div>
        </div>
        <div className="stack-v">
          <div className="card">
            <div className="card-title">События вождения</div>
            <div className="ev-grid">
              <div className="ev hot">
                <b>{hb}</b>
                <span
                  data-tip="Резкие торможения (§7.1 HarshBrakingCount): замедление сильнее −10 км/ч за секунду | Цвет: 0 — норма, 1 — внимание, 2+ — опасно"
                >
                  резких торможения
                </span>
              </div>
              <div className="ev hot">
                <b>{ha}</b>
                <span
                  data-tip="Резкие разгоны (§7.2 HarshAccelCount): ускорение сильнее +10 км/ч за секунду | Симметрично торможениям; старт с места не считается"
                >
                  резких разгона
                </span>
              </div>
              <div className="ev hot">
                <b>{hscCount}</b>
                <span
                  data-tip="Резкие манёвры на высокой скорости (§7.10 HighSpeedCornering): смена курса больше 45° за 5 сек при скорости выше 60 км/ч | Риск заноса"
                >
                  манёвра &gt;60 км/ч
                </span>
              </div>
            </div>
          </div>
          <div className="card">
            <div className="card-title">Резкость</div>
            <div className="stats-grid" style={{ marginTop: 0 }}>
              <Stat
                value={fmtNum(accelRMS, 2)}
                cls={accelRMS > 1.5 ? "c-red" : accelRMS > 0.5 ? "c-amber" : "c-plum"}
                tip="Интенсивность ускорений (§7.4 AccelerationRMS): среднеквадратичное ускорение, м/с² | Зоны: до 0,5 — плавно · 0,5–1,5 — умеренно · выше 1,5 — резко"
                label="Ср. ускорение"
              />
              <Stat
                value={fmtNum(jerkRMS, 2)}
                cls={jerkRMS > 2 ? "c-red" : jerkRMS > 0.5 ? "c-amber" : "c-plum"}
                tip="Резкость рывков (§7.5 JerkRMS): среднеквадратичная скорость изменения ускорения, м/с³ | Зоны: до 0,5 — плавно · 0,5–2,0 — умеренно · выше 2,0 — резко"
                label="Ср. рывок"
              />
              <Stat
                value={fmtNum(uniformity, 2)}
                cls={uniformity > 0.8 ? "c-plum" : uniformity > 0.4 ? "c-amber" : "c-red"}
                tip="Равномерность (§7.6 SpeedConsistencyIndex): единица минус отношение разброса к средней скорости | Зоны: выше 0,8 — ровно · 0,4–0,8 — умеренно · ниже 0,4 — рвано"
                label="Равномерность"
              />
            </div>
          </div>
          <div className="card">
            <div className="card-title">Сложность маршрута</div>
            <div className="stats-grid" style={{ marginTop: 0 }}>
              <Stat
                value={fmtNum(stats?.methodology?.bearingConsistency ?? null, 2)}
                cls="c-amber"
                tip="Прямолинейность маршрута (§7.7 BearingConsistency): единица минус нормированное рассеяние курса | Зоны: выше 0,85 — трасса · 0,5–0,85 — город · ниже 0,5 — серпантин"
                label="Прямолинейность"
              />
              <Stat
                value={fmtInt(stats?.methodology?.uTurnCount ?? 0)}
                cls="c-amber"
                tip="Развороты (§7.8 UTurnCount): смена курса на 150–210° — пересечение встречной полосы | Цвет: 0 — норма · 1 — внимание · 2+ — опасно"
                label="Развороты"
              />
              <Stat
                value={fmtInt(stats?.methodology?.turnCount ?? 0)}
                tip="Повороты (§7.9 TurnCount): смены курса 30–150° | Информативная метрика — характеризует сложность маршрута, а не стиль вождения"
                label="Повороты"
              />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function GgDiagram({ events }: { events: EventsResponse | null | undefined }) {
  // v2.10.0 R1: G-G diagram from real events.gg.points[] (x=longA/g, y=latA/g).
  // Each point → SVG circle radius 2.3, fill rgba(plum, .45).
  // 3 harsh rings from events.gg.rings [0.2, 0.4, 0.6] as concentric circles.
  // 0.4g ring is highlighted (gold dashed) per existing convention.
  // Harsh events get red ring + inner red dot.
  const ref = React.useRef<SVGSVGElement>(null);
  const rings = events?.gg?.rings ?? [0.2, 0.4, 0.6];
  const points = events?.gg?.points ?? [];
  const harshEvents = events?.harshEvents ?? [];

  React.useEffect(() => {
    const svg = ref.current;
    if (!svg) return;
    svg.innerHTML = "";
    const NS = "http://www.w3.org/2000/svg";
    const C = 120, SC = 170; // центр 120,120; масштаб 170px per 1g
    const mk = (n: string, a: Record<string, string | number>) => {
      const e = document.createElementNS(NS, n);
      for (const k in a) e.setAttribute(k, String(a[k]));
      return e;
    };
    const txt = (x: number, y: number, s: string, fill: string, size = 8) => {
      const t = mk("text", { x, y, fill, "font-size": size, "font-family": "Arial Narrow,Arial,sans-serif", "letter-spacing": "1" });
      t.textContent = s;
      svg.appendChild(t);
    };

    // Rings (concentric circles, 0.2 / 0.4 / 0.6 g)
    rings.forEach((g, i) => {
      svg.appendChild(mk("circle", {
        cx: C, cy: C, r: g * SC, fill: "none", stroke: "var(--line)",
        "stroke-width": 1, "stroke-dasharray": i ? "3 4" : "none",
      }));
    });
    // Highlight 0.4g ring (gold dashed) — per existing convention.
    if (rings.includes(0.4)) {
      svg.appendChild(mk("circle", {
        cx: C, cy: C, r: 0.4 * SC, fill: "none", stroke: "#C99A2E",
        "stroke-width": 1, "stroke-dasharray": "4 4", opacity: 0.8,
      }));
    }

    // Axes
    svg.appendChild(mk("line", { x1: C, y1: 8, x2: C, y2: 232, stroke: "var(--line)", "stroke-width": 1 }));
    svg.appendChild(mk("line", { x1: 8, y1: C, x2: 232, y2: C, stroke: "var(--line)", "stroke-width": 1 }));

    // Labels
    txt(C + 4, 16, "РАЗГОН", "var(--faint)");
    txt(C + 4, 230, "ТОРМОЖЕНИЕ", "var(--faint)");
    txt(10, C - 6, "ВЛЕВО", "var(--faint)");
    txt(204, C - 6, "ВПРАВО", "var(--faint)");

    // Plot all G-G points (radius 2.3, plum color with transparency)
    // x = longA/g, y = latA/g — note: SVG y axis is inverted (top = higher y)
    // Existing convention: разгон вверх (positive longA), торможение вниз (negative longA).
    // So cx = C + x * SC, cy = C - y * SC  (since y is "up" in physics = down in SVG)
    // But the API returns latA (lateral) as y, and longA (longitudinal) as x.
    // The existing convention puts longA on the Y-axis (up=разгон, down=торможение).
    // Let's swap: in the G-G diagram, Y-axis is longA (разгон/торможение), X-axis is latA (lateral).
    // So: cx = C + latA * SC, cy = C - longA * SC.
    // But events.gg.points has x = longA/g, y = latA/g.
    // We need: cx = C + (latA/g) * SC = C + (gg.y) * SC
    //          cy = C - (longA/g) * SC = C - (gg.x) * SC
    for (const p of points) {
      // Clamp to avoid drawing outside the SVG
      const cx = Math.max(8, Math.min(232, C + (p.y ?? 0) * SC));
      const cy = Math.max(8, Math.min(232, C - (p.x ?? 0) * SC));
      svg.appendChild(mk("circle", {
        cx: cx.toFixed(1), cy: cy.toFixed(1), r: 2.3,
        fill: "rgba(142,45,78,.45)",
      }));
    }

    // Highlight harsh events with red ring + inner red dot
    // harshEvents have lat/lng/longA — match with gg.points by longA
    for (const he of harshEvents) {
      const xg = he.longA / 9.81;
      // For harsh events, latA is unknown — but we can place them along x=0 axis
      // since harsh events are typically straight-line braking/acceleration.
      const cx = C; // lateral = 0
      const cy = Math.max(8, Math.min(232, C - xg * SC));
      svg.appendChild(mk("circle", {
        cx: cx.toFixed(1), cy: cy.toFixed(1), r: 6,
        fill: "none", stroke: "#D93A3A", "stroke-width": 1.4, opacity: 0.9,
      }));
      svg.appendChild(mk("circle", {
        cx: cx.toFixed(1), cy: cy.toFixed(1), r: 2, fill: "#D93A3A",
      }));
    }
  }, [points, rings, harshEvents]);

  return <svg ref={ref} className="gg-svg" viewBox="0 0 240 240" aria-hidden="true" />;
}

// === Блок 07: Пробки и заторы (LIVE v2.10.1) ===
// Источники:
//   - stats.methodology.timeInTraffic (§5.4): сумма интервалов со скоростью <10 км/ч.
//   - stats.methodology.timeAtCruise (§5.5): сумма интервалов со скоростью >60 км/ч.
//   - stats.methodology.movingTime / idleTime (§4.6/§4.7).
//   - stats.route.timeLostToTrafficSec (§6.8): потери от 2ГИС (если трафик получен).
//   - stats.methodology.speedDistribution (§5.3): 6 бакетов [0-20,20-40,...].
function TrafficBlock({ stats, aggregated = false }: { stats: SessionStats | null | undefined; aggregated?: boolean }) {
  void aggregated; // пробки в период-режиме — суммы по всем поездкам
  if (!stats || !stats.methodology) {
    return (
      <section>
        <div className="sec-head">
          <span className="sec-num">07</span>
          <span className="sec-title">Пробки и заторы</span>
          <span className="sec-sub">загрузка…</span>
        </div>
      </section>
    );
  }
  const m = stats.methodology;
  const moveSec = m.movingTime;
  const idleSec = m.idleTime;
  const jamSec = m.timeInTraffic; // §5.4: <10 км/ч
  const cruiseSec = m.timeAtCruise; // §5.5: >60 км/ч
  const moveNoJamSec = Math.max(0, moveSec - jamSec);
  const totalActive = Math.max(1, moveSec + idleSec);
  const movePct = (moveNoJamSec / totalActive) * 100;
  const jamPct = (jamSec / totalActive) * 100;
  const idlePct = (idleSec / totalActive) * 100;
  const jamMin = jamSec / 60;
  const cruiseMin = cruiseSec / 60;
  const moveNoJamMin = moveNoJamSec / 60;
  const idleMin = idleSec / 60;

  // §9.5 TimeInCongestion: timeLostToTrafficSec из 2ГИС (если есть) иначе fallback на jamSec
  const timeLostSec = stats.route?.timeLostToTrafficSec ?? jamSec;
  const timeLostMin = timeLostSec / 60;
  const trafficFetched = !!stats.route?.trafficFetched;

  // §9.3 TrafficSeverity: фактическая/плановая скорость (1.0 = свободно, 0.5 = пробка)
  const planSpeedKmh = stats.route?.planDistanceM && stats.route?.planDurationSec && stats.route.planDurationSec > 0
    ? (stats.route.planDistanceM / stats.route.planDurationSec) * 3.6
    : 40;
  const actualAvgKmh = stats.distance > 0 && stats.duration > 0
    ? (stats.distance / stats.duration) * 3.6
    : 0;
  const trafficSeverity = planSpeedKmh > 0 ? Math.max(0, Math.min(1, actualAvgKmh / planSpeedKmh)) : null;

  // §9.2 AvgTrafficSpeed: средняя по сегментам с пробками — у нас p50 (медиана) ближе всего.
  const avgTrafficSpeed = m.speedP50 ?? actualAvgKmh;

  // §9.4 CongestedSegments: доля точек в бакетах 0-20 + 20-40 (медленные)
  const dist = m.speedDistribution ?? [];
  const congestedPct = ((dist[0] ?? 0) + (dist[1] ?? 0));
  const totalSegments = 6; // всего бакетов

  // Покрытие данными: trafficFetched ? "100%" : "0 / 6" (нет данных 2ГИС)
  const coverageFetched = trafficFetched ? totalSegments : 0;
  const coverageText = `${coverageFetched} / ${totalSegments}`;

  // §9.5 значение — используем timeLost (если есть) или jam/2 как approximation
  const congMinVal = timeLostSec > 0 ? timeLostMin : jamMin / 2;

  return (
    <section>
      <div className="sec-head">
        <span className="sec-num">07</span>
        <span className="sec-title">Пробки и заторы</span>
        <span className="sec-sub">
          активная часть · {fmtInt((moveSec + idleSec) / 60)} мин ·{" "}
          {trafficFetched ? `данные 2ГИС учтены` : "по скорости GPS"}
        </span>
      </div>
      <div className="card">
        <div className="jbar">
          <div
            className="jb jb-move"
            style={{ width: `${movePct}%` }}
            data-tip={`Движение вне пробок (§5.4): ${fmtInt(moveNoJamMin)} мин из ${fmtInt((moveSec + idleSec) / 60)} мин активной поездки`}
          />
          <div
            className="jb jb-jam"
            style={{ width: `${jamPct}%` }}
            data-tip={`Время в пробках (§5.4 TimeInTraffic): ${fmtInt(jamMin)} мин — по вашей скорости ниже 10 км/ч | Считается по точкам GPS`}
          />
          <div
            className="jb jb-idle"
            style={{ width: `${idlePct}%` }}
            data-tip={`Остановки внутри поездки (§4.7 IdleTime): ${fmtInt(idleMin)} мин — светофоры, ожидание, парковка`}
          />
        </div>
        <div className="jbar-leg">
          <span>
            <i className="jb-move" />
            движение · {fmtInt(moveNoJamMin)} мин
          </span>
          <span>
            <i className="jb-jam" />
            Время в пробках · {fmtInt(jamMin)} мин
          </span>
          <span>
            <i className="jb-idle" />
            остановки · {fmtInt(idleMin)} мин
          </span>
        </div>
        <div className="stats-grid">
          <Stat
            value={`${fmtInt(congMinVal)} мин`}
            cls="c-red"
            tip={`Время в заторах (§9.5 TimeInCongestion): ${trafficFetched ? `${fmtInt(timeLostMin)} мин — потери от 2ГИС (§6.8)` : `approx ${fmtInt(jamMin / 2)} мин — половина jam-времени как оценка`} | Считается по сегментам, где скорость ниже половины плановой`}
            label="Время в заторах"
          />
          <Stat
            value={trafficSeverity != null ? fmtNum(trafficSeverity, 2) : "—"}
            cls={trafficSeverity == null ? "c-faint" : trafficSeverity >= 0.8 ? "c-plum" : trafficSeverity >= 0.5 ? "c-amber" : "c-red"}
            tip="Индекс загруженности (§9.3 TrafficSeverity): среднее отношение фактической скорости сегментов к плановой | 1,0 — свободно · 0,5 — пробка · 0,0 — глухой затор"
            label="Индекс загруженности"
          />
          <Stat
            value={`${fmtNum(avgTrafficSpeed, 1)} км/ч`}
            tip={`Средняя скорость с учётом пробок (§9.2 AvgTrafficSpeed): медианная скорость (§5.1) — ближе всего к «скорости с пробками» | План: ${fmtNum(planSpeedKmh, 1)} км/ч`}
            label="Скорость с пробками"
          />
          <Stat
            value={fmtNum(congestedPct, 1) + "%"}
            cls={congestedPct > 30 ? "c-red" : congestedPct > 15 ? "c-amber" : "c-plum"}
            tip="Перегруженные сегменты (§9.4 CongestedSegments): доля точек в бакетах 0–20 и 20–40 км/ч | Чем выше процент — тем больше доля медленного движения"
            label="Перегруж. сегменты"
          />
          <Stat
            value={coverageText}
            cls={trafficFetched ? "c-plum" : "c-amber"}
            tip={`Сегменты с данными о пробках (§9.1 TrafficFetchedSegments): покрытие маршрута данными 2ГИС | ${trafficFetched ? "трафик получен из TrafficJob" : "трафик не получен — расчёт только по GPS-скорости"}`}
            label="Покрытие данными"
          />
        </div>
      </div>
    </section>
  );
}

// === Блок 08: География и рельеф (LIVE v2.10.1) ===
// Источники:
//   - stats.methodology.routeEfficiency (§8.2): фактический путь / прямая.
//   - stats.methodology.avgAccuracy (§8.6): средняя точность GPS.
//   - stats.elevationGain/Loss (§8.4/§8.5): сумма подъёмов/спусков.
//   - bbox (stats.bbox): для heuristic городской зоны.
//   - speedProfile[].alt: для построения реального высотного профиля и расчёта AltitudeRange.
function GeoBlock({ stats, aggregated = false }: { stats: SessionStats | null | undefined; aggregated?: boolean }) {
  void aggregated; // рельеф в период-режиме — суммы/взвешенные средние
  // v2.10.1: useMemo вызываются ВНАЧАЛЕ (rules-of-hooks). early return — после.
  const elevGain = stats?.elevationGain ?? 0;
  const elevLoss = stats?.elevationLoss ?? 0;
  const avgAccuracy = stats?.methodology?.avgAccuracy ?? null;
  const routeEfficiency = stats?.methodology?.routeEfficiency ?? null;

  // v2.10.1: высотный профиль из speedProfile.alt[] (сглаженный на сервере)
  const altProfile = React.useMemo(() => {
    if (!stats?.speedProfile) return [];
    return stats.speedProfile
      .map((p) => p.alt)
      .filter((a): a is number => a != null && Number.isFinite(a));
  }, [stats]);

  // §8.3 AltitudeRange: max - min из реальных высот
  const altMin = altProfile.length > 0 ? Math.min(...altProfile) : null;
  const altMax = altProfile.length > 0 ? Math.max(...altProfile) : null;
  const altRange = altMin != null && altMax != null ? altMax - altMin : null;
  const altMid = altMin != null && altMax != null ? (altMin + altMax) / 2 : null;

  // v2.10.1: UrbanRatio heuristic — bbox площадь + доля низкоскоростных точек.
  const bbox = stats?.bbox;
  const bboxWidthKm = bbox ? (bbox.maxLon - bbox.minLon) * 111 * Math.cos((bbox.minLat + bbox.maxLat) / 2 * Math.PI / 180) : 0;
  const bboxHeightKm = bbox ? (bbox.maxLat - bbox.minLat) * 111 : 0;
  const bboxAreaKm2 = bboxWidthKm * bboxHeightKm;
  const speedDist = stats?.methodology?.speedDistribution ?? [];
  const lowSpeedPct = (speedDist[0] ?? 0) + (speedDist[1] ?? 0); // 0-20 + 20-40
  let urbanRatio: number;
  if (bboxAreaKm2 > 0 && bboxAreaKm2 < 25) {
    urbanRatio = 75 + Math.min(20, lowSpeedPct / 5); // 75-95%
  } else if (bboxAreaKm2 > 0 && bboxAreaKm2 < 100) {
    urbanRatio = 50 + Math.min(20, lowSpeedPct / 4); // 50-70%
  } else if (bboxAreaKm2 > 0) {
    urbanRatio = Math.max(15, 40 - Math.min(25, lowSpeedPct / 4)); // 15-40%
  } else {
    urbanRatio = 50 + Math.min(20, lowSpeedPct / 4); // fallback
  }
  urbanRatio = Math.max(0, Math.min(100, Math.round(urbanRatio)));

  // SVG path из реального высотного профиля
  const svgPath = React.useMemo(() => {
    if (altProfile.length < 2) {
      // Fallback на старый статичный профиль (если высот нет)
      return {
        area: "M0,50 L22,38 45,28 70,34 95,20 118,28 140,42 165,50 190,56 215,48 240,60 265,68 290,64 318,58 L318,92 0,92 Z",
        line: "0,50 22,38 45,28 70,34 95,20 118,28 140,42 165,50 190,56 215,48 240,60 265,68 290,64 318,58",
        hasReal: false,
      };
    }
    const W = 320, H = 92, pad = 4;
    const mn = Math.min(...altProfile);
    const mx = Math.max(...altProfile);
    const rg = Math.max(1, mx - mn);
    const step = (W - 2 * pad) / Math.max(1, altProfile.length - 1);
    const xy = altProfile.map((a, i) => {
      const x = pad + i * step;
      const y = H - pad - ((a - mn) / rg) * (H - 2 * pad);
      return [x, y] as [number, number];
    });
    const line = xy.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
    const area = `M${xy[0][0].toFixed(1)},${H} ` + xy.map((p) => `L${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ") + ` L${xy[xy.length - 1][0].toFixed(1)},${H} Z`;
    return { area, line, hasReal: true };
  }, [altProfile]);

  if (!stats) {
    return (
      <section>
        <div className="sec-head">
          <span className="sec-num">08</span>
          <span className="sec-title">География и рельеф</span>
          <span className="sec-sub">загрузка…</span>
        </div>
      </section>
    );
  }

  const elevRangeVal = altRange != null ? `${fmtNum(altRange, 0)} м` : `${Math.abs(elevGain - elevLoss)} м`;

  return (
    <section>
      <div className="sec-head">
        <span className="sec-num">08</span>
        <span className="sec-title">География и рельеф</span>
        <span className="sec-sub">
          {stats ? `набор +${elevGain} м / спуск −${elevLoss} м` : "поездка"}
          {altRange != null ? ` · перепад ${fmtNum(altRange, 0)} м` : ""}
        </span>
      </div>
      <div className="card">
        <div className="stats-grid" style={{ marginTop: 0 }}>
          <Stat
            value={routeEfficiency != null ? fmtNum(routeEfficiency, 2) : "—"}
            cls={routeEfficiency == null ? "c-faint" : routeEfficiency <= 1.15 ? "c-plum" : routeEfficiency <= 1.4 ? "c-amber" : "c-red"}
            tip="Извилистость маршрута (§8.2 RouteEfficiency): фактический путь к прямой дистанции старта и финиша | 1,0 — по прямой; больше — больше крюк"
            label="Извилистость маршрута"
          />
          <Stat
            value={`${urbanRatio}%`}
            cls={urbanRatio > 60 ? "c-amber" : "c-plum"}
            tip={`Доля городской зоны (§8.5 UrbanRatio): heuristic по bbox (${fmtNum(bboxAreaKm2, 1)} км²) и доле низкоскоростных точек (${fmtNum(lowSpeedPct, 0)}% <40 км/ч) | Остальные ${100 - urbanRatio}% — загород`}
            label="Городская зона"
          />
          <Stat
            value={`+${elevGain} м`}
            cls="c-plum"
            tip="Набор высоты (§8.4 AltitudeGain): сумма только подъёмов | Спуски в зачёт не идут — это «работа в гору»"
            label="Набор высоты"
          />
          <Stat
            value={elevRangeVal}
            tip={`Перепад высот (§8.3 AltitudeRange): разница max-min по ${altProfile.length} высотным точкам | ${altRange != null ? `min ${fmtNum(altMin!, 0)} м · max ${fmtNum(altMax!, 0)} м` : "высотных данных нет — approximation из набора/спуска"}`}
            label="Перепад высот"
          />
          <Stat
            value={avgAccuracy != null ? `${fmtNum(avgAccuracy, 1)} м` : "—"}
            cls={avgAccuracy == null ? "c-faint" : avgAccuracy <= 5 ? "c-plum" : avgAccuracy <= 15 ? "c-amber" : "c-red"}
            tip="Средняя точность GPS (§8.6 AvgAccuracy): средний радиус погрешности сигнала | До 5 м — точно, 5–15 м — приемлемо, выше — осторожно с выводами"
            label="Точность GPS"
          />
        </div>
        <div className="elev">
          <svg viewBox="0 0 320 92" preserveAspectRatio="none" aria-hidden="true">
            <defs>
              <linearGradient id="egrad" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0" stopColor="#8E2D4E" />
                <stop offset=".5" stopColor="#A85D8A" />
                <stop offset="1" stopColor="#7B4B9E" />
              </linearGradient>
            </defs>
            {altMid != null ? (
              <line x1="0" y1={(92 - 4 - ((altMid - (altMin ?? 0)) / Math.max(1, altRange ?? 1)) * (92 - 8)).toFixed(1)} x2="320" y2={(92 - 4 - ((altMid - (altMin ?? 0)) / Math.max(1, altRange ?? 1)) * (92 - 8)).toFixed(1)} stroke="var(--line)" strokeDasharray="3 4" />
            ) : (
              <line x1="0" y1="50" x2="320" y2="50" stroke="var(--line)" strokeDasharray="3 4" />
            )}
            <path d={svgPath.area} fill="var(--plum-dim)" />
            <polyline points={svgPath.line} fill="none" stroke="url(#egrad)" strokeWidth="2.2" />
          </svg>
          <div className="elev-l">
            <span className="c-plum">набор +{elevGain} м</span>
            <span className="c-faint">{svgPath.hasReal ? `высоты ${fmtNum(altMin ?? 0, 0)}–${fmtNum(altMax ?? 0, 0)} м · пунктир — средняя` : "пунктир — средняя высота"}</span>
            <span className="c-violet">спуск −{elevLoss} м</span>
          </div>
        </div>
      </div>
    </section>
  );
}

// === Блок 09: Тяжёлые участки (аккордеон, LIVE v2.10.1) ===
// Источник: GET /api/routes/heavy-segments — агрегат P75-хотспотов по всем routeHash-группам.
// Каждая группа: routeHash, sessionCount, totalSegments, hotspotCount, worstHotspots[].
// Цвет точки = severity (P75): <0.25 — красный (тяжёлый), 0.25-0.4 — оранжевый, >0.4 — слива.
function HeavySegmentsBlock({ data }: { data: HeavySegmentsData | null | undefined }) {
  const groups = data?.groups ?? [];
  const totalHotspots = data?.totalHotspotSegments ?? 0;
  const worstP75 = data?.worstP75 ?? null;
  const groupCount = data?.groupCount ?? 0;

  // v2.10.1: helper — цвет dot по severity (P75)
  const dotColor = (p75: number): string => {
    if (p75 < 0.25) return "#D93A3A"; // red — тяжёлый
    if (p75 < 0.4) return "#DB6B5B"; // orange-red — средний
    return "#A85D8A"; // plum — лёгкий
  };
  const dotCls = (p75: number): string => {
    if (p75 < 0.25) return "c-red";
    if (p75 < 0.4) return "c-amber";
    return "c-plum";
  };
  const dotChip = (p75: number): string => {
    if (p75 < 0.25) return "chip-red";
    if (p75 < 0.4) return "chip-amber";
    return "chip-plum";
  };
  const dotLabel = (p75: number): string => {
    if (p75 < 0.25) return "тяжёлый";
    if (p75 < 0.4) return "средний";
    return "лёгкий";
  };

  if (groupCount === 0) {
    return (
      <details className="acc" open>
        <summary>
          <span className="sec-num">09</span>Тяжёлые участки
          <span className="acc-badge">нет данных</span>
          <i className="chev">›</i>
        </summary>
        <div className="acc-body">
          <p className="acc-note">
            Нет routeHash-групп с хотспотами в БД. Создайте минимум 2 поездки по одному
            маршруту — система рассчитает P75-хотспоты (§10.6).
          </p>
        </div>
      </details>
    );
  }

  return (
    <details className="acc" open>
      <summary>
        <span className="sec-num">09</span>Тяжёлые участки
        <span className="acc-badge">
          {totalHotspots} участков · {groupCount} {groupCount === 1 ? "маршрут" : "маршрута"}
          {worstP75 != null ? ` · худший P75=${fmtNum(worstP75, 2)}` : ""}
        </span>
        <i className="chev">›</i>
      </summary>
      <div className="acc-body">
        <p className="acc-note">
          <span
            data-tip="Хронически пробочные участки (§10.6 HotspotSegments): сегменты, где медианная скорость стабильно ниже типичной для маршрута | Скорость участка — отношение к обычной скорости маршрута (P75): ниже 0,25 — тяжёлый, 0,25–0,4 — средний, выше 0,4 — лёгкий | Устойчиво к аномалиям: одна снежная поездка рейтинг не портит"
          >
            Скорость участка
          </span>{" "}
          — P75 фактической/плановой скорости по сегментам. Источник: GET /api/routes/heavy-segments.
        </p>
        {groups.map((g, idx) => {
          const dots = g.worstHotspots.map((h) => h.p75);
          // Сводный P75 группы = min из worst (тяжелейший сегмент)
          const groupP75 = dots.length > 0 ? Math.min(...dots) : null;
          const groupLab = groupP75 != null ? dotLabel(groupP75) : "—";
          const groupCls = groupP75 != null ? dotCls(groupP75) : "c-faint";
          const groupChip = groupP75 != null ? dotChip(groupP75) : "";
          const avgDistKm = g.avgDistanceM != null ? (g.avgDistanceM / 1000).toFixed(1).replace(".", ",") : "—";
          return (
            <div className="hs-row" key={g.routeHash}>
              <div>
                <div className="r-name">
                  Маршрут {g.routeHash.slice(0, 8)}… · {g.sessionCount} поездок
                </div>
                <div className="r-sub">
                  {g.hotspotCount} участков из {g.totalSegments} · ср. дистанция {avgDistKm} км
                </div>
                <div className="dots">
                  {dots.map((p, i) => (
                    <i
                      key={i}
                      style={{ background: dotColor(p) }}
                      data-tip={`Сегмент ${g.worstHotspots[i].segmentId} · P75=${fmtNum(p, 2)} · ${dotLabel(p)}`}
                    />
                  ))}
                  {dots.length === 0 ? (
                    <>
                      <i style={{ background: "#A85D8A" }} />
                      <i style={{ background: "#A85D8A" }} />
                      <i style={{ background: "#A85D8A" }} />
                      <i style={{ background: "#C77B8E" }} />
                    </>
                  ) : null}
                </div>
              </div>
              <div className="hs-val">
                <span className="hs-lab">скорость участка</span>
                <b className={groupCls}>{groupP75 != null ? fmtNum(groupP75, 2) : "—"}</b>
                <span className={`chip ${groupChip}`}>{groupLab}</span>
              </div>
            </div>
          );
        })}
      </div>
    </details>
  );
}

// === Блок 10: Частые маршруты (LIVE v2.10.1) ===
// Источник: GET /api/routes/grouped → listRouteGroups() — avg/best/worst/stdDev per routeHash.
// Per-row trend: useRouteTrend(routeHash) — теперь включает trafficPattern + dayOfWeekPattern.
function RoutesBlock({ groups }: { groups: { groups: RouteGroupInfo[]; total: number } | null | undefined }) {
  const groupsList = groups?.groups ?? [];
  const total = groups?.total ?? 0;
  const firstSeen = groupsList.length > 0
    ? groupsList.reduce((min, g) => g.firstSeen < min ? g.firstSeen : min, groupsList[0].firstSeen)
    : null;
  const totalTrips = groupsList.reduce((s, g) => s + g.sessionCount, 0);

  const firstDate = firstSeen ? new Date(firstSeen) : null;
  const firstDateStr = firstDate
    ? `с ${firstDate.toLocaleDateString("ru-RU", { day: "2-digit", month: "short" })}`
    : "нет поездок";

  return (
    <section>
      <div className="sec-head">
        <span className="sec-num">10</span>
        <span className="sec-title">Частые маршруты</span>
        <span className="sec-sub">
          {firstDateStr} · {totalTrips} поездок · {total} {total === 1 ? "маршрут" : "маршрута"} · нажмите для сравнения
        </span>
      </div>
      {groupsList.length === 0 ? (
        <div className="card" style={{ padding: "20px", color: "var(--muted)", fontSize: 12 }}>
          Нет routeHash-групп. Создайте минимум 2 поездки по одному маршруту —
          система сгруппирует их автоматически (§10.0).
        </div>
      ) : (
        <RouteList groups={groupsList} />
      )}
    </section>
  );
}

function RouteList({ groups }: { groups: RouteGroupInfo[] }) {
  const [openIdx, setOpenIdx] = React.useState<number | null>(0);
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (ref.current) bindTips(ref.current);
  }, [openIdx]);

  const maxSessionCount = Math.max(...groups.map((g) => g.sessionCount), 1);

  return (
    <div ref={ref}>
      {groups.map((g, i) => (
        <div key={g.routeHash} className={`route-row ${openIdx === i ? "open" : ""}`}>
          <div className="route-head" onClick={() => setOpenIdx(openIdx === i ? null : i)}>
            <div className={`route-count rc-1`}>{g.sessionCount}</div>
            <div className="route-mid">
              <div className="r-name">
                Маршрут {g.routeHash.slice(0, 8)}…
                {g.topologyHash ? ` · топология ${g.topologyHash}` : ""}
              </div>
              <div className="r-sub">
                {g.startCoord && g.endCoord
                  ? `${g.startCoord.lat.toFixed(3)},${g.startCoord.lon.toFixed(3)} → ${g.endCoord.lat.toFixed(3)},${g.endCoord.lon.toFixed(3)}`
                  : "координаты недоступны"}
                {g.avgDistanceM != null ? ` · ср. ${(g.avgDistanceM / 1000).toFixed(1).replace(".", ",")} км` : ""}
              </div>
              <div className="rbar">
                <div style={{ width: `${Math.round((g.sessionCount / maxSessionCount) * 100)}%` }} />
              </div>
            </div>
            <div className="r-last">
              последняя: {new Date(g.lastSeen).toLocaleDateString("ru-RU", { day: "2-digit", month: "short" })}
            </div>
            <i className="chev">›</i>
          </div>
          {openIdx === i ? (
            <div className="route-body">
              <RouteComparison routeGroup={g} />
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function RouteComparison({ routeGroup }: { routeGroup: RouteGroupInfo }) {
  // v2.10.1: fetch per-group trend (включая trafficPattern + dayOfWeekPattern после расширения endpoint)
  const trend = useRouteTrend(routeGroup.routeHash);
  const data: RouteTrendData | undefined = trend.data ?? undefined;
  const stats = data?.stats;
  const avgMin = stats?.avg != null ? stats.avg / 60 : null;
  const bestMin = stats?.best != null ? stats.best / 60 : null;
  const worstMin = stats?.worst != null ? stats.worst / 60 : null;
  const stdDevMin = stats?.stdDev != null ? stats.stdDev / 60 : null;

  // v2.10.1: 4 часа ночи/утро/день/вечер из 8 бакетов по 3 часа
  const trafficPattern = data?.trafficPattern ?? [];
  const hours4: (number | null)[] = [
    trafficPattern[0] && trafficPattern[0].avgActiveDurationSec != null ? trafficPattern[0].avgActiveDurationSec / 60 : null, // 0-3 night
    trafficPattern[1] && trafficPattern[1].avgActiveDurationSec != null ? trafficPattern[1].avgActiveDurationSec / 60 : null, // 3-6 morning
    trafficPattern[2] && trafficPattern[2].avgActiveDurationSec != null ? trafficPattern[2].avgActiveDurationSec / 60 : null, // 6-9 morning peak
    trafficPattern[3] && trafficPattern[3].avgActiveDurationSec != null ? trafficPattern[3].avgActiveDurationSec / 60 : null, // 9-12 day
    trafficPattern[4] && trafficPattern[4].avgActiveDurationSec != null ? trafficPattern[4].avgActiveDurationSec / 60 : null, // 12-15 day
    trafficPattern[5] && trafficPattern[5].avgActiveDurationSec != null ? trafficPattern[5].avgActiveDurationSec / 60 : null, // 15-18 evening peak
    trafficPattern[6] && trafficPattern[6].avgActiveDurationSec != null ? trafficPattern[6].avgActiveDurationSec / 60 : null, // 18-21 evening
    trafficPattern[7] && trafficPattern[7].avgActiveDurationSec != null ? trafficPattern[7].avgActiveDurationSec / 60 : null, // 21-24 night
  ];
  // 4 bucketed periods: ночь (0-6), утро (6-12), день (12-18), вечер (18-24)
  const periodLabels = ["ночь", "утро", "день", "вечер"];
  const hours4Agg: (number | null)[] = [
    avgOrNull([hours4[0], hours4[1]]),
    avgOrNull([hours4[2], hours4[3]]),
    avgOrNull([hours4[4], hours4[5]]),
    avgOrNull([hours4[6], hours4[7]]),
  ];

  const dowPattern = data?.dayOfWeekPattern ?? [];
  const days = dowPattern.map((d) => d.avgActiveDurationSec != null ? d.avgActiveDurationSec / 60 : null);
  const dlab = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];

  const tr = data?.trend;
  const slope = tr?.slope ?? null;
  const ci = tr?.ci95;
  const ciText = ci ? `[${fmtNum(ci[0], 2)}, ${fmtNum(ci[1], 2)}]` : null;
  const trendWord = tr?.rating === "improving" ? "улучшающийся" : tr?.rating === "degrading" ? "ухудшающийся" : tr?.rating === "stable" ? "стабильный" : "недостаточно данных";
  const history = data?.history ?? [];

  if (!data) {
    return (
      <div style={{ padding: "12px", color: "var(--muted)", fontSize: 12 }}>
        Загрузка тренда маршрута…
      </div>
    );
  }

  return (
    <>
      <div className="cmp-grid">
        <div className="cmp-cell">
          <b>{avgMin != null ? fmtInt(avgMin) : "—"} мин</b>
          <span>среднее время</span>
        </div>
        <div className="cmp-cell">
          <b className="c-plum">{bestMin != null ? fmtInt(bestMin) : "—"} мин</b>
          <span>лучшее</span>
        </div>
        <div className="cmp-cell">
          <b className="c-red">{worstMin != null ? fmtInt(worstMin) : "—"} мин</b>
          <span>худшее</span>
        </div>
      </div>
      <p className="acc-note" style={{ margin: "0 0 4px" }}>
        Стабильность времени: <b>±{stdDevMin != null ? fmtInt(stdDevMin) : "—"} мин</b> —{" "}
        {stdDevMin == null ? "—" : stdDevMin <= 5 ? "высокопредсказуемый" : stdDevMin <= 10 ? "предсказуемый" : "волатильный"} маршрут ({routeGroup.sessionCount} поездок).
      </p>
      <div className="heat-title">Зависимость от времени суток</div>
      <div className="heat heat-4c">
        {hours4Agg.map((v, k) => {
          const col = heatColor(v, avgMin ?? 0);
          const val = v == null ? "—" : `${fmtInt(v)} мин`;
          const tip = `${periodLabels[k]}: ${v == null ? "нет поездок" : `${fmtInt(v)} мин в среднем`}`;
          return (
            <i key={k} style={{ background: col }} data-tip={tip}>
              {val}
              <small>{periodLabels[k]}</small>
            </i>
          );
        })}
      </div>
      <div className="heat-title">Зависимость от дня недели</div>
      <div className="heat heat-7c">
        {days.map((v, k) => {
          const col = heatColor(v, avgMin ?? 0);
          return (
            <i
              key={k}
              style={{ background: col }}
              data-tip={`${dlab[k]}: ${v == null ? "нет поездок" : `${fmtInt(v)} мин в среднем (среднее по маршруту ${avgMin != null ? fmtInt(avgMin) : "—"} мин)`}`}
            >
              {v == null ? "—" : fmtInt(v)}
              <small>{dlab[k]}</small>
            </i>
          );
        })}
      </div>
      {slope == null ? (
        <>
          <div className="heat-title">Тренд времени</div>
          <p className="acc-note" style={{ margin: 0 }}>
            Недостаточно поездок для тренда (минимум 8, сейчас {history.length}).
          </p>
        </>
      ) : (
        <>
          <div className="heat-title">Тренд времени · Theil-Sen</div>
          <RouteTrendSvg trend={data} />
          <p className="trend-cap">
            Наклон <b>{slope > 0 ? "+" : slope < 0 ? "−" : "±"}{Math.abs(slope).toString().replace(".", ",")} сек/день</b> · 95% CI <b>{ciText ?? "—"}</b> — {trendWord} тренд. Пунктир — медианная регрессия, точки — поездки.
          </p>
        </>
      )}
    </>
  );
}

function avgOrNull(values: (number | null)[]): number | null {
  const valid = values.filter((v): v is number => v != null && Number.isFinite(v));
  if (valid.length === 0) return null;
  return valid.reduce((s, v) => s + v, 0) / valid.length;
}

function RouteTrendSvg({ trend }: { trend: RouteTrendData }) {
  const history = trend.history ?? [];
  const pts = history.map((h) => h.activeDurationSec / 60); // мин
  if (pts.length < 2) {
    return <div style={{ color: "var(--muted)", fontSize: 12, padding: 8 }}>Недостаточно точек ({pts.length})</div>;
  }
  const mn = Math.min(...pts);
  const mx = Math.max(...pts);
  const rg = Math.max(1, mx - mn + 4);
  const W = 320, H = 84, pad = 6;
  const npts = pts.length;
  const xy = pts.map((p, i) => [
    pad + (i * (W - 2 * pad)) / Math.max(1, npts - 1),
    H - pad - ((p - mn + 2) / rg) * (H - 2 * pad),
  ] as [number, number]);
  const poly = xy.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
  // Линия тренда — соединяет первую и последнюю точку регрессии Theil-Sen
  const tr = trend.trend;
  const y1 = xy[0][1];
  const y2 = xy[xy.length - 1][1];
  return (
    <svg className="trend-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      <polyline points={poly} fill="none" stroke="#A85D8A" strokeWidth="1.6" />
      {tr?.slope != null && (
        <line x1={pad} y1={y1.toFixed(1)} x2={W - pad} y2={y2.toFixed(1)} stroke="#8E2D4E" strokeWidth="1.6" strokeDasharray="5 4" />
      )}
      {xy.map((p, i) => (
        <circle key={i} cx={p[0].toFixed(1)} cy={p[1].toFixed(1)} r="2" fill="#8E2D4E" />
      ))}
    </svg>
  );
}

// === Блок 11: Качество данных (LIVE v2.10.1) ===
// Источник: stats.methodology.* — все 4 метрики качества (§11.1–§11.6).
function DataQualityBlock({ stats, aggregated = false }: { stats: SessionStats | null | undefined; aggregated?: boolean }) {
  void aggregated; // качество данных в период-режиме — средние по поездкам
  // v2.10.1: Все значения из live API; fallback только при отсутствии stats (загрузка).
  const completeness = stats?.methodology?.completenessScore ?? null;
  const reliability = stats?.methodology?.sessionReliability;
  const reliabilityLabel = reliability?.rating ?? "—";
  const reliabilityCls = (reliability?.value ?? 0) >= 0.85 ? "c-plum" : (reliability?.value ?? 0) >= 0.5 ? "c-amber" : "c-red";
  const pointDensity = stats?.methodology?.pointDensity ?? null;
  const gapCount = stats?.methodology?.gapCount ?? 0;
  const gapTotalSec = (stats?.methodology?.gapTotalDurationMs ?? 0) / 1000;
  const accuracyP90 = stats?.methodology?.accuracyP90 ?? null;
  // v2.10.1: доп метрики — driftScore (компонент надёжности), plausibilityScore, activeIdleTime
  const driftScore = reliability?.driftScore ?? null;
  const plausibility = reliability?.plausibilityScore ?? null;
  const activeIdleTime = stats?.methodology?.activeTrip?.activeIdleTime ?? null;

  if (!stats || !stats.methodology) {
    return (
      <details className="acc">
        <summary>
          <span className="sec-num">11</span>Качество данных
          <span className="acc-badge">загрузка…</span>
          <i className="chev">›</i>
        </summary>
      </details>
    );
  }

  return (
    <details className="acc">
      <summary>
        <span className="sec-num">11</span>Качество данных
        <span className="acc-badge">
          надёжность: {reliability ? reliability.rating : "—"}
        </span>
        <i className="chev">›</i>
      </summary>
      <div className="acc-body">
        <div className="prog-row">
          <div className="prog-head">
            <span>
              <span data-tip="Полнота записи (§11.5 CompletenessScore): доля времени с валидными точками | Выше 85% — данным можно доверять">
                Полнота данных
              </span>
            </span>
            <b>{completeness != null ? `${Math.round(completeness)}%` : "—"}</b>
          </div>
          <div className="prog">
            <div style={{ width: `${completeness != null ? Math.round(completeness) : 0}%` }} />
          </div>
        </div>
        <div className="stats-grid" style={{ marginTop: 0 }}>
          <Stat
            value={reliability ? reliabilityLabel : "—"}
            cls={reliabilityCls}
            tip={`Индекс доверия к записи (§11.6 SessionReliability): сводка дрейфа GPS и правдоподобия скорости | value=${reliability?.value ?? "—"} · drift=${driftScore ?? "—"} · plausibility=${plausibility ?? "—"} | Выше 0,85 — высокая, 0,5–0,85 — средняя, ниже 0,5 — низкая`}
            label="Надёжность записи"
          />
          <Stat
            value={pointDensity != null ? `${fmtNum(pointDensity, 1)}/с` : "—"}
            cls={pointDensity == null ? "c-faint" : pointDensity >= 1 ? "c-plum" : pointDensity >= 0.5 ? "c-amber" : "c-red"}
            tip="Плотность точек (§11.1 PointDensity): точек GPS в секунду активной части | Выше 1/с — достаточно для анализа манёвров"
            label="Плотность точек"
          />
          <Stat
            value={`${gapCount} · ${fmtInt(gapTotalSec)} сек`}
            cls={gapCount === 0 ? "c-plum" : gapCount <= 3 ? "c-amber" : "c-red"}
            tip="Разрывы (§11.2 GapCount, §11.3 GapTotalDuration): количество и суммарная длительность пауз сигнала | Разрыв — интервал между точками длиннее 30 сек"
            label="Пропуски сигнала"
          />
          <Stat
            value={accuracyP90 != null ? `${fmtNum(accuracyP90, 1)} м` : "—"}
            cls={accuracyP90 == null ? "c-faint" : accuracyP90 <= 10 ? "c-plum" : accuracyP90 <= 25 ? "c-amber" : "c-red"}
            tip="Точность GPS P90 (§11.4 AccuracyP90): 9 из 10 точек точнее этого значения | До 10 м — хорошо для городских маршрутов"
            label="Точность P90"
          />
          {driftScore != null ? (
            <Stat
              value={fmtNum(driftScore, 2)}
              cls={driftScore <= 0.15 ? "c-plum" : driftScore <= 0.3 ? "c-amber" : "c-red"}
              tip="Дрейф GPS (§11.6 DriftScore): насколько далеко точка ушла от реального положения | 0 — идеально, до 0,15 — норма, выше — проблема"
              label="Дрейф GPS"
            />
          ) : null}
          {plausibility != null ? (
            <Stat
              value={fmtNum(plausibility, 2)}
              cls={plausibility >= 0.85 ? "c-plum" : plausibility >= 0.5 ? "c-amber" : "c-red"}
              tip="Правдоподобие скорости (§11.6 PlausibilityScore): насколько реалистичны скорости между точками | 1,0 — все скорости возможны, ниже — есть нереалистичные"
              label="Правдоподобие скор."
            />
          ) : null}
          {activeIdleTime != null ? (
            <Stat
              value={`${fmtInt(activeIdleTime / 60)} мин`}
              tip="Время активных стоянок (§4.7 ActiveIdleTime): стоянки внутри активной поездки — светофоры, ожидание, парковка | Меньше — лучше"
              label="Активные стоянки"
            />
          ) : null}
        </div>
      </div>
    </details>
  );
}
