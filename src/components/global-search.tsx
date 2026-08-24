"use client";

// src/components/global-search.tsx — глобальный поиск по сессиям (Cmd+Shift+F).

import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Search, X, MapPin, Tag, StickyNote, Smartphone, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
} from "@/components/ui/dialog";
import { useSessionSearch } from "@/lib/hooks";
import { fmtDate, fmtNumber } from "@/lib/format";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface GlobalSearchProps {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onSelect: (id: string) => void;
}

const FIELD_ICONS: Record<string, React.ReactNode> = {
  deviceId: <Smartphone className="h-3 w-3" />,
  deviceName: <Smartphone className="h-3 w-3" />,
  notes: <StickyNote className="h-3 w-3" />,
  tags: <Tag className="h-3 w-3" />,
};

const FIELD_LABELS: Record<string, string> = {
  deviceId: "Device ID",
  deviceName: "Имя устройства",
  notes: "Заметки",
  tags: "Теги",
};

export function GlobalSearch({ open, onOpenChange, onSelect }: GlobalSearchProps) {
  const [query, setQuery] = React.useState("");
  const [selected, setSelected] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement>(null);

  // Debounce
  const [debounced, setDebounced] = React.useState("");
  React.useEffect(() => {
    const id = setTimeout(() => setDebounced(query), 300);
    return () => clearTimeout(id);
  }, [query]);

  const { data, isFetching } = useSessionSearch(debounced);
  const results = data?.sessions || [];

  React.useEffect(() => {
    if (open) {
      setQuery("");
      setSelected(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  React.useEffect(() => {
    setSelected(0);
  }, [debounced]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((s) => Math.min(s + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (results[selected]) {
        handleSelect(results[selected].id);
      }
    }
  }

  function handleSelect(id: string) {
    onSelect(id);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="p-0 gap-0 max-w-2xl overflow-hidden" onKeyDown={onKeyDown}>
        <div className="flex items-center gap-2 border-b px-3 py-2.5">
          <Search className="h-4 w-4 text-muted-foreground shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Поиск по сессиям: deviceId, заметки, теги…"
            className="flex-1 bg-transparent outline-none text-sm placeholder:text-muted-foreground"
          />
          {isFetching && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
          {query && (
            <button onClick={() => setQuery("")} className="text-muted-foreground hover:text-foreground">
              <X className="h-3.5 w-3.5" />
            </button>
          )}
          <kbd>Esc</kbd>
        </div>

        <div className="max-h-[420px] overflow-y-auto scroll-telem">
          {!debounced.trim() ? (
            <div className="px-4 py-12 text-center text-sm text-muted-foreground space-y-2">
              <Search className="h-8 w-8 mx-auto opacity-30" />
              <div>Начните вводить для поиска</div>
              <div className="text-[10px] text-muted-foreground/70">
                Поиск работает по deviceId, имени устройства, заметкам и тегам
              </div>
            </div>
          ) : results.length === 0 ? (
            <div className="px-4 py-12 text-center text-sm text-muted-foreground space-y-2">
              <MapPin className="h-8 w-8 mx-auto opacity-30" />
              <div>Ничего не найдено по запросу «{debounced}»</div>
            </div>
          ) : (
            <ul className="divide-y">
              <AnimatePresence>
                {results.map((s, idx) => (
                  <motion.li
                    key={s.id}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: Math.min(idx * 0.02, 0.2) }}
                  >
                    <button
                      onMouseEnter={() => setSelected(idx)}
                      onClick={() => handleSelect(s.id)}
                      className={cn(
                        "w-full text-left px-3 py-2.5 transition-colors",
                        selected === idx ? "bg-accent" : "hover:bg-accent/50"
                      )}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0 flex-1 space-y-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-xs font-medium truncate">
                              {s.deviceName || s.deviceId}
                            </span>
                            {s.matchFields.map((f) => (
                              <Badge
                                key={f}
                                variant="outline"
                                className="text-[9px] gap-0.5 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/30"
                              >
                                {FIELD_ICONS[f]}
                                {FIELD_LABELS[f] || f}
                              </Badge>
                            ))}
                          </div>
                          <div className="text-[10px] text-muted-foreground flex items-center gap-2">
                            <span>{fmtDate(s.startTime)}</span>
                            <span>·</span>
                            <span>{fmtNumber(s.pointCount)} тчк</span>
                            {s.notes && (
                              <>
                                <span>·</span>
                                <span className="truncate max-w-[200px] italic">
                                  «{s.notes.slice(0, 60)}{s.notes.length > 60 ? "…" : ""}»
                                </span>
                              </>
                            )}
                          </div>
                        </div>
                      </div>
                    </button>
                  </motion.li>
                ))}
              </AnimatePresence>
            </ul>
          )}
        </div>

        {results.length > 0 && (
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
            <span>
              Найдено: <span className="font-mono font-semibold">{results.length}</span>
            </span>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
