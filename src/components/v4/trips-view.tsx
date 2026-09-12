// src/components/v4/trips-view.tsx — вкладка Поездки v4.
// LIVE: /api/sessions (useSessions) + /api/sessions/[id]/stats (useSessionStats per row).
// NO mock data — shows real sessions from the database only.
//
// v2.14.0 (Ф1): соседние записи ОДНОГО устройства с паузой < 10 минут
// склеиваются в одну карточку-поездку. iOS при блокировке экрана сворачивает
// SensorLogger → сервер режет одну поездку на сессии (разрыв пуша >60с =
// новая сессия); кейс 02.09: вечерняя поездка = 5 кусков, «где поездка?».
// Аналитика и API НЕ меняются — склейка только на экране списка.
//
// v2.14.0 (Ф2): живое обновление — useSessions опрашивает сервер каждые 30с
// при активной вкладке; у идущей записи статы обновляются каждые 15с
// (useSessionStats {live}); чип «идёт запись» пульсирует (chip-live).
//
// v2.15.0 (sync): параметры склеенной поездки синхронизированы с «Аналитикой» —
// те же формулы, что в период-агрегате (v4-hooks.ts):
//   длительность = Σ длительностей записей (§4.1) — как KPI «Длительность»/«всего»;
//   «в поездке» = Σ активных частей (§4.11) — как «в поездках» в шапке;
//   ср. скорость = Σ дистанций / Σ активных (§4.3 + §4.11, FIX-C1);
//   EcoScore = взвешенное среднее по активной длительности (wavg).
// Раньше карточка показывала span «от старта первой до конца последней» (паузы
// между записями раздували «2 ч» до «4 ч 51 мин») и ср. = Σдист/Σдвижения —
// цифры расходились с «Аналитикой» за тот же день. Span остался отдельной
// строкой «От старта до финиша».

"use client";

import * as React from "react";
import { ZipImport } from "@/components/zip-import";
import { useSessions, useSessionStats, useSessionsStatsBatch, isStatsBatchCovered, useReverseGeocode, SESSION_STATUS_RU, type SessionStats } from "@/lib/hooks";
import type { SessionListItem } from "@/lib/api-client";
import { useTrips, useTripsStatsBatch, useTripStats } from "@/lib/trip-hooks"; // v2.26.0: ПОЕЗДКИ сервера
import { ecoCls, ecoLab } from "@/lib/v4-utils";
import { fmtSecFull, fmtDurMin, fmtNumber, pluralRu } from "@/lib/format";
import { bindTips } from "./use-v4-tipbox";

// v2.14.0 (Ф1): пауза между записями одного устройства, при которой записи
// считаются ОДНОЙ поездкой. 10 минут — консервативно: реальные паузы
// «заглянул в магазин / постоял в пробке без точек» короче, а отдельные
// поездки (утром и вечером) разделены часами.
const TRIP_MERGE_GAP_MS = 10 * 60_000;

// v2.26.1: тултип бейджа EcoScore — простым языком (что это за балл и как
// читать зоны). Раньше подпись «резко» висела без объяснений.
const ECO_SCORE_TIP =
  "Оценка плавности вождения: 0–100 | Чем плавнее разгоны, торможения и повороты — тем выше балл | 80 и выше — плавно · 60–79 — умеренно · ниже 60 — агрессивный стиль";

interface SessionGroup {
  device: string;
  /** asc по startTime — хронологический порядок показа */
  sessions: SessionListItem[];
}

// Список от API отсортирован по startTime desc (сначала новые). Идём от новых
// к старым: сессия присоединяется к последней группе, если она того же
// устройства и «стык» (начало старшей записи группы − конец текущей сессии)
// меньше TRIP_MERGE_GAP_MS. Внутри группы порядок разворачиваем в asc.
function groupIntoTrips(list: SessionListItem[]): SessionGroup[] {
  const groups: Array<{ device: string; sessions: SessionListItem[] }> = [];
  for (const s of list) {
    const cur = groups[groups.length - 1];
    if (cur && cur.device === s.deviceId) {
      // cur.sessions в desc-порядке: последняя — самая старая запись группы.
      const boundary = cur.sessions[cur.sessions.length - 1];
      const boundaryStart = new Date(boundary.startTime).getTime();
      const sEnd = new Date(s.endTime ?? s.startTime).getTime();
      if (
        Number.isFinite(boundaryStart) &&
        Number.isFinite(sEnd) &&
        boundaryStart - sEnd < TRIP_MERGE_GAP_MS
      ) {
        cur.sessions.push(s);
        continue;
      }
    }
    groups.push({ device: s.deviceId, sessions: [s] });
  }
  return groups.map((g) => ({ device: g.device, sessions: [...g.sessions].reverse() }));
}

/** v2.23.0: данные зарегистрированного пользователя — для карточки «Подключение телефона» */
export interface TripsUserInfo {
  email: string;
  ingestToken: string;
}

