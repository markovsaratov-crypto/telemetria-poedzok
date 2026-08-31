// src/components/v4/trips-view.tsx — вкладка Поездки v4.
// LIVE: /api/sessions (useSessions) + /api/sessions/[id]/stats (useSessionStats per row).
// NO mock data — shows real sessions from the database only.

"use client";

import * as React from "react";
import { useSessions, useSessionStats, type SessionStats } from "@/lib/hooks";
import type { SessionListItem } from "@/lib/api-client";
import { ecoCls, ecoLab } from "@/lib/v4-utils";
import { bindTips } from "./use-v4-tipbox";

export function TripsView({ onGoAdmin }: { onGoAdmin?: () => void }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [openId, setOpenId] = React.useState<string | null>(null);
  const sessions = useSessions({ limit: 50 });
  React.useEffect(() => {
    if (ref.current) bindTips(ref.current);
  }, [openId, sessions.data]);

  const list: SessionListItem[] = sessions.data?.sessions ?? [];
  const isLoading = sessions.isLoading && !sessions.data;
  const isError = sessions.isError;
  // Рефреш показателя «свежести» раз в минуту (чтобы часы без перезагрузки обновлялись)
  const [, setTick] = React.useState(0);
  React.useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 60_000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div ref={ref}>
      {isError ? (
        <div className="card" style={{ padding: "20px", color: "var(--red)", fontSize: 13 }}>
          Не удалось загрузить список поездок. Попробуйте обновить страницу.
        </div>
      ) : isLoading ? (
        <TripsSkeleton />
      ) : list.length === 0 ? (
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
            Поездок пока нет
          </div>
          <div style={{ fontSize: 12, lineHeight: 1.6 }}>
            Импортируйте CSV через вкладку АДМИН или подключите SensorLogger
            к <code>/api/ingest</code> — поездки появятся здесь автоматически.
          </div>
        </div>
      ) : (
        <>
          <StaleDataBanner list={list} onGoAdmin={onGoAdmin} />
          <TripsSummary list={list} />
          {list.map((s) => (
            <TripCard
              key={s.id}
              session={s}
              isOpen={openId === s.id}
              onToggle={() =>
                setOpenId(openId === s.id ? null : s.id)
              }
            />
          ))}
        </>
      )}
    </div>
  );
}

// Баннер «данные не обновлялись»: появляется, если последняя сессия старше 24 ч.
// Отвечает на вопрос «почему не подтягиваются новые поездки» прямо в UI:
// поездки попадают сюда только через ingest-канал (SensorLogger → /api/ingest/sensorlogger).
function StaleDataBanner({
  list,
  onGoAdmin,
}: {
  list: SessionListItem[];
  onGoAdmin?: () => void;
}) {
  if (list.length === 0) return null;
  const latest = Math.max(
    ...list.map((s) => new Date(s.endTime ?? s.startTime).getTime())
  );
  const hours = (Date.now() - latest) / 3_600_000;
  if (hours < 24) return null;

  const days = Math.floor(hours / 24);
  const label =
    days >= 1
      ? `${days} ${days === 1 ? "день" : days < 5 ? "дня" : "дней"}`
      : `${Math.floor(hours)} ч`;
  const latestStr = new Date(latest).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });

  return (
    <div className="stale-banner" role="status">
      <div className="stale-banner-main">
        <b>Новых загрузок нет уже {label}</b>
        <span>
          Последняя поездка — {latestStr}. Список обновляется только когда
          SensorLogger на iPhone отправляет данные на сервер. Если вы
          записывали поездки, но их здесь нет — канал загрузки нужно
          проверить.
        </span>
      </div>
      {onGoAdmin ? (
        <button
          type="button"
          className="stale-banner-btn"
          onClick={onGoAdmin}
        >
          Диагностика канала →
        </button>
      ) : null}
    </div>
  );
}

