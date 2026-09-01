// src/components/v4/telematika-layout.tsx — каркас v4: единственный горизонтальный
// top-bar (бренд + 3 bookmark-вкладки + активная-вкладка слово + utility иконки
// + тема + выход). На мобильных — те же 3 bookmark-вкладки + bottom-nav вместо
// hamburger/Sheet drawer. Период-селектор + фильтр поездки согласованы: клик по
// period-pill сбрасывает selectedSessionId, клик по trip-pill открывает dropdown.

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
import { useSessions } from "@/lib/hooks";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import { api } from "@/lib/api-client";
import { useQueryClient } from "@tanstack/react-query";

export type V4Tab = "analytics" | "trips" | "admin";
export type Period = PeriodKey;

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
  children: React.ReactNode;
}

const TABS: { id: V4Tab; label: string; icon: React.ReactNode }[] = [
  { id: "analytics", label: "Аналитика", icon: <BarChart3 className="h-3.5 w-3.5" /> },
  { id: "trips", label: "Поездки", icon: <Car className="h-3.5 w-3.5" /> },
  { id: "admin", label: "Админ", icon: <SettingsIcon className="h-3.5 w-3.5" /> },
];

const PERIOD_LIST: { id: Period; label: string }[] = [
  { id: "today", label: "Сегодня" },
  { id: "week", label: "7 дней" },
  { id: "d30", label: "30 дней" },
  { id: "month", label: "Месяц" },
  { id: "all", label: "Всё время" },
];

// Форматирование даты/времени из ISO timestamp строки (из API sessions).
function fmtSessionLabel(startTime: string | number | Date): string {
  try {
    const d = new Date(startTime);
    const dd = String(d.getDate()).padStart(2, "0");
    const months = ["ЯНВ", "ФЕВ", "МАР", "АПР", "МАЙ", "ИЮН", "ИЮЛ", "АВГ", "СЕН", "ОКТ", "НОЯ", "ДЕК"];
    const mo = months[d.getMonth()];
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

  // Live sessions list for trip-filter dropdown.
  const sessions = useSessions({ limit: 50 });
  const sessionsList = sessions.data?.sessions ?? [];

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

  // Re-bind tips after every render (for newly-mounted [data-tip] elements).
  React.useEffect(() => {
    if (layoutRef.current) bindTips(layoutRef.current);
  });

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
    () => sessionsList.find((s) => s.id === selectedSessionId) ?? null,
    [sessionsList, selectedSessionId]
  );

  const filteredSessions = React.useMemo(() => {
    if (!tripFilterQuery) return sessionsList;
    const q = tripFilterQuery.toLowerCase();
    return sessionsList.filter((s) => {
      const label = fmtSessionLabel(s.startTime);
      const dev = (s.deviceName || s.deviceId || "").toLowerCase();
      const rel = relativeLabel(s.startTime).toLowerCase();
      return label.toLowerCase().includes(q) || dev.includes(q) || rel.includes(q);
    });
  }, [sessionsList, tripFilterQuery]);

  // Active-tab title indicator — word next to tabs.
  const activeTabLabel = TABS.find((t) => t.id === tab)?.label ?? "";

  // v2.11.0 (U-22): sr-only заголовок текущего раздела + семантический <main> —
  // у страницы единственный h1 (бренд в шапке), навигация по разделам скринридером.
  const tabAriaTitle =
    tab === "admin" ? "Администрирование" : tab === "trips" ? "Поездки" : "Аналитика";

  return (
    <div className="v4-app" ref={layoutRef}>
      <div className="v4-wrap">
        {/* === Single horizontal top bar ===
            Brand · 3 bookmark tabs · active-tab word · utility buttons · theme · logout */}
        <header className="topbar">
          <div className="brand">
            <h1>Телематика Маркова</h1>
          </div>

          <nav className="v4-bookmarks" aria-label="Вкладки">
            {TABS.map((t) => (
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
              title="Глобальный поиск (⌘⇧F)"
              aria-label="Поиск"
            >
              <Search className="h-4 w-4" />
              <span className="kbd-mini">⌘⇧F</span>
            </button>
            <button
              className="iconbtn"
              onClick={() => onCmdOpen()}
              title="Команды (⌘K)"
              aria-label="Команды"
            >
              <Command className="h-4 w-4" />
              <span className="kbd-mini">⌘K</span>
            </button>
            <button
              className="iconbtn"
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
                  title={`Период: ${p.label} — метрики по всем поездкам за период`}
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
                    <span>{selectedSession.deviceName || selectedSession.deviceId}</span>
                    <span className="mono" style={{ fontSize: 10, color: "var(--muted)" }}>
                      {fmtSessionLabel(selectedSession.startTime)}
                    </span>
                  </>
                ) : sessions.isLoading ? (
                  <span>Загрузка…</span>
                ) : sessionsList.length === 0 ? (
                  <span>Нет поездок</span>
                ) : (
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
                        {sessionsList.length === 0 ? "Список поездок пуст" : "Ничего не найдено"}
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
                            <b>{s.deviceName || s.deviceId}</b>
                            <br />
                            <span className="mono">{fmtSessionLabel(s.startTime)}</span>
                          </span>
                          <span className="mono">{relativeLabel(s.startTime)}</span>
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
        {TABS.map((t) => (
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
