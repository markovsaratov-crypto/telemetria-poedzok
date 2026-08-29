"use client";

// src/components/speed-profile-chart.tsx — v2.9.3: спидограмма поездки (скорость-время).
// SVG-график с градиентной заливкой, полосой состояний (движение/стоянка/разрыв §4.6),
// референсной линией средней скорости, маркером максимума и hover-кросхейром.
// Общий для десктопа (session-stats-card) и мобильной версии (SessionDetailScreen).
// v2.9.4: связка карта↔график — сэмплы несут lat/lng; onHoverIdx/onPinIdx/externalIdx
// синхронизируют кросхейр с маркером на карте (клик по графику = закрепление точки).
// v2.9.9: паритет с тепловой картой — линия скорости окрашена по бакетам км/ч
// (та же шкала 0–30/30–60/60–90/90–120/120+, что и на карте: SPEED_BUCKETS из map-track),
// плюс пунктирные пороги бакетов с цветными подписями справа и легенда-чипы.

import * as React from "react";
import { cn } from "@/lib/utils";
// v2.9.10: импорт из lib/speed-buckets вместо ./map-track — избежать
// транзитивного импорта leaflet при статической генерации (prerender).
import { SPEED_BUCKETS, speedBucketFor } from "@/lib/speed-buckets";

export interface SpeedProfilePointView {
  t: number; // сек от начала
  v: number | null; // км/ч
  st: 0 | 1 | 2; // 0 idle, 1 moving, 2 gap
  alt?: number | null; // м (v2.9.4)
  lat?: number; // v2.9.4: для маркера на карте
  lng?: number; // v2.9.4
}

interface SpeedProfileChartProps {
  profile: SpeedProfilePointView[];
  startIso?: string | null; // ISO старта сессии — для подписей оси времени
  avgKmh?: number | null;
  maxKmh?: number | null;
  height?: number; // px высота области графика
  compact?: boolean; // мобильный режим: меньше подписей
  className?: string;
  // v2.9.4: связка карта↔график
  onHoverIdx?: (idx: number | null) => void; // hover по графику (null — курсор ушёл)
  onPinIdx?: (idx: number | null) => void; // клик по графику (закрепить/открепить точку)
  externalIdx?: number | null; // внешний индекс (клик по карте) — показать кросхейр
  pinnedIdx?: number | null; // закреплённый индекс — рисуем маркер-пин
}

const STATE_COLORS: Record<0 | 1 | 2, string> = {
  0: "oklch(0.75 0.13 85 / 0.85)", // idle — жёлтый
  1: "oklch(0.65 0.15 145 / 0.85)", // moving — зелёный
  2: "oklch(0.6 0.19 25 / 0.85)", // gap — красный
};

function fmtClock(startMs: number, tSec: number): string {
  const d = new Date(startMs + tSec * 1000);
  return d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}

function fmtDurationShort(sec: number): string {
  if (sec < 60) return `${Math.round(sec)}с`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  if (m < 60) return s === 0 ? `${m}м` : `${m}м ${s}с`;
  const h = Math.floor(m / 60);
  return `${h}ч ${m % 60}м`;
}

