// src/components/v4/trips-view.tsx — вкладка Поездки v4.
// Сводка недели + список 8 поездок; клик по поездке раскрывает план-факт по сегментам.

"use client";

import * as React from "react";
import { TRIPS, ecoCls, ecoLab } from "@/lib/telematika-v4-mock";
import { bindTips } from "./use-v4-tipbox";

export function TripsView() {
  const ref = React.useRef<HTMLDivElement>(null);
  const [openIdx, setOpenIdx] = React.useState<number | null>(null);
  React.useEffect(() => {
    if (ref.current) bindTips(ref.current);
  }, [openIdx]);

  const totalKm = TRIPS.reduce((s, t) => s + Number(t.sub.split(" км")[0].replace(",", ".")), 0);
  const totalMin = TRIPS.reduce((s, t) => s + Number(t.sub.split("· ")[1].split(" ")[0]), 0);
  const avgEco = Math.round(TRIPS.reduce((s, t) => s + t.eco, 0) / TRIPS.length);
  const bestEco = Math.max(...TRIPS.map((t) => t.eco));
  const hh = Math.floor(totalMin / 60);
  const mm = totalMin % 60;

  return (
    <div ref={ref}>
      <div className="card tsum">
        <div className="tsum-main">
          <b>{TRIPS.length} поездок</b>
          <span>22–28 августа · по активной части</span>
        </div>
        <div className="tsum-stats">
          <div>
            <b>{totalKm.toFixed(1).replace(".", ",")}</b>
            <span>км всего</span>
          </div>
          <div>
            <b>{hh} ч {mm} м</b>
            <span>в поездках</span>
          </div>
          <div>
            <b>{avgEco}</b>
            <span>средняя плавность</span>
          </div>
          <div>
            <b>{bestEco}</b>
            <span>лучшая плавность</span>
          </div>
        </div>
      </div>

      {TRIPS.map((tr, i) => (
        <TripCard
          key={i}
          trip={tr}
          isOpen={openIdx === i}
          onToggle={() => setOpenIdx(openIdx === i ? null : i)}
        />
      ))}

      <div className="toast">
        <b>Подсказка.</b> Нажмите на поездку — раскроется план-факт по её сегментам со средними скоростями и события вождения.
      </div>
    </div>
  );
}

function TripCard({
  trip,
  isOpen,
  onToggle,
}: {
  trip: (typeof TRIPS)[0];
  isOpen: boolean;
  onToggle: () => void;
}) {
  const plan = trip.segs.reduce((s, x) => s + x.plan, 0);
  const fact = trip.segs.reduce((s, x) => s + x.fact, 0);
  const tot = fact - plan;
  const totC = tot <= 0 ? "c-plum" : tot <= 3 ? "c-amber" : "c-red";

  return (
    <div className={`trip ${isOpen ? "open" : ""}`}>
      <div className="trip-head" onClick={onToggle}>
        <div className="trip-date">
          <b>{trip.d}</b>
          <span>{trip.mo}</span>
          <small>{trip.t}</small>
        </div>
        <div className="trip-info">
          <div className="t-route">{trip.route}</div>
          <div className="t-sub">{trip.sub}</div>
        </div>
        <div className={`t-eco ${ecoCls(trip.eco)}`}>
          <b>{trip.eco}</b>
          <small>{ecoLab(trip.eco)}</small>
        </div>
        <i className="chev">›</i>
      </div>
      <div className="trip-body">
        <div className="pf-segs-head">
          План и факт по сегментам <span className="muted">│ — план · полоса — факт</span>
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
          <b className={totC}>
            {tot > 0 ? "+" : "−"}
            {Math.abs(tot)} мин
          </b>
        </div>
        <div className="t-ev">События: {trip.ev}</div>
      </div>
    </div>
  );
}
