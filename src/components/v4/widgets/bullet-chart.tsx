// src/components/v4/widgets/bullet-chart.tsx — bullet-виджет для блока 02.
// v2.21.0: «Плавность · EcoScore» (§7.3 CAP) и «Эффективность · экономия к плану»
// (TimeSavingIndex §6.3) переведены с gauge-дуг на bullet chart (Stephen Few):
// качественные зоны-подложки → толстая полоса-мера → целевой маркер → шкала.
// Данные, методика, breakdown-строки и тултипы не изменились — заменена
// только визуализация. Стили — только на CSS-переменных (светлая/тёмная тема).

"use client";

import * as React from "react";
import { bindTips } from "../use-v4-tipbox";

export interface BulletBreakdownRow {
  label: string;
  tip?: string;
  barPct: number; // 0..100, ширина cap-fill
  barColor?: string; // CSS color, default --plum
  value: string; // "-14,8 балла" или "−74 мин"
  valueColor?: string; // CSS color, default --plum
}

// Качественная зона-подложка (background band) в единицах шкалы.
export interface BulletRange {
  from: number;
  to: number;
  color: string; // CSS-цвет подложки (обычно var(--…-dim) — авто для тёмной темы)
  label?: string; // имя зоны для тултипа и a11y
}

export interface BulletTick {
  value: number;
  label: string;
}

// Полоса-мера (measure bar). Для двусторонней шкалы (Эффективность)
// from может быть 0 (план), а to — отрицательным (экономия влево).
export interface BulletMeasure {
  from: number;
  to: number;
  color: string;
  tip?: string;
}

export interface BulletChartProps {
  // Заголовок карточки
  title: string;
  // Текст тултипа для знака ? рядом с заголовком
  helpTip: string;
  // Большое число (например "70" или "−0,8")
  bigValue: string;
  // Подпись справа от числа (например "/ 100" или "мин/поездку")
  bigValueSuffix?: string;
  // Зона-бейдж
  bandText: string;
  bandCls: string; // "c-plum" | "c-amber" | "c-red"
  // Домен шкалы в единицах данных (0..100 или −5..+5)
  min: number;
  max: number;
  // Качественные зоны
  ranges: BulletRange[];
  // Полоса-мера; null → «нет данных» (пустой bullet)
  measure: BulletMeasure | null;
  // Целевой маркер (comparative measure)
  target?: { value: number; tip?: string };
  // Деления шкалы с готовыми подписями
  ticks: BulletTick[];
  // Подпись пустого bullet, если мера не рассчитана
  emptyHint?: string;
  // Note под bullet
  note?: React.ReactNode;
  // Строки breakdown (как у прежнего gauge-виджета)
  rows: BulletBreakdownRow[];
}

const fmtRg = (v: number) => v.toLocaleString("ru-RU");

function toPct(v: number, min: number, max: number): number {
  const span = max - min;
  if (!Number.isFinite(span) || span <= 0) return 0;
  return Math.max(0, Math.min(100, ((v - min) / span) * 100));
}

export function BulletChart(props: BulletChartProps) {
  const {
    title,
    helpTip,
    bigValue,
    bigValueSuffix,
    bandText,
    bandCls,
    min,
    max,
    ranges,
    measure,
    target,
    ticks,
    emptyHint,
    note,
    rows,
  } = props;
  const cardRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (cardRef.current) bindTips(cardRef.current);
  }, [rows, bigValue, ranges, measure, bandText]);

  const rangeList = ranges.slice().sort((a, b) => a.from - b.from);
  const mFrom = measure ? toPct(measure.from, min, max) : 0;
  const mTo = measure ? toPct(measure.to, min, max) : 0;
  const mLeft = Math.min(mFrom, mTo);
  const mWidth = Math.abs(mTo - mFrom);
  const targetLeft = target != null ? toPct(target.value, min, max) : null;

  // a11y: текстовое описание bullet для скринридеров (визуал — role="img")
  const aria = [
    `Шкала от ${fmtRg(min)} до ${fmtRg(max)}.`,
    ...rangeList.map((r) => (r.label ? `Зона «${r.label}» — от ${fmtRg(r.from)} до ${fmtRg(r.to)}.` : "")),
    measure ? `Значение: от ${fmtRg(measure.from)} до ${fmtRg(measure.to)}.` : "Значение не рассчитано.",
    target != null ? `Цель: ${fmtRg(target.value)}.` : "",
    `Итог: ${bigValue}${bigValueSuffix ? " " + bigValueSuffix : ""}, ${bandText}.`,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className="card" ref={cardRef}>
      <div className="card-title">
        {title}
        <span className="help" data-tip={helpTip}>?</span>
      </div>
      <div className="bullet-head">
        <div className="bullet-num">
          <b>{bigValue}</b>
          {bigValueSuffix ? <span> {bigValueSuffix}</span> : null}
        </div>
        <span className={`score-band ${bandCls}`}>{bandText}</span>
      </div>
      <div className="bullet-scale" role="img" aria-label={aria}>
        {rangeList.map((r, i) => {
          const from = toPct(r.from, min, max);
          const to = toPct(r.to, min, max);
          return (
            <div
              key={i}
              className="bullet-range"
              style={{ left: `${from}%`, width: `${Math.max(0, to - from)}%`, background: r.color }}
              data-tip={r.label ? `Зона «${r.label}»: от ${fmtRg(r.from)} до ${fmtRg(r.to)}` : undefined}
            />
          );
        })}
        {measure ? (
          <div
            className="bullet-measure"
            style={{ left: `${mLeft}%`, width: `${mWidth}%`, background: measure.color }}
            data-tip={measure.tip ?? undefined}
          />
        ) : null}
        {targetLeft != null ? (
          <div className="bullet-target" style={{ left: `${targetLeft}%` }} data-tip={target?.tip ?? undefined} />
        ) : null}
        {!measure && emptyHint ? <span className="bullet-empty">{emptyHint}</span> : null}
      </div>
      <div className="bullet-ticks" aria-hidden="true">
        {ticks.map((t, i) => {
          const align = i === 0 ? "start" : i === ticks.length - 1 ? "end" : "mid";
          return (
            <span key={i} data-align={align} style={{ left: `${toPct(t.value, min, max)}%` }}>
              {t.label}
            </span>
          );
        })}
      </div>
      <div className="cap-rows">
        {rows.map((r, i) => (
          <div className="cap-row" key={i}>
            <span className="cap-l" data-tip={r.tip ?? ""}>{r.label}</span>
            <div className="cap-bar">
              <div
                className="cap-fill"
                style={{ width: `${Math.max(0, Math.min(100, r.barPct))}%`, background: r.barColor ?? "var(--plum)" }}
              />
            </div>
            <span className="cap-v" style={{ color: r.valueColor ?? undefined }}>
              <b style={{ color: r.valueColor ?? "var(--plum)" }}>{r.value}</b>
            </span>
          </div>
        ))}
      </div>
      {note ? <p className="cap-note">{note}</p> : null}
    </div>
  );
}
