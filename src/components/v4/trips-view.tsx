// src/components/v4/trips-view.tsx — вкладка Поездки v4.
// LIVE: /api/sessions (useSessions) + /api/sessions/[id]/stats (useSessionStats per row).
// NO mock data — shows real sessions from the database only.

"use client";

import * as React from "react";
import { useSessions, useSessionStats, useReverseGeocode, SESSION_STATUS_RU, type SessionStats } from "@/lib/hooks";
import type { SessionListItem } from "@/lib/api-client";
import { ecoCls, ecoLab } from "@/lib/v4-utils";
import { fmtSecFull, fmtDurMin, fmtNumber, pluralRu } from "@/lib/format";
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
            {/* v2.11.0 (U-28): точный эндпоинт и путь к импорту — раньше вёл
                на общий /api/ingest и «вкладка АДМИН» без подсказки про Импорт */}
            Импортируйте CSV через вкладку «Админ» → раздел «Импорт данных» или
            подключите SensorLogger к{" "}
            <code>/api/ingest/sensorlogger</code> — поездки появятся здесь
            автоматически.
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
    // v2.12.0 (D-4): сколько сессий уже посчитано — пока не все, сводка помечена
    // «считаем…» (раньше частичные суммы выглядели как финальные и «росли» на глазах)
    loadedCount: number;
  }>({ totalDurMin: 0, totalDistKm: 0, ecoSum: 0, ecoCount: 0, loadedCount: 0 });

  const avgEco = agg.ecoCount > 0 ? Math.round(agg.ecoSum / agg.ecoCount) : null;
  const computing = agg.loadedCount < list.length;

  return (
    <>
      <SummaryAggregator list={list} onAgg={setAgg} />
      <div className="card tsum">
        <div className="tsum-main">
          <b>
            {fmtNumber(list.length)} {pluralRu(list.length, ["поездка", "поездки", "поездок"])}
          </b>
          <span>
            последняя:{" "}
            {list[0]
              ? new Date(list[0].startTime).toLocaleDateString("ru-RU", {
                  day: "2-digit",
                  month: "short",
                })
              : "—"}
            {computing ? " · считаем сводку…" : ""}
          </span>
        </div>
        <div className="tsum-stats">
          <div>
            <b>{agg.totalDistKm > 0 ? agg.totalDistKm.toFixed(1).replace(".", ",") : "—"}</b>
            <span>км всего</span>
          </div>
          <div>
            {/* v2.12.0 (округления): единый формат длительности «5 ч 7 мин» */}
            <b>{agg.totalDurMin > 0 ? fmtDurMin(agg.totalDurMin) : "—"}</b>
            <span>в поездках</span>
          </div>
          <div>
            <b>{avgEco ?? "—"}</b>
            <span>средняя плавность</span>
          </div>
          <div>
            {/* v2.12.0 (D-1): фактические строки GpsPoint (не денормализованный
                pointCount — он расходился: Σ 15 266 vs факт 15 148) + разделители */}
            <b>{fmtNumber(list.reduce((s, x) => s + (x.pointCountActual ?? x.pointCount ?? 0), 0))}</b>
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
    loadedCount: number;
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
      // v2.12.0 (D-4): передаём и число посчитанных сессий — сводка честно
      // помечает незавершённый расчёт
      onAgg({ totalDurMin, totalDistKm, ecoSum, ecoCount, loadedCount: loadedRef.current.size });
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
  // v2.12.0 (Q3): идентификация поездки по адресу конечной точки (требование
  // владельца). endLat/endLon — последняя точка записи из /api/sessions;
  // адрес резолвится через /api/geocode/reverse (кэш 30 дней на сервере).
  const dest = useReverseGeocode(session.endLat ?? null, session.endLon ?? null);
  const destShort = dest.data?.short ?? null;

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

  // v2.12.0 (D-2): «0,0 км · 68 мин» при нулевой дистанции и avgSpeed=null —
  // это «нет данных о движении» (GPS-джиттер без активной поездки), не «0 км».
  const noMovement =
    stats.data != null && distanceKm != null && durationMin != null &&
    distanceKm <= 0 && stats.data.avgSpeed == null;
  const sub =
    noMovement
      ? `${fmtNumber(session.pointCountActual ?? session.pointCount)} ${pluralRu(session.pointCountActual ?? session.pointCount, ["точка", "точки", "точек"])} · нет данных о движении · ${fmtDurMin(durationMin)}`
      : durationMin != null && distanceKm != null
        ? `${distanceKm.toFixed(1).replace(".", ",")} км · ${fmtDurMin(durationMin)}`
        : session.pointCount
          ? `${fmtNumber(session.pointCountActual ?? session.pointCount)} ${pluralRu(session.pointCountActual ?? session.pointCount, ["точка", "точки", "точек"])}`
          : "загрузка…";

  // Заголовок: адрес финиша → fallback имя устройства → deviceId
  const title =
    destShort != null ? (
      <span title={dest.data?.address ?? undefined}>
        <span aria-hidden="true" style={{ color: "var(--plum)", fontWeight: 800 }}>→ </span>
        {destShort}
      </span>
    ) : dest.isLoading ? (
      <span style={{ color: "var(--muted)", fontWeight: 600 }}>→ адрес финиша…</span>
    ) : (
      <span>{session.deviceName || session.deviceId}</span>
    );

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
            {title}
            {/* v2.11.0 (U-15): RU-подпись статуса вместо сырого enum */}
            <span
              className="chip chip-amber"
              style={{ marginLeft: 6, fontSize: 10 }}
              data-tip={`Статус записи: ${SESSION_STATUS_RU[session.status] ?? session.status} | ${fmtNumber(session.pointCountActual ?? session.pointCount)} ${pluralRu(session.pointCountActual ?? session.pointCount, ["точка", "точки", "точек"])} GPS`}
            >
              {SESSION_STATUS_RU[session.status] ?? session.status}
            </span>
          </div>
          <div className="t-sub">{sub}</div>
        </div>
        <div className={`t-eco ${eco != null ? ecoCls(eco) : ""}`}>
          {/* v2.12.0 (V-5): единицы в бейдже — «39 / 100 · резко» вместо «39 РЕЗКО» */}
          <b>{eco ?? "—"}</b>
          <small>{eco != null ? `${ecoLab(eco)} · из 100` : "—"}</small>
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
  // v2.12.0 (Q3): полный адрес финиша — в детальной карточке
  const dest = useReverseGeocode(session.endLat ?? null, session.endLon ?? null);
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
  // v2.12.0 (округления): «0 мин» для записей < 60 сек → секунды (fmtSecFull);
  // минуты — только когда они минуты (68 мин), часы — от 60 минут (1 ч 32 мин)
  const moveStr = fmtSecFull(stats.movingTime);
  const idleStr = fmtSecFull(stats.idleTime);
  const gapSec = stats.gapTime ?? 0;
  // FIX-C1: средняя — из API (§4.3: активная дистанция / активная длительность).
  // Раньше пересчитывалась локально как «вся дистанция / вся длительность» —
  // расходилась с подписью «активной части» и занижалась хвостами.
  const avgKmh = stats.avgSpeed != null ? stats.avgSpeed * 3.6 : null;
  const maxKmh = stats.maxSpeed != null ? stats.maxSpeed * 3.6 : null;
  // v2.12.0 (D-2): дистанция 0 без активной поездки — «нет данных», не «0 км»
  const hasMovement = stats.distance > 0 || stats.avgSpeed != null;

  return (
    <div className="trip-body">
      <div className="seg-total" style={{ marginBottom: 10 }}>
        <span>старт:</span>
        <b>{startStr}</b>
        <span>финиш:</span>
        <b>{endStr ?? "—"}</b>
      </div>
      {dest.data ? (
        <div className="seg-total" style={{ marginBottom: 10 }}>
          <span>куда:</span>
          <b
            style={{ fontWeight: 600 }}
            data-tip={`Адрес конечной точки записи (Nominatim, кэш на сервере) | ${dest.data.cached ? "из кэша" : "свежий запрос"}`}
          >
            → {dest.data.short}
          </b>
        </div>
      ) : null}
      <div className="stats-grid" style={{ marginTop: 0, marginBottom: 10 }}>
        <Stat
          value={`${fmtNumber(stats.pointCount)}`}
          tip="Количество GPS-точек в записи (после фильтрации выбросов и дедупликации)"
          label="GPS-точек"
        />
        <Stat
          // v2.12.0 (округления): 1 знак после запятой (Math.round давал «1 км»
          // и «1,3 км» на одном экране; .replace после round был мёртвым кодом)
          value={hasMovement ? `${(stats.distance / 1000).toFixed(1).replace(".", ",")} км` : "нет данных"}
          tip="Дистанция (§4.2): сумма гаверсинусов между соседними точками активной части. 0 и отсутствие активной поездки = GPS-запись без движения"
          label="Дистанция"
        />
        <Stat
          value={fmtDurMin(stats.duration / 60)}
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
          tip="Максимальная скорость (§4.4) — пик с фильтрацией выбросов и сглаживанием"
          label="Макс. скорость"
        />
        <Stat
          value={moveStr}
          tip="Время в движении (§4.6): скорость выше 2 км/ч после гистерезиса"
          label="В движении"
        />
        <Stat
          value={idleStr}
          tip="Время стоянок (§4.7): скорость ниже 2 км/ч"
          label="Стоянки"
        />
        <Stat
          value={fmtSecFull(gapSec)}
          tip="Разрывы записи (§4.6): интервалы между точками длиннее 30 сек — время без данных GPS"
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
