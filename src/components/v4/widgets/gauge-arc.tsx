// src/components/v4/widgets/gauge-arc.tsx — общий gauge-виджет для блока 02.
// Используется и для EcoScore (7.3 CAP), и для Эффективности (TimeSavingIndex).
// ВАЖНО: оба виджета одинаковые по стилю — SVG arc, pathLength=100, толщина 11,
// большое число + zone-band подпись + breakdown cap-rows под шкалой.

"use client";

import * as React from "react";
import { bindTips } from "../use-v4-tipbox";

export interface GaugeBreakdownRow {
  label: string;
  tip?: string;
  barPct: number;     // 0..100, ширина cap-fill
  barColor?: string;  // CSS color, default --plum
  value: string;       // "-14,8 балла" или "−74 мин"
  valueColor?: string; // CSS color, default --plum
}

export interface GaugeArcProps {
  // Заголовок карточки
  title: string;
  // Текст тултипа для знака ? рядом с заголовком
  helpTip: string;
  // Большое число в центре (например "70" или "−0,8")
  bigValue: string;
  // Подпись справа от числа (например "/ 100" или "мин/поездку")
  bigValueSuffix?: string;
  // Цвет дуги (CSS color)
  arcColor: string;
  // Доля заполнения дуги, 0..100
  arcPct: number;
  // Зона-бейдж
  bandText: string;
  bandCls: string; // "c-plum" | "c-amber" | "c-red"
  // Note под gauge (например про базовые линии)
  note?: React.ReactNode;
  // Заголовок breakdown-секции (необязательно)
  breakdownTitle?: string;
  // Строки breakdown
  rows: GaugeBreakdownRow[];
}

export function GaugeArc(props: GaugeArcProps) {
  const {
    title,
    helpTip,
    bigValue,
    bigValueSuffix,
    arcColor,
    arcPct,
    bandText,
    bandCls,
    note,
    rows,
  } = props;
  const cardRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (cardRef.current) bindTips(cardRef.current);
  }, [rows, bigValue, arcColor, arcPct, bandText]);

  return (
    <div className="card" ref={cardRef}>
      <div className="card-title">
        {title}
        <span className="help" data-tip={helpTip}>?</span>
      </div>
      <div className="gauge-wrap">
        <svg className="gauge" viewBox="0 0 128 80" aria-hidden="true">
          <path d="M12 66 A56 56 0 0 1 116 66" fill="none" stroke="var(--line)" strokeWidth="11" strokeLinecap="round" pathLength={100} />
          <path
            d="M12 66 A56 56 0 0 1 116 66"
            fill="none"
            stroke={arcColor}
            strokeWidth="11"
            strokeLinecap="round"
            pathLength={100}
            strokeDasharray={`${arcPct} 100`}
            style={{ transition: "stroke-dasharray 0.35s ease, stroke 0.35s ease" }}
          />
        </svg>
        <div className="gauge-num">
          <b>{bigValue}</b>
          {bigValueSuffix ? <span> {bigValueSuffix}</span> : null}
        </div>
        <span className={`score-band ${bandCls}`}>{bandText}</span>
      </div>
      <div className="cap-rows">
        {rows.map((r, i) => (
          <div className="cap-row" key={i}>
            <span className="cap-l" data-tip={r.tip ?? ""}>{r.label}</span>
            <div className="cap-bar">
              <div
                className="cap-fill"
                style={{ width: `${r.barPct}%`, background: r.barColor ?? "var(--plum)" }}
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
