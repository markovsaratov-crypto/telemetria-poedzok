"use client";

// src/components/sw-update-toast.tsx — v2.9.9: плавающий баннер «Доступна новая версия».
// Показывается, когда новый service worker установлен и ждёт подтверждения;
// «Обновить» → SKIP_WAITING → активация → авторелоад (см. pwa-register.tsx).

import * as React from "react";
import { AnimatePresence, motion } from "framer-motion";
import { RefreshCw, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useSwUpdate } from "@/components/pwa-register";

export function SwUpdateToast() {
  const { updateReady, applyUpdate } = useSwUpdate();
  const [dismissed, setDismissed] = React.useState(false);
  const [updating, setUpdating] = React.useState(false);

  const handleApply = React.useCallback(() => {
    setUpdating(true);
    applyUpdate();
  }, [applyUpdate]);

  const open = updateReady && !dismissed;

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0, y: 24, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 24, scale: 0.97 }}
          transition={{ type: "spring", stiffness: 380, damping: 30 }}
          className="fixed bottom-4 left-1/2 z-[60] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 sm:bottom-6"
          role="alert"
          aria-live="polite"
        >
          <div className="relative overflow-hidden rounded-2xl border border-primary/25 bg-popover/95 shadow-xl shadow-primary/10 backdrop-blur-md">
            {/* акцентная полоса-градиент сверху */}
            <div
              aria-hidden
              className="absolute inset-x-0 top-0 h-[3px] bg-gradient-to-r from-primary via-rose-400 to-amber-400"
            />
            <div className="flex items-center gap-3 p-4 pr-10">
              <div className="flex h-9 w-9 flex-none items-center justify-center rounded-xl bg-primary/12 text-primary ring-1 ring-primary/25">
                {updating ? (
                  <RefreshCw className="h-4.5 w-4.5 animate-spin" />
                ) : (
                  <Sparkles className="h-4.5 w-4.5" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold leading-tight">
                  {updating ? "Обновляем…" : "Доступна новая версия"}
                </p>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">
                  {updating
                    ? "Страница перезагрузится автоматически"
                    : "Обновите приложение, чтобы получить последние изменения"}
                </p>
              </div>
              <Button size="sm" onClick={handleApply} disabled={updating} className="flex-none">
                {updating ? (
                  <RefreshCw className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                )}
                Обновить
              </Button>
              {!updating && (
                <button
                  type="button"
                  onClick={() => setDismissed(true)}
                  aria-label="Скрыть уведомление об обновлении"
                  className="absolute right-2.5 top-2.5 flex h-7 w-7 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  <X className="h-4 w-4" />
                </button>
              )}
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
