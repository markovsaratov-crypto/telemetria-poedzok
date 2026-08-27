"use client";

// src/components/mobile/shared/BottomNav.tsx
// ТЗ §2.2: Bottom Navigation — 4 таба (фиксированная снизу, 44pt touch target)

import * as React from "react";
import { motion } from "framer-motion";
import { List, Map, BarChart3, Route } from "lucide-react";
import { cn } from "@/lib/utils";

export type MobileTab = "trips" | "map" | "analytics" | "routes";

interface BottomNavProps {
  active: MobileTab;
  onChange: (tab: MobileTab) => void;
}

const TABS: { id: MobileTab; label: string; icon: React.ReactNode }[] = [
  { id: "trips", label: "Поездки", icon: <List className="h-5 w-5" /> },
  { id: "map", label: "Карта", icon: <Map className="h-5 w-5" /> },
  { id: "analytics", label: "Аналитика", icon: <BarChart3 className="h-5 w-5" /> },
  { id: "routes", label: "Маршруты", icon: <Route className="h-5 w-5" /> },
];

export function BottomNav({ active, onChange }: BottomNavProps) {
  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 bg-card/95 backdrop-blur-md border-t safe-bottom">
      <div className="flex items-center justify-around px-2 py-1">
        {TABS.map((tab) => {
          const isActive = active === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => onChange(tab.id)}
              className={cn(
                "flex flex-col items-center justify-center gap-1 py-2 px-3 rounded-xl transition-colors",
                "min-w-[64px] min-h-[44px]",
                isActive ? "text-primary" : "text-muted-foreground"
              )}
              aria-label={tab.label}
              aria-current={isActive ? "page" : undefined}
            >
              <motion.div
                animate={isActive ? { scale: 1.1 } : { scale: 1 }}
                transition={{ type: "spring", stiffness: 300, damping: 20 }}
              >
                {tab.icon}
              </motion.div>
              <span className="text-[10px] font-medium">{tab.label}</span>
              {isActive && (
                <motion.div
                  layoutId="bottomNavIndicator"
                  className="absolute -top-px h-0.5 w-8 rounded-full bg-primary"
                />
              )}
            </button>
          );
        })}
      </div>
    </nav>
  );
}