function TripsSkeleton() {
  return (
    <>
      <div className="card tsum" aria-busy="true" aria-label="Загрузка сводки поездок">
        <div className="tsum-main">
          <b>— поездок</b>
          <span>загрузка списка…</span>
        </div>
        <div className="tsum-stats">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i}>
              <b style={{ color: "var(--faint)" }}>—</b>
              <span>—</span>
            </div>
          ))}
        </div>
      </div>
      {Array.from({ length: 4 }).map((_, i) => (
        <div
          key={i}
          className="trip"
          style={{ opacity: 0.5 }}
          aria-hidden="true"
        >
          <div className="trip-head">
            <div className="trip-date">
              <b>—</b>
              <span>—</span>
              <small>—</small>
            </div>
            <div className="trip-info">
              <div className="t-route">загрузка…</div>
              <div className="t-sub">—</div>
            </div>
            <div className="t-eco">
              <b>—</b>
              <small>—</small>
            </div>
            <i className="chev">›</i>
          </div>
        </div>
      ))}
    </>
  );
}

function TripsSummary({ list }: { list: SessionListItem[] }) {
  // Per-session stats are fetched in hidden <SummaryAggregator> child which
  // accumulates totals in a ref map and pushes the aggregate up via onAgg.
  const [agg, setAgg] = React.useState<{
    totalDurMin: number;
    totalDistKm: number;
    ecoSum: number;
    ecoCount: number;
  }>({ totalDurMin: 0, totalDistKm: 0, ecoSum: 0, ecoCount: 0 });

  const hh = Math.floor(agg.totalDurMin / 60);
  const mm = Math.round(agg.totalDurMin % 60);
  const avgEco = agg.ecoCount > 0 ? Math.round(agg.ecoSum / agg.ecoCount) : null;

  return (
    <>
      <SummaryAggregator list={list} onAgg={setAgg} />
      <div className="card tsum">
        <div className="tsum-main">
          <b>{list.length} поездок</b>
          <span>
            последняя:{" "}
            {list[0]
              ? new Date(list[0].startTime).toLocaleDateString("ru-RU", {
                  day: "2-digit",
                  month: "short",
                })
              : "—"}
          </span>
        </div>
        <div className="tsum-stats">
          <div>
            <b>{agg.totalDistKm > 0 ? agg.totalDistKm.toFixed(1).replace(".", ",") : "—"}</b>
            <span>км всего</span>
          </div>
          <div>
            <b>{agg.totalDurMin > 0 ? `${hh} ч ${mm} м` : "—"}</b>
            <span>в поездках</span>
          </div>
          <div>
            <b>{avgEco ?? "—"}</b>
            <span>средняя плавность</span>
          </div>
          <div>
            <b>{list.reduce((s, x) => s + (x.pointCount ?? 0), 0)}</b>
            <span>GPS-точек</span>
          </div>
        </div>
      </div>
    </>
  );
}

// Hidden helper — fetches per-session stats and aggregates totals.
function SummaryAggregator({
  list,
  onAgg,
}: {
  list: SessionListItem[];
  onAgg: (a: {
    totalDurMin: number;
    totalDistKm: number;
    ecoSum: number;
    ecoCount: number;
  }) => void;
}) {
  // Track all loaded stats in a ref map to accumulate without losing prior values.
  const loadedRef = React.useRef<Map<string, SessionStats>>(new Map());

  // Стабильный колбэк: без useCallback inline-стрелка в render создаёт новую
  // ссылку → useEffect в AggregatorRow срабатывает на каждый рендер →
  // setState-цикл («Maximum update depth exceeded»).
  const handleLoaded = React.useCallback(
    (id: string, stats: SessionStats) => {
      loadedRef.current.set(id, stats);
      let totalDurMin = 0;
      let totalDistKm = 0;
      let ecoSum = 0;
      let ecoCount = 0;
      for (const v of loadedRef.current.values()) {
        totalDurMin += (v.duration ?? 0) / 60;
        totalDistKm += (v.distance ?? 0) / 1000;
        const ecoVal = v.methodology?.ecoScore?.value;
        if (ecoVal != null && Number.isFinite(ecoVal)) {
          ecoSum += ecoVal;
          ecoCount++;
        }
      }
      onAgg({ totalDurMin, totalDistKm, ecoSum, ecoCount });
    },
    [onAgg]
  );

  return (
    <div style={{ display: "none" }} aria-hidden="true">
      {list.map((s) => (
        <AggregatorRow key={s.id} id={s.id} onLoaded={handleLoaded} />
      ))}
    </div>
  );
}

