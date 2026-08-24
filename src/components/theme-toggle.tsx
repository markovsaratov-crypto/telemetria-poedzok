"use client";

// src/components/theme-toggle.tsx — переключатель light/dark.

import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";
import { useSyncExternalStore } from "react";

// Безопасное определение «смонтирован ли клиент» без setState в effect.
const emptySubscribe = () => () => {};
function useMounted(): boolean {
  return useSyncExternalStore(
    emptySubscribe,
    () => true, // client snapshot
    () => false // server snapshot
  );
}

export function ThemeToggle() {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const mounted = useMounted();

  const isDark = (resolvedTheme || theme) === "dark";

  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-8 w-8"
      onClick={() => setTheme(isDark ? "light" : "dark")}
      aria-label={isDark ? "Светлая тема" : "Тёмная тема"}
      title={isDark ? "Светлая тема" : "Тёмная тема"}
    >
      {mounted && isDark ? (
        <Sun className="h-4 w-4" />
      ) : (
        <Moon className="h-4 w-4" />
      )}
    </Button>
  );
}
