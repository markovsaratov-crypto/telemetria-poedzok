// src/components/v4/telematika-layout.tsx — каркас v4: единственный горизонтальный
// top-bar (бренд + 3 bookmark-вкладки + активная-вкладка слово + utility иконки
// + тема + выход). На мобильных — bottom-nav вместо вкладок в шапке (v2.22.0:
// bookmark-вкладки в topbar скрыты на <768px, «Команды»/«Справка» — v4-desktop-only),
// остаются только Обновить/Поиск/Тема/Выйти. Период-селектор + фильтр поездки
// согласованы: клик по period-pill сбрасывает selectedSessionId, клик по
// trip-pill открывает dropdown.

"use client";

import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  LogOut,
  Search,
  Command,
  HelpCircle,
  Sun,
  Moon,
  ChevronDown,
  RefreshCw,
  BarChart3,
  Car,
  Settings as SettingsIcon,
} from "lucide-react";
import { useV4Tipbox, bindTips } from "./use-v4-tipbox";
import { type PeriodKey } from "@/lib/v4-utils";
import { useSessionsStatsBatch, useReverseGeocode, type SessionsQuery } from "@/lib/hooks";
import { useTrips } from "@/lib/trip-hooks";
import { fmtMonthShort } from "@/lib/format";
import type { SessionListItem, TripListItem } from "@/lib/api-client";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import { useQueryClient } from "@tanstack/react-query";

export type V4Tab = "analytics" | "trips" | "admin";
export type Period = PeriodKey;

// v2.38.2 · F83 (кодревью): единые параметры списка записей для queryKey
// ["sessions", params]. Лейаут (dropdown фильтра) и analytics-view (метаданные
// записи) ОБЯЗАНЫ использовать один объект параметров: {limit:50} vs
// {limit:50,minPoints:10} давали разные ключи → два параллельных
// GET /api/sessions и два независимых 30с-поллинга (app-root использует
// те же параметры — его вызов также попадает в общий кэш-ключ).
export const SESSIONS_LIST_QUERY: SessionsQuery = { limit: 50, minPoints: 10 };

// v2.43.0 (CR-L, порт чанк-патча telemat-fix-a1 R1/R2 в исходник): пункт
// dropdown «Аналитики» = ПОЕЗДКА из /api/trips (псевдо-запись с id "t:<tripId>").
// Дропдаун синхронен вкладке «Поездки» (один источник /api/trips, один queryKey);
// транспортные фрагменты-записи остаются ВНУТРИ поездок и больше не засоряют
// селектор (было: 240 сессий-осколков против 39 поездок, обрезка по limit:50
// прятала старые поездки). sessionIds — для агрегата «Аналитики» (R3/R4 в
// v4-hooks/analytics-view) и прогрева статов (R2).
interface TripFilterItem {
  id: string; // "t:<tripId>"
  deviceId: string;
  deviceName?: string | null;
  startTime: string; // trip.spanStart
  endTime?: string | null;
  endLat?: number | null;
  endLon?: number | null;
  pointCount?: number | null;
  sessionCount: number;
  sessionIds: string[];
}

interface LayoutProps {
  tab: V4Tab;
  onTabChange: (t: V4Tab) => void;
  period: Period;
  onPeriodChange: (p: Period) => void;
  selectedSessionId: string | null;
  onSelectedSessionChange: (id: string | null) => void;
  onCmdOpen: () => void;
  onSearchOpen: () => void;
  onHelpOpen: () => void;
  /** v2.23.0: показывать вкладку «Админ» (owner/admin; для role=user скрыта) */
  showAdmin?: boolean;
  children: React.ReactNode;
}

const TABS: { id: V4Tab; label: string; icon: React.ReactNode }[] = [
  { id: "analytics", label: "Аналитика", icon: <BarChart3 className="h-3.5 w-3.5" /> },
  { id: "trips", label: "Поездки", icon: <Car className="h-3.5 w-3.5" /> },
  { id: "admin", label: "Админ", icon: <SettingsIcon className="h-3.5 w-3.5" /> },
];

// v2.12.0: «Месяц» удалён по требованию владельца — 4 периода достаточно
// (30 дней — скользящее окно; календарный месяц дублировал его с путаницей).
const PERIOD_LIST: { id: Period; label: string }[] = [
  { id: "today", label: "Сегодня" },
  { id: "week", label: "7 дней" },
  { id: "d30", label: "30 дней" },
  { id: "all", label: "Всё время" },
];