function AggregatorRow({
  id,
  onLoaded,
}: {
  id: string;
  onLoaded: (id: string, stats: SessionStats) => void;
}) {
  const stats = useSessionStats(id);
  React.useEffect(() => {
    if (stats.data) {
      onLoaded(id, stats.data);
    }
  }, [id, stats.data, onLoaded]);
  return null;
}

function TripCard({
  session,
  isOpen,
  onToggle,
}: {
  session: SessionListItem;
  isOpen: boolean;
  onToggle: () => void;
}) {
  const stats = useSessionStats(session.id);

  const start = new Date(session.startTime);
  const dd = String(start.getDate()).padStart(2, "0");
  const months = ["ЯНВ", "ФЕВ", "МАР", "АПР", "МАЙ", "ИЮН", "ИЮЛ", "АВГ", "СЕН", "ОКТ", "НОЯ", "ДЕК"];
  const mo = months[start.getMonth()];
  const hh = String(start.getHours()).padStart(2, "0");
  const mm = String(start.getMinutes()).padStart(2, "0");

  const durationMin = stats.data ? stats.data.duration / 60 : null;
  const distanceKm = stats.data ? stats.data.distance / 1000 : null;
  const ecoValue = stats.data?.methodology?.ecoScore?.value ?? null;
  const eco =
    ecoValue != null
      ? Math.max(0, Math.min(100, Math.round(ecoValue)))
      : null;

  const sub =
    durationMin != null && distanceKm != null
      ? `${distanceKm.toFixed(1).replace(".", ",")} км · ${Math.round(durationMin)} мин`
      : session.pointCount
        ? `${session.pointCount} точек`
        : "загрузка…";

  return (
    <div className={`trip ${isOpen ? "open" : ""}`}>
      <div
        className="trip-head"
        onClick={onToggle}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
      >
        <div className="trip-date">
          <b>{dd}</b>
          <span>{mo}</span>
          <small>
            {hh}:{mm}
          </small>
        </div>
        <div className="trip-info">
          <div className="t-route">
            {session.deviceName || session.deviceId}
            <span
              className="chip chip-amber"
              style={{ marginLeft: 6, fontSize: 10 }}
              data-tip={`Статус записи: ${session.status} | ${session.pointCount} точек GPS`}
            >
              {session.status}
            </span>
          </div>
          <div className="t-sub">{sub}</div>
        </div>
        <div className={`t-eco ${eco != null ? ecoCls(eco) : ""}`}>
          <b>{eco ?? "—"}</b>
          <small>{eco != null ? ecoLab(eco) : "—"}</small>
        </div>
        <i className="chev">›</i>
      </div>
      {isOpen ? (
        <TripBody session={session} stats={stats.data ?? null} />
      ) : null}
    </div>
  );
}

