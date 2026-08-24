"use client";

// src/components/shortcuts-help.tsx — диалог со списком всех keyboard shortcuts.

import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Keyboard, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

interface ShortcutsHelpProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

interface Shortcut {
  keys: string[];
  description: string;
  group: string;
}

const SHORTCUTS: Shortcut[] = [
  // Global
  { keys: ["⌘", "K"], description: "Открыть командную палитру", group: "Глобальные" },
  { keys: ["⌘", "K"], description: "Закрыть командную палитру", group: "Глобальные" },
  { keys: ["Alt", "1"], description: "Перейти на вкладку Обзор", group: "Глобальные" },
  { keys: ["Alt", "2"], description: "Перейти на вкладку Сессии", group: "Глобальные" },
  { keys: ["Alt", "3"], description: "Перейти на вкладку Маршруты", group: "Глобальные" },
  { keys: ["Alt", "4"], description: "Перейти на вкладку Импорт", group: "Глобальные" },
  { keys: ["Alt", "5"], description: "Перейти на вкладку Администрирование", group: "Глобальные" },
  { keys: ["?"], description: "Показать эту справку", group: "Глобальные" },
  { keys: ["Esc"], description: "Закрыть диалог/попап", group: "Глобальные" },
  // Command palette
  { keys: ["↑", "↓"], description: "Навигация по командам", group: "Командная палитра" },
  { keys: ["↵"], description: "Выбрать команду", group: "Командная палитра" },
  // Map
  { keys: ["Scroll"], description: "Зум карты", group: "Карта" },
  { keys: ["Click"], description: "Установить точку (в планировщике)", group: "Карта" },
  { keys: ["Drag"], description: "Перемещение карты", group: "Карта" },
  // Sessions
  { keys: ["Enter"], description: "Применить фильтр (в поле Device ID)", group: "Сессии" },
];

export function ShortcutsHelp({ open, onOpenChange }: ShortcutsHelpProps) {
  const groups = React.useMemo(() => {
    const g: Record<string, Shortcut[]> = {};
    for (const s of SHORTCUTS) {
      if (!g[s.group]) g[s.group] = [];
      g[s.group].push(s);
    }
    return g;
  }, []);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Keyboard className="h-4 w-4 text-primary" />
            Горячие клавиши
          </DialogTitle>
          <DialogDescription className="text-xs">
            Используйте эти комбинации для быстрой навигации
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 max-h-[60vh] overflow-y-auto scroll-telem">
          {Object.entries(groups).map(([group, items]) => (
            <div key={group}>
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground font-medium mb-2">
                {group}
              </div>
              <div className="space-y-1.5">
                {items.map((s, i) => (
                  <div
                    key={i}
                    className="flex items-center justify-between gap-3 py-1.5 border-b border-border/40 last:border-b-0"
                  >
                    <span className="text-xs text-foreground">{s.description}</span>
                    <div className="flex items-center gap-1 shrink-0">
                      {s.keys.map((k, j) => (
                        <kbd key={j}>{k}</kbd>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
