"use client";

// src/components/altitude-profile-chart.tsx — v2.9.4: высотный профиль поездки.
// SVG-график «горного» стиля: градиентная заливка рельефа, маркеры min/max,
// подписи набора/снижения, hover-кросхейр с тултипом (высота + время).
// Геометрия X-оси идентична спидограмме (общий ряд сэмплов speedProfile) —
// графики визуально выровнены при вертикальной stacking-компоновке.
// Участвует в связке карта↔график (onHoverIdx/onPinIdx/externalIdx/pinnedIdx).

import * as React from "react";
import { cn } from "@/lib/utils";
import type { SpeedProfilePointView } from "@/components/speed-profile-chart";

interface AltitudeProfileChartProps {
  profile: SpeedProfilePointView[]; // общий ряд со спидограммой (используется поле alt)
  startIso?: string | null;
  height?: number;
  compact?: boolean;
  className?: string;
  // v2.9.4: связка карта↔график (общие индексы со спидограммой)
  onHoverIdx?: (idx: number | null) => void;
  onPinIdx?: (idx: number | null) => void;
  externalIdx?: number | null;
  pinnedIdx?: number | null;
}

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

export function AltitudeProfileChart({
  profile,
  startIso,
  height = 148,
  compact = false,
  className,
  onHoverIdx,
  onPinIdx,
  externalIdx,
  pinnedIdx,
}: AltitudeProfileChartProps) {
  const wrapRef = React.useRef<HTMLDivElement>(null);
  const [hover, setHover] = React.useState<{ x: number; idx: number } | null>(null);
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

  const startMs = React.useMemo(
    () => (startIso ? new Date(startIso).getTime() : 0),
    [startIso]
  );

  // только точки с высотой — профиль может быть с пропусками
  const altPoints = React.useMemo(
    () => profile.map((p, i) => ({ ...p, i })).filter((p) => p.alt != null),
    [profile]
  );

  const geom = React.useMemo(() => {
    if (altPoints.length < 2) return null;
    const W = viewW;
    const H = height;
    const PAD = { top: 16, right: 12, bottom: compact ? 18 : 22, left: compact ? 10 : 40 };
    const plotW = W - PAD.left - PAD.right;
    const plotH = H - PAD.top - PAD.bottom;

    const tMax = Math.max(profile[profile.length - 1].t, 1);
    const altMax = Math.max(...altPoints.map((p) => p.alt as number));
    const altMin = Math.min(...altPoints.map((p) => p.alt as number));
    // вертикальный padding 12% диапазона (но не менее 4м — плоский рельеф)
    const range = Math.max(altMax - altMin, 8);
    const yTop = altMax + range * 0.12;
    const yBot = Math.min(altMin - range * 0.12, altMax - 2);
    const x = (t: number) => PAD.left + (t / tMax) * plotW;
    const y = (a: number) => PAD.top + plotH - ((a - yBot) / (yTop - yBot)) * plotH;

    // линия рельефа (по точкам с высотой)
    const linePath = altPoints
      .map((p, j) => `${j === 0 ? "M" : "L"} ${x(p.t).toFixed(1)} ${y(p.alt as number).toFixed(1)}`)
      .join(" ");
    const areaPath =
      `${linePath} L ${x(altPoints[altPoints.length - 1].t).toFixed(1)} ${y(yBot).toFixed(1)} ` +
      `L ${x(altPoints[0].t).toFixed(1)} ${y(yBot).toFixed(1)} Z`;

    // набор/снижение по сглаженному ряду
    let gain = 0;
    let loss = 0;
    for (let j = 1; j < altPoints.length; j++) {
      const d = (altPoints[j].alt as number) - (altPoints[j - 1].alt as number);
      if (d > 0) gain += d;
      else loss += -d;
    }

    // индексы min/max
    let maxI = 0;
    let minI = 0;
    altPoints.forEach((p, j) => {
      if ((p.alt as number) > (altPoints[maxI].alt as number)) maxI = j;
      if ((p.alt as number) < (altPoints[minI].alt as number)) minI = j;
    });

    return {
      W,
      H,
      PAD,
      plotH,
      tMax,
      x,
      y,
      linePath,
      areaPath,
      gain,
      loss,
      maxI,
      minI,
      altMax,
      altMin,
      yBot,
      yTicks: [altMin, Math.round((altMin + altMax) / 2), altMax],
    };
  }, [altPoints, profile, viewW, height, compact]);

  const onMove = React.useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!geom || !wrapRef.current) return;
      const rect = wrapRef.current.getBoundingClientRect();
      const relX = ((e.clientX - rect.left) / rect.width) * geom.W;
      const tRatio = (relX - geom.PAD.left) / (geom.W - geom.PAD.left - geom.PAD.right);
      if (tRatio < 0 || tRatio > 1) {
        setHover(null);
        onHoverIdx?.(null);
        return;
      }
      const t = tRatio * geom.tMax;
      // ближайший сэмпл ИСХОДНОГО ряда (общий индекс со спидограммой)
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
    [geom, profile, onHoverIdx]
  );

  const onClick = React.useCallback(() => {
    if (!onPinIdx) return;
    const idx = hover?.idx ?? externalIdx ?? null;
    if (idx == null) return;
    onPinIdx(pinnedIdx === idx ? null : idx);
  }, [onPinIdx, hover, externalIdx, pinnedIdx]);

  if (!geom) {
    return null; // без высотных данных профиль не рендерится
  }

  const { W, H, PAD } = geom;
  const activeIdx = hover?.idx ?? externalIdx ?? pinnedIdx ?? null;
  const tipP = activeIdx != null ? profile[activeIdx] : null;
  const tipX = activeIdx != null ? geom.x(profile[activeIdx].t) : null;
  const tipLeftPct = tipX != null ? (tipX / W) * 100 : 0;
  const isPinned = pinnedIdx != null && pinnedIdx === activeIdx;

  return (
    <div className={cn("relative select-none", className)}>
      {/* Легенда */}
      <div className="flex items-center gap-3 flex-wrap text-[10px] text-muted-foreground mb-1.5">
        <span className="tabular-nums">
          ↑ подъём <span className="font-semibold text-emerald-600 dark:text-emerald-400">{Math.round(geom.gain)} м</span>
        </span>
        <span className="tabular-nums">
          ↓ спуск <span className="font-semibold text-amber-600 dark:text-amber-400">{Math.round(geom.loss)} м</span>
        </span>
        <span className="ml-auto tabular-nums">
          мин <span className="font-semibold text-foreground">{Math.round(geom.altMin)}</span> · макс{" "}
          <span className="font-semibold text-foreground">{Math.round(geom.altMax)}</span> м
        </span>
      </div>

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
          aria-label="Высотный профиль поездки"
        >
          <defs>
            {/* «горный» градиент: тёплые тона вверх от базовой линии */}
            <linearGradient id="apcFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="oklch(0.70 0.15 50)" stopOpacity="0.38" />
              <stop offset="55%" stopColor="oklch(0.78 0.13 70)" stopOpacity="0.16" />
              <stop offset="100%" stopColor="oklch(0.85 0.10 85)" stopOpacity="0.03" />
            </linearGradient>
            <linearGradient id="apcLine" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="oklch(0.62 0.16 50)" />
              <stop offset="100%" stopColor="oklch(0.72 0.14 70)" />
            </linearGradient>
          </defs>

          {/* Горизонтальная сетка + Y-подписи (значения высот) */}
          {geom.yTicks.map((a, i) => (
            <g key={i}>
              <line
                x1={PAD.left}
                x2={W - PAD.right}
                y1={geom.y(a)}
                y2={geom.y(a)}
                stroke="oklch(0.5 0.02 350 / 0.10)"
                strokeWidth="1"
                strokeDasharray={i === 0 ? "" : "3 4"}
              />
              {!compact && (
                <text
                  x={PAD.left - 5}
                  y={geom.y(a) + 3}
                  textAnchor="end"
                  className="fill-muted-foreground"
                  style={{ fontSize: 9 }}
                >
                  {a}
                </text>
              )}
            </g>
          ))}

          {/* Рельеф */}
          <path d={geom.areaPath} fill="url(#apcFill)" />
          <path
            d={geom.linePath}
            fill="none"
            stroke="url(#apcLine)"
            strokeWidth={compact ? 1.6 : 2}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />

          {/* Маркер вершины */}
          {(() => {
            const p = altPoints[geom.maxI];
            return (
              <g>
                <circle
                  cx={geom.x(p.t)}
                  cy={geom.y(p.alt as number)}
                  r={compact ? 3 : 3.5}
                  fill="oklch(0.62 0.16 50)"
                  stroke="oklch(0.99 0.005 350)"
                  strokeWidth="1.5"
                />
                {!compact && (
                  <text
                    x={Math.min(geom.x(p.t) + 6, W - PAD.right - 30)}
                    y={geom.y(p.alt as number) - 5}
                    className="fill-amber-700 dark:fill-amber-400"
                    style={{ fontSize: 9.5, fontWeight: 600 }}
                  >
                    {Math.round(p.alt as number)}м
                  </text>
                )}
              </g>
            );
          })()}

          {/* X-подписи: старт / середина / конец (выровнены со спидограммой) */}
          {[0, 0.5, 1].map((f, i) => {
            const t = f * geom.tMax;
            const label = startMs > 0 ? fmtClock(startMs, t) : fmtDurationShort(t);
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
          {tipX != null && tipP && tipP.alt != null && (
            <g>
              <line
                x1={tipX}
                x2={tipX}
                y1={PAD.top}
                y2={H - PAD.bottom}
                stroke={isPinned ? "oklch(0.62 0.16 50)" : "oklch(0.55 0.18 350 / 0.55)"}
                strokeWidth={isPinned ? 1.5 : 1}
                strokeDasharray={isPinned ? "" : "3 3"}
              />
              <circle
                cx={tipX}
                cy={geom.y(tipP.alt)}
                r={isPinned ? 4.5 : 3.5}
                fill="oklch(0.62 0.16 50)"
                stroke="oklch(0.99 0.005 350)"
                strokeWidth="1.5"
              />
              {isPinned && <circle cx={tipX} cy={PAD.top - 5} r={2.5} fill="oklch(0.62 0.16 50)" />}
            </g>
          )}
        </svg>

        {/* Tooltip */}
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
              <span className="mx-1 opacity-40">·</span>+{fmtDurationShort(tipP.t)}
            </div>
            <div className="font-semibold tabular-nums">
              {tipP.alt != null ? `${Math.round(tipP.alt)} м` : "нет данных"}
              {tipP.v != null && (
                <span className="ml-1 font-normal text-muted-foreground">{tipP.v} км/ч</span>
              )}
              {isPinned && <span className="ml-1 opacity-60">· закреплено</span>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