function TripBody({
  session,
  stats,
}: {
  session: SessionListItem;
  stats: SessionStats | null;
}) {
  if (!stats) {
    return (
      <div className="trip-body">
        <p style={{ fontSize: 12, color: "var(--muted)", margin: 0 }}>
          Загрузка детальной статистики…
        </p>
      </div>
    );
  }
  const bbox = stats.bbox;
  const routeHash = stats.routeHash ?? session.routeId ?? null;
  const startStr = new Date(stats.startTime).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  });
  const endStr = stats.endTime
    ? new Date(stats.endTime).toLocaleString("ru-RU", {
        day: "2-digit",
        month: "long",
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;
  const moveMin = Math.round(stats.movingTime / 60);
  const idleMin = Math.round(stats.idleTime / 60);
  const gapSec = stats.gapTime ?? 0;
  // FIX-C1: средняя — из API (§4.3: активная дистанция / активная длительность).
  // Раньше пересчитывалась локально как «вся дистанция / вся длительность» —
  // расходилась с подписью «активной части» и занижалась хвостами.
  const avgKmh = stats.avgSpeed != null ? stats.avgSpeed * 3.6 : null;
  const maxKmh = stats.maxSpeed != null ? stats.maxSpeed * 3.6 : null;

  return (
    <div className="trip-body">
      <div className="seg-total" style={{ marginBottom: 10 }}>
        <span>старт:</span>
        <b>{startStr}</b>
        <span>финиш:</span>
        <b>{endStr ?? "—"}</b>
      </div>
      <div className="stats-grid" style={{ marginTop: 0, marginBottom: 10 }}>
        <Stat
          value={`${stats.pointCount}`}
          tip="Количество GPS-точек в записи (после фильтрации выбросов и дедупликации)"
          label="GPS-точек"
        />
        <Stat
          value={`${Math.round(stats.distance / 1000).toString().replace(".", ",")} км`}
          tip="Дистанция (§4.2): сумма гаверсинусов между соседними точками активной части"
          label="Дистанция"
        />
        <Stat
          value={`${Math.round(stats.duration / 60)} мин`}
          tip="Длительность записи (§4.1): от первой до последней точки, включая стоянки-«хвосты». Аналитика (дистанция, скорость) — по активной поездке (§4.11)"
          label="Длительность"
        />
        <Stat
          value={avgKmh != null ? `${avgKmh.toFixed(1).replace(".", ",")} км/ч` : "—"}
          tip="Средняя скорость активной части (§4.3)"
          label="Ср. скорость"
        />
        <Stat
          value={maxKmh != null ? `${maxKmh.toFixed(1).replace(".", ",")} км/ч` : "—"}
          tip="Максимальная скорость (§4.4) — пик с фильтрацией выбросов"
          label="Макс. скорость"
        />
        <Stat
          value={`${moveMin} мин`}
          tip="Время в движении (§4.6): скорость выше 2 км/ч после гистерезиса"
          label="В движении"
        />
        <Stat
          value={`${idleMin} мин`}
          tip="Время стоянок (§4.7): скорость ниже 2 км/ч"
          label="Стоянки"
        />
        <Stat
          value={`${Math.round(gapSec)} сек`}
          tip="Разрывы записи (§4.6): интервалы между точками длиннее 30 сек"
          label="Разрывы"
        />
      </div>
      <div className="seg-total" style={{ marginBottom: 6 }}>
        <span>bbox:</span>
        <b
          className="mono"
          style={{ fontSize: 10, fontWeight: 400 }}
        >
          {bbox
            ? `${bbox.minLat.toFixed(4)}..${bbox.maxLat.toFixed(4)} Lat · ${bbox.minLon.toFixed(4)}..${bbox.maxLon.toFixed(4)} Lon`
            : "—"}
        </b>
      </div>
      {routeHash ? (
        <div className="seg-total" style={{ marginBottom: 6 }}>
          <span>routeHash:</span>
          <b
            className="mono"
            style={{ fontSize: 10, fontWeight: 400 }}
            data-tip={`Детерминированный хэш маршрута (§10.0). Используется для группировки концептуально одинаковых поездок и расчёта P75-хотспотов.`}
          >
            {routeHash}
          </b>
        </div>
      ) : null}
      <div className="seg-total">
        <span>статус:</span>
        <b>{stats.endTime ? "завершена" : "активна"}</b>
      </div>
    </div>
  );
}

function Stat({
  value,
  tip,
  label,
}: {
  value: string;
  tip: string;
  label: string;
}) {
  return (
    <div className="stat">
      <div className="v" dangerouslySetInnerHTML={{ __html: value }} />
      <div className="l">
        <span data-tip={tip}>{label}</span>
      </div>
    </div>
  );
}
