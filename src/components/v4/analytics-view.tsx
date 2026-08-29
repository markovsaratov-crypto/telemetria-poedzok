// src/components/v4/analytics-view.tsx — вкладка Аналитика v4 (v2.10.0 R1).
// 11 блоков (порядок утверждён, не менять):
//   1. Шапка сессии + таймлайн записи
//   2. 01 Основные показатели (7 KPI)          — LIVE /api/sessions/[id]/stats
//   3. 02 Оценка вождения — EcoScore + Эффективность — LIVE stats + events
//   4. 03 Скоростной профиль                  — LIVE stats
//   5. 04 План и факт · время                  — MOCK (R1 scope не включает)
//   6. 05 Карта поездки                        — LIVE /api/sessions/[id]/track (Leaflet)
//   7. 06 Поведение и манёвры                 — LIVE /api/sessions/[id]/events (G-G diagram)
//   8. 07 Пробки и заторы                      — MOCK
//   9. 08 География и рельеф                  — MOCK
//  10. 09 Тяжёлые участки (аккордеон)         — MOCK
//  11. 10 Частые маршруты                      — MOCK
//  12. 11 Качество данных (аккордеон)         — MOCK

"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import { motion } from "framer-motion";
import {
  PERIODS,
  TRIPS,
  ROUTES,
  BUCKETS,
  mulberry32,
  ecoZone,
  effZone,
  effToGaugePct,
  heatColor,
  type PeriodKey,
  type Trip,
  type RouteData,
} from "@/lib/telematika-v4-mock";
import { useSessionStats, type SessionStats } from "@/lib/hooks";
import { useV4Track, useV4Events } from "@/lib/v4-hooks";
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
  // v2.10.0 R1: live API hooks (replaces PERIODS mock in blocks 01/02/03/05/06).
  const stats = useSessionStats(sessionId);
  const track = useV4Track(sessionId);
  const events = useV4Events(sessionId);

  const data = PERIODS[period];
  const selectedTrip: Trip | null = TRIPS[0]; // for mock block 04 (PlanFact)
  const rootRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (rootRef.current) bindTips(rootRef.current);
  });

  // v2.10.0 R1: Empty state when no session selected.
  if (!sessionId) {
    return (
      <div ref={rootRef}>
        <div
          className="card"
          style={{
            padding: "32px 20px",
            textAlign: "center",
            color: "var(--muted)",
          }}
        >
          <div
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: "var(--text)",
              marginBottom: 8,
            }}
          >
            Выберите поездку
          </div>
          <div style={{ fontSize: 12, lineHeight: 1.6 }}>
            Откройте фильтр поездки вверху страницы и выберите конкретную сессию —
            блоки 01–06 отобразят живые данные из API.
            <br />
            Блоки 04, 07–11 останутся демонстрационными.
          </div>
        </div>
      </div>
    );
  }

  return (
    <div ref={rootRef}>
      <SessionHeader stats={stats.data} period={period} />
      <KpiBlock stats={stats.data} period={period} mockData={data} />
      <DrivingScoreBlock stats={stats.data} events={events.data} mockData={data} />
      <SpeedProfileBlock stats={stats.data} mockData={data} />
      <PlanFactBlock trip={selectedTrip} />
      <MapBlock track={track.data} isLoading={track.isLoading} isError={track.isError} />
      <BehaviorBlock events={events.data} stats={stats.data} />
      <TrafficBlock data={data} />
      <GeoBlock stats={stats.data} />
      <HeavySegmentsBlock />
      <RoutesBlock />
      <DataQualityBlock stats={stats.data} />
      <div className="toast">
        <b>v2.10.0 R1+R2.</b> Блоки 01–06 подключены к живому API. Блоки 04, 07–11
        пока используют демонстрационные данные. Карта — Leaflet, слой по умолчанию
        «Street» (OpenStreetMap Standard tiles), доступны Satellite/Terrain/Dark.
        G-G диаграмма — реальные точки из /events (не seeded).
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
  mockData,
}: {
  stats: SessionStats | null | undefined;
  period: PeriodKey;
  mockData: typeof PERIODS.today;
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
          {stats ? `${fmtInt(stats.pointCount)} точек · запись ${fmtInt(dur)} мин` : mockData.sub}
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
  mockData,
}: {
  stats: SessionStats | null | undefined;
  events: EventsResponse | null | undefined;
  mockData: typeof PERIODS.today;
}) {
  // v2.10.0 R6.1: prefer canonical CAP value + breakdown from stats.methodology.ecoScore.
  // The /stats endpoint now computes EcoScore with corpus-calibrated baselines (median of
  // all sessions + 1.2x margin for small corpus per §7.3), so the value is no longer 0 on
  // noisy synthetic CSV data. Fallback to count-based formula only when stats not available.
  const hb = events?.summary?.harshBraking ?? 0;
  const ha = events?.summary?.harshAcceleration ?? 0;
  const mn = events?.summary?.maneuvers ?? 0;
  const ecoBreakdown = stats?.methodology?.ecoScore?.breakdown;
  // v2.10.0 R6.7: simplify baseline version for UI (was "corpus-median-8-margin1.2" — looked like debug log).
  const rawBaselineVersion = stats?.methodology?.ecoScore?.baselineVersion ?? "default";
  const baselineVersion = rawBaselineVersion.startsWith("corpus-median-")
    ? "корпус v2.10"
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

  // v2.10.0 R1: Efficiency (TimeSavingIndex) = (duration - planDurationSec) / 60 → min/trip.
  const planDurationSec = stats?.route?.planDurationSec;
  const actualDuration = stats?.duration;
  const eff = React.useMemo(() => {
    if (planDurationSec != null && actualDuration != null && planDurationSec > 0) {
      return (actualDuration - planDurationSec) / 60;
    }
    return mockData.eff; // fallback
  }, [planDurationSec, actualDuration, mockData.eff]);

  const ez = effZone(eff);
  const effPct = effToGaugePct(eff);
  const effBigValue = `${eff > 0 ? "+" : "−"}${Math.abs(eff).toString().replace(".", ",")}`;

  return (
    <section>
      <div className="sec-head">
        <span className="sec-num">02</span>
        <span className="sec-title">Оценка вождения</span>
        <span className="sec-sub">
          {events ? `${mn} манёвров · ${hb + ha} резких` : mockData.sub} · базлайн: {baselineVersion}
        </span>
      </div>
      <div className="score-grid">
        {/* === Виджет 1: Плавность · EcoScore === */}
        <GaugeArc
          title="Плавность · EcoScore"
          helpTip="Оценка плавности вождения (§7.3, методика CAP). v2.10.0 R6.1: canonical формула 100×(1 − 0.45·penalty(braking) − 0.30·penalty(accel) − 0.25·penalty(jerk)), где penalty=1−1/(1+(actual/baseline)^1.5). Baseline = корпус-медиана (8 сессий) × 1.2 (margin для корпуса <30). Зоны: 80+ отлично · 60–79 неплохо · ниже 60 резко"
          bigValue={String(ecoScore)}
          bigValueSuffix="/ 100"
          arcColor={z.c}
          arcPct={ecoScore}
          bandText={z.band}
          bandCls={z.cls}
          note={
            <>
              Шкала штрафа — доля от максимума компонента (45 / 30 / 25 баллов). v2.10.0 R6.1: breakdown
              из stats.methodology.ecoScore.breakdown (canonical penalty×weight), базлайн {baselineVersion}.
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
          helpTip="Метрика TimeSavingIndex: среднее отклонение времени от плана (§6.3 DurationDeviation) | Как читать: слева от нуля — экономия (слива), справа — опоздания (алый) | v2.10.0 R1: вычисляется из stats.route.planDurationSec vs stats.duration"
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
  mockData,
}: {
  stats: SessionStats | null | undefined;
  mockData: typeof PERIODS.today;
}) {
  // v2.10.0 R1: compute 6 buckets from speedProfile.v[] (km/h).
  // Buckets: 0-20 / 20-40 / 40-60 / 60-80 / 80-100 / 100+
  const buckets = React.useMemo(() => {
    if (!stats?.speedProfile || stats.speedProfile.length === 0) {
      return mockData.dist; // fallback to mock when no data
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
    if (total === 0) return [16, 16, 16, 16, 16, 16]; // equal split placeholder
    return counts.map((c) => Math.round((c / total) * 1000) / 10);
  }, [stats, mockData.dist]);

  // 5 stats from speedProfile (or fallback to methodology).
  const sp = React.useMemo(() => {
    if (!stats?.speedProfile || stats.speedProfile.length === 0) {
      return {
        p50: mockData.st.p50,
        std: mockData.st.std,
        vr: mockData.st.vr,
        jam: mockData.st.jam,
        cruise: mockData.st.cruise,
      };
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
  }, [stats, mockData.st]);

  // Bucket percentages sum normalized to 100
  const totalPct = buckets.reduce((s, v) => s + v, 0) || 100;
  const normalizedBuckets = buckets.map((v) => Math.round((v / totalPct) * 1000) / 10);

  return (
    <section>
      <div className="sec-head">
        <span className="sec-num">03</span>
        <span className="sec-title">Скоростной профиль</span>
        <span className="sec-sub">
          {stats?.speedProfile
            ? `${stats.speedProfile.length} точек активной части · ${sp.p50} км/ч медиана`
            : mockData.spsub}
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

// === Блок 04: План и факт · время (MOCK — R1 scope не включает) ===
function PlanFactBlock({ trip }: { trip: Trip | null }) {
  if (!trip) return null;
  const plan = trip.segs.reduce((s, x) => s + x.plan, 0);
  const fact = trip.segs.reduce((s, x) => s + x.fact, 0);
  const dt = fact - plan;
  const heroCls = dt <= 0 ? "c-plum" : dt <= 2 ? "c-amber" : "c-red";
  const heroSign = dt > 0 ? "+" : "−";
  const heroChip =
    Math.abs(dt) <= Math.max(2, plan * 0.05)
      ? "chip-amber"
      : dt <= 0
        ? "chip-plum"
        : "chip-red";

  return (
    <section>
      <div className="sec-head">
        <span className="sec-num">04</span>
        <span className="sec-title">План и факт · время</span>
        <span className="sec-sub">
          {trip.d} {trip.mo.toLowerCase()} · план 2ГИС по эталонному маршруту · MOCK
        </span>
      </div>
      <div className="card">
        <div className="pf-hero">
          <div>
            <div className="pf-label">
              <span
                data-tip="Отклонение по времени (§6.3 DurationDeviation): факт минус план, в минутах и процентах | Факт — активная поездка (174 мин), план — расчёт маршрутизатора (170 мин) | Обратная шкала: экономия — слива, перерасход — алый"
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
              {Math.abs(dt)} <span className="unit">мин</span>
            </div>
            <div className="pf-sub">
              {((dt / plan) * 100).toFixed(1).replace(".", ",")}% к плану{" "}
              <span className={`chip ${heroChip}`}>
                {Math.abs(dt) <= plan * 0.05 ? "в пределах ±5%" : dt <= 0 ? "экономия" : "перерасход"}
              </span>
            </div>
          </div>
          <div className="pf-side">
            <div className="pf-mini">
              <span
                data-tip="Отклонение по дистанции (§6.6 DistanceDeviation): факт 124,9 км против плана 122,0 км | Обратная шкала: короче плана — слива, длиннее — алый"
              >
                Откл. по дистанции
              </span>
              <b className="c-amber">+2,4%</b>
            </div>
            <div className="pf-mini">
              <span
                data-tip="Отклонение скорости по сегментам (§6.7 SpeedDeviation): среднее по сегментам | Прямая шкала: быстрее плана — слива, медленнее — алый"
              >
                Откл. по скорости
              </span>
              <b className="c-red">−3,1%</b>
            </div>
            <div className="pf-mini">
              <span
                data-tip="Потери времени из-за пробок (§6.8 TimeLostToTraffic): на сколько минут пробки удлинили поездку относительно плана | Алый — безусловная потеря"
              >
                Потери в пробках
              </span>
              <b className="c-red">4 мин</b>
            </div>
          </div>
        </div>

        <div className="pf-segs-head">
          По сегментам поездки{" "}
          <span className="muted">│ — план · полоса — факт · цвет — знак отклонения</span>
        </div>

        {trip.segs.map((s, i) => {
          const sdt = s.fact - s.plan;
          const sCls = sdt <= 0 ? "save" : sdt <= 2 ? "warn" : "lost";
          const sCc = sdt <= 0 ? "c-plum" : sdt <= 2 ? "c-amber" : "c-red";
          const max = Math.max(...trip.segs.map((x) => Math.max(x.plan, x.fact))) * 1.12;
          const dv = Math.round(((s.fact_speed - s.plan_speed) / s.plan_speed) * 100);
          const scc = dv >= 0 ? "chip-plum" : dv >= -10 ? "chip-amber" : "chip-red";
          return (
            <div className="seg-row" key={i}>
              <div className="seg-name">
                {s.name}
                <small>{s.type_dist}</small>
              </div>
              <div className="bullet">
                <div className={`fill ${sCls}`} style={{ width: `${(s.fact / max) * 100}%` }} />
                <div className="tick" style={{ left: `${(s.plan / max) * 100}%` }} />
              </div>
              <div className="seg-delta">
                <b className={sCc}>
                  {sdt > 0 ? "+" : "−"}
                  {Math.abs(sdt)} мин
                </b>
                <span className="p">факт {s.fact} · план {s.plan}</span>
                <span className="spd">
                  {s.fact_speed.toString().replace(".", ",")} км/ч{" "}
                  <span className={`chip ${scc}`}>
                    {dv > 0 ? "+" : ""}
                    {dv}%
                  </span>
                  {s.jam ? (
                    <span className="chip chip-red" style={{ marginLeft: 4 }}>
                      пробка +{s.jam} мин
                    </span>
                  ) : null}
                </span>
              </div>
            </div>
          );
        })}

        <div className="seg-total">
          <span>Итог:</span>
          <span>
            план <b>{plan} мин</b>
          </span>
          <span>
            факт <b>{fact} мин</b>
          </span>
          <b className={heroCls}>
            {dt > 0 ? "+" : "−"}
            {Math.abs(dt)} мин
          </b>
        </div>
        <p className="pf-note">
          Скорость сегмента — средняя фактическая (дистанция/время сегмента); в чипе — отклонение от плановой скорости сегмента (§6.7). Основная потеря — Ленинградское шоссе: +10 мин, из них 8 мин — пробка. (MOCK — R1 scope не включает)
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
}: {
  track: TrackResponse | null | undefined;
  isLoading: boolean;
  isError: boolean;
}) {
  return (
    <section>
      <div className="sec-head">
        <span className="sec-num">05</span>
        <span className="sec-title">Карта поездки</span>
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
}: {
  events: EventsResponse | null | undefined;
  stats: SessionStats | null | undefined;
}) {
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
              data-tip="Каждая точка — манёвр: по горизонтали боковое ускорение, по вертикали разгон вверх и торможение вниз | Визуализация метрик §7.4 AccelerationRMS и §7.5 JerkRMS | Алые кольца — события резких торможений и разгонов (§7.1, §7.2) | Внутри 0,4g — плавная езда | v2.10.0 R1: LIVE из /events.gg.points[] (x=longA/g, y=latA/g)"
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

// === Блок 07: Пробки и заторы (MOCK — R1 scope не включает) ===
function TrafficBlock({ data }: { data: typeof PERIODS.today }) {
  return (
    <section>
      <div className="sec-head">
        <span className="sec-num">07</span>
        <span className="sec-title">Пробки и заторы</span>
        <span className="sec-sub">активная часть · 174 мин · данные 2ГИС · MOCK</span>
      </div>
      <div className="card">
        <div className="jbar">
          <div
            className="jb jb-move"
            style={{ width: "58.6%" }}
            data-tip="Движение вне пробок: 102 мин из 174 мин активной поездки"
          />
          <div
            className="jb jb-jam"
            style={{ width: "20.7%" }}
            data-tip="Время в пробках (§5.4 TimeInTraffic): 36 мин — по вашей скорости ниже 10 км/ч | Считается по точкам GPS"
          />
          <div
            className="jb jb-idle"
            style={{ width: "20.7%" }}
            data-tip="Остановки внутри поездки: 36 мин — светофоры, ожидание, парковка"
          />
        </div>
        <div className="jbar-leg">
          <span>
            <i className="jb-move" />
            движение · 102 мин
          </span>
          <span>
            <i className="jb-jam" />
            Время в пробках · 36 мин
          </span>
          <span>
            <i className="jb-idle" />
            остановки · 36 мин
          </span>
        </div>
        <div className="stats-grid">
          <Stat
            value="22 мин"
            cls="c-red"
            tip="Время в заторах (§9.5 TimeInCongestion): сумма времени сегментов, где скорость ниже половины плановой | Считается по данным 2ГИС о пробках — поэтому отличается от 36 мин «по скорости» (§5.4)"
            label="Время в заторах"
          />
          <Stat
            value="0,78"
            cls="c-amber"
            tip="Индекс загруженности (§9.3 TrafficSeverity): среднее отношение фактической скорости сегментов к плановой | 1,0 — свободно · 0,5 — пробка · 0,0 — глухой затор"
            label="Индекс загруженности"
          />
          <Stat
            value="38,4 км/ч"
            tip="Средняя скорость с учётом пробок (§9.2 AvgTrafficSpeed): средняя по сегментам с данными 2ГИС | Ниже вашей фактической средней — влияние заторов"
            label="Скорость с пробками"
          />
          <Stat
            value="3"
            cls="c-red"
            tip="Перегруженные сегменты (§9.4 CongestedSegments): участки, где фактическая скорость ниже половины плановой | Единый порог «пробки» 0,5 по всей системе"
            label="Перегруж. сегменты"
          />
          <Stat
            value="21 / 23"
            tip="Сегменты с данными о пробках (§9.1 TrafficFetchedSegments): покрытие маршрута данными 2ГИС | 2 сегмента без данных — заторы на них не учтены"
            label="Покрытие данными"
          />
        </div>
      </div>
    </section>
  );
}

// === Блок 08: География и рельеф (LIVE partial) ===
function GeoBlock({ stats }: { stats: SessionStats | null | undefined }) {
  // v2.10.0 R1: Live stats for elevation + accuracy. Route efficiency + urban ratio stay MOCK.
  const elevGain = stats?.elevationGain ?? 0;
  const elevLoss = stats?.elevationLoss ?? 0;
  const elevRange = stats?.methodology?.avgAccuracy != null ? null : null; // not directly available
  const avgAccuracy = stats?.methodology?.avgAccuracy ?? null;
  const routeEfficiency = stats?.methodology?.routeEfficiency ?? null;

  return (
    <section>
      <div className="sec-head">
        <span className="sec-num">08</span>
        <span className="sec-title">География и рельеф</span>
        <span className="sec-sub">
          {stats ? `набор +${elevGain} м / спуск −${elevLoss} м` : "поездка"}
        </span>
      </div>
      <div className="card">
        <div className="stats-grid" style={{ marginTop: 0 }}>
          <Stat
            value={routeEfficiency != null ? fmtNum(routeEfficiency, 2) : "—"}
            cls="c-amber"
            tip="Извилистость маршрута (§8.2 RouteEfficiency): фактический путь к прямой дистанции старта и финиша | 1,0 — по прямой; больше — больше крюк"
            label="Извилистость маршрута"
          />
          <Stat
            value="68%"
            tip="Доля городской зоны (§8.5 UrbanRatio): доля точек в городской черте по обратному геокодированию | Остальные 32% — МКАД и загород (MOCK — R1 scope не включает)"
            label="Городская зона"
          />
          <Stat
            value={`+${elevGain} м`}
            cls="c-plum"
            tip="Набор высоты (§8.4 AltitudeGain): сумма только подъёмов | Спуски в зачёт не идут — это «работа в гору»"
            label="Набор высоты"
          />
          <Stat
            value={elevRange != null ? `${elevRange} м` : `${Math.abs(elevGain - elevLoss)} м`}
            tip="Перепад высот (§8.3 AltitudeRange): разница между самой высокой и низкой точками | Меньше набора высоты — рельеф холмистый, но без больших перепадов"
            label="Перепад высот"
          />
          <Stat
            value={avgAccuracy != null ? `${fmtNum(avgAccuracy, 1)} м` : "—"}
            cls="c-plum"
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
            <line x1="0" y1="50" x2="320" y2="50" stroke="var(--line)" strokeDasharray="3 4" />
            <path
              d="M0,50 L22,38 45,28 70,34 95,20 118,28 140,42 165,50 190,56 215,48 240,60 265,68 290,64 318,58 L318,92 0,92 Z"
              fill="var(--plum-dim)"
            />
            <polyline
              points="0,50 22,38 45,28 70,34 95,20 118,28 140,42 165,50 190,56 215,48 240,60 265,68 290,64 318,58"
              fill="none"
              stroke="url(#egrad)"
              strokeWidth="2.2"
            />
          </svg>
          <div className="elev-l">
            <span className="c-plum">набор +{elevGain} м</span>
            <span className="c-faint">пунктир — средняя высота</span>
            <span className="c-violet">спуск −{elevLoss} м</span>
          </div>
        </div>
      </div>
    </section>
  );
}

// === Блок 09: Тяжёлые участки (аккордеон, MOCK) ===
function HeavySegmentsBlock() {
  return (
    <details className="acc" open>
      <summary>
        <span className="sec-num">09</span>Тяжёлые участки
        <span className="acc-badge">12 участков · 3 маршрута · MOCK</span>
        <i className="chev">›</i>
      </summary>
      <div className="acc-body">
        <p className="acc-note">
          <span
            data-tip="Хронически пробочные участки (§10.6 HotspotSegments): сегменты, где медианная скорость стабильно ниже типичной для маршрута | Скорость участка — отношение к обычной скорости маршрута: ниже 0,25 — тяжёлый, 0,25–0,4 — средний, выше 0,4 — лёгкий | Устойчиво к аномалиям: одна снежная поездка рейтинг не портит"
          >
            Скорость участка
          </span>{" "}
          — доля от типичной скорости маршрута (P75). Точки — последние поездки. (MOCK — R1 scope не включает)
        </p>
        <div className="hs-row">
          <div>
            <div className="r-name">Дом → Офис · утро</div>
            <div className="r-sub">8 участков · выезд с МКАД на Ленинградское ш.</div>
            <div className="dots">
              <i style={{ background: "#D93A3A" }} />
              <i style={{ background: "#D93A3A" }} />
              <i style={{ background: "#D93A3A" }} />
              <i style={{ background: "#D93A3A" }} />
              <i style={{ background: "#DB6B5B" }} />
              <i style={{ background: "#DB6B5B" }} />
              <i style={{ background: "#DB6B5B" }} />
              <i style={{ background: "#DB6B5B" }} />
            </div>
          </div>
          <div className="hs-val">
            <span className="hs-lab">скорость участка</span>
            <b className="c-red">0,18</b>
            <span className="chip chip-red">тяжёлый</span>
          </div>
        </div>
        <div className="hs-row">
          <div>
            <div className="r-name">Офис → МКАД · юг</div>
            <div className="r-sub">3 участка · развязка на юге кольца</div>
            <div className="dots">
              <i style={{ background: "#DB6B5B" }} />
              <i style={{ background: "#DB6B5B" }} />
              <i style={{ background: "#DB6B5B" }} />
              <i style={{ background: "#DB6B5B" }} />
              <i style={{ background: "#C77B8E" }} />
              <i style={{ background: "#C77B8E" }} />
              <i style={{ background: "#C77B8E" }} />
              <i style={{ background: "#C77B8E" }} />
            </div>
          </div>
          <div className="hs-val">
            <span className="hs-lab">скорость участка</span>
            <b className="c-amber">0,32</b>
            <span className="chip chip-amber">средний</span>
          </div>
        </div>
        <div className="hs-row">
          <div>
            <div className="r-name">Офис → Дача · Истра</div>
            <div className="r-sub">1 участок · примыкание к Волоколамскому ш.</div>
            <div className="dots">
              <i style={{ background: "#A85D8A" }} />
              <i style={{ background: "#A85D8A" }} />
              <i style={{ background: "#A85D8A" }} />
              <i style={{ background: "#A85D8A" }} />
              <i style={{ background: "#A85D8A" }} />
              <i style={{ background: "#A85D8A" }} />
              <i style={{ background: "#C77B8E" }} />
              <i style={{ background: "#C77B8E" }} />
            </div>
          </div>
          <div className="hs-val">
            <span className="hs-lab">скорость участка</span>
            <b className="c-plum">0,44</b>
            <span className="chip chip-plum">лёгкий</span>
          </div>
        </div>
      </div>
    </details>
  );
}

// === Блок 10: Частые маршруты (MOCK) ===
function RoutesBlock() {
  return (
    <section>
      <div className="sec-head">
        <span className="sec-num">10</span>
        <span className="sec-title">Частые маршруты</span>
        <span className="sec-sub">с 14 мая · 92 поездки · нажмите для сравнения · MOCK</span>
      </div>
      <RouteList />
    </section>
  );
}

function RouteList() {
  const [openIdx, setOpenIdx] = React.useState<number | null>(0);
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (ref.current) bindTips(ref.current);
  }, [openIdx]);

  return (
    <div ref={ref}>
      {ROUTES.map((rt, i) => (
        <div key={i} className={`route-row ${openIdx === i ? "open" : ""}`}>
          <div className="route-head" onClick={() => setOpenIdx(openIdx === i ? null : i)}>
            <div className={`route-count ${rt.cls}`}>{rt.c}</div>
            <div className="route-mid">
              <div className="r-name">{rt.n}</div>
              <div className="r-sub">{rt.sub}</div>
              <div className="rbar">
                <div style={{ width: `${Math.round((Number(rt.c) / 18) * 100)}%` }} />
              </div>
            </div>
            <div className="r-last">последняя: 28 авг</div>
            <i className="chev">›</i>
          </div>
          <div className="route-body">
            <RouteComparison rt={rt} />
          </div>
        </div>
      ))}
    </div>
  );
}

function RouteComparison({ rt }: { rt: RouteData }) {
  return (
    <>
      <div className="cmp-grid">
        <div className="cmp-cell">
          <b>{rt.avg} мин</b>
          <span>среднее время</span>
        </div>
        <div className="cmp-cell">
          <b className="c-plum">{rt.best} мин</b>
          <span>лучшее</span>
        </div>
        <div className="cmp-cell">
          <b className="c-red">{rt.worst} мин</b>
          <span>худшее</span>
        </div>
      </div>
      <p className="acc-note" style={{ margin: "0 0 4px" }}>
        Стабильность времени: <b>±{rt.std} мин</b> —{" "}
        {rt.std <= 5 ? "высокопредсказуемый" : rt.std <= 10 ? "предсказуемый" : "волатильный"} маршрут ({rt.c} поездок).
      </p>
      <div className="heat-title">Зависимость от времени суток</div>
      <div className="heat heat-4c">
        {rt.hours.map((v, k) => {
          const col = heatColor(v, rt.avg);
          const val = v === null ? "—" : `${v} мин`;
          const tip = `${rt.hlab[k]}: ${v === null ? "нет поездок" : `${v} мин в среднем`}`;
          return (
            <i key={k} style={{ background: col }} data-tip={tip}>
              {val}
              <small>{rt.hlab[k]}</small>
            </i>
          );
        })}
      </div>
      <div className="heat-title">Зависимость от дня недели</div>
      <div className="heat heat-7c">
        {rt.days.map((v, k) => {
          const col = heatColor(v, rt.avg);
          return (
            <i
              key={k}
              style={{ background: col }}
              data-tip={`${rt.dlab[k]}: ${v} мин в среднем (среднее по маршруту ${rt.avg} мин)`}
            >
              {v}
              <small>{rt.dlab[k]}</small>
            </i>
          );
        })}
      </div>
      {rt.slope === null ? (
        <>
          <div className="heat-title">Тренд времени</div>
          <p className="acc-note" style={{ margin: 0 }}>
            Недостаточно поездок для тренда (минимум 8, сейчас {rt.npts}).
          </p>
        </>
      ) : (
        <>
          <div className="heat-title">Тренд времени · Theil-Sen</div>
          <RouteTrendSvg rt={rt} />
          <p className="trend-cap">
            Наклон <b>{rt.slope > 0 ? "+" : rt.slope < 0 ? "−" : "±"}{Math.abs(rt.slope!).toString().replace(".", ",")} мин/мес</b> · 95% CI <b>[{rt.ci}]</b> — {rt.trendWord} тренд. Пунктир — медианная регрессия, точки — поездки.
          </p>
        </>
      )}
    </>
  );
}

function RouteTrendSvg({ rt }: { rt: RouteData }) {
  const r = React.useMemo(() => mulberry32(rt.seed), [rt.seed]);
  const pts = React.useMemo(() => {
    const arr: number[] = [];
    let v = 176 + (r() - 0.5) * 8;
    for (let i = 0; i < rt.npts; i++) {
      v += (r() - 0.45) * 6 + (rt.slope ?? 0) * 0.4;
      arr.push(Math.max(rt.best - 2, Math.min(rt.worst + 2, v)));
    }
    return arr;
  }, [r, rt]);
  const mn = Math.min(...pts);
  const mx = Math.max(...pts);
  const rg = mx - mn + 4;
  const W = 320, H = 84, pad = 6;
  const xy = pts.map((p, i) => [
    pad + (i * (W - 2 * pad)) / (rt.npts - 1),
    H - pad - ((p - mn + 2) / rg) * (H - 2 * pad),
  ]);
  const poly = xy.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
  const y1 = H - pad - ((pts[0] - mn + 2) / rg) * (H - 2 * pad);
  const y2 = H - pad - ((pts[rt.npts - 1] - mn + 2) / rg) * (H - 2 * pad);
  return (
    <svg className="trend-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
      <polyline points={poly} fill="none" stroke="#A85D8A" strokeWidth="1.6" />
      <line x1={pad} y1={y1.toFixed(1)} x2={W - pad} y2={y2.toFixed(1)} stroke="#8E2D4E" strokeWidth="1.6" strokeDasharray="5 4" />
      {xy.map((p, i) => (
        <circle key={i} cx={p[0].toFixed(1)} cy={p[1].toFixed(1)} r="2" fill="#8E2D4E" />
      ))}
    </svg>
  );
}

// === Блок 11: Качество данных (LIVE partial) ===
function DataQualityBlock({ stats }: { stats: SessionStats | null | undefined }) {
  // v2.10.0 R1: Live methodology values for completeness, gaps, accuracy.
  const completeness = stats?.methodology?.completenessScore ?? 92;
  const reliability = stats?.methodology?.sessionReliability;
  const reliabilityLabel = reliability?.rating ?? "—";
  const reliabilityCls = (reliability?.value ?? 0) >= 0.85 ? "c-plum" : (reliability?.value ?? 0) >= 0.5 ? "c-amber" : "c-red";
  const pointDensity = stats?.methodology?.pointDensity ?? null;
  const gapCount = stats?.methodology?.gapCount ?? 0;
  const gapTotalSec = (stats?.methodology?.gapTotalDurationMs ?? 0) / 1000;
  const accuracyP90 = stats?.methodology?.accuracyP90 ?? null;

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
            <b>{Math.round(completeness)}%</b>
          </div>
          <div className="prog">
            <div style={{ width: `${Math.round(completeness)}%` }} />
          </div>
        </div>
        <div className="stats-grid" style={{ marginTop: 0 }}>
          <Stat
            value={reliability ? reliabilityLabel : "—"}
            cls={reliabilityCls}
            tip="Индекс доверия к записи (§11.6 SessionReliability): сводка дрейфа GPS и правдоподобия скорости | Выше 0,85 — высокая, 0,5–0,85 — средняя, ниже 0,5 — низкая"
            label="Надёжность записи"
          />
          <Stat
            value={pointDensity != null ? `${fmtNum(pointDensity, 1)}/с` : "—"}
            tip="Плотность точек (§11.1 PointDensity): точек GPS в секунду активной части | Выше 1/с — достаточно для анализа манёвров"
            label="Плотность точек"
          />
          <Stat
            value={`${gapCount} · ${fmtInt(gapTotalSec)} сек`}
            tip="Разрывы (§11.2 GapCount, §11.3 GapTotalDuration): количество и суммарная длительность пауз сигнала | Разрыв — интервал между точками длиннее 30 сек"
            label="Пропуски сигнала"
          />
          <Stat
            value={accuracyP90 != null ? `${fmtNum(accuracyP90, 1)} м` : "—"}
            tip="Точность GPS P90 (§11.4 AccuracyP90): 9 из 10 точек точнее этого значения | До 10 м — хорошо для городских маршрутов"
            label="Точность P90"
          />
        </div>
      </div>
    </details>
  );
}
