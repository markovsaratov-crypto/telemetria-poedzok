"use client";

// src/components/theme-toggle.tsx — переключатель light/dark с анимацией.

import * as React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";
import { useSyncExternalStore } from "react";

const emptySubscribe = () => () => {};
function useMounted(): boolean {
  return useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false
  );
}

export function ThemeToggle() {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const mounted = useMounted();
  const [animating, setAnimating] = React.useState(false);

  const isDark = (resolvedTheme || theme) === "dark";

  function toggle() {
    setAnimating(true);
    setTheme(isDark ? "light" : "dark");
    setTimeout(() => setAnimating(false), 400);
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-8 w-8 relative overflow-hidden"
      onClick={toggle}
      aria-label={isDark ? "Светлая тема" : "Тёмная тема"}
      title={isDark ? "Светлая тема" : "Тёмная тема"}
    >
      <AnimatePresence mode="wait" initial={false}>
        {mounted && isDark ? (
          <motion.span
            key="sun"
            initial={{ rotate: -90, opacity: 0, scale: 0.5 }}
            animate={{ rotate: 0, opacity: 1, scale: 1 }}
            exit={{ rotate: 90, opacity: 0, scale: 0.5 }}
            transition={{ duration: 0.3, ease: "easeOut" }}
            className="absolute inset-0 flex items-center justify-center"
          >
            <Sun className="h-4 w-4 text-amber-500" />
          </motion.span>
        ) : (
          <motion.span
            key="moon"
            initial={{ rotate: 90, opacity: 0, scale: 0.5 }}
            animate={{ rotate: 0, opacity: 1, scale: 1 }}
            exit={{ rotate: -90, opacity: 0, scale: 0.5 }}
            transition={{ duration: 0.3, ease: "easeOut" }}
            className="absolute inset-0 flex items-center justify-center"
          >
            <Moon className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
          </motion.span>
        )}
      </AnimatePresence>
      {/* Pulse ring при переключении */}
      {animating && (
        <motion.span
          initial={{ scale: 0, opacity: 0.5 }}
          animate={{ scale: 2, opacity: 0 }}
          transition={{ duration: 0.4 }}
          className="absolute inset-0 rounded-full border-2 border-primary pointer-events-none"
        />
      )}
    </Button>
  );
}