// Форматирование даты/времени из ISO timestamp строки (из API sessions).
// v2.38.2 · F82: массив капс-месяцев — общий MONTHS_RU из lib/format.ts
// (была 4-я локальная копия «ЯНВ…ДЕК»).
function fmtSessionLabel(startTime: string | number | Date): string {
  try {
    const d = new Date(startTime);
    const dd = String(d.getDate()).padStart(2, "0");
    const mo = fmtMonthShort(d.getMonth());
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${dd} ${mo} ${hh}:${mm}`;
  } catch {
    return String(startTime);
  }
}

function relativeLabel(startTime: string | number | Date): string {
  try {
    const now = Date.now();
    const t = new Date(startTime).getTime();
    const diff = (now - t) / 1000;
    if (diff < 60) return "только что";
    if (diff < 3600) return `${Math.floor(diff / 60)} мин назад`;
    if (diff < 86400) return `${Math.floor(diff / 3600)} ч назад`;
    if (diff < 86400 * 2) return "вчера";
    return `${Math.floor(diff / 86400)} д назад`;
  } catch {
    return "";
  }
}

// v2.12.0 (V-1): платформенно-зависимые подписи горячих клавиш — глифы ⌘/⇧
// понятны только пользователям Mac; на Windows/Linux показываем Ctrl-форму.
function useIsMac(): boolean {
  const [isMac, setIsMac] = React.useState(false);
  React.useEffect(() => {
    setIsMac(/Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent));
  }, []);
  return isMac;
}

// v2.12.0 (Q3): подпись поездки в фильтре — адрес конечной точки
// (идентификация по месту назначения), fallback — имя устройства.
// v2.43.0 (CR-L): структурный тип — подходит и для записей, и для псевдо-записей
// поездок (TripFilterItem) без приведения типов.
function TripFilterLabel({
  session,
  bold = false,
}: {
  session: Pick<SessionListItem, "endLat" | "endLon" | "deviceName" | "deviceId">;
  bold?: boolean;
}) {
  const dest = useReverseGeocode(session.endLat ?? null, session.endLon ?? null);
  const destShort = dest.data?.short ?? null;
  if (destShort != null) {
    return (
      <span
        className={bold ? "" : undefined}
        style={{ fontWeight: bold ? 700 : 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 170 }}
        title={dest.data?.address ?? undefined}
      >
        <span aria-hidden="true" style={{ color: "var(--plum)", fontWeight: 800 }}>→ </span>
        {destShort}
      </span>
    );
  }
  if (dest.isLoading) {
    return (
      <span style={{ color: "var(--muted)", fontWeight: 500, fontSize: 11 }}>
        → адрес финиша…
      </span>
    );
  }
  return <b>{session.deviceName || session.deviceId}</b>;
}

export function TelematikaLayout(props: LayoutProps) {
  const {
    tab,
    onTabChange,
    period,
    onPeriodChange,
    selectedSessionId,
    onSelectedSessionChange,
    onCmdOpen,
    onSearchOpen,
    onHelpOpen,
    showAdmin = true,
    children,
  } = props;
  useV4Tipbox();

  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = React.useState(false);
  const queryClient = useQueryClient();
  const [tripFilterOpen, setTripFilterOpen] = React.useState(false);
  const [tripFilterQuery, setTripFilterQuery] = React.useState("");
  const tripFilterRef = React.useRef<HTMLDivElement>(null);
  const layoutRef = React.useRef<HTMLDivElement>(null);
  const isMac = useIsMac();
  // v2.12.0 (V-1): подписи под иконками — «⌘K» на Mac, «Ctrl K» на Windows/Linux.
  // v2.26.2: «Ctrl⇧F» → «Ctrl+Shift+F» — глиф ⇧ отсутствует в Consolas
  // (Windows 10) и рендерился битой подписью «СтрF» на кнопке поиска.
  const kbdCmd = isMac ? "⌘K" : "Ctrl K";
  const kbdSearch = isMac ? "⌘⇧F" : "Ctrl+Shift+F";

  // v2.43.0 (CR-L, R1): список пунктов dropdown — ПОЕЗДКИ (/api/trips, тот же
  // queryKey, что вкладка «Поездки»: один запрос/кэш/смарт-опрос 60с). Псевдо-
  // запись наследует поля адресной идентификации (endLat/endLon → reverse
  // geocode), span поездки и sessionIds для агрегата «Аналитики».
  const trips = useTrips({ limit: 50 });
  const tripsList: TripFilterItem[] = React.useMemo(
    () =>
      (trips.data?.trips ?? [])
        .filter((t): t is TripListItem => !!t && typeof t.id === "string")
        .map((t) => ({
          id: `t:${t.id}`,
          deviceId: t.deviceId,
          deviceName: null,
          startTime: t.spanStart,
          endTime: t.spanEnd,
          endLat: t.endLat,
          endLon: t.endLon,
          pointCount: t.pointCountActual,
          sessionCount: Number(t.sessionCount) || 0,
          sessionIds: Array.isArray(t.sessionIds) ? t.sessionIds : [],
        })),
    [trips.data]
  );

  // v2.43.0 (CR-L, R2): прогрев статов — по ПЕРВОЙ записи каждой поездки
  // (реальный session UUID из sessionIds). Тот же ключ ["stats-batch", ids],
  // что агрегат «Аналитики»: выбор поездки в dropdown → статы уже в кэше,
  // агрегат стартует без холодного шторма поштучных запросов.
  useSessionsStatsBatch(
    tripsList
      .map((p) => p.sessionIds[0] ?? "")
      .filter((v) => v.length > 0)
  );

  React.useEffect(() => setMounted(true), []);

  React.useEffect(() => {
    if (tripFilterOpen) {
      const onDoc = (e: MouseEvent) => {
        if (tripFilterRef.current && !tripFilterRef.current.contains(e.target as Node)) {
          setTripFilterOpen(false);
        }
      };
      document.addEventListener("mousedown", onDoc);
      return () => document.removeEventListener("mousedown", onDoc);
    }
  }, [tripFilterOpen]);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        onCmdOpen();
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === "F") {
        e.preventDefault();
        onSearchOpen();
      }
      if (e.shiftKey && e.key === "?" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const target = e.target as HTMLElement;
        if (target.tagName !== "INPUT" && target.tagName !== "TEXTAREA" && !target.isContentEditable) {
          e.preventDefault();
          onHelpOpen();
        }
      }
      if (e.altKey && /^[1-3]$/.test(e.key)) {
        e.preventDefault();
        const t = TABS[Number(e.key) - 1];
        if (t) onTabChange(t.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCmdOpen, onSearchOpen, onHelpOpen, onTabChange]);

  // v2.38.2 · F88 (кодревью): bindTips вызывался после КАЖДОГО рендера —
  // querySelectorAll по всему поддереву (десятки карточек × data-tip) на каждый
  // keystroke фильтра/поиска. Теперь: один скан при монтировании + MutationObserver
  // (добавление узлов / появление data-tip) — поведение идентично: новые
  // [data-tip]-элементы биндятся в тот же момент, что и раньше; bindTips
  // идемпотентен (__v4TipBound). Атрибуты, которые пишет сам bindTips
  // (tabindex/role), не входят в attributeFilter — циклов нет.
  React.useEffect(() => {
    const root = layoutRef.current;
    if (!root) return;
    bindTips(root);
    const mo = new MutationObserver((muts) => {
      if (muts.some((m) => m.addedNodes.length > 0)) bindTips(root);
    });
    mo.observe(root, { childList: true, subtree: true, attributeFilter: ["data-tip"] });
    return () => mo.disconnect();
  }, []);

  async function handleLogout() {
    try {
      await api.post("/api/auth/logout", undefined, { expect: "none" });
      toast.success("Вы вышли из системы");
      setTimeout(() => window.location.reload(), 300);
    } catch (e) {
      toast.error("Ошибка выхода", { description: (e as Error).message });
    }
  }

  // v2.11.0 (U-14): тост об успехе — только ПОСЛЕ завершения invalidate/refetch
  // (раньше «Данные обновлены» выскакивал до того, как данные реально пришли;
  // при ошибке запроса тост ошибки уже показывает api-client).
  async function handleRefresh() {
    try {
      await queryClient.invalidateQueries();
      toast.success("Данные обновлены");
    } catch {
      /* ошибки отдельных запросов уже показаны тостами из api-client */
    }
  }

  const selectedSession = React.useMemo(
    () => tripsList.find((s) => s.id === selectedSessionId) ?? null,
    [tripsList, selectedSessionId]
  );

  const filteredSessions = React.useMemo(() => {
    if (!tripFilterQuery) return tripsList;
    const q = tripFilterQuery.toLowerCase();
    return tripsList.filter((s) => {
      const label = fmtSessionLabel(s.startTime);
      const dev = (s.deviceName || s.deviceId || "").toLowerCase();
      const rel = relativeLabel(s.startTime).toLowerCase();
      return label.toLowerCase().includes(q) || dev.includes(q) || rel.includes(q);
    });
  }, [tripsList, tripFilterQuery]);

  // Active-tab title indicator — word next to tabs.
  const activeTabLabel = TABS.find((t) => t.id === tab)?.label ?? "";

  // v2.11.0 (U-22): sr-only заголовок текущего раздела + семантический <main> —
  // v2.23.0: «Админ» — только владельцу/админу (role=user видел вкладку,
  // которая целиком билась об 403 админ-роутов)
  const visibleTabs = TABS.filter((t) => showAdmin || t.id !== "admin");

  // у страницы единственный h1 (бренд в шапке), навигация по разделам скринридером.
  const tabAriaTitle =
    tab === "admin" ? "Администрирование" : tab === "trips" ? "Поездки" : "Аналитика";

  return (
    <div className="v4-app" ref={layoutRef}>
      <div className="v4-wrap">
        {/* === Single horizontal top bar ===
            Brand · 3 bookmark tabs · active-tab word · utility buttons · theme · logout */}
        <header className="topbar">
          {/* v2.28.0: бренд — «Телемат» + логотип владельца (прозрачная
              подложка сохранена в обеих темах: на тёмной оси-«молнии»
              растворяются, градиентная кривая остаётся видимой) */}
          <div className="brand">
            <img
              src="/logo.png"
              alt="Логотип Телемат"
              width={512}
              height={512}
              className="brand-logo"
              draggable={false}
            />
            <h1>Телемат</h1>
          </div>

          <nav className="v4-bookmarks" aria-label="Вкладки">
            {visibleTabs.map((t) => (
              <button
                key={t.id}
                className={`v4-bookmark ${tab === t.id ? "active" : ""}`}
                onClick={() => onTabChange(t.id)}
                title={t.label}
                aria-current={tab === t.id ? "page" : undefined}
              >
                <span className="v4-bookmark-icon">{t.icon}</span>
                <span className="v4-bookmark-label">{t.label}</span>
              </button>
            ))}
          </nav>

          <div className="v4-topbar-active-label" aria-hidden="true">
            {activeTabLabel}
          </div>

          <div className="topbar-actions">
            <button
              className="iconbtn"
              onClick={handleRefresh}
              title="Обновить данные"
              aria-label="Обновить"
            >
              <RefreshCw className="h-4 w-4" />
            </button>
            <button
              className="iconbtn"
              onClick={() => onSearchOpen()}
              title={`Глобальный поиск (${kbdSearch})`}
              aria-label="Поиск"
            >
              <Search className="h-4 w-4" />
              <span className="kbd-mini">{kbdSearch}</span>
            </button>
            {/* v2.22.0 (M-1): «Команды» (⌘K) и «Справка» (?) — desktop-фичи
                (шорткаты/горячие клавиши), на мобильных спрятаны по требованию
                владельца (класс v4-desktop-only, CSS max-width 767px).
                Диалоги остаются доступны с физической клавиатуры (Ctrl+K, «?»). */}
            <button
              className="iconbtn v4-desktop-only"
              onClick={() => onCmdOpen()}
              title={`Команды (${kbdCmd})`}
              aria-label="Команды"
            >
              <Command className="h-4 w-4" />
              <span className="kbd-mini">{kbdCmd}</span>
            </button>
            <button
              className="iconbtn v4-desktop-only"
              onClick={() => onHelpOpen()}
              title="Горячие клавиши (?)"
              aria-label="Справка"
            >
              <HelpCircle className="h-4 w-4" />
            </button>
            {mounted ? (
              <button
                className="iconbtn"
                onClick={() => setTheme(resolvedTheme === "dark" ? "light" : "dark")}
                title="Переключить тему"
                aria-label="Тема"
              >
                {resolvedTheme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
              </button>
            ) : null}
            <button
              className="textbtn"
              onClick={handleLogout}
              title="Выйти"
              aria-label="Выйти"
            >
              <LogOut className="h-3.5 w-3.5" />
              <span className="v4-textbtn-label">Выйти</span>
            </button>
          </div>
        </header>

        {/* === Period-selector + trip-filter (only for Аналитика) === */}
        {tab === "analytics" && (
          <div className="pills-row">
            <div className="pills" role="group" aria-label="Выбор периода">
              {PERIOD_LIST.map((p) => (
                <button
                  key={p.id}
                  className={`pill ${period === p.id ? "active" : ""}`}
                  onClick={() => {
                    onPeriodChange(p.id);
                    // v2.10.2: клик по периоду → период-режим (все поездки периода).
                    onSelectedSessionChange(null);
                  }}
                  title={`Период: ${p.label} — метрики по всем записям за период`}
                >
                  {p.label}
                </button>
              ))}
            </div>

            <div className="pills-divider" aria-hidden="true">
              |
            </div>

            <div className="trip-filter" ref={tripFilterRef}>
              <button
                className={`trip-filter-btn ${selectedSessionId ? "active" : ""}`}
                onClick={() => {
                  setTripFilterOpen((v) => !v);
                  setTripFilterQuery("");
                }}
                title="Выбрать конкретную поездку"
              >
                {selectedSession ? (
                  <>
                    <TripFilterLabel session={selectedSession} />
                    <span className="mono" style={{ fontSize: 10, color: "var(--muted)" }}>
                      {fmtSessionLabel(selectedSession.startTime)}
                    </span>
                  </>
                ) : trips.isLoading ? (
                  <span>Загрузка…</span>
                ) : tripsList.length === 0 ? (
                  <span>Нет поездок</span>
                ) : (
                  /* v2.43.0 (CR-L, R5): dropdown листает ПОЕЗДКИ — терминология
                      единственная на обеих вкладках («запись» = транспортный
                      фрагмент внутри поездки, в селекторе не встречается) */
                  <span>Все поездки · период</span>
                )}
                <ChevronDown className="chev h-3 w-3" />
              </button>
              {tripFilterOpen && (
                <div className="trip-filter-popover">
                  <input
                    className="trip-filter-search"
                    type="text"
                    placeholder="Поиск по дате, устройству…"
                    value={tripFilterQuery}
                    onChange={(e) => setTripFilterQuery(e.target.value)}
                    autoFocus
                  />
                  <div className="trip-filter-list">
                    {/* v2.10.2: сброс к период-режиму — метрики по всем поездкам периода */}
                    <button
                      className={`trip-filter-item period-reset ${!selectedSessionId ? "selected" : ""}`}
                      onClick={() => {
                        onSelectedSessionChange(null);
                        setTripFilterOpen(false);
                      }}
                    >
                      <span>
                        <b>Все поездки периода</b>
                        <br />
                        <span className="mono">агрегат за выбранный период</span>
                      </span>
                      <span className="mono">период</span>
                    </button>
                    {filteredSessions.length === 0 ? (
                      <div className="trip-filter-empty">
                        {tripsList.length === 0 ? "Список поездок пуст" : "Ничего не найдено"}
                      </div>
                    ) : (
                      filteredSessions.map((s) => (
                        <button
                          key={s.id}
                          className={`trip-filter-item ${selectedSessionId === s.id ? "selected" : ""}`}
                          onClick={() => {
                            onSelectedSessionChange(s.id);
                            setTripFilterOpen(false);
                          }}
                        >
                          <span>
                            {/* v2.12.0 (Q3): идентификация поездки по адресу
                                конечной точки — требование владельца */}
                            <TripFilterLabel session={s} bold />
                            <br />
                            <span className="mono">{fmtSessionLabel(s.startTime)}</span>
                          </span>
                          {/* v2.43.0 (CR-L, R7): бейдж «×N записей» у мультифрагментных
                              поездок — видно, что в поездке несколько кусков записи;
                              одиночные — как раньше, относительное время */}
                          <span className="mono">
                            {s.sessionCount > 1
                              ? `×${s.sessionCount} ${
                                  [2, 3, 4].includes(s.sessionCount % 10) &&
                                  ![12, 13, 14].includes(s.sessionCount % 100)
                                    ? "записи"
                                    : "записей"
                                }`
                              : relativeLabel(s.startTime)}
                          </span>
                        </button>
                      ))
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* === Content === */}
        {/* v2.11.0 (U-22): контент обёрнут в <main id="content"> + sr-only h2
            с названием раздела (единый h1 остаётся в шапке) */}
        <main id="content">
          <h2 className="sr-only">{tabAriaTitle}</h2>
          <AnimatePresence mode="wait">
            <motion.div
              key={tab + (selectedSessionId ?? "") + period}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.18 }}
            >
              {children}
            </motion.div>
          </AnimatePresence>
        </main>
      </div>

      {/* === Bottom navigation (mobile only, sticky) === */}
      <nav className="v4-bottom-nav" aria-label="Мобильная навигация">
        {visibleTabs.map((t) => (
          <button
            key={t.id}
            className={`v4-bottom-nav-item ${tab === t.id ? "active" : ""}`}
            onClick={() => onTabChange(t.id)}
            aria-current={tab === t.id ? "page" : undefined}
          >
            <span className="v4-bottom-nav-icon">{t.icon}</span>
            <span className="v4-bottom-nav-label">{t.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
