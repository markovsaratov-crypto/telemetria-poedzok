"use client";

// src/components/shortcuts-help.tsx — диалог со списком всех keyboard shortcuts.
// v2.38.2 · F79: список приведён к ФАКТИЧЕСКИМ хоткеям v4 (аудит keydown-роутера
// в telematika-layout + диалогов). Удалены мёртвые пункты: Alt+4/Alt+5 (роутер
// ловит только Alt+1–3), «вкладки Маршруты/Импорт» (таких вкладок в v4 нет),
// «Space — пауза в replay» и «Click — точка в планировщике» (replay и
// планировщика не существует), «Enter — фильтр Device ID» (поля нет).
// Модификаторы — платформенно (конвенция v2.12.0 V-1 из telematika-layout):
// ⌘/⇧ на Mac, Ctrl/Shift на Windows/Linux.

import * as React from "react";
import { Keyboard } from "lucide-react";
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
  // "MOD" → ⌘ (Mac) / Ctrl (Windows/Linux); "SHIFT" → ⇧ / Shift
  keys: string[];
  description: string;
  group: string;
}

const SHORTCUTS: Shortcut[] = [
  // Global — keydown-роутер telematika-layout.tsx
  { keys: ["MOD", "K"], description: "Открыть командную палитру", group: "Глобальные" },
  { keys: ["MOD", "SHIFT", "F"], description: "Глобальный поиск записей", group: "Глобальные" },
  { keys: ["Alt", "1"], description: "Перейти на вкладку «Аналитика»", group: "Глобальные" },
  { keys: ["Alt", "2"], description: "Перейти на вкладку «Поездки»", group: "Глобальные" },
  { keys: ["Alt", "3"], description: "Перейти на вкладку «Админ» (владелец/админ)", group: "Глобальные" },
  { keys: ["?"], description: "Показать эту справку", group: "Глобальные" },
  { keys: ["Esc"], description: "Закрыть диалог / скрыть подсказку", group: "Глобальные" },
  // Dialogs (командная палитра ⌘K, глобальный поиск ⌘⇧F)
  { keys: ["↑", "↓"], description: "Навигация по списку (палитра, поиск)", group: "Диалоги" },
  { keys: ["↵"], description: "Выбрать элемент (палитра, поиск)", group: "Диалоги" },
  // Map — блок 05 «Карта поездки» (Leaflet, вкладка «Аналитика»)
  { keys: ["Scroll"], description: "Зум карты поездки", group: "Карта поездки" },
  { keys: ["Drag"], description: "Перемещение карты поездки", group: "Карта поездки" },
];

// v2.12.0 (V-1): платформенно-зависимые глифы — ⌘/⇧ понятны только на Mac;
// на Windows/Linux показываем Ctrl/Shift-форму (дублирует useIsMac из
// telematika-layout — там он не экспортирован).
function useIsMac(): boolean {
  const [isMac, setIsMac] = React.useState(false);
  React.useEffect(() => {
    setIsMac(/Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent));
  }, []);
  return isMac;
}

function platformKey(k: string, isMac: boolean): string {
  if (k === "MOD") return isMac ? "⌘" : "Ctrl";
  if (k === "SHIFT") return isMac ? "⇧" : "Shift";
  return k;
}

export function ShortcutsHelp({ open, onOpenChange }: ShortcutsHelpProps) {
  const isMac = useIsMac();

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
                        <kbd key={j}>{platformKey(k, isMac)}</kbd>
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