export function SpeedProfileChart({
  profile,
  startIso,
  avgKmh,
  maxKmh,
  height = 208,
  compact = false,
  className,
  onHoverIdx,
  onPinIdx,
  externalIdx,
  pinnedIdx,
}: SpeedProfileChartProps) {
  const wrapRef = React.useRef<HTMLDivElement>(null);
  const [hover, setHover] = React.useState<{ x: number; idx: number } | null>(null);
  // v2.9.3: динамическая ширина viewBox — иначе preserveAspectRatio="none"
  // растягивает текст подписей осей по горизонтали
  const [viewW, setViewW] = React.useState<number>(600);

  React.useEffect(() => {
    const el = wrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect?.width;
      if (w && w > 50) setViewW(Math.round(w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const W = viewW;
  const H = height;
  // v2.9.5: Y-подписи теперь и в compact-режиме (VLM: «Y-axis labels missing,
  // forcing the user to guess values») — левый padding расширен
  const PAD = { top: 14, right: 12, bottom: compact ? 18 : 22, left: compact ? 26 : 34 };
  const ribbonH = 5; // полоса состояний
  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom - ribbonH - 4;

  const startMs = React.useMemo(
    () => (startIso ? new Date(startIso).getTime() : 0),
    [startIso]
  );

  const geom = React.useMemo(() => {
    if (!profile || profile.length < 2) return null;
    const tMax = Math.max(profile[profile.length - 1].t, 1);
    const vMax = Math.max(10, ...profile.map((p) => p.v ?? 0)) * 1.12;
    const x = (t: number) => PAD.left + (t / tMax) * plotW;
    const y = (v: number) => PAD.top + plotH - (Math.max(0, v) / vMax) * plotH;

    // v2.9.9: пробеги линии по бакетам скорости (паритет с heat-картой):
    // непрерывные отрезки одного цвета; разрыв на null-скоростях;
    // при смене бакета новый пробег начинается с предыдущей точки (без щелей)
    const bucketRuns: Array<{ bucket: number; pts: Array<{ x: number; y: number }> }> = [];
    let run: { bucket: number; pts: Array<{ x: number; y: number }> } | null = null;
    let prevPt: { x: number; y: number } | null = null;
    for (const p of profile) {
      if (p.v == null) {
        run = null;
        prevPt = null;
        continue;
      }
      const b = speedBucketFor(p.v);
      const pt = { x: x(p.t), y: y(p.v) };
      if (!run || run.bucket !== b) {
        // начало пробега: стыкуем с предыдущей точкой, чтобы линия не рвалась
        run = { bucket: b, pts: prevPt ? [prevPt, pt] : [pt] };
        bucketRuns.push(run);
      } else {
        run.pts.push(pt);
      }
      prevPt = pt;
    }

    // v2.9.9: какие бакеты реально присутствуют в поездке (для легенды)
    const presentBuckets = new Set(bucketRuns.map((r) => r.bucket));

    // v2.9.9: пороги бакетов (30/60/90/120 км/ч) в пределах видимой шкалы Y
    const thresholds = SPEED_BUCKETS.slice(0, -1)
      .map((b, i) => ({ v: b.maxKmh, color: SPEED_BUCKETS[i + 1].color, y: y(b.maxKmh) }))
      .filter((t) => t.v < vMax * 0.97 && t.v > 0);

    // Путь area (от первой невалидной точки к последней)
    const valid = profile.filter((p) => p.v != null);
    const areaPath =
      valid.length >= 2
        ? `M ${x(valid[0].t)} ${y(0)} ` +
          valid.map((p) => `L ${x(p.t).toFixed(1)} ${y(p.v!).toFixed(1)}`).join(" ") +
          ` L ${x(valid[valid.length - 1].t).toFixed(1)} ${y(0)} Z`
        : "";

    // Полоса состояний: consecutive runs по st
    const ribbon: Array<{ x: number; w: number; st: 0 | 1 | 2 }> = [];
    let runStart = 0;
    for (let i = 1; i <= profile.length; i++) {
      if (i === profile.length || profile[i].st !== profile[runStart].st) {
        const x1 = x(profile[runStart].t);
        const x2 = x(profile[Math.min(i, profile.length - 1)].t);
        ribbon.push({ x: x1, w: Math.max(1.5, x2 - x1), st: profile[runStart].st });
        runStart = i;
      }
    }

    // Индекс максимума
    let maxIdx = -1;
    let maxVal = -1;
    profile.forEach((p, i) => {
      if (p.v != null && p.v > maxVal) {
        maxVal = p.v;
        maxIdx = i;
      }
    });

    return {
      tMax,
      vMax,
      x,
      y,
      bucketRuns,
      presentBuckets,
      thresholds,
      areaPath,
      ribbon,
      maxIdx,
      maxVal,
      // y-тики: 3 значения
      yTicks: [0, Math.round(vMax / 2), Math.round(vMax)].map((v) => ({ v, y: y(v) })),
    };
  }, [profile, PAD.left, PAD.top, plotH, plotW]);

  const onMove = React.useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!geom || !wrapRef.current) return;
      const rect = wrapRef.current.getBoundingClientRect();
      const relX = ((e.clientX - rect.left) / rect.width) * W;
      const tRatio = (relX - PAD.left) / plotW;
      if (tRatio < 0 || tRatio > 1) {
        setHover(null);
        onHoverIdx?.(null);
        return;
      }
      const t = tRatio * geom.tMax;
      // ближайший сэмпл по t
      let idx = 0;
      let best = Infinity;
      for (let i = 0; i < profile.length; i++) {
        const d = Math.abs(profile[i].t - t);
        if (d < best) {
          best = d;
          idx = i;
        }
      }
      setHover({ x: geom.x(profile[idx].t), idx });
      onHoverIdx?.(idx);
    },
    [geom, PAD.left, plotW, profile, onHoverIdx]
  );

  // v2.9.4: клик по графику — закрепить точку (повторный клик по той же — открепить)
  const onClick = React.useCallback(() => {
    if (!onPinIdx) return;
    const idx = hover?.idx ?? externalIdx ?? null;
    if (idx == null) return;
    onPinIdx(pinnedIdx === idx ? null : idx);
  }, [onPinIdx, hover, externalIdx, pinnedIdx]);

  // v2.9.4: эффективная точка кросхейра — hover > внешний (карта) > закреплённая
  const activeIdx = hover?.idx ?? externalIdx ?? pinnedIdx ?? null;
  const activeX =
    activeIdx != null && geom ? geom.x(profile[activeIdx].t) : null;

  if (!geom) {
    return (
      <div
        className={cn(
          "flex items-center justify-center text-xs text-muted-foreground rounded-lg bg-muted/30",
          className
        )}
        style={{ height }}
      >
        Недостаточно точек для графика
      </div>
    );
  }

  // v2.9.4: точка для тултипа — с учётом внешнего/закреплённого индекса
  const tipIdx = activeIdx;
  const tipP = tipIdx != null ? profile[tipIdx] : null;
  const tipX = activeX;
  const tipLeftPct = tipX != null ? (tipX / W) * 100 : 0;
  const isPinned = pinnedIdx != null && pinnedIdx === tipIdx;

  return (
    <div className={cn("relative select-none", className)}>
      {/* Легенда (v2.9.5: крупные чипы-точки h-2 w-4 — VLM: «legend dots tiny») */}
      <div className="flex items-center gap-3 flex-wrap text-[10px] text-muted-foreground mb-1.5">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-4 rounded-full" style={{ background: STATE_COLORS[1] }} />
          движение
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-4 rounded-full" style={{ background: STATE_COLORS[0] }} />
          стоянка
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2 w-4 rounded-full" style={{ background: STATE_COLORS[2] }} />
          разрыв
        </span>
        {avgKmh != null && (
          <span className="ml-auto tabular-nums">
            ср <span className="font-semibold text-foreground">{Math.round(avgKmh)}</span> км/ч
          </span>
        )}
        {maxKmh != null && (
          <span className="tabular-nums">
            макс <span className="font-semibold text-rose-600 dark:text-rose-400">{Math.round(maxKmh)}</span> км/ч
          </span>
        )}
      </div>

      {/* v2.9.9: легенда бакетов скорости — паритет с heat-картой.
          Показываем только присутствующие в поездке бакеты (без шума);
          компакт: чипы без подписей (экономия ширины), подпись только у крайних. */}
      {geom && geom.presentBuckets.size > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap text-[9px] text-muted-foreground mb-1.5">
          <span className="mr-0.5 opacity-70">км/ч:</span>
          {SPEED_BUCKETS.map((b, i) =>
            geom.presentBuckets.has(i) ? (
              <span
                key={b.label}
                className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-muted/30 px-1.5 py-[1px] tabular-nums"
              >
                <span className="h-1.5 w-3 rounded-full" style={{ background: b.color }} />
                {b.label}
              </span>
            ) : null
          )}
        </div>
      )}

      <div
        ref={wrapRef}
        className={cn(
          "relative rounded-lg border bg-card/50 overflow-hidden",
          onPinIdx && "cursor-crosshair"
        )}
        onPointerMove={onMove}
        onPointerLeave={() => {
          setHover(null);
          onHoverIdx?.(null);
        }}
        onClick={onClick}
      >
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="w-full block"
          style={{ height }}
          role="img"
          aria-label="График скорости по времени"
        >
          <defs>
            <linearGradient id="spcFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--chart-speed-fill)" stopOpacity="0.32" />
              <stop offset="100%" stopColor="var(--chart-speed-fill)" stopOpacity="0.02" />
            </linearGradient>
          </defs>

          {/* Горизонтальная сетка + Y-подписи (v2.9.5: подписи и в compact, сетка через --chart-grid) */}
          {geom.yTicks.map((tick, i) => (
            <g key={i}>
              <line
                x1={PAD.left}
                x2={W - PAD.right}
                y1={tick.y}
                y2={tick.y}
                stroke={i === 0 ? "var(--chart-grid-strong)" : "var(--chart-grid)"}
                strokeWidth="1"
                strokeDasharray={i === 0 ? "" : "3 4"}
              />
              <text
                x={PAD.left - 5}
                y={tick.y + 3}
                textAnchor="end"
                className="chart-axis-label"
                style={{ fontSize: compact ? 8.5 : 9 }}
              >
                {tick.v}
              </text>
            </g>
          ))}

          {/* Idle/gap фоновые полосы */}
          {geom.ribbon
            .filter((r) => r.st !== 1)
            .map((r, i) => (
              <rect
                key={i}
                x={r.x}
                y={PAD.top}
                width={r.w}
                height={plotH}
                fill={r.st === 0 ? "oklch(0.75 0.13 85 / 0.07)" : "oklch(0.6 0.19 25 / 0.06)"}
              />
            ))}

          {/* v2.9.9: пороги бакетов скорости (30/60/90/120) — пунктир + цветная подпись справа;
              цвет подписи = бакет НАД порогом (тот же язык цветов, что на heat-карте) */}
          {geom.thresholds.map((t) => (
            <g key={`th${t.v}`}>
              <line
                x1={PAD.left}
                x2={W - PAD.right}
                y1={t.y}
                y2={t.y}
                stroke={t.color}
                strokeOpacity="0.38"
                strokeWidth="1"
                strokeDasharray="2 5"
              />
              <text
                x={W - PAD.right + 3}
                y={t.y + 2.5}
                className="chart-axis-label"
                style={{ fontSize: compact ? 7.5 : 8, fill: t.color, fontWeight: 600 }}
              >
                {t.v}
              </text>
            </g>
          ))}

          {/* Area */}
          {geom.areaPath && <path d={geom.areaPath} fill="url(#spcFill)" />}

          {/* Линия средней скорости (v2.9.5: --chart-ref-line для контраста в тёмной теме) */}
          {avgKmh != null && avgKmh > 0 && (
            <g>
              <line
                x1={PAD.left}
                x2={W - PAD.right}
                y1={geom.y(avgKmh)}
                y2={geom.y(avgKmh)}
                stroke="var(--chart-ref-line)"
                strokeWidth="1"
                strokeDasharray="5 4"
              />
              <text
                x={W - PAD.right}
                y={geom.y(avgKmh) - 3}
                textAnchor="end"
                className="chart-axis-label"
                style={{ fontSize: compact ? 8.5 : 9 }}
              >
                ср {Math.round(avgKmh)}
              </text>
            </g>
          )}

          {/* Линии скорости (v2.9.9: пробеги по бакетам — цвет как на heat-карте;
              толщина растёт с бакетом: медленнее — тоньше, быстрее — толще) */}
          {geom.bucketRuns.map((r, i) => {
            const bucket = SPEED_BUCKETS[r.bucket];
            const w = (compact ? 1.5 : 1.9) + r.bucket * (compact ? 0.14 : 0.18);
            return (
              <path
                key={`br${i}`}
                d={r.pts.map((p, j) => `${j === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ")}
                fill="none"
                stroke={bucket.color}
                strokeWidth={w}
                strokeLinejoin="round"
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            );
          })}

          {/* Маркер максимума */}
          {geom.maxIdx >= 0 && profile[geom.maxIdx].v != null && (
            <g>
              <circle
                cx={geom.x(profile[geom.maxIdx].t)}
                cy={geom.y(profile[geom.maxIdx].v!)}
                r={compact ? 3 : 3.5}
                fill="oklch(0.62 0.19 20)"
                stroke="oklch(0.99 0.005 350)"
                strokeWidth="1.5"
              />
              {!compact && (
                <text
                  x={Math.min(geom.x(profile[geom.maxIdx].t) + 6, W - PAD.right - 44)}
                  y={geom.y(profile[geom.maxIdx].v!) - 6}
                  className="fill-rose-600 dark:fill-rose-400"
                  style={{ fontSize: 9.5, fontWeight: 600 }}
                >
                  {Math.round(profile[geom.maxIdx].v!)}
                </text>
              )}
            </g>
          )}

          {/* Полоса состояний (таймлайн §4.6) */}
          {geom.ribbon.map((r, i) => (
            <rect
              key={`rb${i}`}
              x={r.x}
              y={PAD.top + plotH + 4}
              width={r.w}
              height={ribbonH}
              rx={1.5}
              fill={STATE_COLORS[r.st]}
            />
          ))}

          {/* X-подписи: старт / середина / конец (v2.9.5: chart-axis-label с контрастом тёмной темы) */}
          {[0, 0.5, 1].map((f, i) => {
            const t = f * geom.tMax;
            const label =
              startMs > 0
                ? fmtClock(startMs, t)
                : fmtDurationShort(t);
            return (
              <text
                key={i}
                x={geom.x(t)}
                y={H - 4}
                textAnchor={i === 0 ? "start" : i === 2 ? "end" : "middle"}
                className="chart-axis-label"
                style={{ fontSize: 9 }}
              >
                {label}
              </text>
            );
          })}

          {/* Кросхейр: hover > внешний (карта) > закреплённая точка */}
          {tipX != null && tipP && (
            <g>
              <line
                x1={tipX}
                x2={tipX}
                y1={PAD.top}
                y2={PAD.top + plotH + 4 + ribbonH}
                stroke={isPinned ? "var(--chart-speed-line)" : "var(--chart-crosshair)"}
                strokeWidth={isPinned ? 1.5 : 1}
                strokeDasharray={isPinned ? "" : "3 3"}
              />
              {tipP.v != null && (
                <circle
                  cx={tipX}
                  cy={geom.y(tipP.v)}
                  r={isPinned ? 4.5 : 3.5}
                  fill="var(--chart-speed-line)"
                  stroke="oklch(0.99 0.005 350)"
                  strokeWidth="1.5"
                />
              )}
              {/* v2.9.4: флажок-пин закреплённой точки */}
              {isPinned && (
                <circle
                  cx={tipX}
                  cy={PAD.top - 5}
                  r={2.5}
                  fill="var(--chart-speed-line)"
                />
              )}
            </g>
          )}
        </svg>

        {/* Tooltip (hover / внешний / закреплённая точка) */}
        {tipP && tipX != null && (
          <div
            className="pointer-events-none absolute top-1.5 z-10 rounded-md border bg-popover/95 backdrop-blur-sm px-2 py-1 text-[10px] shadow-sm whitespace-nowrap"
            style={{
              left: `${tipLeftPct}%`,
              transform: tipLeftPct > 70 ? "translateX(-100%)" : "translateX(6px)",
            }}
          >
            <div className="text-muted-foreground tabular-nums">
              {startMs > 0 ? fmtClock(startMs, tipP.t) : fmtDurationShort(tipP.t)}
              <span className="mx-1 opacity-40">·</span>
              +{fmtDurationShort(tipP.t)}
            </div>
            <div className="font-semibold tabular-nums">
              {tipP.v != null ? `${tipP.v} км/ч` : "нет данных"}
              <span
                className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full align-middle"
                style={{ background: STATE_COLORS[tipP.st] }}
              />
              {isPinned && <span className="ml-1 opacity-60">· закреплено</span>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
