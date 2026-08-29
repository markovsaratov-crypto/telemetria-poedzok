"use client";

// src/components/command-palette.tsx — Cmd+K command palette для быстрой навигации.

import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  Search,
  LayoutDashboard,
  Map,
  Route as RouteIcon,
  Upload,
  ShieldCheck,
  Moon,
  Sun,
  LogOut,
  Command,
  CornerDownLeft,
  RefreshCw,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useTheme } from "next-themes";

interface CommandItem {
  id: string;
  label: string;
  hint?: string;
  icon: React.ReactNode;
  group: string;
  action: () => void;
  keywords?: string;
}

interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onTabChange: (tab: string) => void;
  onLogout: () => void;
  onRefresh?: () => void;
}

export function CommandPalette({
  open,
  onOpenChange,
  onTabChange,
  onLogout,
  onRefresh,
}: CommandPaletteProps) {
  const { theme, setTheme } = useTheme();
  const [query, setQuery] = React.useState("");
  const [selected, setSelected] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const items = React.useMemo<CommandItem[]>(() => {
    return [
      {
        id: "tab-overview",
        label: "Перейти: Обзор",
        icon: <LayoutDashboard className="h-4 w-4" />,
        group: "Навигация",
        action: () => {
          onTabChange("overview");
          onOpenChange(false);
        },
        keywords: "обзор dashboard home",
      },
      {
        id: "tab-sessions",
        label: "Перейти: Сессии",
        icon: <Map className="h-4 w-4" />,
        group: "Навигация",
        action: () => {
          onTabChange("sessions");
          onOpenChange(false);
        },
        keywords: "сессии trips tracks",
      },
      {
        id: "tab-routes",
        label: "Перейти: Маршруты",
        icon: <RouteIcon className="h-4 w-4" />,
        group: "Навигация",
        action: () => {
          onTabChange("routes");
          onOpenChange(false);
        },
        keywords: "маршруты routes plan",
      },
      {
        id: "tab-import",
        label: "Перейти: Импорт CSV",
        icon: <Upload className="h-4 w-4" />,
        group: "Навигация",
        action: () => {
          onTabChange("import");
          onOpenChange(false);
        },
        keywords: "импорт csv upload",
      },
      {
        id: "tab-admin",
        label: "Перейти: Администрирование",
        icon: <ShieldCheck className="h-4 w-4" />,
        group: "Навигация",
        action: () => {
          onTabChange("admin");
          onOpenChange(false);
        },
        keywords: "админ backup audit admin",
      },
      ...(onRefresh
        ? [
            {
              id: "refresh",
              label: "Обновить данные",
              icon: <RefreshCw className="h-4 w-4" />,
              group: "Действия",
              action: () => {
                onRefresh();
                onOpenChange(false);
              },
              keywords: "refresh reload обновить",
            } as CommandItem,
          ]
        : []),
      {
        id: "toggle-theme",
        label: theme === "dark" ? "Светлая тема" : "Тёмная тема",
        icon: theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />,
        group: "Действия",
        action: () => {
          setTheme(theme === "dark" ? "light" : "dark");
          onOpenChange(false);
        },
        keywords: "theme dark light тема",
      },
      {
        id: "logout",
        label: "Выйти из системы",
        icon: <LogOut className="h-4 w-4" />,
        group: "Действия",
        action: () => {
          onLogout();
          onOpenChange(false);
        },
        keywords: "logout exit выход",
      },
    ];
  }, [theme, setTheme, onTabChange, onOpenChange, onLogout, onRefresh]);

  const filtered = React.useMemo(() => {
    if (!query.trim()) return items;
    const q = query.toLowerCase();
    return items.filter(
      (it) =>
        it.label.toLowerCase().includes(q) ||
        it.keywords?.includes(q) ||
        it.group.toLowerCase().includes(q)
    );
  }, [items, query]);

  React.useEffect(() => {
    setSelected(0);
  }, [query]);

  React.useEffect(() => {
    if (open) {
      setQuery("");
      setSelected(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((s) => (s + 1) % filtered.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) => (s - 1 + filtered.length) % filtered.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      filtered[selected]?.action();
    }
  }

  // Группировка
  const groups = React.useMemo(() => {
    const g: Record<string, CommandItem[]> = {};
    filtered.forEach((it) => {
      if (!g[it.group]) g[it.group] = [];
      g[it.group].push(it);
    });
    return g;
  }, [filtered]);

  let flatIdx = -1;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="p-0 gap-0 max-w-xl overflow-hidden" onKeyDown={onKeyDown}>
        <DialogHeader className="sr-only">
          <DialogTitle>Команды</DialogTitle>
        </DialogHeader>
        <div className="flex items-center gap-2 border-b px-3 py-2.5">
          <Search className="h-4 w-4 text-muted-foreground shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Поиск команд и навигации…"
            className="flex-1 bg-transparent outline-none text-sm placeholder:text-muted-foreground"
          />
          <kbd>Esc</kbd>
        </div>
        <div className="max-h-[360px] overflow-y-auto scroll-telem py-2">
          {filtered.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              Ничего не найдено
            </div>
          ) : (
            Object.entries(groups).map(([group, items]) => (
              <div key={group} className="mb-1">
                <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-muted-foreground font-medium">
                  {group}
                </div>
                {items.map((it) => {
                  flatIdx++;
                  const idx = flatIdx;
                  const isSelected = idx === selected;
                  return (
                    <button
                      key={it.id}
                      onMouseEnter={() => setSelected(idx)}
                      onClick={it.action}
                      className={`w-full text-left px-3 py-2 flex items-center gap-2.5 text-sm transition-colors ${
                        isSelected
                          ? "bg-accent text-accent-foreground"
                          : "hover:bg-accent/50"
                      }`}
                    >
                      <span
                        className={
                          isSelected
                            ? "text-primary"
                            : "text-muted-foreground"
                        }
                      >
                        {it.icon}
                      </span>
                      <span className="flex-1 truncate">{it.label}</span>
                      {isSelected && (
                        <CornerDownLeft className="h-3 w-3 text-muted-foreground" />
                      )}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
        <div className="border-t px-3 py-1.5 flex items-center justify-between text-[10px] text-muted-foreground">
          <div className="flex items-center gap-2">
            <span className="flex items-center gap-1">
              <kbd>↑</kbd>
              <kbd>↓</kbd> навигация
            </span>
            <span className="flex items-center gap-1">
              <kbd>↵</kbd> выбор
            </span>
          </div>
          <span className="flex items-center gap-1">
            <Command className="h-2.5 w-2.5" /> Telemetria v2.9
          </span>
        </div>
      </DialogContent>
    </Dialog>
  );
}
