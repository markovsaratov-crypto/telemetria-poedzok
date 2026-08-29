// src/components/v4/telematika-layout.tsx — каркас v4: шапка + 3 таба + период + фильтр поездки.
// v2.10.0 R1: фильтр поездки переведён на live API /api/sessions (useSessions из hooks.ts).
// selectedTripId (mock "t1".."t8") заменён на selectedSessionId (real UUID).

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
  Menu,
} from "lucide-react";
import { useV4Tipbox, bindTips } from "./use-v4-tipbox";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { type PeriodKey } from "@/lib/telematika-v4-mock";
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

const TABS: { id: V4Tab; label: string }[] = [
  { id: "analytics", label: "Аналитика" },
  { id: "trips", label: "Поездки" },
  { id: "admin", label: "Админ" },
];

const PERIOD_LIST: { id: Period; label: string }[] = [
  { id: "today", label: "Сегодня · 28 авг" },
  { id: "week", label: "7 дней · 22–28 авг" },
  { id: "d30", label: "30 дней" },
  { id: "month", label: "Август" },
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
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const tripFilterRef = React.useRef<HTMLDivElement>(null);
  const layoutRef = React.useRef<HTMLDivElement>(null);

  // v2.10.0 R1: live sessions list (replaces TRIP_FILTER_LIST mock).
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

  // Re-bind tips после каждого рендера
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

  function handleRefresh() {
    queryClient.invalidateQueries();
    toast.success("Данные обновлены");
  }

  // v2.10.0 R1: selected session из live API list.
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

  return (
    <div className="v4-app" ref={layoutRef}>
      <div className="v4-wrap">
        {/* === Шапка (без бейджа PROTOTYPE) === */}
        <header className="topbar">
          <div className="brand">
            <h1>Телематика Маркова</h1>
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
              title="Глобальный поиск (Cmd+Shift+F)"
              aria-label="Поиск"
            >
              <Search className="h-4 w-4" />
              <span className="kbd-mini">⌘⇧F</span>
            </button>
            <button
              className="iconbtn"
              onClick={() => onCmdOpen()}
              title="Команды (Cmd+K)"
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

        {/* === Вкладки (десктоп) === */}
        <nav className="tabs v4-desktop-tabs" aria-label="Вкладки">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`tab ${tab === t.id ? "active" : ""}`}
              onClick={() => onTabChange(t.id)}
              title={t.label}
            >
              {t.label}
            </button>
          ))}
        </nav>

        {/* === Вкладки (мобильные — hamburger + текущая вкладка) === */}
        <div className="v4-mobile-tabs" aria-label="Мобильное меню">
          <button
            type="button"
            className={`v4-hamburger ${drawerOpen ? "is-open" : ""}`}
            onClick={() => setDrawerOpen(true)}
            aria-label="Открыть меню вкладок"
            aria-haspopup="dialog"
            aria-expanded={drawerOpen}
            title="Меню вкладок"
          >
            <Menu className="h-4 w-4" />
          </button>
          <span className="v4-mobile-current">
            {TABS.find((t) => t.id === tab)?.label ?? ""}
          </span>
        </div>

        {/* === Sheet Drawer с тремя вкладками === */}
        <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
          <SheetContent side="left" className="v4-drawer">
            <SheetHeader>
              <SheetTitle>Меню вкладок</SheetTitle>
            </SheetHeader>
            <nav style={{ display: "flex", flexDirection: "column", gap: 0, flex: 1 }}>
              {TABS.map((t, i) => (
                <button
                  key={t.id}
                  type="button"
                  className={`v4-drawer-tab ${tab === t.id ? "active" : ""}`}
                  onClick={() => {
                    onTabChange(t.id);
                    setDrawerOpen(false);
                  }}
                  aria-current={tab === t.id ? "page" : undefined}
                >
                  <span className="v4-drawer-num">0{i + 1}</span>
                  <span>{t.label}</span>
                </button>
              ))}
            </nav>
          </SheetContent>
        </Sheet>

        {/* === Период-селектор + фильтр конкретной поездки (только для Аналитика) === */}
        {tab === "analytics" && (
          <div className="pills-row">
            <div className="pills">
              {PERIOD_LIST.map((p) => (
                <button
                  key={p.id}
                  className={`pill ${period === p.id && !selectedSessionId ? "active" : ""}`}
                  onClick={() => {
                    onPeriodChange(p.id);
                    onSelectedSessionChange(null);
                  }}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <div className="trip-filter" ref={tripFilterRef}>
              <button
                className="trip-filter-btn"
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
                  <span>Выбрать поездку</span>
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

        {/* === Контент === */}
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
      </div>
    </div>
  );
}
