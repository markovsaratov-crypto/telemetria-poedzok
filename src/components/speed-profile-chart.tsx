"use client";

// src/components/speed-profile-chart.tsx — v2.9.3: спидограмма поездки (скорость-время).
// SVG-график с градиентной заливкой, полосой состояний (движение/стоянка/разрыв §4.6),
// референсной линией средней скорости, маркером максимума и hover-кросхейром.
// Общий для десктопа (session-stats-card) и мобильной версии (SessionDetailScreen).

import * as React from "react";
import { cn } from "@/lib/utils";

export interface SpeedProfilePointView {
  t: number; // сек от начала
  v: number | null; // км/ч
  st: 0 | 1 | 2; // 0 idle, 1 moving, 2 gap
}

interface SpeedProfileChartProps {
  profile: SpeedProfilePointView[];
  startIso?: string | null; // ISO старта сессии — для подписей оси времени
  avgKmh?: number | null;
  maxKmh?: number | null;
  height?: number; // px высота области графика
  compact?: boolean; // мобильный режим: меньше подписей
  className?: string;
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
  const PAD = { top: 14, right: 12, bottom: compact ? 18 : 22, left: compact ? 10 : 34 };
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

    // Сегменты линии с пропусками на null-скоростях
    const segs: Array<Array<{ x: number; y: number }>> = [];
    let cur: Array<{ x: number; y: number }> = [];
    for (const p of profile) {
      if (p.v == null) {
        if (cur.length > 0) segs.push(cur);
        cur = [];
        continue;
      }
      cur.push({ x: x(p.t), y: y(p.v) });
    }
    if (cur.length > 0) segs.push(cur);

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
      segs,
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
    },
    [geom, PAD.left, plotW, profile]
  );

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

  const hoverP = hover ? profile[hover.idx] : null;
  const hoverLeftPct = hover ? (hover.x / W) * 100 : 0;

  return (
    <div className={cn("relative select-none", className)}>
      {/* Легенда */}
      <div className="flex items-center gap-3 flex-wrap text-[10px] text-muted-foreground mb-1.5">
        <span className="inline-flex items-center gap-1">
          <span className="h-1.5 w-3 rounded-full" style={{ background: STATE_COLORS[1] }} />
          движение
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="h-1.5 w-3 rounded-full" style={{ background: STATE_COLORS[0] }} />
          стоянка
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="h-1.5 w-3 rounded-full" style={{ background: STATE_COLORS[2] }} />
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

      <div
        ref={wrapRef}
        className="relative rounded-lg border bg-card/50 overflow-hidden"
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
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
              <stop offset="0%" stopColor="oklch(0.62 0.19 350)" stopOpacity="0.32" />
              <stop offset="100%" stopColor="oklch(0.62 0.19 350)" stopOpacity="0.02" />
            </linearGradient>
          </defs>

          {/* Горизонтальная сетка + Y-подписи */}
          {geom.yTicks.map((tick, i) => (
            <g key={i}>
              <line
                x1={PAD.left}
                x2={W - PAD.right}
                y1={tick.y}
                y2={tick.y}
                stroke="oklch(0.5 0.02 350 / 0.12)"
                strokeWidth="1"
                strokeDasharray={i === 0 ? "" : "3 4"}
              />
              {!compact && (
                <text
                  x={PAD.left - 5}
                  y={tick.y + 3}
                  textAnchor="end"
                  className="fill-muted-foreground"
                  style={{ fontSize: 9 }}
                >
                  {tick.v}
                </text>
              )}
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

          {/* Area */}
          {geom.areaPath && <path d={geom.areaPath} fill="url(#spcFill)" />}

          {/* Линия средней скорости */}
          {avgKmh != null && avgKmh > 0 && (
            <g>
              <line
                x1={PAD.left}
                x2={W - PAD.right}
                y1={geom.y(avgKmh)}
                y2={geom.y(avgKmh)}
                stroke="oklch(0.55 0.02 350 / 0.5)"
                strokeWidth="1"
                strokeDasharray="5 4"
              />
              {!compact && (
                <text
                  x={W - PAD.right}
                  y={geom.y(avgKmh) - 3}
                  textAnchor="end"
                  className="fill-muted-foreground"
                  style={{ fontSize: 9 }}
                >
                  ср {Math.round(avgKmh)}
                </text>
              )}
            </g>
          )}

          {/* Линии скорости */}
          {geom.segs.map((seg, i) => (
            <path
              key={i}
              d={seg.map((p, j) => `${j === 0 ? "M" : "L"} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(" ")}
              fill="none"
              stroke="oklch(0.62 0.19 350)"
              strokeWidth={compact ? 1.6 : 2}
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          ))}

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

          {/* X-подписи: старт / середина / конец */}
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
                className="fill-muted-foreground"
                style={{ fontSize: 9 }}
              >
                {label}
              </text>
            );
          })}

          {/* Кросхейр */}
          {hover && hoverP && (
            <g>
              <line
                x1={hover.x}
                x2={hover.x}
                y1={PAD.top}
                y2={PAD.top + plotH + 4 + ribbonH}
                stroke="oklch(0.55 0.18 350 / 0.55)"
                strokeWidth="1"
                strokeDasharray="3 3"
              />
              {hoverP.v != null && (
                <circle
                  cx={hover.x}
                  cy={geom.y(hoverP.v)}
                  r={3.5}
                  fill="oklch(0.62 0.19 350)"
                  stroke="oklch(0.99 0.005 350)"
                  strokeWidth="1.5"
                />
              )}
            </g>
          )}
        </svg>

        {/* Tooltip */}
        {hover && hoverP && (
          <div
            className="pointer-events-none absolute top-1.5 z-10 rounded-md border bg-popover/95 backdrop-blur-sm px-2 py-1 text-[10px] shadow-sm whitespace-nowrap"
            style={{
              left: `${hoverLeftPct}%`,
              transform: hoverLeftPct > 70 ? "translateX(-100%)" : "translateX(6px)",
            }}
          >
            <div className="text-muted-foreground tabular-nums">
              {startMs > 0 ? fmtClock(startMs, hoverP.t) : fmtDurationShort(hoverP.t)}
              <span className="mx-1 opacity-40">·</span>
              +{fmtDurationShort(hoverP.t)}
            </div>
            <div className="font-semibold tabular-nums">
              {hoverP.v != null ? `${hoverP.v} км/ч` : "нет данных"}
              <span
                className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full align-middle"
                style={{ background: STATE_COLORS[hoverP.st] }}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