export function TripsView({
  onGoAdmin,
  userInfo,
}: {
  onGoAdmin?: () => void;
  userInfo?: TripsUserInfo;
}) {
  // v2.26.0 (ТЗ §11): ПОЕЗДКИ СЕРВЕРА — канонический список /api/trips.
  // Склейка больше не клиентская эвристика: поездка назначается сервером
  // (trip-grouping, каноническое правило §4 ТЗ). Легаси-рендер записей остаётся
  // фолбэком на expand-фазе (TRIP_ENABLED=false / поездок ещё нет) — регрессионно
  // безопасный переход (§13 ТЗ).
  const tripsQ = useTrips({ limit: 50 });
  const serverTrips = tripsQ.data?.trips ?? [];
  const serverTripsActive =
    tripsQ.isSuccess && tripsQ.data?.disabled !== true && serverTrips.length > 0;

  const ref = React.useRef<HTMLDivElement>(null);
  const [openId, setOpenId] = React.useState<string | null>(null);
  const sessions = useSessions({ limit: 50 }, { enabled: !serverTripsActive });
  React.useEffect(() => {
    if (ref.current) bindTips(ref.current);
  }, [openId, sessions.data, tripsQ.data]);

  const list: SessionListItem[] = sessions.data?.sessions ?? [];
  const isLoading = sessions.isLoading && !sessions.data;
  const isError = sessions.isError;
  // v2.14.0 (Ф1): группы-поездки — мемо, чтобы не пересчитывать на каждый рендер
  const groups = React.useMemo(() => groupIntoTrips(list), [list]);

  // v2.17.0 (батч-статс): статы ВСЕХ записей вкладки — одним GET /api/stats/batch
  // (вместо N× /api/sessions/[id]/stats, что на проде давало 40–60 с полной
  // загрузки). Ответ просеивается в кэш ["session-stats", id] (хук внутри),
  // карточки/агрегаторы читают его без собственных запросов (coverage в
  // useSessionStats). Пока первый батч в полёте — держим скелетон; сбой или
  // 25-секундный watchdog → рендерим карточки как раньше (поштучная загрузка).
  // v2.17.2: если все id уже покрыты свежим батчем (префетч лейаута /
  // период-агрегат «Аналитики» уже просеяли кэш) — карточки рендерятся
  // мгновенно, не дожидаясь своего запроса.
  const ids = React.useMemo(() => list.map((s) => s.id), [list]);
  const statsBatch = useSessionsStatsBatch(ids);
  const [batchWatchdog, setBatchWatchdog] = React.useState(false);
  React.useEffect(() => {
    setBatchWatchdog(false);
    if (statsBatch.data != null || statsBatch.isError) return;
    const t = window.setTimeout(() => setBatchWatchdog(true), 25_000);
    return () => window.clearTimeout(t);
  }, [statsBatch.data, statsBatch.isError]);
  const allCovered = ids.length > 0 && ids.every((id) => isStatsBatchCovered(id));
  const waitingForStats =
    ids.length > 0 &&
    statsBatch.data == null &&
    !statsBatch.isError &&
    !batchWatchdog &&
    !allCovered;
  // Рефреш показателя «свежести» раз в минуту (чтобы часы без перезагрузки обновлялись)
  const [, setTick] = React.useState(0);
  React.useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 60_000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div ref={ref}>
      {userInfo && <PersonalIngestCard user={userInfo} />}
      {/* v2.24.0: импорт ZIP для зарегистрированных пользователей — восстановление
          поездок, не дошедших по push (SensorLogger хранит логи локально; архив
          экспортируется из приложения и загружается здесь; сессии привязываются
          к аккаунту импортёра — тот же скоуп, что у инжеста по личному токену). */}
      {userInfo && (
        <div style={{ marginBottom: 4 }}>
          <ZipImport />
        </div>
      )}
      {/* v2.26.0: СЕРВЕРНЫЕ ПОЕЗДКИ — приоритетный рендер (ТЗ §11) */}
      {serverTripsActive ? (
        <TripsServerView
          trips={serverTrips}
          isLoading={tripsQ.isLoading}
          isError={tripsQ.isError}
          onGoAdmin={onGoAdmin}
          openId={openId}
          setOpenId={setOpenId}
        />
      ) : isError ? (
        <div className="card" style={{ padding: "20px", color: "var(--red)", fontSize: 13 }}>
          Не удалось загрузить список поездок. Попробуйте обновить страницу.
        </div>
      ) : isLoading || waitingForStats ? (
        // v2.17.0: waitingForStats — статы едут одним батч-запросом; скелетон
        // держим до его завершения (или watchdog 15с → карточки грузятся сами)
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
            {/* v2.24.0: подсказка зависит от роли — для зарегистрированного
                пользователя вкладки «Админ» нет: карточки «Подключение телефона»
                и «Импорт из ZIP» выше; владельцу/админу остаётся старый путь. */}
            {userInfo ? (
              <>
                Скопируйте адрес из карточки «Подключение телефона» выше и
                вставьте его в SensorLogger (HTTP Push) — поездки будут
                появляться здесь автоматически. Пропущенные поездки можно
                вернуть: экспортируйте логи из SensorLogger в ZIP и загрузите
                в карточку «Импорт из ZIP архива».
              </>
            ) : (
              <>
                Импортируйте CSV/ZIP через вкладку «Админ» → раздел «Импорт
                данных» или подключите SensorLogger к{" "}
                <code>/api/ingest/sensorlogger</code> — поездки появятся здесь
                автоматически.
              </>
            )}
          </div>
        </div>
      ) : (
        <>
          <StaleDataBanner list={list} onGoAdmin={onGoAdmin} />
          <TripsSummary list={list} groups={groups} />
          {groups.map((g) =>
            g.sessions.length === 1 ? (
              <TripCard
                key={g.sessions[0].id}
                session={g.sessions[0]}
                isOpen={openId === g.sessions[0].id}
                onToggle={() =>
                  setOpenId(openId === g.sessions[0].id ? null : g.sessions[0].id)
                }
              />
            ) : (
              <GroupedTripCard
                key={`g:${g.sessions[0].id}`}
                group={g}
                isOpen={openId === `g:${g.sessions[0].id}`}
                onToggle={() =>
                  setOpenId(openId === `g:${g.sessions[0].id}` ? null : `g:${g.sessions[0].id}`)
                }
              />
            )
          )}
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

function TripsSummary({
  list,
  groups,
}: {
  list: SessionListItem[];
  groups: SessionGroup[];
}) {
  // Per-session stats are fetched in hidden <SummaryAggregator> child which
  // accumulates totals in a ref map and pushes the aggregate up via onAgg.
  const [agg, setAgg] = React.useState<{
    totalDurMin: number;
    // v2.15.0 (sync): Σ активных частей (§4.11) — «в поездках», как в шапке Аналитики
    totalActiveMin: number;
    totalDistKm: number;
    // v2.15.0 (sync): EcoScore wavg по активной длительности (как период-агрегат)
    ecoWSum: number;
    ecoW: number;
    // v2.12.0 (D-4): сколько сессий уже посчитано — пока не все, сводка помечена
    // «считаем…» (раньше частичные суммы выглядели как финальные и «росли» на глазах)
    loadedCount: number;
  }>({ totalDurMin: 0, totalActiveMin: 0, totalDistKm: 0, ecoWSum: 0, ecoW: 0, loadedCount: 0 });

  const avgEco = agg.ecoW > 0 ? Math.max(0, Math.min(100, Math.round(agg.ecoWSum / agg.ecoW))) : null;
  const computing = agg.loadedCount < list.length;

  return (
    <>
      <SummaryAggregator list={list} onAgg={setAgg} />
      <div className="card tsum">
        <div className="tsum-main">
          {/* v2.14.0 (Ф1): считаем ПОЕЗДКИ (склеенные группы), рядом — сколько
              в них записей. Раньше «12 поездок» при 5 кусках одной поездки. */}
          <b
            data-tip="Что считается одной поездкой | Записи с паузами короче 10 минут объединяются в одну поездку | Телефон иногда приостанавливает приложение, и запись делится на части — здесь они показаны вместе"
          >
            {fmtNumber(groups.length)} {pluralRu(groups.length, ["поездка", "поездки", "поездок"])}
            {groups.length < list.length ? (
              <span style={{ color: "var(--muted)", fontWeight: 500 }}>
                {" "}· {fmtNumber(list.length)} {pluralRu(list.length, ["запись", "записи", "записей"])}
              </span>
            ) : null}
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
            {/* v2.15.0 (sync): «в поездках» = Σ активных частей записей (§4.11) —
                та же метрика, что «в поездках» в шапке Аналитики. Раньше здесь
                была Σ полных длительностей (§4.1): подпись обещала активное
                время, а число содержало стоянки-хвосты. Fallback на Σ записей —
                когда активной части нет ни у одной записи. */}
            <b>
              {agg.totalActiveMin > 0
                ? fmtDurMin(agg.totalActiveMin)
                : agg.totalDurMin > 0
                  ? fmtDurMin(agg.totalDurMin)
                  : "—"}
            </b>
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
    // v2.15.0 (sync): Σ активных частей (§4.11) — «в поездках» как в Аналитике
    totalActiveMin: number;
    totalDistKm: number;
    // v2.15.0 (sync): EcoScore wavg по активной длительности (как период-агрегат)
    ecoWSum: number;
    ecoW: number;
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
      // v2.15.0 (sync): Σ активных частей (§4.11)
      let totalActiveMin = 0;
      let totalDistKm = 0;
      // v2.15.0 (sync): EcoScore — взвешенное среднее по активной длительности
      let ecoWSum = 0;
      let ecoW = 0;
      for (const v of loadedRef.current.values()) {
        totalDurMin += (v.duration ?? 0) / 60;
        const at = v.methodology?.activeTrip;
        if (at?.hasActiveTrip) totalActiveMin += at.activeDuration / 60;
        totalDistKm += (v.distance ?? 0) / 1000;
        const ecoVal = v.methodology?.ecoScore?.value;
        if (ecoVal != null && Number.isFinite(ecoVal)) {
          const w = at?.hasActiveTrip ? Math.max(0, at.activeDuration) : 0;
          ecoWSum += ecoVal * w;
          ecoW += w;
        }
      }
      // v2.12.0 (D-4): передаём и число посчитанных сессий — сводка честно
      // помечает незавершённый расчёт
      onAgg({ totalDurMin, totalActiveMin, totalDistKm, ecoWSum, ecoW, loadedCount: loadedRef.current.size });
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
  live,
  onLoaded,
}: {
  id: string;
  // v2.14.0 (Ф2): live=true → статистика обновляется каждые 15с (идущая запись)
  live?: boolean;
  onLoaded: (id: string, stats: SessionStats) => void;
}) {
  const stats = useSessionStats(id, { live });
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
  // v2.14.0 (Ф2): у идущей записи статистика живая (15с)
  const stats = useSessionStats(session.id, { live: session.status === "recording" });
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
            {/* v2.11.0 (U-15): RU-подпись статуса вместо сырого enum;
                v2.14.0 (Ф2): пульс на живой записи */}
            <span
              className={`chip chip-amber${session.status === "recording" ? " chip-live" : ""}`}
              style={{ marginLeft: 6, fontSize: 10 }}
              data-tip={`Статус: ${SESSION_STATUS_RU[session.status] ?? session.status} | ${fmtNumber(session.pointCountActual ?? session.pointCount)} ${pluralRu(session.pointCountActual ?? session.pointCount, ["точка", "точки", "точек"])} GPS`}
            >
              {SESSION_STATUS_RU[session.status] ?? session.status}
            </span>
          </div>
          <div className="t-sub">{sub}</div>
        </div>
        <div className={`t-eco ${eco != null ? ecoCls(eco) : ""}`} data-tip={ECO_SCORE_TIP}>
          {/* v2.12.0 (V-5): единицы в бейдже — «39 / 100 · агрессивно»; v2.26.1 —
              понятная шкала стиля + тултип-пояснение на самом бейдже */}
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

// ===== v2.14.0 (Ф1): склеенная поездка (несколько записей одного устройства) =====

interface GroupAgg {
  loadedCount: number;
  totalPoints: number;
  totalDistanceM: number;
  spanSec: number;
  sumMovingSec: number;
  sumIdleSec: number;
  sumDurSec: number;
  // v2.15.0 (sync): Σ активных частей записей (§4.11) — «в поездке», как в Аналитике
  sumActiveSec: number;
  maxSpeedMs: number | null;
  ecoAvg: number | null;
}

function GroupedTripCard({
  group,
  isOpen,
  onToggle,
}: {
  group: SessionGroup;
  isOpen: boolean;
  onToggle: () => void;
}) {
  const sessions = group.sessions; // asc
  const first = sessions[0];
  const last = sessions[sessions.length - 1];
  const anyRecording = sessions.some((s) => s.status === "recording");
  const [agg, setAgg] = React.useState<GroupAgg | null>(null);

  // v2.12.0 (Q3) + Ф1: поездка идентифицируется адресом КОНЕЧНОЙ точки
  // последней записи (куда приехали), не первой
  const dest = useReverseGeocode(last.endLat ?? null, last.endLon ?? null);
  const destShort = dest.data?.short ?? null;

  const start = new Date(first.startTime);
  const dd = String(start.getDate()).padStart(2, "0");
  const months = ["ЯНВ", "ФЕВ", "МАР", "АПР", "МАЙ", "ИЮН", "ИЮЛ", "АВГ", "СЕН", "ОКТ", "НОЯ", "ДЕК"];
  const mo = months[start.getMonth()];
  const hh = String(start.getHours()).padStart(2, "0");
  const mm = String(start.getMinutes()).padStart(2, "0");

  const computing = agg == null || agg.loadedCount < sessions.length;
  const totalPoints =
    sessions.reduce((s, x) => s + (x.pointCountActual ?? x.pointCount ?? 0), 0);
  // v2.15.0 (sync): длительность в подзаголовке = Σ длительностей записей (§4.1) —
  // тот же показатель, что KPI «Длительность» и «всего» в шапке Аналитики.
  // Раньше показывался span (от старта первой записи до конца последней) —
  // паузы между записями раздували «2 ч» до «4 ч 51 мин».
  const sub = computing
    ? `${sessions.length} ${pluralRu(sessions.length, ["запись", "записи", "записей"])} · считаем…`
    : agg && (agg.totalDistanceM > 0 || agg.sumMovingSec > 0)
      ? `${(agg.totalDistanceM / 1000).toFixed(1).replace(".", ",")} км · ${fmtDurMin(agg.sumDurSec / 60)} · ${fmtNumber(totalPoints)} ${pluralRu(totalPoints, ["точка", "точки", "точек"])}`
      : `${fmtNumber(totalPoints)} ${pluralRu(totalPoints, ["точка", "точки", "точек"])} · нет данных о движении · ${agg ? fmtDurMin(agg.sumDurSec / 60) : "—"}`;

  const title =
    destShort != null ? (
      <span title={dest.data?.address ?? undefined}>
        <span aria-hidden="true" style={{ color: "var(--plum)", fontWeight: 800 }}>→ </span>
        {destShort}
      </span>
    ) : dest.isLoading ? (
      <span style={{ color: "var(--muted)", fontWeight: 600 }}>→ адрес финиша…</span>
    ) : (
      <span>{first.deviceName || first.deviceId}</span>
    );

  return (
    <div className={`trip ${isOpen ? "open" : ""}`}>
      <GroupStatsAggregator sessions={sessions} onAgg={setAgg} />
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
            {/* Ф1: сколько записей склеено в эту поездку */}
            <span
              className="chip chip-plum"
              style={{ marginLeft: 6, fontSize: 10 }}
              data-tip={`Одна поездка из ${sessions.length} ${pluralRu(sessions.length, ["записи", "записей", "записей"])} | Паузы между ними короче 10 минут — записи объединены в одну поездку`}
            >
              {sessions.length} {pluralRu(sessions.length, ["запись", "записи", "записей"])}
            </span>
            {/* Ф2: живая запись внутри поездки — пульс */}
            {anyRecording ? (
              <span
                className="chip chip-amber chip-live"
                style={{ marginLeft: 4, fontSize: 10 }}
                data-tip="Идёт запись | Показатели поездки обновляются каждые 15 секунд"
              >
                идёт запись
              </span>
            ) : null}
          </div>
          <div className="t-sub">{sub}</div>
        </div>
        <div className={`t-eco ${agg?.ecoAvg != null ? ecoCls(agg.ecoAvg) : ""}`} data-tip={ECO_SCORE_TIP}>
          <b>{agg?.ecoAvg ?? "—"}</b>
          <small>{agg?.ecoAvg != null ? `${ecoLab(agg.ecoAvg)} · из 100` : "—"}</small>
        </div>
        <i className="chev">›</i>
      </div>
      {isOpen ? <GroupedTripBody group={group} agg={agg} /> : null}
    </div>
  );
}

// Скрытый агрегатор: тянет статы каждой записи (live для идущей) и сворачивает
// в GroupAgg. Тот же queryKey, что у сводки и одиночных карточек — запросы
// дедуплицируются TanStack Query, лишнего трафика нет.
function GroupStatsAggregator({
  sessions,
  onAgg,
}: {
  sessions: SessionListItem[];
  onAgg: (a: GroupAgg) => void;
}) {
  const statsRef = React.useRef<Map<string, SessionStats>>(new Map());
  const handleLoaded = React.useCallback(
    (id: string, stats: SessionStats) => {
      statsRef.current.set(id, stats);
      const first = sessions[0];
      const last = sessions[sessions.length - 1];
      const spanSec = Math.max(
        0,
        ((new Date(last.endTime ?? Date.now()).getTime() - new Date(first.startTime).getTime()) / 1000)
      );
      let totalPoints = 0;
      let totalDistanceM = 0;
      let sumMovingSec = 0;
      let sumIdleSec = 0;
      let sumDurSec = 0;
      // v2.15.0 (sync): Σ активных частей (§4.11)
      let sumActiveSec = 0;
      let maxSpeedMs: number | null = null;
      // v2.15.0 (sync): EcoScore — взвешенное среднее по активной длительности,
      // как период-агрегат Аналитики (wavg); записи без активной части не весят
      let ecoWSum = 0;
      let ecoW = 0;
      for (const v of statsRef.current.values()) {
        totalPoints += v.pointCount ?? 0;
        totalDistanceM += v.distance ?? 0;
        sumMovingSec += v.movingTime ?? 0;
        sumIdleSec += v.idleTime ?? 0;
        sumDurSec += v.duration ?? 0;
        const at = v.methodology?.activeTrip;
        if (at?.hasActiveTrip) sumActiveSec += at.activeDuration;
        if (v.maxSpeed != null) {
          maxSpeedMs = Math.max(maxSpeedMs ?? 0, v.maxSpeed);
        }
        const ecoVal = v.methodology?.ecoScore?.value;
        if (ecoVal != null && Number.isFinite(ecoVal)) {
          const w = at?.hasActiveTrip ? Math.max(0, at.activeDuration) : 0;
          ecoWSum += ecoVal * w;
          ecoW += w;
        }
      }
      onAgg({
        loadedCount: statsRef.current.size,
        totalPoints,
        totalDistanceM,
        spanSec,
        sumMovingSec,
        sumIdleSec,
        sumDurSec,
        sumActiveSec,
        maxSpeedMs,
        ecoAvg: ecoW > 0 ? Math.max(0, Math.min(100, Math.round(ecoWSum / ecoW))) : null,
      });
    },
    [sessions, onAgg]
  );

  return (
    <div style={{ display: "none" }} aria-hidden="true">
      {sessions.map((s) => (
        <AggregatorRow key={s.id} id={s.id} live={s.status === "recording"} onLoaded={handleLoaded} />
      ))}
    </div>
  );
}

function GroupedTripBody({
  group,
  agg,
}: {
  group: SessionGroup;
  agg: GroupAgg | null;
}) {
  const sessions = group.sessions; // asc
  const first = sessions[0];
  const last = sessions[sessions.length - 1];
  const anyRecording = sessions.some((s) => s.status === "recording");
  // v2.12.0 (Q3) + Ф1: адрес финиша последней записи
  const dest = useReverseGeocode(last.endLat ?? null, last.endLon ?? null);

  if (!agg) {
    return (
      <div className="trip-body">
        <p style={{ fontSize: 12, color: "var(--muted)", margin: 0 }}>
          Загрузка детальной статистики ({sessions.length}{" "}
          {pluralRu(sessions.length, ["запись", "записи", "записей"])})…
        </p>
      </div>
    );
  }

  const startStr = new Date(first.startTime).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  });
  const endStr = last.endTime
    ? new Date(last.endTime).toLocaleString("ru-RU", {
        day: "2-digit",
        month: "long",
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;

  // v2.15.0 (sync): ср. скорость = Σ дистанций / Σ активных длительностей (§4.3 + §4.11,
  // FIX-C1) — ровно как период-агрегат Аналитики (fallback на Σ длительностей для legacy).
  // Раньше делилось на Σ времени в движении — расходилось с Аналитикой.
  const avgBaseSec = agg.sumActiveSec > 0 ? agg.sumActiveSec : agg.sumDurSec;
  const avgKmh = agg.totalDistanceM > 0 && avgBaseSec > 0 ? (agg.totalDistanceM / avgBaseSec) * 3.6 : null;
  const maxKmh = agg.maxSpeedMs != null ? agg.maxSpeedMs * 3.6 : null;
  // Паузы МЕЖДУ записями (стоянки внутри записей уже в idleTime)
  const pausesSec = Math.max(0, agg.spanSec - agg.sumDurSec);
  const computing = agg.loadedCount < sessions.length;

  return (
    <div className="trip-body">
      <div className="seg-total" style={{ marginBottom: 10 }}>
        <span>старт:</span>
        <b>{startStr}</b>
        <span>финиш:</span>
        <b>{endStr ?? (anyRecording ? "идёт запись" : "—")}</b>
      </div>
      {dest.data ? (
        <div className="seg-total" style={{ marginBottom: 10 }}>
          <span>куда:</span>
          <b
            style={{ fontWeight: 600 }}
            data-tip={`Адрес финиша поездки | Определён по координатам GPS${dest.data.cached ? " · взят из кэша" : ""}`}
          >
            → {dest.data.short}
          </b>
        </div>
      ) : null}
      <div className="stats-grid" style={{ marginTop: 0, marginBottom: 10 }}>
        <Stat
          value={computing ? "…" : `${fmtNumber(agg.totalPoints)}`}
          tip="Сколько точек GPS записано | Повторяющиеся и ошибочные точки отброшены"
          label="GPS-точек"
        />
        <Stat
          value={computing ? "…" : `${(agg.totalDistanceM / 1000).toFixed(1).replace(".", ",")} км`}
          tip="Пройденный путь | Считается только во время движения — стоянки не учитываются"
          label="Дистанция"
        />
        <Stat
          value={computing ? "…" : fmtDurMin(agg.sumDurSec / 60)}
          tip="Суммарная длительность записей | От первой до последней точки, включая остановки | Совпадает с цифрой «всего» на вкладке «Аналитика»"
          label="Длительность"
        />
        <Stat
          value={computing ? "…" : fmtDurMin(agg.sumActiveSec / 60)}
          tip="Время в поездке | От начала до конца движения, включая светофоры и пробки | Совпадает с цифрой «в поездках» на вкладке «Аналитика»"
          label="В поездке"
        />
        <Stat
          value={avgKmh != null ? `${avgKmh.toFixed(1).replace(".", ",")} км/ч` : "—"}
          tip="Средняя скорость | Путь делится на время в поездке: светофоры и пробки учтены, длительные стоянки — нет"
          label="Ср. скорость"
        />
        <Stat
          value={maxKmh != null ? `${maxKmh.toFixed(1).replace(".", ",")} км/ч` : "—"}
          tip="Максимальная скорость | Самый высокий момент скорости за поездку; ошибки GPS отфильтрованы"
          label="Макс. скорость"
        />
        <Stat
          value={computing ? "…" : fmtSecFull(agg.sumMovingSec)}
          tip="Время в движении | Всё время, когда скорость была выше 2 км/ч"
          label="В движении"
        />
        <Stat
          value={computing ? "…" : fmtSecFull(agg.sumIdleSec)}
          tip="Время стоянок | Скорость ниже 2 км/ч: светофоры, ожидание, парковка"
          label="Стоянки"
        />
        <Stat
          value={computing ? "…" : fmtSecFull(pausesSec)}
          tip="Паузы между записями | Телефон приостанавливал отправку данных — записи объединены в одну поездку, паузы внутри неё показаны здесь"
          label="Паузы между записями"
        />
        <Stat
          value={computing ? "…" : fmtDurMin(agg.spanSec / 60)}
          tip="От старта до финиша | Время от начала первой записи до конца последней, включая паузы между ними"
          label="От старта до финиша"
        />
      </div>
      {/* Ф1: раскладка поездки на записи */}
      <div className="frag-head">
        <span>записи этой поездки</span>
        <span>{pluralRu(sessions.length, ["фрагмент", "фрагмента", "фрагментов"])}</span>
      </div>
      <div className="frag-list">
        <FragmentRows sessions={sessions} />
      </div>
      <div className="t-ev">
        Записи объединены автоматически: паузы между ними короче 10 минут.
        Приложение на телефоне иногда приостанавливается (например, при
        блокировке экрана), и запись делится на части — здесь они показаны одной
        поездкой. Путь, длительность, скорость и оценка плавности считаются так
        же, как на вкладке «Аналитика», поэтому цифры совпадают.
      </div>
    </div>
  );
}

// Строки-фрагменты: время · дистанция · точки · статус. Дистанция подтягивается
// теми же stats-запросами (queryKey session-stats), точки — из списка сессий.
function FragmentRows({ sessions }: { sessions: SessionListItem[] }) {
  return (
    <>
      {sessions.map((s) => (
        <FragmentRow key={s.id} session={s} />
      ))}
    </>
  );
}

function FragmentRow({ session }: { session: SessionListItem }) {
  const stats = useSessionStats(session.id, { live: session.status === "recording" });
  const st = new Date(session.startTime);
  const en = session.endTime ? new Date(session.endTime) : null;
  const t = (d: Date) =>
    `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const distKm = stats.data ? stats.data.distance / 1000 : null;
  const pts = session.pointCountActual ?? session.pointCount;
  return (
    <div
      className="frag-row"
      data-tip={`Запись ${session.id.slice(0, 8)} | ${fmtNumber(pts)} ${pluralRu(pts, ["точка", "точки", "точек"])} GPS · ${SESSION_STATUS_RU[session.status] ?? session.status}`}
    >
      <b className="mono">
        {t(st)}–{en ? t(en) : "…"}
      </b>
      <span>{distKm != null ? `${distKm.toFixed(1).replace(".", ",")} км` : "…"}</span>
      <span>
        {fmtNumber(pts)} {pluralRu(pts, ["т.", "т.", "т."])}
      </span>
      <span
        className={`chip chip-${session.status === "recording" ? "amber chip-live" : "gray"}`}
        style={{ fontSize: 9 }}
      >
        {SESSION_STATUS_RU[session.status] ?? session.status}
      </span>
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
            data-tip={`Адрес финиша записи | Определён по координатам GPS${dest.data.cached ? " · взят из кэша" : ""}`}
          >
            → {dest.data.short}
          </b>
        </div>
      ) : null}
      <div className="stats-grid" style={{ marginTop: 0, marginBottom: 10 }}>
        <Stat
          value={`${fmtNumber(stats.pointCount)}`}
          tip="Сколько точек GPS записано | Повторяющиеся и ошибочные точки отброшены"
          label="GPS-точек"
        />
        <Stat
          // v2.12.0 (округления): 1 знак после запятой (Math.round давал «1 км»
          // и «1,3 км» на одном экране; .replace после round был мёртвым кодом)
          value={hasMovement ? `${(stats.distance / 1000).toFixed(1).replace(".", ",")} км` : "нет данных"}
          tip="Пройденный путь | Считается только во время движения | «Нет данных» — запись без движения: телефон лежал на месте"
          label="Дистанция"
        />
        <Stat
          value={fmtDurMin(stats.duration / 60)}
          tip="Длительность записи | От первой до последней точки, включая остановки | Путь и скорость считаются только по времени движения"
          label="Длительность"
        />
        <Stat
          value={avgKmh != null ? `${avgKmh.toFixed(1).replace(".", ",")} км/ч` : "—"}
          tip="Средняя скорость | Путь, поделённый на время в поездке"
          label="Ср. скорость"
        />
        <Stat
          value={maxKmh != null ? `${maxKmh.toFixed(1).replace(".", ",")} км/ч` : "—"}
          tip="Максимальная скорость | Пик за запись; ошибки GPS отфильтрованы"
          label="Макс. скорость"
        />
        <Stat
          value={moveStr}
          tip="Время в движении | Всё время со скоростью выше 2 км/ч"
          label="В движении"
        />
        <Stat
          value={idleStr}
          tip="Время стоянок | Скорость ниже 2 км/ч: светофоры, ожидание, парковка"
          label="Стоянки"
        />
        <Stat
          value={fmtSecFull(gapSec)}
          tip="Разрывы сигнала | Паузы в данных GPS длиннее 30 секунд — в это время данных не было"
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
            data-tip={`Код маршрута | Один и тот же у поездок «откуда → куда» одним маршрутом | Нужен для сравнения ваших похожих поездок между собой`}
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

// v2.23.0: карточка «Подключение телефона» для зарегистрированных пользователей.
// Показывает ЛИЧНЫЙ SensorLogger Push URL (ingestToken = User.apiKey): поездки
// с этого URL привязываются к аккаунту и видны только ему (изоляция данных).
// v2.24.0: URL по умолчанию выдаётся через push.<домен> — стабильный канал
// (единый edge-IP, без round-robin между edge и их редкими 504). Phone-клиент
// SensorLogger не ретраит сбойные отправки — надёжность канала критична.
function PersonalIngestCard({ user }: { user: TripsUserInfo }) {
  const [origin, setOrigin] = React.useState("");
  const [copied, setCopied] = React.useState(false);
  React.useEffect(() => {
    const host = window.location.hostname;
    const pushHost =
      host === "poedzok.fun" || host === "www.poedzok.fun"
        ? "push.poedzok.fun"
        : host;
    setOrigin(`${window.location.protocol}//${pushHost}`);
  }, []);
  const pushUrl =
    origin && user.ingestToken
      ? `${origin}/api/ingest/sensorlogger?token=${user.ingestToken}&deviceId=phone`
      : "";

  async function copy() {
    if (!pushUrl) return;
    try {
      await navigator.clipboard.writeText(pushUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard недоступен — URL можно выделить вручную */
    }
  }

  return (
    <div className="card" style={{ padding: "16px", marginBottom: 4 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          marginBottom: 8,
        }}
      >
        <span style={{ fontSize: 14, fontWeight: 600 }}>Подключение телефона</span>
        <span
          className="chip"
          style={{ fontSize: 10, fontWeight: 600 }}
          data-tip={`Личный канал | Поездки с этого адреса привязаны к аккаунту ${user.email} и видны только вам`}
        >
          личный канал
        </span>
      </div>
      <div style={{ fontSize: 12, lineHeight: 1.6, color: "var(--muted)", marginBottom: 8 }}>
        В приложении SensorLogger (iOS: Настройки → HTTP Push) вставьте адрес ниже —
        поездки будут появляться на этом экране. Адрес начинается с
        <code>https://</code> — iOS блокирует незащищённые <code>http://</code>-ссылки
        («App Transport Security»); канал <code>push.</code> — стабильный. В поле deviceId
        укажите имя своего устройства (например, <code>iphone-15</code>).
      </div>
      {pushUrl ? (
        <div
          style={{
            display: "flex",
            gap: 8,
            alignItems: "stretch",
            flexWrap: "wrap",
          }}
        >
          <code
            style={{
              flex: "1 1 260px",
              fontSize: 11,
              lineHeight: 1.5,
              padding: "8px 10px",
              background: "var(--panel)", border: "1px solid var(--line2)",
              borderRadius: 8,
              wordBreak: "break-all",
              userSelect: "all",
            }}
          >
            {pushUrl}
          </code>
          <button
            type="button"
            className="stale-banner-btn"
            onClick={copy}
            style={{ flex: "0 0 auto", fontSize: 12 }}
            aria-label="Скопировать адрес для SensorLogger"
          >
            {copied ? "Скопировано" : "Копировать"}
          </button>
        </div>
      ) : (
        <div style={{ fontSize: 12, color: "var(--muted)" }}>
          Адрес появится после перезагрузки страницы.
        </div>
      )}
    </div>
  );
}

// ===== v2.26.0 (ТЗ «Поездка не рвётся», §11): СЕРВЕРНЫЕ ПОЕЗДКИ =====
// Карточки рендерятся из /api/trips + /api/trips/batch: поездка назначена
// СЕРВЕРОМ (каноническое правило trip-grouping §4 ТЗ), клиентская эвристика
// groupIntoTrips выше остаётся фолбэком expand-фазы и удаляется в contract-фазе.

function TripsServerView({
  trips,
  isLoading,
  isError,
  onGoAdmin,
  openId,
  setOpenId,
}: {
  trips: import("@/lib/api-client").TripListItem[];
  isLoading: boolean;
  isError: boolean;
  onGoAdmin?: () => void;
  openId: string | null;
  setOpenId: (id: string | null) => void;
}) {
  if (isError) {
    return (
      <div className="card" style={{ padding: "20px", color: "var(--red)", fontSize: 13 }}>
        Не удалось загрузить список поездок. Попробуйте обновить страницу.
      </div>
    );
  }
  if (isLoading) return <TripsSkeleton />;
  return (
    <>
      <StaleTripsBanner trips={trips} onGoAdmin={onGoAdmin} />
      <TripSummaryServer trips={trips} />
      {trips.map((t) => (
        <TripEntryCard
          key={t.id}
          trip={t}
          isOpen={openId === t.id}
          onToggle={() => setOpenId(openId === t.id ? null : t.id)}
        />
      ))}
    </>
  );
}

// Баннер «данных нет >24 ч» — по последней поездке (аналог StaleDataBanner)
function StaleTripsBanner({
  trips,
  onGoAdmin,
}: {
  trips: import("@/lib/api-client").TripListItem[];
  onGoAdmin?: () => void;
}) {
  if (trips.length === 0) return null;
  const latest = Math.max(...trips.map((t) => new Date(t.spanEnd ?? t.spanStart).getTime()));
  const hours = (Date.now() - latest) / 3_600_000;
  if (hours < 24) return null;
  const days = Math.floor(hours / 24);
  const label =
    days >= 1 ? `${days} ${days === 1 ? "день" : days < 5 ? "дня" : "дней"}` : `${Math.floor(hours)} ч`;
  return (
    <div className="stale-banner" role="status">
      <div className="stale-banner-main">
        <b>Новых загрузок нет уже {label}</b>
        <span>
          Поездки попадают сюда только когда SensorLogger отправляет данные на
          сервер. Если вы записывали поездки, но их нет — канал загрузки нужно
          проверить.
        </span>
      </div>
      {onGoAdmin ? (
        <button type="button" className="stale-banner-btn" onClick={onGoAdmin}>
          Диагностика канала →
        </button>
      ) : null}
    </div>
  );
}

// Сводка вкладки: ПОЕЗДКИ (сервер) · записи · км · «в поездках» · EcoScore · точки.
// Статы — одним батчем (useTripsStatsBatch сеет per-trip кэш карточек).
function TripSummaryServer({ trips }: { trips: import("@/lib/api-client").TripListItem[] }) {
  const ids = React.useMemo(() => trips.map((t) => t.id), [trips]);
  const batch = useTripsStatsBatch(ids);
  const stats = batch.data?.stats ?? [];

  const totalSessions = trips.reduce((s, t) => s + (t.sessionCount ?? 0), 0);
  const totalDistKm = stats.reduce((s, x) => s + (x.distance ?? 0), 0) / 1000;
  const totalActiveMin = stats.reduce((s, x) => s + (x.activeDurationSec ?? 0), 0) / 60;
  const totalPoints = stats.reduce((s, x) => s + (x.pointCount ?? 0), 0);
  // EcoScore — взвешенное среднее по активной длительности (как период-агрегат)
  let ecoWSum = 0;
  let ecoW = 0;
  for (const x of stats) {
    const v = x.ecoScore;
    const w = x.activeDurationSec ?? 0;
    if (v != null && Number.isFinite(v) && w > 0) {
      ecoWSum += v * w;
      ecoW += w;
    }
  }
  const avgEco = ecoW > 0 ? Math.max(0, Math.min(100, Math.round(ecoWSum / ecoW))) : null;
  const computing = stats.length < trips.length;

  return (
    <div className="card tsum">
      <div className="tsum-main">
        <b
          data-tip="Что считается одной поездкой | Паузы и остановки короче 15 минут не разрывают поездку — сервер сам объединяет записи | Стоянка 15 минут и дольше — начинается новая поездка"
        >
          {fmtNumber(trips.length)} {pluralRu(trips.length, ["поездка", "поездки", "поездок"])}
          {totalSessions > trips.length ? (
            <span style={{ color: "var(--muted)", fontWeight: 500 }}>
              {" "}· {fmtNumber(totalSessions)} {pluralRu(totalSessions, ["запись", "записи", "записей"])}
            </span>
          ) : null}
        </b>
        <span>
          последняя:{" "}
          {trips[0]
            ? new Date(trips[0].spanStart).toLocaleDateString("ru-RU", {
                day: "2-digit",
                month: "short",
              })
            : "—"}
          {computing ? " · считаем сводку…" : ""}
        </span>
      </div>
      <div className="tsum-stats">
        <div>
          <b>{totalDistKm > 0 ? totalDistKm.toFixed(1).replace(".", ",") : "—"}</b>
          <span>км всего</span>
        </div>
        <div>
          <b>{totalActiveMin > 0 ? fmtDurMin(totalActiveMin) : "—"}</b>
          <span>в поездках</span>
        </div>
        <div>
          <b>{avgEco ?? "—"}</b>
          <span>средняя плавность</span>
        </div>
        <div>
          <b>{fmtNumber(totalPoints)}</b>
          <span>GPS-точек</span>
        </div>
      </div>
    </div>
  );
}

// Карточка ОДНОЙ поездки (серверной): адреса старта/финиша, N записей, план.
function TripEntryCard({
  trip,
  isOpen,
  onToggle,
}: {
  trip: import("@/lib/api-client").TripListItem;
  isOpen: boolean;
  onToggle: () => void;
}) {
  const stats = useTripStats(trip.id, { live: trip.status === "recording" });
  const st = stats.data ?? null;
  const dest = useReverseGeocode(trip.endLat ?? null, trip.endLon ?? null);
  const destShort = dest.data?.short ?? null;

  const start = new Date(trip.spanStart);
  const dd = String(start.getDate()).padStart(2, "0");
  const months = ["ЯНВ", "ФЕВ", "МАР", "АПР", "МАЙ", "ИЮН", "ИЮЛ", "АВГ", "СЕН", "ОКТ", "НОЯ", "ДЕК"];
  const mo = months[start.getMonth()];
  const hh = String(start.getHours()).padStart(2, "0");
  const mm = String(start.getMinutes()).padStart(2, "0");

  const distKm = st ? st.distance / 1000 : null;
  const durMin = st ? st.duration / 60 : null;
  const points = st?.pointCount ?? trip.pointCountActual ?? 0;
  const noMovement = st != null && distKm != null && distKm <= 0;
  const sub =
    st == null
      ? `${trip.sessionCount} ${pluralRu(trip.sessionCount, ["запись", "записи", "записей"])} · считаем…`
      : noMovement
        ? `${fmtNumber(points)} ${pluralRu(points, ["точка", "точки", "точек"])} · нет данных о движении`
        : `${(distKm ?? 0).toFixed(1).replace(".", ",")} км · ${fmtDurMin((st.activeDurationSec ?? 0) / 60)} · ${fmtNumber(points)} ${pluralRu(points, ["точка", "точки", "точек"])}`;

  const title =
    destShort != null ? (
      <span title={dest.data?.address ?? undefined}>
        <span aria-hidden="true" style={{ color: "var(--plum)", fontWeight: 800 }}>→ </span>
        {destShort}
      </span>
    ) : dest.isLoading ? (
      <span style={{ color: "var(--muted)", fontWeight: 600 }}>→ адрес финиша…</span>
    ) : (
      <span>{trip.deviceId}</span>
    );

  const eco = st?.ecoScore ?? null;

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
            {trip.sessionCount > 1 ? (
              <span
                className="chip chip-plum"
                style={{ marginLeft: 6, fontSize: 10 }}
                data-tip={`Одна поездка из ${trip.sessionCount} ${pluralRu(trip.sessionCount, ["записи", "записей", "записей"])} | Паузы между ними короче 15 минут — записи объединены в одну поездку`}
              >
                {trip.sessionCount} {pluralRu(trip.sessionCount, ["запись", "записи", "записей"])}
              </span>
            ) : null}
            {trip.status === "recording" ? (
              <span
                className="chip chip-amber chip-live"
                style={{ marginLeft: 4, fontSize: 10 }}
                data-tip="Идёт запись | Показатели поездки обновляются каждые 15 секунд"
              >
                идёт запись
              </span>
            ) : null}
          </div>
          <div className="t-sub">{sub}</div>
        </div>
        <div className={`t-eco ${eco != null ? ecoCls(eco) : ""}`} data-tip={ECO_SCORE_TIP}>
          <b>{eco ?? "—"}</b>
          <small>{eco != null ? `${ecoLab(eco)} · из 100` : "—"}</small>
        </div>
        <i className="chev">›</i>
      </div>
      {isOpen ? <TripEntryBody trip={trip} st={st} /> : null}
    </div>
  );
}

function TripEntryBody({
  trip,
  st,
}: {
  trip: import("@/lib/api-client").TripListItem;
  st: import("@/lib/api-client").TripStats | null;
}) {
  // «откуда → куда»: адреса первой/последней активной точки поездки (ТЗ §11 —
  // адрес старта теперь показывается, раньше — только финиш)
  const from = useReverseGeocode(trip.startLat ?? null, trip.startLon ?? null);
  const to = useReverseGeocode(trip.endLat ?? null, trip.endLon ?? null);

  const startStr = new Date(trip.spanStart).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
  });
  const endStr = trip.spanEnd
    ? new Date(trip.spanEnd).toLocaleString("ru-RU", {
        day: "2-digit",
        month: "long",
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;

  if (!st) {
    return (
      <div className="trip-body">
        <p style={{ fontSize: 12, color: "var(--muted)", margin: 0 }}>
          Загрузка детальной статистики ({trip.sessionCount}{" "}
          {pluralRu(trip.sessionCount, ["запись", "записи", "записей"])})…
        </p>
      </div>
    );
  }

  const avgKmh = st.avgSpeed != null ? st.avgSpeed * 3.6 : null;
  const maxKmh = st.maxSpeed != null ? st.maxSpeed * 3.6 : null;
  const spanSec = st.duration;
  const pausesSec = st.interFragmentGapSec ?? 0;
  const r = st.route;

  return (
    <div className="trip-body">
      <div className="seg-total" style={{ marginBottom: 10 }}>
        <span>старт:</span>
        <b>{startStr}</b>
        <span>финиш:</span>
        <b>{endStr ?? (trip.status === "recording" ? "идёт запись" : "—")}</b>
      </div>
      <div className="seg-total" style={{ marginBottom: 10 }}>
        <span>откуда:</span>
        <b style={{ fontWeight: 600 }} title={from.data?.address ?? undefined}>
          {from.data ? `← ${from.data.short}` : from.isLoading ? "адрес старта…" : "—"}
        </b>
      </div>
      {to.data ? (
        <div className="seg-total" style={{ marginBottom: 10 }}>
          <span>куда:</span>
          <b
            style={{ fontWeight: 600 }}
            data-tip={`Адрес финиша поездки | Определён по координатам GPS${to.data.cached ? " · взят из кэша" : ""}`}
          >
            → {to.data.short}
          </b>
        </div>
      ) : null}
      <div className="stats-grid" style={{ marginTop: 0, marginBottom: 10 }}>
        <Stat
          value={`${fmtNumber(st.pointCount)}`}
          tip="Сколько точек GPS записано | Повторяющиеся и ошибочные точки отброшены"
          label="GPS-точек"
        />
        <Stat
          value={`${(st.distance / 1000).toFixed(1).replace(".", ",")} км`}
          tip="Пройденный путь | Считается только во время движения — стоянки и парковка не учитываются"
          label="Дистанция"
        />
        <Stat
          value={fmtDurMin(spanSec / 60)}
          tip="От старта до финиша | Включая паузы между записями и остановки короче 15 минут"
          label="Длительность"
        />
        <Stat
          value={fmtDurMin(st.activeDurationSec / 60)}
          tip="Время в поездке | Движение, светофоры и пробки — без длительных стоянок"
          label="В поездке"
        />
        <Stat
          value={avgKmh != null ? `${avgKmh.toFixed(1).replace(".", ",")} км/ч` : "—"}
          tip="Средняя скорость | Путь делится на время в поездке: светофоры и пробки учтены, стоянки — нет"
          label="Ср. скорость"
        />
        <Stat
          value={maxKmh != null ? `${maxKmh.toFixed(1).replace(".", ",")} км/ч` : "—"}
          tip="Максимальная скорость | Пик за всю поездку; ошибки GPS отфильтрованы"
          label="Макс. скорость"
        />
        <Stat
          value={fmtSecFull(st.movingTime)}
          tip="Время в движении | Всё время, когда скорость была выше 2 км/ч"
          label="В движении"
        />
        <Stat
          value={fmtSecFull(st.idleTime)}
          tip="Время стоянок | Скорость ниже 2 км/ч: светофоры, ожидание, парковка"
          label="Стоянки"
        />
        <Stat
          value={fmtSecFull(pausesSec)}
          tip="Паузы между записями | Телефон приостанавливал отправку данных — записи объединены в одну поездку"
          label="Паузы между записями"
        />
        <Stat
          value={fmtSecFull(st.gapTime)}
          tip="Разрывы сигнала | Паузы в данных GPS длиннее 30 секунд"
          label="Разрывы"
        />
      </div>
      {/* План-факт поездки (§9 ТЗ): ОДИН маршрут на всю поездку */}
      {r && (r.planDurationSec != null || r.planDistanceM != null) ? (
        <div className="seg-total" style={{ marginBottom: 10 }}>
          <span>план:</span>
          <b
            style={{ fontWeight: 600 }}
            data-tip={`План поездки | Маршрут по дорогам для всей поездки целиком${r.planCoverage != null ? ` · покрытие ${(r.planCoverage * 100).toFixed(0)}%` : ""}${r.planComparable === false ? " · слишком мало данных GPS — честное сравнение с фактом невозможно" : ""}`}
          >
            {r.planDurationSec != null ? `${fmtDurMin(r.planDurationSec / 60)}` : "—"}
            {r.planDurationSec != null && st.activeDurationSec > 0 && r.planComparable !== false
              ? ` / факт ${fmtDurMin(st.activeDurationSec / 60)} · ${
                  st.activeDurationSec - r.planDurationSec >= 0 ? "+" : ""
                }${fmtDurMin(Math.abs(st.activeDurationSec - r.planDurationSec) / 60)}`
              : ""}
            {r.planComparable === false ? " · план не сопоставим" : ""}
          </b>
        </div>
      ) : null}
      {trip.sessionCount > 1 || (st.fragments ?? []).length > 1 ? (
        <>
          <div className="frag-head">
            <span>записи этой поездки</span>
            <span>{pluralRu((st.fragments ?? trip.sessionIds).length, ["фрагмент", "фрагмента", "фрагментов"])}</span>
          </div>
          <div className="frag-list">
            {(st.fragments ?? []).map((f) => (
              <TripFragmentRow key={f.id} sessionId={f.id} startTime={f.startTime} endTime={f.endTime} pointCount={f.pointCount} status={f.status} />
            ))}
          </div>
        </>
      ) : null}
      <div className="t-ev">
        Поездка собрана автоматически: записи одного устройства с паузами
        короче 15 минут объединены в одну. Путь, скорость и оценка плавности
        считаются по всей поездке целиком — цифры совпадают с вкладкой
        «Аналитика».
      </div>
    </div>
  );
}

// Строка-фрагмент поездки: время · дистанция (из кэша session-stats) · статус
function TripFragmentRow({
  sessionId,
  startTime,
  endTime,
  pointCount,
  status,
}: {
  sessionId: string;
  startTime: string;
  endTime: string | null;
  pointCount: number;
  status: string;
}) {
  const stats = useSessionStats(sessionId, { live: status === "recording" });
  const st = new Date(startTime);
  const en = endTime ? new Date(endTime) : null;
  const t = (d: Date) =>
    `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const distKm = stats.data ? stats.data.distance / 1000 : null;
  return (
    <div
      className="frag-row"
      data-tip={`Запись ${sessionId.slice(0, 8)} | ${fmtNumber(pointCount)} ${pluralRu(pointCount, ["точка", "точки", "точек"])} GPS · ${SESSION_STATUS_RU[status] ?? status}`}
    >
      <b className="mono">
        {t(st)}–{en ? t(en) : "…"}
      </b>
      <span>{distKm != null ? `${distKm.toFixed(1).replace(".", ",")} км` : "…"}</span>
      <span>
        {fmtNumber(pointCount)} {pluralRu(pointCount, ["т.", "т.", "т."])}
      </span>
      <span className={`chip chip-${status === "recording" ? "amber chip-live" : "gray"}`} style={{ fontSize: 9 }}>
        {SESSION_STATUS_RU[status] ?? status}
      </span>
    </div>
  );
}
